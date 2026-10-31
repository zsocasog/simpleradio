"""Exercise the version-guarded patch against the installed pinned dependency."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('audio_network_patch', ROOT / 'tools/patch_audio_network.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AudioNetworkPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (ROOT / '.pio/libdeps/esp32-s3-devkitc1-n16r8/ESP32-audioI2S/src/Audio.cpp').read_text(encoding='utf-8')
        for _, (_, (old, new)) in module.PATCHES.items():
            source = source.replace(new, old)
        cls.original = source.replace(module.INCLUDE, '')

    def test_only_reviewed_blocks_change(self):
        result = module.patch_source(self.original)
        for _, (_, (old, new)) in module.PATCHES.items():
            self.assertIn(new, result)
        for _, (_, (old, new)) in module.PATCHES.items():
            result = result.replace(new, old)
        self.assertEqual(result.replace(module.INCLUDE, ''), self.original)

    def test_repeated_build_and_crlf_are_idempotent(self):
        result = module.patch_source(self.original)
        self.assertEqual(module.patch_source(result), result)
        self.assertEqual(module.patch_source(self.original.replace('\n', '\r\n')), result)

    def test_incomplete_or_changed_patch_is_rejected(self):
        result = module.patch_source(self.original)
        for broken in [result.replace(module.INCLUDE, ''),
                       result.replace('m_client->stop();\n            return false;', 'return true;'),
                       self.original.replace('m_timeout_ms = timeout_ms;', 'm_timeout_ms = 999;')]:
            with self.assertRaises(RuntimeError):
                module.patch_source(broken)

    def test_hls_fix_is_preserved(self):
        source = module.patch_source(self.original)
        self.assertIn('SimpleRadioHls::resolve(m_currentHost.get(), line.get())', source)


if __name__ == '__main__':
    unittest.main()
