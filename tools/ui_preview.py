"""Local UI review with an in-memory radio. Never contacts or updates hardware.

python tools/ui_preview.py --port 8765
Use /?lang=en for English. POSTs and WebSocket controls affect this fixture only.
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import socket
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from project_versions import read_versions

ROOT = Path(__file__).resolve().parents[1] / 'data'
VERSIONS = read_versions(ROOT.parent / 'src/config/version.h')
WEB_BUILD = json.loads((ROOT / 'build-info.json').read_text(encoding='utf-8'))
LOCK = threading.Lock()
REQUESTS = []
CONFIG = dict(displayInvert=False, brightness=230, displayIdleEnabled=True,
    displayIdleBlank=False, displayIdleSeconds=120, displayIdleBrightness=13,
    displayClockEnabled=True, displayClockStyle='digital', displayFooterMode='spectrum',
    displayArtworkMode='album', displayVuStyle='symmetric',
    themeAccent='amber', themeCustomColor='#f5ce74', timeZone='CET-1CEST,M3.5.0/2,M10.5.0/3',
    autoBrightness=True, dayBrightness=230, nightBrightness=51, dayStartMinute=420,
    nightStartMinute=1200, irEnabled=True, irSensitivity=40, irActionLearning='',
    encoderEnabled=True, secondEncoderEnabled=False, encoderMode='single_volume_picker',
    encoderSensitivity=8, encoderVolumeStep=5, encoderLongPressMs=700,
    encoderAutoPlayStation=True, encoderAutoPlayMs=2500, mqttEnabled=True,
    mqttHost='broker.example', mqttPort=1883, mqttUser='', mqttPassword='',
    mqttRootTopic='simpleradio', streamRetryEnabled=True, streamRetryMs=5000,
    autoStart=False, volumeCurve='soft', frontLedEnabled=False, frontLedUseTheme=True,
    frontLedBrightness=128, frontLedStandbyBrightness=13, frontLedColor='#a9f7bf',
    hasLastFmApiKey=True, hasSavedLastFmApiKey=False)
IR_ACTIONS = ['prev','next','toggle','volUp','volDown','mute','power','up','down','left','right','ok','list','back'] + ['digit'+str(i) for i in range(10)] + ['star','hash'] + ['station'+str(i) for i in range(1,6)]
def ir_key(action): return 'ir'+action[0].upper()+action[1:]
CONFIG.update(irRemoteProfilesVersion=1, irRemoteProfile='rcnec21', irRemoteCustom='')
CONFIG.update({ir_key(action):'0' for action in IR_ACTIONS})
IR_BANKS = {profile:{ir_key(action):'0' for action in IR_ACTIONS} for profile in ('rcnec21','car21','nav17','custom')}
HARDWARE = dict(schemaVersion=1, transientPlayerControls=True, encoderCount=1,
    encoder1=dict(available=True, hasButton=True), encoder2=dict(available=False, hasButton=False),
    frontRgbLed=dict(available=False, type='none'), ir=dict(available=True))
STATIONS = [dict(id=i+1, name=name, url='https://stream.example/'+str(i), logo=logo) for i,(name,logo) in enumerate([
    ('Danubius','https://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png'),
    ('BDPST ROCK Rádió (Hi-Fi / Lossless / FLAC)','https://www.bdpstrock.hu/assets/img/front/favicon.ico'),
    ('Dance Wave!','https://dancewave.online/dw-logo.png'), ('Retro Rádió','')])]
STATION_REVISION = 7
STATE = dict(playing=True, stationId=2, station=STATIONS[1]['name'], volume=35,
    eqLow=0, eqMid=0, eqHigh=0, balance=0, artist='Falling In Reverse',
    title='Fashionably Late', streamConnectionState='playing',
    cachedArtworkPath='', albumArtworkPath='', streamLogoUrl=STATIONS[1]['logo'])

def status():
    return dict(status={**STATE,'clients':1}, wifi=dict(connected=True, quality=70,
        ssid='SimpleRadio preview', rssi=-65, ip='127.0.0.1'),
        mqtt=dict(configured=CONFIG['mqttEnabled'], connected=CONFIG['mqttEnabled'],
        stateText='OK',host=CONFIG['mqttHost'],port=CONFIG['mqttPort'],rootTopic=CONFIG['mqttRootTopic'],hasAuth=False),
        filesystem=dict(totalBytes=7200000,usedBytes=720000,freeBytes=6480000,
        artworkCacheBytes=363000,artworkCacheLimitBytes=5500000,artworkCacheTargetBytes=5000000),
        system=dict(version=VERSIONS['APP_VERSION'],chipModel='ESP32-S3',cpuMhz=240,uptimeMs=180000,
        resetReasonText='USB',flashSize=16777216,sdk='v5.5.5'),
        webui=dict(version=WEB_BUILD['webuiVersion'],manifestPresent=True,manifestValid=True,compatible=True))

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args): pass
    def reply(self,body,kind='application/json',code=200):
        if not isinstance(body,bytes): body=json.dumps(body).encode()
        self.send_response(code);self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store')
        self.end_headers();self.wfile.write(body)
    def do_GET(self):
        url=urlsplit(self.path);path=url.path
        if path=='/ws': return self.websocket()
        routes={'/api/config':CONFIG,'/api/hardware':HARDWARE,'/api/stations':{'stations':STATIONS,'revision':STATION_REVISION},
            '/api/logos':{'logos':[]},'/api/system/status':status(),'/api/state':STATE,'/__preview/requests':REQUESTS}
        if path in routes: return self.reply(routes[path])
        if path=='/favicon.ico': return self.reply(b'','image/x-icon')
        file=(ROOT / (path.lstrip('/') or 'index.html')).resolve()
        if ROOT.resolve() not in file.parents or not file.is_file(): return self.reply({'error':'Not found'},code=404)
        content=file.read_bytes()
        if file.name=='index.html':
            language=parse_qs(url.query).get('lang',['hu'])[0]
            if language not in ('hu','en','template'):language='hu'
            content=content.replace(b'src="i18n.js?',('src="i18n/'+language+'.js?').encode())
        self.reply(content,mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
    def do_POST(self):
        global STATION_REVISION
        path=urlsplit(self.path).path
        body=self.rfile.read(int(self.headers.get('Content-Length',0)))
        if path=='/api/stations/import':
            try: data=json.loads(body)
            except (ValueError,UnicodeError): return self.reply(b'invalid','text/plain',400)
            with LOCK:
                REQUESTS.append({'path':path,'data':data})
                if data.get('revision')!=STATION_REVISION: return self.reply(b'conflict','text/plain',409)
                if data.get('mode') not in ('append','replace') or not isinstance(data.get('stations'),list) or not data['stations']:
                    return self.reply(b'invalid','text/plain',400)
                if len(body)>131072 or len(data['stations'])>500: return self.reply(b'limit','text/plain',413)
                replacing=data['mode']=='replace';next_list=[] if replacing else list(STATIONS)
                by_url={s['url']:s for s in STATIONS};seen={s['url'] for s in next_list}
                next_id=max((s['id'] for s in STATIONS),default=-1)+1;added=skipped=0
                for row in data['stations']:
                    if not isinstance(row,dict) or not isinstance(row.get('name'),str) or not isinstance(row.get('url'),str):
                        return self.reply(b'invalid','text/plain',400)
                    name=row['name'].strip();url=row['url'].strip()
                    if not name or not url.startswith(('http://','https://')): return self.reply(b'invalid','text/plain',400)
                    if url in seen: skipped+=1;continue
                    previous=by_url.get(url) if replacing else None
                    next_list.append(dict(id=previous['id'] if previous else next_id,name=name,url=url,logo=previous.get('logo','') if previous else ''))
                    if not previous:next_id+=1
                    seen.add(url);added+=1
                if len(next_list)>500:return self.reply(b'limit','text/plain',413)
                if replacing or added:STATIONS[:]=next_list;STATION_REVISION+=1
                if not any(s['id']==STATE['stationId'] for s in STATIONS):
                    first=STATIONS[0];STATE.update(stationId=first['id'],station=first['name'],playing=False)
                return self.reply(dict(added=added,skipped=skipped,total=len(STATIONS),revision=STATION_REVISION))
        data={k:v[-1] for k,v in parse_qs(body.decode(),keep_blank_values=True).items()} if not path.startswith('/api/ota/') else {}
        with LOCK:
            REQUESTS.append({'path':path,'data':data})
            if path=='/api/config/save':
                previous=CONFIG['irRemoteProfile']
                for key,value in data.items():
                    if key in CONFIG:
                        original=CONFIG[key]
                        CONFIG[key]=(value=='1') if isinstance(original,bool) else int(value) if isinstance(original,int) else value
                IR_BANKS[previous] = {ir_key(action):CONFIG[ir_key(action)] for action in IR_ACTIONS}
                if CONFIG['irRemoteProfile'] != previous:
                    CONFIG.update(IR_BANKS[CONFIG['irRemoteProfile']]); CONFIG['irActionLearning']=''
                if 'irRemoteCodeMap' in data:
                    codes=json.loads(data['irRemoteCodeMap'])
                    CONFIG.update({ir_key(action):codes.get(action,'0') for action in IR_ACTIONS})
                    IR_BANKS[CONFIG['irRemoteProfile']]={ir_key(action):CONFIG[ir_key(action)] for action in IR_ACTIONS}
                if data.get('lastFmApiKey'): CONFIG.update(hasLastFmApiKey=True,hasSavedLastFmApiKey=True)
                if data.get('clearLastFmApiKey')=='1': CONFIG.update(hasLastFmApiKey=True,hasSavedLastFmApiKey=False)
                return self.reply(CONFIG)
            if path=='/__preview/learn':
                action=CONFIG.get('irActionLearning','')
                if action in IR_ACTIONS: CONFIG[ir_key(action)]=data.get('code','12345678901234567890')
                CONFIG['irActionLearning']=''
                return self.reply(CONFIG)
            if path=='/__preview/clear':REQUESTS.clear();return self.reply({'ok':True})
        if path.startswith('/api/ota/'):return self.reply({'error':'Preview: hardware updates are disabled'},code=400)
        self.reply({'ok':True})
    def websocket(self):
        key=self.headers.get('Sec-WebSocket-Key','')
        accept=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101);self.send_header('Upgrade','websocket');self.send_header('Connection','Upgrade')
        self.send_header('Sec-WebSocket-Accept',accept);self.end_headers()
        def send(data,opcode=1):
            payload=json.dumps(data).encode() if not isinstance(data,bytes) else data
            header=bytes([0x80|opcode,len(payload)]) if len(payload)<126 else bytes([0x80|opcode,126])+struct.pack('!H',len(payload))
            self.wfile.write(header+payload);self.wfile.flush()
        def receive(n):
            data=self.rfile.read(n)
            if len(data)!=n:raise ConnectionError()
            return data
        try:
            send(STATE)
            while True:
                header=receive(2);opcode=header[0]&15;length=header[1]&127
                if length==126:length=struct.unpack('!H',receive(2))[0]
                elif length==127:length=struct.unpack('!Q',receive(8))[0]
                if length>1048576:break
                mask=receive(4) if header[1]&128 else b'';payload=receive(length)
                if mask:payload=bytes(b^mask[i%4] for i,b in enumerate(payload))
                if opcode==8:break
                if opcode==9:send(payload,10);continue
                if opcode!=1:continue
                command=json.loads(payload)
                if 'ping' in command:send({'pong':command['ping']});continue
                with LOCK:
                    REQUESTS.append({'path':'/ws','data':command})
                    for k in ('volume','eqLow','eqMid','eqHigh','balance'):
                        if k in command:STATE[k]=command[k]
                    if 'play' in command:STATE['playing']=command['play']
                    if 'station' in command:
                        station=next((s for s in STATIONS if s['id']==command['station']),STATIONS[0])
                        STATE.update(stationId=station['id'],station=station['name'],streamLogoUrl=station['logo'])
                    send(STATE)
        except (ConnectionError,OSError,ValueError):pass
        self.close_connection=True

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--long-title',action='store_true',help='Use a long song title for responsive layout checks')
    args=parser.parse_args()
    if args.long_title:
        STATE.update(artist='Dire Straits',title='Money for Nothing (Full Length Version)')
    print('SimpleRadio fixture: http://127.0.0.1:'+str(args.port),flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
