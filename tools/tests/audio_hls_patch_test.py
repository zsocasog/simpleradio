"""Test the build patch without changing a dependency or reading secrets."""
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "patch_audio_hls.py"
spec = importlib.util.spec_from_file_location("audio_hls_patch", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AudioHlsPatchTests(unittest.TestCase):
    def setUp(self):
        self.function = (
            "ps_ptr<char> Audio::m3u8redirection(uint8_t* codec) {\n"
            "    // Keep codec choice and other decoder logic intact.\n"
            + module.ORIGINAL_URL_BLOCK + "    return result;\n}"
        )
        self.source = '#include "Audio.h"\n' + self.function + "\n// unrelated source\n"
        self.hash = hashlib.sha256(self.function.encode()).hexdigest()

    def apply(self, source):
        with patch.object(module, "ORIGINAL_HASH", self.hash):
            return module.patch_source(source)

    def test_only_url_block_and_include_change(self):
        result = self.apply(self.source)
        self.assertIn(module.PATCHED_URL_BLOCK, result)
        self.assertNotIn(module.ORIGINAL_URL_BLOCK, result)
        self.assertEqual(result.replace(module.PATCHED_URL_BLOCK, module.ORIGINAL_URL_BLOCK)
                         .replace(module.INCLUDE, ""), self.source)

    def test_repeated_build_is_idempotent(self):
        result = self.apply(self.source)
        self.assertEqual(self.apply(result), result)

    def test_windows_line_endings(self):
        self.assertEqual(self.apply(self.source.replace("\n", "\r\n")), self.apply(self.source))

    def test_unfamiliar_source_is_not_overwritten(self):
        with self.assertRaisesRegex(RuntimeError, "unfamiliar audio source"):
            self.apply(self.source.replace("return result;", "return differentResult;"))

    def test_edited_existing_patch_is_rejected(self):
        result = self.apply(self.source)
        with self.assertRaises(RuntimeError):
            self.apply(result.replace("resolved.text", "modified.text"))

    def test_missing_or_duplicate_function_is_rejected(self):
        for source in ["", self.source + self.function]:
            with self.assertRaises(RuntimeError):
                self.apply(source)

    def test_missing_include_in_patched_file_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "incomplete existing patch"):
            self.apply(self.apply(self.source).replace(module.INCLUDE, ""))


if __name__ == "__main__":
    unittest.main()
