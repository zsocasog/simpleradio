"""Repeatable, bounded API-level extreme-user test for one SimpleRadio.

Without --exercise: read-only monitoring. --exercise requires --mute or explicit --test-volume 1 and
creates a recovery journal BEFORE mutations. Never updates firmware/data.
Requires websockets (pip install websockets). Outputs stay under .pio by default.
"""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import random
import socket
import shutil
import struct
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, ProxyHandler, build_opener

from stress_fixture import FixtureServer, png, upload_png
from stress_report import AudioAudit, write_report

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FIELDS = ('brightness', 'displayInvert', 'displayArtworkMode', 'displayFooterMode', 'themeAccent')
STATE_FIELDS = ('stationId', 'playing', 'volume', 'eqLow', 'eqMid', 'eqHigh', 'balance')

def validate_image(body, content_type):
    if body.startswith(b'BM'):
        if len(body) < 66 or struct.unpack_from('<I', body, 2)[0] != len(body):
            raise ValueError('Incomplete BMP image')
        width, height = struct.unpack_from('<ii', body, 18)
        bpp = struct.unpack_from('<H', body, 28)[0]
        offset = struct.unpack_from('<I', body, 10)[0]
        if width <= 0 or not height or bpp != 16 or offset + ((width * 2 + 3) & ~3) * abs(height) != len(body):
            raise ValueError('Invalid BMP pixel extent')
    elif not (body.startswith(b'\xff\xd8') and body.endswith(b'\xff\xd9') or
              body.startswith(b'\x89PNG\r\n\x1a\n') and body[-8:-4] == b'IEND'):
        raise ValueError('Unexpected/incomplete image response: ' + content_type)

class Run:
    def __init__(self, args):
        self.args = args; self.base = args.base.rstrip('/')
        if urlsplit(self.base).scheme not in ('http', 'https') or urlsplit(self.base).username:
            raise ValueError('Use a device HTTP(S) URL without embedded credentials')
        self.directory = args.out.resolve(); self.directory.mkdir(parents=True, exist_ok=False)
        self.log = (self.directory / 'events.jsonl').open('w', encoding='utf-8', buffering=1)
        self.events = []; self.phase = 'preflight'; self.start = time.monotonic()
        self.state = {}; self.state_number = 0; self.last_control = self.start
        self.stop_load = False; self.background = []; self.ws = None; self.reader = None
        self.audit = AudioAudit(expect_continuous=getattr(args,'expect_continuous',False)); self.telemetry = None; self.sample_lock = asyncio.Lock()
        self.prefix = 'SR-test-' + self.directory.name + '-'; self.temp_ids = []
        self.backup = None; self.fixture = None; self.recovering = False
        self.serial_capture = None
        self.inflight = set()
        # HTTP/1.1 browsers normally use six connections per origin. Keep the
        # deliberate >6 overload available, but do not confuse local executor
        # queue time with time spent receiving a response from the device.
        self.http_slots = asyncio.Semaphore(getattr(args,'http_parallel',6))
        self.http = build_opener(ProxyHandler({})); self.rng = random.Random(args.seed)
        sources=self.directory/'runner-source';sources.mkdir()
        hashes={}
        for name in ('stress_radio.py','stress_report.py','stress_fixture.py','stress_serial.py'):
            path=Path(__file__).resolve().parent/name
            shutil.copyfile(path,sources/name);hashes[name]=hashlib.sha256(path.read_bytes()).hexdigest()
        self.emit('manifest', seed=args.seed, base=self.base, exercise=args.exercise,
                  profile=getattr(args,'profile','extreme'),scale=getattr(args,'scale',1),runnerHashes=hashes,
                  imageParallel=getattr(args,'image_parallel',3),
                  httpParallel=getattr(args,'http_parallel',6),
                  forceLcdImages=getattr(args,'force_lcd_images',False),
                  logoSaveMode=getattr(args,'logo_save_mode','overlap'),
                  testVolume=getattr(args,'test_volume',0),
                  durableCommands=getattr(args,'durable_commands',False),
                  staticReadLoad=getattr(args,'static_read_load',False),
                  expectContinuous=getattr(args,'expect_continuous',False),
                  soakSeconds=getattr(args,'soak_seconds',None) if getattr(args,'profile','')=='soak' else None,
                  referenceSha256=hashlib.sha256(args.reference_file.read_bytes()).hexdigest() if getattr(args,'reference_file',None) else None,
                  sourceVersion=read_version(), note='No acoustic or browser-DOM certification')

    def emit(self, kind, **fields):
        event = dict(kind=kind, t=round(time.monotonic() - self.start, 3), phase=self.phase, **fields)
        self.events.append(event); self.log.write(json.dumps(event, ensure_ascii=False) + '\n')

    def raw(self, path, fields=None, body=None, timeout=8):
        data = urlencode({k: int(v) if isinstance(v, bool) else v for k,v in fields.items()}).encode() if fields is not None else body
        headers = {'Connection': 'close', 'Cache-Control': 'no-cache'}
        if data is not None: headers['Content-Type'] = 'application/x-www-form-urlencoded' if fields is not None else 'image/png'
        started = time.monotonic()
        try: response = self.http.open(Request(self.base + path, data=data, headers=headers), timeout=timeout)
        except HTTPError as error: response = error
        with response:
            first = response.read(1); ttfb = (time.monotonic() - started) * 1000
            payload = first + response.read()
            expected = response.headers.get('Content-Length')
            if expected is not None and len(payload) != int(expected): raise ValueError('Truncated HTTP body')
            return response.code, payload, response.headers.get('Content-Type', ''), ttfb

    async def request(self, path, fields=None, body=None, expected=(200,), operation=None, image=False, timeout=8):
        if fields is not None or body is not None:
            if not self.args.exercise: raise ValueError('Read-only mode refuses writes')
        started = time.monotonic(); phase = self.phase
        op = operation or path.split('?')[0]
        try:
            async def bounded_raw():
                async with self.http_slots:
                    admitted=time.monotonic()
                    result=await asyncio.to_thread(self.raw,path,fields,body,timeout)
                    return result,(admitted-started)*1000,(time.monotonic()-admitted)*1000
            pending=asyncio.create_task(bounded_raw())
            self.inflight.add(pending);pending.add_done_callback(self.inflight.discard)
            (code,payload,content_type,ttfb),queue_ms,network_ms=await asyncio.shield(pending)
            ok = code in expected
            if ok and code == 200 and image: validate_image(payload, content_type)
            self.emit('http', operation=op, requestPhase=phase, status=code, ok=ok,
                      ms=round((time.monotonic() - started) * 1000, 1), ttfbMs=round(ttfb, 1),
                      clientQueueMs=round(queue_ms,1),networkMs=round(network_ms,1),bytes=len(payload))
            if not ok:
                # Device API failures are plain messages, not configuration
                # payloads. Keep a bounded reason so a 503 is diagnosable.
                reason = payload.decode('utf-8', errors='replace')[:160] if content_type.startswith('text/plain') else ''
                raise RuntimeError(f'{op}: HTTP {code}' + (': ' + reason if reason else ''))
            return payload
        except Exception as error:
            self.emit('failure', operation=op, detail=type(error).__name__ + ': ' + str(error))
            raise

    async def get(self, path, **kwargs): return json.loads(await self.request(path, **kwargs))

    async def websocket_reader(self):
        async for raw in self.ws:
            state = json.loads(raw)
            if 'stationId' in state:
                self.state = state; self.state_number += 1
                self.emit('state', **{k: state[k] for k in STATE_FIELDS if k in state},
                          codec=state.get('codec'), connection=state.get('streamConnectionState'),
                          album=bool(state.get('albumArtworkPath')))

    async def connect_ws(self):
        from websockets.asyncio.client import connect
        url = ('wss' if self.base.startswith('https:') else 'ws') + self.base[self.base.index(':'):] + '/ws'
        self.ws = await connect(url, proxy=None, compression=None, open_timeout=8, close_timeout=2, max_size=256 * 1024)
        self.state = {}
        self.reader = asyncio.create_task(self.websocket_reader())
        await self.wait_state(lambda: bool(self.state), 8)

    async def wait_state(self, predicate, seconds=12):
        end = time.monotonic() + seconds
        while not predicate():
            if self.reader and self.reader.done(): self.reader.result(); raise ConnectionError('WebSocket reader stopped')
            if time.monotonic() >= end: raise TimeoutError('Player command/state not confirmed')
            await asyncio.sleep(.04)

    async def command(self, fields, wait=True):
        if not self.args.exercise: raise ValueError('Read-only mode refuses player commands')
        started = time.monotonic()
        if 'station' in fields or 'play' in fields: self.last_control = started
        before = self.state_number
        await self.ws.send(json.dumps({'persist':getattr(self.args,'durable_commands',False), **fields}))
        expected = {('stationId' if k == 'station' else 'playing' if k == 'play' else k): v
                    for k, v in fields.items() if k not in ('persist','commit')}
        if wait:
            # No-op commands need not broadcast a new state.
            await self.wait_state(lambda: all(self.state.get(k) == v for k, v in expected.items()))
        self.emit('command', fields=fields, acknowledged=wait, oldRevision=before,
                  ms=round((time.monotonic() - started) * 1000, 1))

    async def sample(self):
        async with self.sample_lock:
            status = await self.get('/api/system/status')
            system = status['system']
            if self.args.expect_build and system['buildId'] != self.args.expect_build:
                raise RuntimeError('Firmware build changed during test')
            if self.telemetry is None:
                body = await self.request('/api/diagnostics', expected=(200, 404))
                try: self.telemetry = json.loads(body).get('schema') == 1
                except (ValueError, AttributeError): self.telemetry = False
                self.emit('coverage', audioTelemetry=self.telemetry)
            diag = await self.get('/api/diagnostics') if self.telemetry else {}
            stable = bool(self.state.get('playing') and
                          status['status'].get('streamConnectionState') == 'connected' and
                          time.monotonic() - self.last_control >= 5)
            sample = dict(uptimeMs=system['uptimeMs'], heapFree=system['heapFree'],
                          heapLargest=system['heapLargest'], psramFree=system['psramFree'],
                          buildId=system['buildId'], stable=stable, audio=diag.get('audio'),
                           performance=diag.get('performance'),
                          httpTaskPriority=diag.get('httpTaskPriority'),httpTaskCore=diag.get('httpTaskCore'),
                          lcdThumbnailRam=diag.get('lcdThumbnailRam'),
                          stationImageQueue=diag.get('stationImageQueue'),
                          httpTx=diag.get('httpTx'),
                          dmaHeap=diag.get('dmaHeap'),httpTaskStackFreeMin=diag.get('httpTaskStackFreeMin'),
                          httpTxTiming=diag.get('httpTxTiming'),
                          stationSaveRuntime=diag.get('stationSaveRuntime'),
                          stationSaveStackFreeMin=diag.get('stationSaveStackFreeMin'),
                          feedEvents=diag.get('feedEvents'),zeroEvents=diag.get('zeroEvents'),logoUploads=diag.get('logoUploads'),
                          spectrumLoad=diag.get('spectrumLoad'),
                          allocationFailures=diag.get('allocationFailures'),
                          previousAllocationFailures=diag.get('previousAllocationFailures'),
                          codec=self.state.get('codec',''),
                          stationId=self.state.get('stationId'),
                          artwork=status.get('artwork', {}), savePending=system.get('settingsSavePending'),
                          artworkNetworkActive=system.get('artworkNetworkActive'),
                          wifiRssi=status.get('wifi', {}).get('rssi'))
            self.emit('sample', **sample)
            if sample.get('httpTaskStackFreeMin') is not None and sample['httpTaskStackFreeMin'] < 2048:
                self.emit('failure',operation='http-stack-headroom',detail='HTTP task stack reserve below 2 KiB')
                raise RuntimeError('HTTP task stack headroom too low')
            for finding in self.audit.observe(dict(phase=self.phase,**sample)): self.emit(**finding)
            if self.args.exercise and not self.recovering and status['status']['volume'] != getattr(self.args,'test_volume',0):
                raise RuntimeError('Volume changed externally; aborting controlled-volume test')
            if self.audit.previous and any(e['kind'] == 'reboot' for e in self.events):
                raise RuntimeError('Unexpected reset; stop load and restore')
            return sample

    async def monitor(self):
        while not self.stop_load:
            try: await self.sample()
            except Exception:
                self.stop_load = True; raise
            await asyncio.sleep(1)

    async def image_load(self, station_ids):
        cycle = 0
        while not self.stop_load:
            suffix = '&lcd=1' if getattr(self.args,'force_lcd_images',False) else ''
            jobs = [self.request(f'/api/artwork/station?id={sid}'+suffix, expected=(200, 404),
                                 operation='station-image', image=True) for sid in self.rng.sample(station_ids, min(getattr(self.args,'image_parallel',3), len(station_ids)))]
            if cycle % 4 == 0:
                jobs += [self.request('/api/stations'), self.request('/api/logos')]
            cover = self.state.get('albumArtworkPath', '')
            if cover.startswith('/api/artwork/album?'): jobs.append(self.request(cover, expected=(200, 404), operation='album-image', image=True))
            await asyncio.gather(*jobs)
            cycle += 1; await asyncio.sleep(1.5)

    async def static_file_load(self):
        while not self.stop_load:
            await asyncio.gather(*(self.request(path,operation='static-read')
                                   for path in ('/config.json','/state.json','/ui.css')))
            await asyncio.sleep(.1)

    async def hold(self, seconds):
        deadline = time.monotonic() + seconds * self.args.scale
        while time.monotonic() < deadline:
            for task in self.background:
                if task.done(): task.result()
            await asyncio.sleep(min(.25, max(0, deadline - time.monotonic())))

    def set_phase(self, name):
        self.phase = name
        self.emit('phase', expectsAudio=name in ('FLAC-baseline','images-and-web','settings-during-playback',
                  'new-station-and-logo','rapid-switches','controlled-WAV','MP3-mixed-use','stop-start-recovery') or name.startswith(('isolation-', 'save-benchmark-', 'save-preemption-', 'cold-logo-', 'switch-', 'upload-', 'soak-')))
        print(name, flush=True)

    async def save_config(self, fields):
        response = json.loads(await self.request('/api/config/save', fields, operation='settings-save', timeout=20))
        if any(response.get(k) != v for k, v in fields.items()): raise ValueError('Save response differs from requested settings')
        persisted = await self.get('/config.json', operation='settings-persistence')
        if any(persisted.get(k) != v for k, v in fields.items()): raise ValueError('Settings acknowledged but not persisted')
        self.emit('persisted', fields=fields)

    async def add_station(self, suffix, url, logo='', prepare_logo=True):
        name = self.prefix + suffix
        self.emit('station-intent', name=name)  # recoverable even if reply is lost
        reply = json.loads(await self.request('/api/station/save', dict(name=name, url=url, logo=logo, prepareLogo=int(prepare_logo)), operation='station-save', timeout=20))
        sid = reply['id']; self.temp_ids.append(sid)
        self.emit('station-created', id=sid, name=name)
        return sid

    async def restore(self):
        if not self.backup: return
        self.recovering = True; self.set_phase('restore')
        # A timed-out load can have ended in a reboot after the last sample.
        # Use a fresh control connection; never trust a stale socket/state.
        if self.reader: self.reader.cancel(); await asyncio.gather(self.reader, return_exceptions=True)
        if self.ws: await self.ws.close()
        await self.connect_ws()
        await self.command({'play': False, 'volume': 0})
        original = self.backup['state']; await self.command({'station': original['stationId'], 'play': False})
        stations = (await self.get('/api/stations'))['stations']
        for station in owned_stations(stations, self.prefix, self.backup['stationIds']):
            await self.request('/api/station/delete', {'id': station['id']}, operation='cleanup-station')
        await self.save_config(self.backup['config'])
        await self.command({k: v for k, v in original.items() if k in ('eqLow','eqMid','eqHigh','balance')})
        await self.command({'station': original['stationId'], 'volume': original['volume'], 'play': original['playing'],
                            'persist':True,'commit':True})
        await self.verify_durable_controls(original)
        after = (await self.get('/api/stations'))['stations']
        if station_digest(after) != self.backup['stationDigest']: raise ValueError('Original station list was not preserved')
        self.emit('restored', stationListIdentical=True, settingsVerified=True, playerVerified=True)

    async def verify_durable_controls(self, fields):
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            body=await self.request('/state.json',expected=(200,404),timeout=4,operation='state-persistence')
            try: saved=json.loads(body)
            except (ValueError,UnicodeError): saved={}
            if all(saved.get(k)==v for k,v in fields.items() if k in STATE_FIELDS):
                self.emit('state-persisted',fields={k:v for k,v in fields.items() if k in STATE_FIELDS})
                return
            await asyncio.sleep(.25)
        raise ValueError('Acknowledged controls were not durably persisted')

    async def online_search(self):
        # This is a browser-side service in SimpleRadio. Never invent an ESP
        # search endpoint or attribute this network time to the ESP firmware.
        url = 'https://de1.api.radio-browser.info/json/stations/search?' + urlencode(dict(name='radio', countrycode='HU', limit=8, hidebroken='true'))
        def get():
            with self.http.open(url, timeout=8) as response: return json.load(response)
        started = time.monotonic()
        try:
            rows = await asyncio.to_thread(get)
            self.emit('external-search', count=len(rows), ms=round((time.monotonic()-started)*1000, 1), origin='host-not-ESP')
        except Exception as error: self.emit('external-service', detail=type(error).__name__, origin='host-not-ESP')

    async def exercise(self):
        await self.connect_ws()
        config = await self.get('/api/config'); stations = (await self.get('/api/stations'))['stations']
        if not stations: raise ValueError('At least one saved station is required')
        self.backup = dict(state={k:self.state[k] for k in STATE_FIELDS},
                           config={k:config[k] for k in CONFIG_FIELDS},
                           stationIds=[s['id'] for s in stations], stationDigest=station_digest(stations),
                           prefix=self.prefix, base=self.base)
        (self.directory / 'recovery.json').write_text(json.dumps(self.backup, indent=2), encoding='utf-8')
        await self.command({'volume':getattr(self.args,'test_volume',0)})
        if getattr(self.args,'test_volume',0) == 1 and config.get('displayFooterMode') != 'spectrum':
            await self.save_config({'displayFooterMode':'spectrum'})
        self.background = [asyncio.create_task(self.monitor())]
        if self.args.profile == 'saves':
            await self.save_benchmark(stations, config)
            return
        if self.args.profile == 'save-preemption':
            await self.save_preemption(stations,config)
            return
        if self.args.profile == 'isolation':
            await self.isolation(stations, config)
            return
        if self.args.profile == 'cold-logos':
            await self.cold_logos(stations)
            return
        if self.args.profile == 'switches':
            await self.controlled_switches(stations)
            return
        if self.args.profile == 'uploads':
            await self.controlled_uploads(stations)
            return
        if self.args.profile == 'soak':
            await self.soak(stations,config)
            return
        if self.args.profile == 'disconnects':
            await self.controlled_disconnects(stations)
            return
        self.set_phase('idle-baseline'); await self.command({'play':False}); await self.hold(12)
        flac = next((s for s in stations if 'flac' in s['url'].lower() or 'flac' in s['name'].lower()), stations[0])
        mp3 = next((s for s in stations if 'danubius' in s['name'].lower()),
                   next((s for s in stations if '.mp3' in s['url'].lower()),
                        next((s for s in stations if s['id'] != flac['id']), stations[0])))
        self.set_phase('FLAC-baseline'); await self.command({'station':flac['id'],'play':True}); await self.hold(45)
        self.set_phase('images-and-web'); self.background.append(asyncio.create_task(self.image_load([s['id'] for s in stations])))
        for asset in ('/', '/app.js', '/ui.js', '/ui.css', '/icons.svg'):
            await self.request(asset, expected=(200,404), operation='web-assets')
        await self.hold(40)
        self.set_phase('settings-during-playback')
        for i in range(3):
            await self.save_config({'brightness': max(1, config['brightness'] - 1 - i)})
            await self.command({'eqLow':i-1,'eqHigh':1-i,'balance':i*5})
            await self.hold(8)
        self.set_phase('new-station-and-logo')
        # A new station must exercise a genuinely cold image, not reuse the
        # previous test's identical fixture URL and prepared LCD thumbnail.
        fixture_logo = self.args.fixture_url + '/logo-slow.png?' + urlencode({'run':self.prefix}) if self.args.fixture_url else ''
        sid = await self.add_station('clone', mp3['url'], fixture_logo,
            prepare_logo=getattr(self.args,'logo_save_mode','overlap')!='browser')
        body = png(); reply = json.loads(await self.request(f'/api/logo/upload?id={sid}', body=body, operation='logo-upload'))
        path = reply['path']
        await self.request('/api/station/save', dict(id=sid, name=self.prefix+'clone', url=mp3['url'],logo=path,prepareLogo=1), operation='station-logo-binding')
        await self.command({'station':sid,'play':True}); await self.hold(40)
        await self.request('/api/station/move', dict(id=sid,direction=-1), operation='station-reorder')
        self.set_phase('rapid-switches')
        choices = [flac['id'],mp3['id'],sid,flac['id'],sid,mp3['id']]
        for choice in choices:
            await self.command({'station':choice,'play':True}, wait=False); await asyncio.sleep(.18)
        await self.wait_state(lambda:self.state.get('stationId')==mp3['id']); await self.hold(35)
        if self.args.fixture_url:
            self.set_phase('controlled-WAV')
            local = await self.add_station('reference', self.args.fixture_url + '/tone.wav', self.args.fixture_url + '/logo.png')
            await self.command({'station':local,'play':True}); await self.hold(45)
        self.set_phase('MP3-mixed-use'); await self.command({'station':mp3['id'],'play':True})
        await self.online_search()
        for i in range(3):
            await self.save_config({'displayInvert':bool(i%2), 'displayFooterMode':'spectrum' if i!=1 else 'vu'})
            await self.command({'eqLow':0,'eqHigh':0,'balance':0}); await self.hold(12)
        self.set_phase('stop-start-recovery'); await self.command({'play':False}); await self.hold(5)
        await self.command({'play':True}); await self.hold(30)

    async def cold_logos(self, stations):
        if not self.args.fixture_url:
            raise ValueError('cold-logos requires the LAN fixture')
        flac = next((s for s in stations if 'flac' in s['url'].lower()), stations[0])
        if getattr(self.args,'reference_file',None):
            route=self.args.fixture_url+'/reference'+self.args.reference_file.suffix.lower()
            sid=await self.add_station('cold-reference',route,self.args.fixture_url+'/logo.png')
            flac=dict(id=sid,url=route)
            self.emit('controlled-source',format=self.args.reference_file.suffix[1:].upper())
        self.set_phase('cold-logo-baseline')
        await self.command({'station':flac['id'],'play':True}); await self.hold(20)
        self.background.append(asyncio.create_task(self.image_load([s['id'] for s in stations])))
        for i in range(6):
            self.set_phase(f'cold-logo-{i+1}')
            logo=self.args.fixture_url+'/logo-slow.png?'+urlencode({'run':self.prefix,'iteration':i})
            sid=await self.add_station(f'cold-{i}',flac['url'],logo,
                prepare_logo=getattr(self.args,'logo_save_mode','overlap')!='browser')
            reply=json.loads(await self.request(f'/api/logo/upload?id={sid}',body=png(),operation='logo-upload'))
            await self.request('/api/station/save',dict(id=sid,name=self.prefix+f'cold-{i}',
                url=flac['url'],logo=reply['path'],prepareLogo=1),operation='station-logo-binding')
            await self.hold(5)
            await self.request('/api/station/delete',{'id':sid},operation='cleanup-station')
        self.set_phase('cold-logo-recovery'); await self.hold(12)

    async def soak(self, stations, config):
        if not self.args.fixture_url or not self.args.reference_file:
            raise ValueError('soak requires a controlled reference and the LAN fixture')
        route=self.args.fixture_url+'/reference'+self.args.reference_file.suffix.lower()
        ids=[]
        for variant in ('a','b'):
            ids.append(await self.add_station('soak-'+variant,route+'?'+urlencode({'run':self.prefix,'variant':variant})))
        radio=next((s for s in stations if 'danubius' in s['name'].lower()),stations[0])
        self.background.append(asyncio.create_task(self.image_load([s['id'] for s in stations])))
        if getattr(self.args,'static_read_load',False):
            self.background.append(asyncio.create_task(self.static_file_load()))
        deadline=time.monotonic()+self.args.soak_seconds*self.args.scale; cycle=0
        while time.monotonic()<deadline:
            started=time.monotonic(); sid=ids[cycle%2]
            self.set_phase(f'soak-local-{cycle+1}')
            await self.command({'station':sid,'play':True}); await self.hold(12)
            reply=json.loads(await self.request(f'/api/logo/upload?id={sid}',body=png(),operation='logo-upload',timeout=25))
            await self.request('/api/station/save',dict(id=sid,name=self.prefix+'soak-'+('a' if cycle%2==0 else 'b'),
                url=route+'?'+urlencode({'run':self.prefix,'variant':'a' if cycle%2==0 else 'b'}),
                logo=reply['path'],prepareLogo=1),operation='station-logo-binding')
            await self.save_config({'brightness':(config['brightness']+(1 if cycle%2==0 else 2))%255+1})
            if cycle%3==2:
                self.set_phase(f'soak-radio-{cycle+1}')
                await self.command({'station':radio['id'],'play':True}); await self.hold(35)
                self.set_phase(f'soak-return-{cycle+1}')
                await self.command({'station':sid,'play':True})
            remaining=min(deadline-time.monotonic(),120*self.args.scale-(time.monotonic()-started))
            if remaining>0:await self.hold(remaining/self.args.scale)
            cycle+=1
        self.emit('soak-complete',cycles=cycle,seconds=self.args.soak_seconds*self.args.scale)

    async def controlled_disconnects(self, stations):
        if not self.args.fixture_url or not self.args.reference_file:
            raise ValueError('disconnects requires a controlled reference and the LAN fixture')
        route=self.args.fixture_url+'/reference'+self.args.reference_file.suffix.lower()
        sid=await self.add_station('disconnect-reference',route)
        self.set_phase('isolation-disconnects')
        await self.command({'station':sid,'play':True}); await self.hold(10)
        async def abandon(station):
            def partial():
                with self.http.open(Request(self.base+f'/api/artwork/station?id={station}'),timeout=8) as response:
                    return response.read(64)
            task=asyncio.create_task(asyncio.to_thread(partial))
            self.inflight.add(task);task.add_done_callback(self.inflight.discard)
            data=await asyncio.shield(task)
            self.emit('intentional-image-disconnect',bytes=len(data))
        for cycle in range(10):
            chosen=self.rng.sample(stations,min(6,len(stations)))
            await asyncio.gather(*(abandon(s['id']) if i%2==0 else self.request(
                f'/api/artwork/station?id={s["id"]}',image=True,operation='complete-image') for i,s in enumerate(chosen)))
            await self.hold(1)
        await self.hold(5)
        diag=await self.get('/api/diagnostics')
        queue=diag.get('stationImageQueue')
        if queue and (queue.get('pending') or queue.get('active')):
            raise RuntimeError('Image admissions retained after clients completed or disconnected')
        self.emit('image-admissions-drained',queue=queue)

    async def controlled_uploads(self, stations):
        if not self.args.fixture_url or not self.args.reference_file:
            raise ValueError('uploads requires a controlled reference and the LAN fixture')
        route=self.args.fixture_url+'/reference'+self.args.reference_file.suffix.lower()
        sid=await self.add_station('upload-reference',route)
        await self.command({'station':sid,'play':True})
        self.set_phase('upload-baseline'); await self.hold(20)
        self.background.append(asyncio.create_task(self.image_load([s['id'] for s in stations])))
        for i,image in enumerate((upload_png(),png(),upload_png(True),upload_png(True))):
            self.set_phase(f'upload-{i+1}-{len(image)}B')
            # Retain the actual duration; a longer observation window must not
            # conceal an upload which exceeds the ordinary 8-second client.
            started=time.monotonic()
            reply=json.loads(await self.request(f'/api/logo/upload?id={sid}',body=image,
                                               operation='logo-upload',timeout=25))
            elapsed=time.monotonic()-started
            if elapsed>8:self.emit('slow-upload',seconds=round(elapsed,3),ordinaryTimeoutSeconds=8)
            await self.request('/api/station/save',dict(id=sid,name=self.prefix+'upload-reference',url=route,
                logo=reply['path'],prepareLogo=1),operation='station-logo-binding')
            await self.hold(12)
        self.set_phase('upload-recovery'); await self.hold(12)

    async def controlled_switches(self, stations):
        if not self.args.fixture_url or not self.args.reference_file:
            raise ValueError('switches requires a controlled reference and the LAN fixture')
        route=self.args.fixture_url+'/reference'+self.args.reference_file.suffix.lower()
        # Different stream identities exercise a real reconnect, even though
        # both deliver the same bytes. No new image/album job in this profile.
        ids=[]
        for variant in ('a','b'):
            url=route+'?'+urlencode({'run':self.prefix,'variant':variant})
            ids.append(await self.add_station('switch-'+variant,url))
        self.emit('controlled-source',format=self.args.reference_file.suffix[1:].upper())
        self.set_phase('switch-baseline')
        await self.command({'station':ids[0],'play':True});await self.hold(20)
        self.background.append(asyncio.create_task(self.image_load([s['id'] for s in stations])))
        for round in range(3):
            self.set_phase(f'switch-rapid-{round+1}')
            for sid in ids*3:
                await self.command({'station':sid,'play':True},wait=False)
                await asyncio.sleep(.18)
            await self.wait_state(lambda:self.state.get('stationId')==ids[-1])
            await self.hold(20)
        self.set_phase('switch-recovery');await self.hold(15)

    async def isolation(self, stations, config):
        flac = next((s for s in stations if 'flac' in s['url'].lower() or 'flac' in s['name'].lower()),stations[0])
        if self.args.fixture_url:
            suffix=self.args.reference_file.suffix.lower() if self.args.reference_file else '.wav'
            route='/reference'+suffix if self.args.reference_file else '/tone.wav'
            sid=await self.add_station('isolated-reference',self.args.fixture_url+route,self.args.fixture_url+'/logo.png')
            self.emit('controlled-source',format=suffix[1:].upper())
        else:
            sid=flac['id']
        await self.command({'station':sid,'play':True})
        self.set_phase('isolation-baseline'); await self.hold(35)
        self.set_phase('isolation-images')
        images=asyncio.create_task(self.image_load([s['id'] for s in stations]));self.background.append(images)
        await self.hold(40)
        images.cancel();await asyncio.gather(images,return_exceptions=True);self.background.remove(images)
        self.set_phase('isolation-recovery');await self.hold(20)
        self.set_phase('isolation-saves')
        for i in range(3):
            await self.save_config({'brightness':max(1,config['brightness']-1-i)});await self.hold(8)
        self.set_phase('isolation-mixed')
        images=asyncio.create_task(self.image_load([s['id'] for s in stations]));self.background.append(images)
        for i in range(3):
            await self.save_config({'brightness':max(1,config['brightness']-4-i)});await self.hold(8)

    async def save_benchmark(self, stations, config):
        flac = next((s for s in stations if 'flac' in s['url'].lower()), stations[0])
        if self.args.fixture_url:
            suffix = self.args.reference_file.suffix.lower() if self.args.reference_file else '.wav'
            route = '/reference'+suffix if self.args.reference_file else '/tone.wav'
            sid = await self.add_station('save-reference', self.args.fixture_url+route, self.args.fixture_url+'/logo.png')
        else:
            sid = flac['id']
        await self.command({'station':sid, 'play':True})
        self.set_phase('save-benchmark-baseline'); await self.hold(15)
        self.set_phase('save-benchmark-loaded')
        self.background.append(asyncio.create_task(self.image_load([s['id'] for s in stations])))
        if getattr(self.args,'static_read_load',False):
            self.background.append(asyncio.create_task(self.static_file_load()))
        for i in range(24):
            await self.save_config({'brightness':(config['brightness']+i+1)%255+1})
            # Also change fields persisted in state.json: a duplicate-write
            # optimization must not hide starvation on real control changes.
            await self.command({'eqLow':i%3-1,'eqHigh':1-i%3,'balance':5*(i%2),'persist':True})
            await self.hold(1.25)
        await self.verify_durable_controls({k:self.state[k] for k in STATE_FIELDS})

    async def save_preemption(self, stations, config):
        if not self.fixture or not self.args.reference_file:
            raise ValueError('save-preemption requires the served continuous reference')
        url=self.args.fixture_url+'/reference'+self.args.reference_file.suffix.lower()
        sid=await self.add_station('preemption-source',url)
        await self.command({'station':sid,'play':True});await self.hold(12)
        for index,mode in enumerate(('headers','body')):
            self.set_phase('save-preemption-'+mode)
            route='/logo-preempt.png?'+urlencode({'mode':mode,'run':self.prefix})
            logo_sid=await self.add_station('preemption-'+mode,url,self.args.fixture_url+route,prepare_logo=False)
            await self.request('/api/station/logo/prepare',{'id':logo_sid},expected=(202,))
            setup_started=time.monotonic()
            # This is fixture setup, not the timed save. A preceding logo may
            # still be finishing its LCD thumbnail on the serialized worker.
            until=setup_started+30
            while time.monotonic()<until:
                with self.fixture.preemption_lock:row=self.fixture.preemption.get(route)
                if row and row['started'].is_set():break
                await self.hold(.05)
            else:raise TimeoutError('Controlled slow artwork request never started')
            self.emit('preemption-setup',mode=mode,seconds=round(time.monotonic()-setup_started,3))
            started=time.monotonic()
            await self.save_config({'brightness':(config['brightness']+index+1)%255+1})
            elapsed=time.monotonic()-started
            self.emit('preemption-save',mode=mode,seconds=round(elapsed,3))
            if elapsed>getattr(self.args,'preemption_limit',4):raise TimeoutError('Save waited for controlled slow artwork')
            until=time.monotonic()+15
            while time.monotonic()<until:
                image=await self.request(f'/api/artwork/station?id={logo_sid}',expected=(200,404),operation='preempted-logo')
                if image.startswith((b'\x89PNG',b'\xff\xd8',b'BM')):
                    validate_image(image,'image');break
                await self.hold(.25)
            else:raise TimeoutError('Artwork did not complete after settings save')
            with self.fixture.preemption_lock:hits=self.fixture.preemption[route]['hits']
            self.emit('preemption-resumed',mode=mode,requests=hits,imageBytes=len(image))
            await self.hold(3)

    async def run(self):
        ok = False
        try:
            if self.args.serial_port:
                from stress_serial import SerialCapture
                self.serial_capture = SerialCapture(self.args.serial_port, self.directory / 'serial.log')
                self.emit('coverage', serialCapture=True)
            if self.args.exercise: await self.exercise()
            else:
                await self.connect_ws()
                self.set_phase('read-only')
                until = time.monotonic() + self.args.observe_seconds
                while time.monotonic() < until:
                    await self.sample(); await asyncio.sleep(1)
            ok = True
        except Exception as error:
            self.emit('failure', operation='scenario', detail=type(error).__name__ + ': ' + str(error))
        finally:
            self.stop_load = True
            for task in self.background: task.cancel()
            await asyncio.gather(*self.background, return_exceptions=True)
            # A cancelled asyncio waiter does not cancel urllib in its worker
            # thread. Drain bounded requests before restoring settings.
            if self.inflight: await asyncio.gather(*list(self.inflight),return_exceptions=True)
            if not ok:
                try:
                    health = await self.get('/api/system/status', operation='failure-health')
                    last = next((e for e in reversed(self.events) if e['kind']=='sample'),None)
                    if last and health['system']['uptimeMs'] < last['uptimeMs']:
                        self.emit('reboot',operation='failure-health',detail='Reset after last successful sample',
                                  resetReason=health['system'].get('resetReason'))
                    if self.telemetry:
                        diagnostic=await self.get('/api/diagnostics',operation='failure-diagnostics')
                        self.emit('failure-diagnostics',httpTxTiming=diagnostic.get('httpTxTiming'),
                                  dmaHeap=diagnostic.get('dmaHeap'),allocationFailures=diagnostic.get('allocationFailures'),
                                  previousAbort=diagnostic.get('previousAbort'),
                                  previousAllocationFailures=diagnostic.get('previousAllocationFailures'))
                except Exception: pass # Original failure remains; restoration is still attempted.
            if self.args.exercise and self.backup:
                try: await self.restore()
                except Exception as error:
                    ok = False; self.emit('failure', operation='restore', detail=type(error).__name__ + ': ' + str(error))
            if self.reader: self.reader.cancel(); await asyncio.gather(self.reader, return_exceptions=True)
            if self.ws: await self.ws.close()
            if self.serial_capture: self.serial_capture.close()
            self.emit('finished', completed=ok)
            summary = write_report(self.directory, self.events); self.log.close()
            print(json.dumps({k:summary[k] for k in ('result','requests','samples','stableAudioSamples','minimumHeap','minimumLargestBlock')},ensure_ascii=False),flush=True)
            print(str(self.directory / 'report.md'), flush=True)
        return ok and summary['result'] not in ('FAIL', 'INCONCLUSIVE_AUDIO', 'INCONCLUSIVE_COVERAGE', 'INCONCLUSIVE_SPECTRUM', 'INCONCLUSIVE_CONTENT')

def owned_stations(stations, prefix, original_ids):
    return [s for s in stations if s['id'] not in original_ids and s['name'].startswith(prefix)]

def station_digest(stations):
    canonical = [{k:s.get(k) for k in ('id','name','url','logo')} for s in stations]
    return hashlib.sha256(json.dumps(canonical,sort_keys=True).encode()).hexdigest()

def read_version():
    import re
    return re.search(r'#define APP_VERSION "([^"]+)"', (ROOT/'src/config/version.h').read_text()) [1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://192.168.0.213')
    parser.add_argument('--out', type=Path, default=ROOT/'.pio/stress'/time.strftime('%Y%m%d-%H%M%S'))
    parser.add_argument('--exercise',action='store_true'); parser.add_argument('--mute',action='store_true')
    parser.add_argument('--test-volume',type=int,choices=(0,1),default=0,
                        help='Explicit 1%% output for testing the real spectrum load; default 0 requires --mute')
    parser.add_argument('--scale',type=float,default=1); parser.add_argument('--seed',type=int,default=20261109)
    parser.add_argument('--observe-seconds',type=float,default=30); parser.add_argument('--expect-build')
    parser.add_argument('--profile', choices=('extreme','isolation','saves','cold-logos','switches','uploads','soak','disconnects','save-preemption'),default='extreme')
    parser.add_argument('--preemption-limit',type=float,default=4,help='Maximum save/persistence seconds during the controlled slow artwork request')
    parser.add_argument('--soak-seconds',type=float,default=7200,help='Bounded soak duration before automatic restoration')
    parser.add_argument('--image-parallel', type=int, choices=range(1,7), default=3,
                        help='Concurrent full station-image requests (default 3; browser-pressure test 6)')
    parser.add_argument('--http-parallel',type=int,choices=range(1,13),default=6,
                        help='Total HTTP connections per device: browser-like 6, deliberate overload up to 12')
    parser.add_argument('--static-read-load',action='store_true',help='Overlap persisted JSON and CSS reads with the save benchmark or soak')
    parser.add_argument('--durable-commands',action='store_true',help='Persist ordinary playback/EQ commands like normal UI clicks; restoration is always durable')
    parser.add_argument('--force-lcd-images',action='store_true',help='Compare the same logos via their LCD/BMP representation')
    parser.add_argument('--logo-save-mode',choices=('overlap','browser'),default='overlap',
                        help='Exercise overlapping ESP prewarm/upload or the real browser prepareLogo=0 ordering')
    parser.add_argument('--fixture-url', help='LAN address of this PC, e.g. http://192.168.0.10:19840')
    parser.add_argument('--serve-fixture', action='store_true')
    parser.add_argument('--reference-file',type=Path,help='Optional long local FLAC/Ogg/MP3/WAV for controlled isolation runs')
    parser.add_argument('--expect-continuous',action='store_true',help='Fail on all-zero sent blocks in settled local-fixture phases; requires an audited non-silent source and 1%% output')
    parser.add_argument('--serial-port', help='Optional passive USB serial capture; never asserts DTR/RTS')
    parser.add_argument('--restore',type=Path,help='Recover only the saved journal, without running scenarios')
    args = parser.parse_args()
    if args.scale <= 0 or args.observe_seconds <= 0 or args.soak_seconds <= 0: parser.error('Durations must be positive')
    if args.mute and args.test_volume: parser.error('--mute cannot be combined with --test-volume 1')
    if args.exercise and not args.mute and args.test_volume != 1: parser.error('--exercise requires --mute or explicit --test-volume 1')
    if args.restore and not args.exercise: parser.error('--restore requires --exercise and a permitted test volume')
    if args.serve_fixture and not args.fixture_url: parser.error('--serve-fixture requires a device-reachable --fixture-url')
    if args.reference_file and not args.serve_fixture: parser.error('--reference-file requires --serve-fixture')
    if args.expect_continuous and (not args.reference_file or args.test_volume!=1): parser.error('--expect-continuous requires a reference file and explicit --test-volume 1')
    server = None
    if args.serve_fixture:
        server = FixtureServer(urlsplit(args.fixture_url).port or 19840,args.reference_file)
        threading.Thread(target=server.serve_forever,daemon=True).start()
    async def execute():
        asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=16))
        run = Run(args)
        run.fixture=server
        if args.restore:
            run.backup=json.loads(args.restore.read_text(encoding='utf-8')); run.prefix=run.backup['prefix']
            if run.backup['base'] != run.base: raise ValueError('Recovery journal belongs to a different device URL')
            await run.connect_ws()
            try: await run.restore()
            finally:
                run.reader.cancel(); await asyncio.gather(run.reader,return_exceptions=True); await run.ws.close();run.log.close()
            return True
        return await run.run()
    try: return 0 if asyncio.run(execute()) else 1
    finally:
        if server: server.close()

if __name__ == '__main__': raise SystemExit(main())
