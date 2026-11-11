import gzip
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from web_assets import prepare_web_assets


class WebAssetsTests(unittest.TestCase):
    def test_companions_decode_exactly_and_are_repeatable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = ('const title="Állomások";\n' * 200).encode()
            (root/'app.js').write_bytes(original)
            (root/'ui.css').write_bytes(b'body{color:red}' * 100)
            count, plain, compressed = prepare_web_assets(root)
            self.assertEqual(count, 2)
            self.assertLess(compressed, plain)
            encoded = (root/'app.js.gz').read_bytes()
            self.assertEqual(gzip.decompress(encoded), original)
            prepare_web_assets(root)
            self.assertEqual((root/'app.js.gz').read_bytes(), encoded)
            (root/'app.js').write_bytes(b'const updated=1;')
            prepare_web_assets(root)
            self.assertEqual(gzip.decompress((root/'app.js.gz').read_bytes()), b'const updated=1;')

    def test_deleted_sources_drop_only_their_generated_companions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ('old.js.gz', 'old.css.gz', 'logo.png', 'config.json', 'custom.bin.gz'):
                (root/name).write_bytes(b'keep')
            (root/'i18n').mkdir()
            (root/'i18n/en.js').write_bytes(b'const language="en";')
            self.assertEqual(prepare_web_assets(root), (0, 0, 0))
            self.assertFalse((root/'old.js.gz').exists())
            self.assertFalse((root/'old.css.gz').exists())
            for name in ('logo.png', 'config.json', 'custom.bin.gz', 'i18n/en.js'):
                self.assertTrue((root/name).exists())
