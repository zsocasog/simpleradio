"""Optional passive USB log capture; DTR/RTS stay disabled before opening."""
import threading
import time

class SerialCapture:
    def __init__(self, port, path):
        import serial
        self.serial = serial.Serial(port=None, baudrate=115200, timeout=.25)
        self.serial.dtr = False; self.serial.rts = False
        self.serial.port = port; self.serial.open()
        self.file = open(path, 'w', encoding='utf-8', buffering=1)
        self.stopped = threading.Event(); self.started = time.monotonic()
        self.thread = threading.Thread(target=self.read, daemon=True); self.thread.start()
    def read(self):
        try:
            while not self.stopped.is_set():
                line = self.serial.readline()
                if line: self.file.write(f'{time.monotonic()-self.started:.3f} ' + line.decode('utf-8',errors='replace').rstrip() + '\n')
        except Exception as error:
            self.file.write(f'CAPTURE_STOPPED {type(error).__name__}\n')
    def close(self):
        self.stopped.set(); self.thread.join(2); self.serial.close(); self.file.close()
