"""Compile the actual station import validation with the ESP32 toolchain."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class StationImportPolicyTests(unittest.TestCase):
    def test_actual_cpp_validation_and_bounds(self):
        compiler = shutil.which('xtensa-esp32s3-elf-g++')
        if not compiler:
            folder = Path.home() / '.platformio/packages/toolchain-xtensa-esp-elf/bin'
            compiler = next((str(folder / name) for name in
                ('xtensa-esp32s3-elf-g++.exe', 'xtensa-esp32s3-elf-g++') if (folder / name).is_file()), None)
        if not compiler:
            self.skipTest('Project ESP32 toolchain is unavailable')
        output = ROOT / '.pio/tests/station-import-policy'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            result = subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-c',
                str(ROOT / 'tools/tests/station_import_policy.cpp'), '-o', str(Path(directory) / 'fixtures.o')],
                capture_output=True, text=True, timeout=60, cwd=ROOT)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
