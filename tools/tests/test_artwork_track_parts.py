"""Compile the real constexpr parser fixtures with the pinned ESP32 toolchain."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ArtworkTrackPartsTests(unittest.TestCase):
    def test_cpp_fixtures_compile_with_arduino_macro_compatibility(self):
        compiler = shutil.which('xtensa-esp32s3-elf-g++')
        if not compiler:
            tool = Path.home() / '.platformio/packages/toolchain-xtensa-esp-elf/bin'
            compiler = next((str(tool / name) for name in
                             ('xtensa-esp32s3-elf-g++.exe', 'xtensa-esp32s3-elf-g++')
                             if (tool / name).is_file()), None)
        if not compiler:
            self.skipTest('Install the project PlatformIO toolchain for C++ parser tests')
        output = ROOT / '.pio/tests/artwork-track-parts'
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            result = subprocess.run(
                [compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-c',
                 str(ROOT / 'tools/tests/artwork_track_parts.cpp'),
                 '-o', str(Path(directory) / 'fixtures.o')],
                capture_output=True, text=True, timeout=60, cwd=ROOT)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
