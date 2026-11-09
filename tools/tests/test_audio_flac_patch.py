import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
import patch_audio_flac


class FlacMaskPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = ROOT / '.pio/libdeps/esp32-s3-devkitc1-n16r8/ESP32-audioI2S/src/flac_decoder/flac_decoder.cpp'
        cls.original = path.read_text(encoding='utf-8').replace(patch_audio_flac.NEW, patch_audio_flac.OLD)

    def test_only_table_storage_changes(self):
        patched = patch_audio_flac.patch_source(self.original)
        self.assertEqual(patched.replace(patch_audio_flac.NEW, patch_audio_flac.OLD), self.original)
        self.assertEqual(patched.count(patch_audio_flac.NEW), 1)
        # All 33 exact values, including zero and the full-width mask, survive.
        before = re.search(r'const uint32_t mask\[33\] = \{(.*?)\};', self.original, re.S).group(1)
        after = re.search(r'const uint32_t mask\[33\] = \{(.*?)\};', patched, re.S).group(1)
        self.assertEqual(after, before)

    def test_idempotent(self):
        patched = patch_audio_flac.patch_source(self.original)
        self.assertEqual(patch_audio_flac.patch_source(patched), patched)

    def test_unreviewed_logic_or_values_fail_closed(self):
        for changed in (self.original.replace('mask[33]', 'mask[32]', 1),
                        self.original.replace('0x00000000', '0x00000001', 1),
                        self.original.replace('if (nBits < 32)', 'if (nBits < 31)', 1)):
            with self.assertRaises(RuntimeError):
                patch_audio_flac.patch_source(changed)

    def test_missing_or_duplicate_function_fails_closed(self):
        function = re.search(r'(?ms)^uint32_t FlacDecoder::readUint\(.*?^}', self.original).group()
        for changed in (self.original.replace(function, ''), self.original + '\n' + function):
            with self.assertRaises(RuntimeError):
                patch_audio_flac.patch_source(changed)


if __name__ == '__main__':
    unittest.main()
