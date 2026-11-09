import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'tools'))
from stress_report import AudioAudit, summarize, percentile, write_report, feed_balances
from stress_radio import Run, owned_stations, station_digest, validate_image
from stress_fixture import PCM, RATE, png
import patch_runtime_probe

def sample(**audio):
    return dict(uptimeMs=5000, stable=True, heapFree=30000, heapLargest=15000, psramFree=6000000,
                audio=dict(epoch=2,active=True,sentFrames=1000,feedDeadlineMisses=0,writeErrors=0,**audio))

class ReportTests(unittest.TestCase):
    def test_absent_audio_measurements_are_inconclusive(self):
        self.assertEqual(summarize([])['result'],'INCONCLUSIVE_AUDIO')

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
    def test_network_reader_detects_truncated_body(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_): pass
            def do_GET(self):
                self.send_response(200);self.send_header('Content-Length','20');self.end_headers();self.wfile.write(b'bad');self.close_connection=True
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory() as d:
                args=SimpleNamespace(base=f'http://127.0.0.1:{server.server_port}',out=Path(d)/'run',seed=1,exercise=False)
                run=Run(args)
                try:
                    with self.assertRaises(Exception):run.raw('/')
                    with self.assertRaises(ValueError):asyncio.run(run.request('/api/config/save',{'brightness':5}))
                finally:run.log.close()
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
