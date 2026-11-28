from pathlib import Path
import shutil
import subprocess
import unittest


class PlayerLayoutTests(unittest.TestCase):
    def test_motion_and_pixel_composition(self):
        compiler = shutil.which('xtensa-esp32s3-elf-g++')
        if not compiler:
            folder = Path.home() / '.platformio/packages/toolchain-xtensa-esp-elf/bin'
            compiler = next((p for p in (folder / 'xtensa-esp32s3-elf-g++.exe',
                                         folder / 'xtensa-esp32s3-elf-g++') if p.is_file()), None)
        if not compiler:
            self.skipTest('PlatformIO ESP32-S3 toolchain unavailable')
        subprocess.run([compiler, '-std=c++17', '-fsyntax-only',
                        Path(__file__).with_name('player_layout_motion.cpp')], check=True)
