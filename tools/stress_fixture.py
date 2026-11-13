"""Deterministic LAN WAV/PNG fixture, with a deliberately slow image variant.

The tone is a repeatable 1-second signal, not silence. PCM is checked offline;
the ESP's muted output is monitored by timing, not by listening to this file.
"""
import math
import random
import struct
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RATE = 44100
PCM = b''.join(struct.pack('<hh', *([int(6000 * math.sin(2 * math.pi * (220 if i < RATE // 2 else 880) * i / RATE))] * 2)) for i in range(RATE))

def png():
    def chunk(name, data): return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
    side = 96
    rows = b''.join(b'\0' + b''.join(bytes((30 + x * 2, 90 + y, 160)) for x in range(side)) for y in range(side))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', side, side, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

def upload_png(noisy=False):
    """Two repeatable 150px images with high and low compression."""
    def chunk(name,data): return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data)&0xffffffff)
    side=150; rng=random.Random(20261111)
    rows=b''.join(b'\0'+(rng.randbytes(side*3) if noisy else bytes((30,110,190))*side) for _ in range(side))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',side,side,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')

class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def do_GET(self):
        try:
            if self.path.startswith('/logo-preempt.png?'):
                from urllib.parse import parse_qs,urlsplit
                mode=parse_qs(urlsplit(self.path).query).get('mode',['headers'])[0]
                with self.server.preemption_lock:
                    row=self.server.preemption.setdefault(self.path,{'hits':0,'started':threading.Event()})
                    row['hits']+=1;first=row['hits']==1;row['started'].set()
                data=png()
                if first and mode=='headers':self.server.stopping.wait(5)
                self.send_response(200);self.send_header('Content-Type','image/png')
                self.send_header('Content-Length',str(len(data)));self.end_headers()
                if first and mode=='body':
                    self.wfile.write(data[:256]);self.wfile.flush();self.server.stopping.wait(5)
                    self.wfile.write(data[256:])
                else:self.wfile.write(data)
                return
            reference=getattr(self.server,'reference_file',None)
            if reference and self.path.split('?',1)[0]=='/reference'+reference.suffix.lower():
                self.send_response(200)
                self.send_header('Content-Type',{'.flac':'audio/flac','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg'}[reference.suffix.lower()])
                if reference.suffix.lower()=='.ogg':
                    # Exercise the radio stream path, not the web-file path.
                    self.send_header('Connection','close');self.close_connection=True
                else:
                    self.send_header('Content-Length',str(reference.stat().st_size))
                self.end_headers()
                with reference.open('rb') as source:
                    while not self.server.stopping.is_set():
                        data=source.read(16384)
                        if not data:break
                        self.wfile.write(data)
                return
            if self.path.startswith('/logo'):
                data = png(); self.send_response(200); self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(data))); self.end_headers()
                for offset in range(0, len(data), 256):
                    self.wfile.write(data[offset:offset+256]); self.wfile.flush()
                    if 'slow' in self.path: time.sleep(.075)
                return
            if not self.path.startswith('/tone.wav'):
                self.send_error(404); return
            seconds = 600; size = seconds * len(PCM)
            header = b'RIFF' + struct.pack('<I', size + 36) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 2, RATE, RATE * 4, 4, 16) + b'data' + struct.pack('<I', size)
            self.send_response(200); self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(size + 44)); self.end_headers(); self.wfile.write(header)
            # Bounded ahead-of-time delivery. Avoid an unlimited LAN burst
            # making the fixture server itself the dominant stress source.
            start = time.monotonic()
            for second in range(seconds):
                if self.server.stopping.is_set(): break
                self.wfile.write(PCM); self.wfile.flush()
                delay = start + second - time.monotonic()
                if delay > 0: self.server.stopping.wait(delay)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError): pass

class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, port, reference_file=None):
        from pathlib import Path
        self.reference_file=Path(reference_file).resolve() if reference_file else None
        if self.reference_file and (not self.reference_file.is_file() or self.reference_file.suffix.lower() not in ('.flac','.mp3','.wav','.ogg')):
            raise ValueError('Reference must be an existing FLAC, Ogg, MP3 or WAV file')
        self.stopping = threading.Event()
        self.preemption_lock=threading.Lock();self.preemption={}
        super().__init__(('0.0.0.0', port), FixtureHandler)
    def close(self):
        self.stopping.set(); self.shutdown(); self.server_close()
    def handle_error(self, request, client_address):
        # A station switch normally resets this HTTP connection while the
        # server waits for the next keep-alive request. It is not a radio crash.
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)): return
        super().handle_error(request, client_address)

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--port', type=int, default=19840)
    args = parser.parse_args(); server = FixtureServer(args.port)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
