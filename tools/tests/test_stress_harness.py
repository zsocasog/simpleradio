import asyncio
import copy
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'tools'))
from stress_report import AudioAudit, summarize, percentile, write_report, feed_balances
from stress_radio import Run, owned_stations, station_digest, validate_image
from stress_fixture import PCM, RATE, png, upload_png, FixtureHandler
import patch_runtime_probe

def sample(**audio):
    return dict(uptimeMs=5000, stable=True, heapFree=30000, heapLargest=15000, psramFree=6000000,
                audio=dict(epoch=2,active=True,sentFrames=1000,feedDeadlineMisses=0,writeErrors=0,**audio))

class ReportTests(unittest.TestCase):
    def test_absent_audio_measurements_are_inconclusive(self):
        self.assertEqual(summarize([])['result'],'INCONCLUSIVE_AUDIO')

    def test_one_percent_requires_observed_fft_and_lcd_progress(self):
        manifest=dict(kind='manifest',testVolume=1)
        samples=[]
        for i in range(4):
            s=sample();s.update(kind='sample',phase='fixture',t=i,uptimeMs=5000+i*1000)
            s['audio'].update(sampleRate=44100,dmaFrames=8192,writeMaxUs=1,sentFrames=i*44100,acceptedBytes=i*44100*8)
            s['spectrumLoad']=dict(enabled=True,visible=True,analyzed=40*i,draws=27*i)
            samples.append(s)
        summary=summarize([manifest,*samples])
        self.assertEqual(summary['spectrumMovingPairs'],3)
        self.assertEqual(summary['result'],'NO_FAILURE_OBSERVED')
        for s in samples:s['spectrumLoad']['draws']=0
        self.assertEqual(summarize([manifest,*samples])['result'],'INCONCLUSIVE_SPECTRUM')
        for s in samples:s['spectrumLoad']=None
        self.assertEqual(summarize([manifest,*samples])['result'],'INCONCLUSIVE_SPECTRUM')

    def test_sent_silence_counts_exclude_control_transitions_and_absent_telemetry(self):
        rows=[]
        for i in range(4):
            s=sample();s.update(kind='sample',phase='fixture',t=i,uptimeMs=5000+1000*i)
            s['audio'].update(sampleRate=44100,dmaFrames=8192,writeMaxUs=1,sentFrames=i*44100,acceptedBytes=i*44100*8,
                              observedBlocks=i*172,zeroBlocks=i)
            rows.append(s)
        report=summarize(rows);self.assertEqual(report['observedSentBlocks'],516);self.assertEqual(report['allZeroSentBlocks'],3)
        rows[1]['stable']=False
        self.assertEqual(summarize(rows)['allZeroSentBlocks'],1)

    def test_interrupted_scenario_cannot_be_reported_as_complete(self):
        self.assertEqual(summarize([dict(kind='manifest',exercise=True)])['result'],'INCOMPLETE')

    def test_real_output_stop_is_detected(self):
        a=AudioAudit();a.observe(sample());self.assertEqual(a.observe(sample())[0]['kind'],'audio-failure')

    def test_expected_station_switch_is_excluded(self):
        a=AudioAudit();a.observe(sample());s=sample();s['stable']=False
        self.assertEqual(a.observe(s),[])

    def test_epoch_change_is_not_a_fake_counter_stall(self):
        a=AudioAudit();a.observe(sample());s=sample();s['audio']['epoch']=3
        self.assertEqual(a.observe(s)[0]['kind'],'audio-risk')

    def test_starvation_is_risk_and_not_acoustic_proof(self):
        a=AudioAudit();a.observe(sample());s=sample();s['audio'].update(sentFrames=5000,feedDeadlineMisses=1)
        f=a.observe(s);self.assertEqual(len(f),1);self.assertEqual(f[0]['kind'],'audio-risk')

    def test_only_an_audited_continuous_local_source_treats_sent_silence_as_failure(self):
        old=sample();old.update(phase='upload-large',stationId=3);old['audio']['zeroBlocks']=1
        new=copy.deepcopy(old);new['audio'].update(sentFrames=5000,zeroBlocks=2)
        ordinary=AudioAudit();ordinary.observe(old);self.assertEqual(ordinary.observe(new),[])
        strict=AudioAudit(expect_continuous=True);strict.observe(old)
        self.assertEqual(strict.observe(new)[0]['kind'],'audio-failure')
        strict=AudioAudit(expect_continuous=True);strict.observe(old);new['phase']='soak-radio-3'
        self.assertEqual(strict.observe(new),[])

    def test_offline_report_recovers_a_missed_live_content_warning(self):
        rows=[]
        for i in range(3):
            s=sample();s.update(kind='sample',phase='upload-fixture',t=i,stationId=3,uptimeMs=5000+1000*i)
            s['audio'].update(sampleRate=44100,dmaFrames=8192,writeMaxUs=1,sentFrames=i*44100,acceptedBytes=i*44100*8,
                              observedBlocks=i*172,zeroBlocks=i)
            rows.append(s)
        report=summarize([dict(kind='manifest',testVolume=1,expectContinuous=True),*rows])
        self.assertEqual(report['result'],'FAIL')
        self.assertEqual(sum(f.get('blocks',0) for f in report['findings']),2)

    def test_a_phase_label_change_cannot_hide_a_gap_in_the_same_continuous_source(self):
        old=sample();old.update(phase='upload-baseline',stationId=3);old['audio']['zeroBlocks']=2
        new=copy.deepcopy(old);new.update(phase='upload-1-small',uptimeMs=6000)
        new['audio'].update(sentFrames=5000,zeroBlocks=6)
        audit=AudioAudit(expect_continuous=True);audit.observe(old)
        self.assertEqual(audit.observe(new)[0]['blocks'],4)
        new['stationId']=4
        audit=AudioAudit(expect_continuous=True);audit.observe(old)
        self.assertEqual(audit.observe(new),[])

    def test_uptime_wrap_is_not_reboot(self):
        a=AudioAudit();s=sample();s['uptimeMs']=0xfffffff0;a.observe(s)
        self.assertFalse(any(x['kind']=='reboot' for x in a.observe(sample())))

    def test_reboot_is_detected(self):
        a=AudioAudit();a.observe(sample());s=sample();s['uptimeMs']=100
        self.assertEqual(a.observe(s)[0]['kind'],'reboot')

    def test_percentiles_and_saved_report(self):
        self.assertEqual(percentile([1,5,3,4,2],95),5)
        events=[dict(kind='http',phase='idle',operation='save',ms=x,ok=True) for x in [1,2,80]]
        with tempfile.TemporaryDirectory() as d:
            summary=write_report(d,events)
            self.assertEqual(summary['latency']['idle / save']['p95Ms'],80)
            self.assertTrue((Path(d)/'report.md').exists())

    def test_feed_balance_allows_two_rings_and_splits_control_transitions(self):
        rows=[]
        for i in range(3):
            s=sample();s.update(t=i,phase='test',kind='sample',codec='WAV')
            s['audio'].update(sampleRate=44100,dmaFrames=8192,writeMaxUs=5000,sentFrames=i*44100,acceptedBytes=i*20000*8)
            rows.append(s)
        balance=feed_balances(rows)[0]
        self.assertGreater(balance['conservativeDeficitMs'],500)
        self.assertEqual(summarize(rows)['result'],'OBSERVED_WITH_RISKS')
        rows[1]['stable']=False
        self.assertEqual(feed_balances(rows),[])

class SafetyTests(unittest.TestCase):
    def test_cancelled_request_retains_http_slot_until_real_network_job_finishes(self):
        async def check(directory):
            entered=threading.Event();release=threading.Event();second=threading.Event()
            args=SimpleNamespace(base='http://192.0.2.1',out=Path(directory)/'run',seed=1,
                                 exercise=True,http_parallel=1)
            run=Run(args)
            def raw(path,*_args):
                if path=='/first':
                    entered.set()
                    if not release.wait(2):raise TimeoutError('Test did not release first request')
                else:second.set()
                return 200,b'ok','text/plain',1
            run.raw=raw
            first=asyncio.create_task(run.request('/first'))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait,1))
                first.cancel();await asyncio.gather(first,return_exceptions=True)
                next_request=asyncio.create_task(run.request('/second'))
                await asyncio.sleep(.03)
                self.assertFalse(second.is_set())
                release.set()
                self.assertEqual(await next_request,b'ok')
                await asyncio.gather(*run.inflight)
                self.assertTrue(second.is_set())
                row=next(e for e in run.events if e.get('operation')=='/second')
                self.assertGreaterEqual(row['clientQueueMs'],20)
                self.assertIn('networkMs',row)
            finally:
                release.set();await asyncio.gather(*run.inflight,return_exceptions=True);run.log.close()
        with tempfile.TemporaryDirectory() as directory:asyncio.run(check(directory))

    def test_commands_default_to_transient_but_explicit_durable_commit_is_preserved(self):
        async def check():
            sent=[]
            async def send(text):sent.append(json.loads(text))
            run=object.__new__(Run);run.args=SimpleNamespace(exercise=True);run.ws=SimpleNamespace(send=send)
            run.state_number=1;run.emit=lambda *_args,**_kwargs:None
            await run.command({'eqLow':1},wait=False)
            self.assertFalse(sent[-1]['persist'])
            run.args.durable_commands=True
            await run.command({'eqLow':1},wait=False)
            self.assertTrue(sent[-1]['persist'])
            run.state={'eqLow':2}
            async def wait_state(predicate):self.assertTrue(predicate())
            run.wait_state=wait_state
            await run.command({'eqLow':2,'persist':True,'commit':True})
            self.assertTrue(sent[-1]['persist']);self.assertTrue(sent[-1]['commit'])
        asyncio.run(check())

    def test_durable_control_check_reads_the_file_instead_of_trusting_live_state(self):
        async def check():
            run=object.__new__(Run);run.emit=lambda *_args,**_kwargs:None;calls=[]
            async def request(path,**kwargs):
                calls.append(path);return json.dumps({'volume':0 if len(calls)==1 else 1}).encode()
            run.request=request
            await run.verify_durable_controls({'volume':1})
            self.assertEqual(calls,['/state.json','/state.json'])
        asyncio.run(check())

    def test_cleanup_never_selects_original_or_other_users_stations(self):
        s=[dict(id=1,name='SR-test-own-original'),dict(id=2,name='SR-test-own-clone'),dict(id=3,name='SR-test-other-clone')]
        self.assertEqual([x['id'] for x in owned_stations(s,'SR-test-own-',[1])],[2])

    def test_station_digest_checks_order_and_logo(self):
        s=[dict(id=1,name='a',url='u',logo='l'),dict(id=2,name='b')]
        self.assertNotEqual(station_digest(s),station_digest(list(reversed(s))))

    def test_reference_signal_is_repeatable_stereo_and_non_silent(self):
        self.assertEqual(len(PCM),RATE*4)
        l,r=struct.unpack_from('<hh',PCM,400);self.assertEqual(l,r);self.assertNotEqual(l,0)
        validate_image(png(),'image/png')
        with self.assertRaises(ValueError):validate_image(png()[:-2],'image/png')

    def test_upload_fixtures_cover_small_and_large_durable_originals(self):
        self.assertEqual(upload_png(True),upload_png(True))
        self.assertLess(len(upload_png()),32768)
        self.assertGreater(len(upload_png(True)),32768)
        self.assertLess(len(upload_png(True)),120*1024)
        for body in (upload_png(),upload_png(True)):validate_image(body,'image/png')

class ColdLogoTests(unittest.IsolatedAsyncioTestCase):
    async def test_volume_guard_accepts_only_the_explicitly_permitted_level(self):
        for permitted in (0,1):
            run=object.__new__(Run);run.args=SimpleNamespace(exercise=True,test_volume=permitted,expect_build=None)
            run.sample_lock=asyncio.Lock();run.telemetry=False;run.state={};run.last_control=0
            run.recovering=False;run.phase='fixture';run.audit=AudioAudit();run.events=[];run.emit=lambda *_,**__:None
            volume=permitted
            async def get(_):return dict(system=dict(uptimeMs=5000,heapFree=30000,heapLargest=10000,psramFree=6000000,buildId='test'),status=dict(volume=volume))
            run.get=get
            await run.sample()
            volume=2
            with self.assertRaisesRegex(RuntimeError,'Volume changed externally'):await run.sample()

    async def test_soak_is_bounded_and_only_changes_owned_stations(self):
        run=object.__new__(Run);run.args=SimpleNamespace(fixture_url='http://192.0.2.1:19840',reference_file=Path('reference.ogg'),soak_seconds=120,scale=1)
        run.prefix='SR-test-soak-';run.background=[]
        now=[0];created=[];saved=[];commands=[]
        async def add(suffix,url,logo=''):created.append((suffix,url));return 100+len(created)
        async def hold(seconds):now[0]+=seconds
        async def images(_):await asyncio.Future()
        async def command(fields):commands.append(fields)
        async def request(path,fields=None,**kwargs):
            saved.append((path,fields));return b'{"path":"/logos/own.png"}'
        async def config(_):pass
        run.add_station=add;run.hold=hold;run.image_load=images;run.command=command
        run.request=request;run.save_config=config;run.set_phase=lambda _:None;run.emit=lambda *_,**__:None
        try:
            with patch('stress_radio.time.monotonic',side_effect=lambda:now[0]):
                await run.soak([dict(id=7,name='original',url='http://radio/live')],dict(brightness=100))
        finally:
            for task in run.background:task.cancel()
            await asyncio.gather(*run.background,return_exceptions=True)
        self.assertEqual(now[0],120);self.assertEqual(len(created),2)
        self.assertEqual(commands,[dict(station=101,play=True)])
        self.assertTrue(all(fields is None or fields['id'] in (101,102) for _,fields in saved))

    async def test_browser_save_uses_local_reference_without_remote_prewarm_overlap(self):
        run=object.__new__(Run)
        run.args=SimpleNamespace(fixture_url='http://192.0.2.1:19840',
            reference_file=Path('reference.ogg'),logo_save_mode='browser')
        run.prefix='SR-test-browser-';run.background=[]
        created=[];deleted=[];bound=[];commands=[]
        async def command(fields):commands.append(fields)
        async def hold(_):pass
        async def image_load(_):pass
        async def add(suffix,url,logo,prepare_logo=True):
            sid=100+len(created);created.append((sid,url,prepare_logo));return sid
        async def request(path,fields=None,**kwargs):
            if path.startswith('/api/logo/upload?'):return b'{"path":"/logos/own.png"}'
            if path=='/api/station/delete':deleted.append(fields['id'])
            if path=='/api/station/save':bound.append(fields)
            return b'{}'
        run.command=command;run.hold=hold;run.image_load=image_load
        run.add_station=add;run.request=request;run.set_phase=lambda _:None
        run.emit=lambda *_,**__:None
        await run.cold_logos([dict(id=2,url='http://station/live.flac')])
        await asyncio.gather(*run.background)
        self.assertEqual(commands,[{'station':100,'play':True}])
        self.assertTrue(all(url=='http://192.0.2.1:19840/reference.ogg' for _,url,_ in created))
        self.assertTrue(created[0][2])
        self.assertTrue(all(not prepare for _,_,prepare in created[1:]))
        self.assertEqual(deleted,[sid for sid,_,_ in created[1:]])
        self.assertTrue(all(fields['prepareLogo']==1 and fields['logo']=='/logos/own.png' for fields in bound))

    async def test_switch_measurement_uses_distinct_owned_streams_without_new_images(self):
        run=object.__new__(Run)
        run.args=SimpleNamespace(fixture_url='http://192.0.2.1:19840',reference_file=Path('reference.ogg'))
        run.prefix='SR-test-switch-';run.background=[];run.state={'stationId':101}
        created=[];commands=[];waited=[]
        async def add(suffix,url,logo=''):
            sid=100+len(created);created.append((sid,url,logo));return sid
        async def command(fields,wait=True):commands.append((fields,wait))
        async def hold(_):pass
        async def image_load(_):pass
        async def wait_state(predicate):waited.append(predicate())
        run.add_station=add;run.command=command;run.hold=hold;run.image_load=image_load
        run.wait_state=wait_state;run.set_phase=lambda _:None;run.emit=lambda *_,**__:None
        with patch('stress_radio.asyncio.sleep',new=hold):
            await run.controlled_switches([dict(id=2,url='http://station/live.flac')])
        await asyncio.gather(*run.background)
        self.assertEqual(len(created),2)
        self.assertNotEqual(created[0][1],created[1][1])
        self.assertTrue(all('run=SR-test-switch-' in url and not logo for _,url,logo in created))
        self.assertEqual([c['station'] for c,_ in commands[1:]],[100,101]*9)
        self.assertTrue(all(not wait for _,wait in commands[1:]))
        self.assertEqual(waited,[True]*3)

    async def test_cold_run_bounds_mutations_and_never_reuses_a_logo_url(self):
        run=object.__new__(Run)
        run.args=SimpleNamespace(fixture_url='http://192.0.2.1:19840')
        run.prefix='SR-test-isolated-';run.background=[]
        created=[];deleted=[];commands=[];images=[]
        async def command(fields):commands.append(fields)
        async def hold(_):pass
        async def image_load(ids):images.extend(ids)
        async def add(suffix,url,logo,prepare_logo=True):
            sid=100+len(created);created.append((sid,url,logo));return sid
        async def request(path,fields=None,**kwargs):
            if path.startswith('/api/logo/upload?'):return b'{"path":"/logos/own.png"}'
            if path=='/api/station/delete':deleted.append(fields['id'])
            return b'{}'
        run.command=command;run.hold=hold;run.image_load=image_load
        run.add_station=add;run.request=request;run.set_phase=lambda _:None
        await run.cold_logos([dict(id=2,url='http://station/live.flac'),dict(id=8,url='http://station/live.mp3')])
        await asyncio.gather(*run.background)
        self.assertEqual(len(created),6)
        self.assertEqual(len({logo for _,_,logo in created}),6)
        self.assertTrue(all('run=SR-test-isolated-' in logo for _,_,logo in created))
        self.assertEqual(deleted,[sid for sid,_,_ in created])
        self.assertEqual(images,[2,8])
        self.assertEqual(commands,[{'station':2,'play':True}])

class ProbePatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original=(ROOT/'.pio/libdeps/esp32-s3-devkitc1-n16r8/ESP32-audioI2S/src/Audio.cpp').read_text(encoding='utf-8')

    def test_patch_is_idempotent_and_preserves_writes(self):
        source=self.original;p=patch_runtime_probe.patch_source(source)
        self.assertEqual(patch_runtime_probe.patch_source(p),p)
        old=[l for l in source.splitlines() if 'i2s_channel_write(' in l]
        self.assertEqual(old,[l for l in p.splitlines() if 'i2s_channel_write(' in l])
        self.assertIn('RuntimeProbe::written',p)

    def test_unreviewed_or_partial_source_fails_closed(self):
        p=patch_runtime_probe.patch_source(self.original)
        with self.assertRaises(RuntimeError):patch_runtime_probe.patch_source(p.replace('    }\n\n    // ---- statistics','    // ---- statistics',1))
        with self.assertRaises(RuntimeError):patch_runtime_probe.patch_source(self.original.replace('m_validSamples -=','m_validSamples +=',1))

    def test_pinned_dma_capacity_and_feature_default(self):
        header=(ROOT/'.pio/libdeps/esp32-s3-devkitc1-n16r8/ESP32-audioI2S/src/Audio.h').read_text(encoding='utf-8')
        self.assertIn('DMA_DESC_NUM = 32;',header);self.assertIn('DMA_FRAME_NUM = 256;',header)
        self.assertIn('#define SIMPLE_RADIO_RUNTIME_DIAGNOSTICS 0',(ROOT/'src/diagnostics/runtime_probe.h').read_text())

class HttpTests(unittest.TestCase):
    def test_ogg_reference_uses_stream_headers_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            reference=Path(directory)/'reference.ogg'
            data=b'OggS'+bytes(range(256))*90
            reference.write_bytes(data)
            handler=object.__new__(FixtureHandler)
            handler.path='/reference.ogg';handler.wfile=io.BytesIO()
            handler.server=SimpleNamespace(reference_file=reference,stopping=threading.Event())
            headers={};codes=[]
            handler.send_response=codes.append
            handler.send_header=lambda key,value:headers.__setitem__(key,value)
            handler.end_headers=lambda:None
            handler.do_GET()
            self.assertEqual(codes,[200])
            self.assertEqual(headers['Content-Type'],'audio/ogg')
            self.assertNotIn('Content-Length',headers)
            self.assertTrue(handler.close_connection)
            self.assertEqual(handler.wfile.getvalue(),data)

    def test_network_reader_detects_truncated_body(self):
        class Response:
            code=200;headers={'Content-Length':'20','Content-Type':'image/png'}
            def __init__(self):self.remaining=b'bad'
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self,count=-1):
                body=self.remaining if count<0 else self.remaining[:count]
                self.remaining=self.remaining[len(body):];return body
        with tempfile.TemporaryDirectory() as d:
            args=SimpleNamespace(base='http://127.0.0.1',out=Path(d)/'run',seed=1,exercise=False)
            run=Run(args);run.http=SimpleNamespace(open=lambda *_args,**_kwargs:Response())
            try:
                with self.assertRaisesRegex(ValueError,'Truncated HTTP body'):run.raw('/')
                with self.assertRaises(ValueError):asyncio.run(run.request('/api/config/save',{'brightness':5}))
            finally:run.log.close()

if __name__=='__main__':unittest.main()
