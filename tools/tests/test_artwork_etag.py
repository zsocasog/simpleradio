from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class ArtworkEtagTests(unittest.TestCase):
    def test_conditional_get_parser_on_pinned_s3_compiler(self):
        compiler = Path.home() / '.platformio/packages/toolchain-xtensa-esp-elf/bin/xtensa-esp32s3-elf-g++.exe'
        if not compiler.is_file(): self.skipTest('Install the PlatformIO S3 compiler')
        output=ROOT/'.pio/tests/artwork-etag';output.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=output) as directory:
            result=subprocess.run([str(compiler),'-std=c++17','-Wall','-Wextra','-Werror','-c',
                                   str(ROOT/'tools/tests/artwork_etag.cpp'),'-o',str(Path(directory)/'fixture.o')],
                                  cwd=ROOT,capture_output=True,text=True,timeout=60)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)

if __name__=='__main__':unittest.main()
