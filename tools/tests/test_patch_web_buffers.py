import hashlib
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('web_buffers', ROOT / 'tools/patch_web_buffers.py')
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class GuardTests(unittest.TestCase):
    def test_exact_guard_and_idempotence(self):
        original = 'before\nold\nafter\n'
        sha = hashlib.sha256(original.encode()).hexdigest()
        edits = [('old', 'replacement')]
        patched = patcher.patch(original, sha, edits)
        self.assertEqual(patcher.patch(patched, sha, edits), patched)
        self.assertEqual(patcher.patch(original.replace('\n', '\r\n'), sha, edits), patched)

    def test_unknown_or_partial_sources_are_rejected(self):
        sha = hashlib.sha256(b'old first\nold second\n').hexdigest()
        edits = [('old first', 'new first'), ('old second', 'new second')]
        for source in ['unknown', 'new first\nold second\n', 'old first\nold second\nextra']:
            with self.assertRaises(RuntimeError):
                patcher.patch(source, sha, edits)

    def test_allocation_uses_only_psram_and_non_esp32_branch_is_unchanged(self):
        old, new = patcher.SOURCE_EDITS[0]
        esp32 = new.split('#else')[0]
        self.assertIn('MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT', esp32)
        self.assertIn('memory ? new (memory) SendBuffer : nullptr', esp32)
        self.assertNotIn('MALLOC_CAP_INTERNAL', esp32)
        self.assertEqual(new.split('#else\n')[1].split('\n#endif')[0], old)
        self.assertIn('heap_caps_free(buffer)', patcher.HEADER_EDITS[1][1])

    def test_every_file_constructor_bounds_stdio_before_reads(self):
        # Cover direct/gzip opens and static files before gzip trailer reads.
        file_edits = [edit for edit in patcher.SOURCE_EDITS if 'setBufferSize' in edit[1]]
        self.assertEqual(len(file_edits), 2)
        for original, replacement in file_edits:
            self.assertTrue(replacement.startswith(original + '\n#if defined(ESP32)'))
            self.assertEqual(replacement.count('_content.setBufferSize(512)'), 1)
            self.assertTrue(replacement.endswith('#endif'))
        folder = ROOT / '.pio/libdeps/esp32-s3-devkitc1-n16r8/ESPAsyncWebServer/src'
        if folder.exists():
            code = patcher.patch_source((folder / 'WebResponses.cpp').read_text(encoding='utf-8'))
            # There must be no remaining file assignment without its budget.
            for original, replacement in file_edits:
                self.assertEqual(code.count(original), 1)
                self.assertEqual(code.count(replacement), 1)
            self.assertLess(code.index('_content.setBufferSize(512)'), code.index('if (!_content.available())'))
            static = patcher.patch_handler((folder / 'WebHandlers.cpp').read_text(encoding='utf-8'))
            self.assertLess(static.index('request->_tempFile.setBufferSize(512)'),
                            static.index('AsyncWebServerRequest::_getEtag(request->_tempFile'))
            # A user-supplied File may have already been read: do not resize it.
            file_ctor = code.split('AsyncFileResponse::AsyncFileResponse(File content,')[1]
            file_ctor = file_ctor.split('size_t AsyncFileResponse::_fillBuffer')[0]
            self.assertNotIn('setBufferSize', file_ctor)

    @unittest.skipUnless((ROOT / '.pio/libdeps/esp32-s3-devkitc1-n16r8/ESPAsyncWebServer/src').exists(), 'dependency not installed')
    def test_pinned_sources_change_only_reviewed_buffer_and_retry_edits(self):
        folder = ROOT / '.pio/libdeps/esp32-s3-devkitc1-n16r8/ESPAsyncWebServer/src'
        for name, sha, edits, transform in [
            ('WebResponseImpl.h', patcher.HEADER_HASH, patcher.HEADER_EDITS, patcher.patch_header),
            ('WebResponses.cpp', patcher.SOURCE_HASH, patcher.SOURCE_EDITS, patcher.patch_source),
            ('WebHandlers.cpp', patcher.HANDLER_HASH, patcher.HANDLER_EDITS, patcher.patch_handler),
        ]:
            source = (folder / name).read_text(encoding='utf-8')
            patched = transform(source)
            self.assertEqual(transform(patched), patched)
            restored = patched
            for old, new in edits:
                self.assertEqual(restored.count(new), 1)
                restored = restored.replace(new, old)
            self.assertEqual(hashlib.sha256(restored.encode()).hexdigest(), sha)
            # Everything outside the reviewed buffer/partial-write edits is byte-identical.


if __name__ == '__main__':
    unittest.main()
