"""The observer must never alter audio writes or the existing library fixes."""
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('audio_output_patch', ROOT / 'tools/patch_audio_output.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OutputPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (ROOT / '.pio/libdeps/esp32-s3-devkitc1-n16r8/ESP32-audioI2S/src/Audio.cpp').read_text(encoding='utf-8')
        for _, blocks in module.PATCHES.values():
            for old, new in blocks:
                source = source.replace(new, old)
        cls.original = source.replace(module.INCLUDE, '')

    def test_only_reviewed_lifecycle_notifications_change(self):
        patched = module.patch_source(self.original)
        restored = patched
        for _, blocks in module.PATCHES.values():
            for old, new in blocks:
                self.assertIn(new, patched)
                restored = restored.replace(new, old)
        self.assertEqual(restored.replace(module.INCLUDE, ''), self.original)
        play = r'(?ms)^void IRAM_ATTR Audio::playChunk\(\).*?^}'
        self.assertEqual(re.search(play, patched).group(), re.search(play, self.original).group())

    def test_idempotent_and_crlf(self):
        result = module.patch_source(self.original)
        self.assertEqual(module.patch_source(result), result)
        self.assertEqual(module.patch_source(self.original.replace('\n', '\r\n')), result)

    def test_modified_dependency_or_partial_hook_fails_closed(self):
        result = module.patch_source(self.original)
        broken = [result.replace(module.INCLUDE, ''),
                  result.replace('    SimpleRadioAudioOutput::stop();\n', '', 1),
                  self.original.replace('m_i2s_chan_cfg.auto_clear = true;', 'm_i2s_chan_cfg.auto_clear = false;')]
        for source in broken:
            with self.assertRaises(RuntimeError):
                module.patch_source(source)

    def test_existing_network_and_hls_fixes_are_retained(self):
        result = module.patch_source(self.original)
        self.assertIn('SimpleRadioAudio::serviceNetwork', result)
        self.assertIn('SimpleRadioHls::resolve', result)


if __name__ == '__main__':
    unittest.main()
