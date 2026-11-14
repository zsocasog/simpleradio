"""Compile LED pin, wire protocol and transfer lifetime fixtures with the project toolchain."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class FrontLedPolicyTests(unittest.TestCase):
    def test_actual_cpp_policy(self):
        compiler = shutil.which('xtensa-esp32s3-elf-g++')
        if not compiler:
            folder = Path.home() / '.platformio/packages/toolchain-xtensa-esp-elf/bin'
            compiler = next((str(folder / name) for name in
                ('xtensa-esp32s3-elf-g++.exe', 'xtensa-esp32s3-elf-g++') if (folder / name).is_file()), None)
        if not compiler:
            self.skipTest('Project ESP32 toolchain is unavailable')
        output = ROOT / '.pio/tests/front-led-policy'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            for index, (source, flags) in enumerate([
                ('front_led_policy.cpp', []),
                ('front_led_defaults.cpp', ['-DLED_TEST_PROFILE=1']),
                ('front_led_defaults.cpp', ['-DLED_TEST_PROFILE=2']),
            ]):
                with self.subTest(source=source, flags=flags):
                    result = subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', *flags, '-c',
                        str(ROOT / 'tools/tests' / source), '-o', str(Path(directory) / f'fixtures-{index}.o')],
                        capture_output=True, text=True, timeout=60, cwd=ROOT)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
