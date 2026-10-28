"""Version generation preserves separate firmware and installed WebUI identities."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_versions import generate_web_metadata, read_versions


class ProjectVersionsTest(unittest.TestCase):
    def setUp(self):
        workspace = Path(__file__).resolve().parents[2]
        fixture_dir = workspace / '.pio/artifacts/central-versions-20261028/test-fixtures'
        fixture_dir.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=fixture_dir)
        self.root = Path(temporary.name).resolve()
        assert self.root.is_relative_to(fixture_dir.resolve())
        self.addCleanup(temporary.cleanup)
        (self.root / 'src/config').mkdir(parents=True)
        self.header = self.root / 'src/config/version.h'
        self.header.write_text('#define APP_VERSION "2.3.4"\n#define WEB_UI_VERSION "5.6.7"\n'
                               '#define WEB_API_VERSION 2\n#define WEB_UI_MIN_API_VERSION 1\n'
                               '#define WEB_UI_MAX_API_VERSION 2\n', encoding='utf-8')
        self.data = self.root / 'data'
        self.data.mkdir()
        (self.data / 'index.html').write_text('<link href="style.css?v=0.0.0&amp;ui=manual">'
            '<script src="ui.js?v=0.0.0"></script><h1>Radio</h1>'
            '<a href="https://example.org/help.js?v=1">Help</a>', encoding='utf-8')
        (self.data / 'wifi.html').write_text('<link href="wifi.css"><script src="wifi.js"></script>', encoding='utf-8')
        (self.data / 'ui.js').write_text('const versionTest = true;\n', encoding='utf-8')
        (self.data / 'style.css').write_text('body { color: white; }\n', encoding='utf-8')
        (self.root / 'README.md').write_text('> Current version: **old** · Radio\nHistory: 0.8.24\n', encoding='utf-8')
        (self.root / 'README.hu.md').write_text('> Jelenlegi verzió: **régi** · Rádió\nElőzmény: 0.8.24\n', encoding='utf-8')

    def test_independent_versions_and_all_local_asset_links(self):
        versions, revision = generate_web_metadata(self.root)
        manifest = json.loads((self.data / 'build-info.json').read_text(encoding='utf-8'))
        self.assertEqual(versions['APP_VERSION'], '2.3.4')
        self.assertEqual(manifest['webuiVersion'], '5.6.7')
        self.assertEqual(manifest['requiresFirmwareApi'], {'min': 1, 'max': 2})
        for name in ('index.html', 'wifi.html'):
            self.assertIn('?v=5.6.7&amp;ui=' + revision, (self.data / name).read_text(encoding='utf-8'))
            self.assertNotIn('?v=2.3.4', (self.data / name).read_text(encoding='utf-8'))
        self.assertIn('https://example.org/help.js?v=1', (self.data / 'index.html').read_text(encoding='utf-8'))
        self.assertEqual((self.root / 'README.md').read_text(encoding='utf-8'),
                         '> Current version: **2.3.4** · Radio\nHistory: 0.8.24\n')
        self.assertEqual((self.root / 'README.hu.md').read_text(encoding='utf-8'),
                         '> Jelenlegi verzió: **2.3.4** · Rádió\nElőzmény: 0.8.24\n')

    def test_repeat_build_is_stable_and_does_not_rewrite_outputs(self):
        first = generate_web_metadata(self.root)
        files = [self.data / 'index.html', self.data / 'wifi.html',
                 self.data / 'build-info.json', self.root / 'README.md', self.root / 'README.hu.md']
        before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in files]
        self.assertEqual(generate_web_metadata(self.root), first)
        self.assertEqual([(p.read_bytes(), p.stat().st_mtime_ns) for p in files], before)

    def test_asset_or_html_change_refreshes_cache_without_version_bump(self):
        versions, first = generate_web_metadata(self.root)
        (self.data / 'style.css').write_text('body { color: gold; }', encoding='utf-8')
        same_versions, second = generate_web_metadata(self.root)
        self.assertEqual(same_versions, versions)
        self.assertNotEqual(first, second)
        index = self.data / 'index.html'
        index.write_text(index.read_text(encoding='utf-8').replace('Radio</h1>', 'Player</h1>'), encoding='utf-8')
        _, third = generate_web_metadata(self.root)
        self.assertNotEqual(second, third)
        self.assertEqual(generate_web_metadata(self.root)[1], third)

    def test_missing_webui_version_fails_before_output_changes(self):
        self.header.write_text(self.header.read_text(encoding='utf-8').replace('#define WEB_UI_VERSION "5.6.7"\n', ''), encoding='utf-8')
        before = (self.data / 'index.html').read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'Missing WEB_UI_VERSION'):
            generate_web_metadata(self.root)
        self.assertEqual((self.data / 'index.html').read_bytes(), before)
        self.assertFalse((self.data / 'build-info.json').exists())

    def test_invalid_api_range_is_rejected(self):
        self.header.write_text(self.header.read_text(encoding='utf-8').replace('WEB_UI_MIN_API_VERSION 1', 'WEB_UI_MIN_API_VERSION 3'), encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'minimum API version'):
            read_versions(self.header)


if __name__ == '__main__':
    unittest.main()
