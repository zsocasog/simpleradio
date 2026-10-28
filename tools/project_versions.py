"""Generate version metadata and web cache keys from src/config/version.h."""
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import quote


ASSET_REF = re.compile(
    r'''(?P<prefix>\b(?:src|href)\s*=\s*["'])(?P<path>[A-Za-z0-9_./-]+\.(?:css|js|svg))'''
    r'''(?:\?[^"']*)?(?P<suffix>["'])''', re.IGNORECASE)
WEB_ASSET_TYPES = {'.html', '.css', '.js', '.svg', '.png', '.jpg', '.jpeg',
                   '.webp', '.gif', '.ico', '.woff', '.woff2'}


def read_versions(header):
    text = Path(header).read_text(encoding='utf-8')

    def macro(name):
        match = re.search(rf'^\s*#\s*define\s+{re.escape(name)}\s+(?:"([^"]+)"|(\d+))\s*$',
                          text, re.MULTILINE)
        if not match:
            raise RuntimeError(f'Missing {name} in {header}')
        return match.group(1) if match.group(1) is not None else int(match.group(2))

    versions = {name: macro(name) for name in ('APP_VERSION', 'WEB_UI_VERSION',
                'WEB_API_VERSION', 'WEB_UI_MIN_API_VERSION', 'WEB_UI_MAX_API_VERSION')}
    for name in ('APP_VERSION', 'WEB_UI_VERSION'):
        if not isinstance(versions[name], str) or not re.fullmatch(r'[A-Za-z0-9._+-]+', versions[name]):
            raise RuntimeError(f'{name} must be a nonempty release version string')
    for name in ('WEB_API_VERSION', 'WEB_UI_MIN_API_VERSION', 'WEB_UI_MAX_API_VERSION'):
        if not isinstance(versions[name], int) or versions[name] < 1:
            raise RuntimeError(f'{name} must be a positive integer')
    if versions['WEB_UI_MIN_API_VERSION'] > versions['WEB_UI_MAX_API_VERSION']:
        raise RuntimeError('WebUI minimum API version exceeds its maximum')
    return versions


def rewrite_asset_urls(text, query=''):
    return ASSET_REF.sub(lambda m: m['prefix'] + m['path'] + query + m['suffix'], text)


def asset_revision(data_dir):
    digest = hashlib.sha256()
    for path in sorted(Path(data_dir).rglob('*')):
        if not path.is_file() or path.suffix.lower() not in WEB_ASSET_TYPES:
            continue
        # Normalize generated query strings so repeated builds remain identical.
        content = (rewrite_asset_urls(path.read_text(encoding='utf-8')).encode('utf-8')
                   if path.suffix.lower() == '.html' else path.read_bytes())
        digest.update(path.relative_to(data_dir).as_posix().encode('utf-8') + b'\0')
        digest.update(len(content).to_bytes(8, 'big'))
        digest.update(content)
    return digest.hexdigest()[:12]


def write_if_changed(path, content):
    if not path.exists() or path.read_text(encoding='utf-8') != content:
        path.write_text(content, encoding='utf-8', newline='\n')


def generate_web_metadata(project_dir):
    project_dir = Path(project_dir)
    versions = read_versions(project_dir / 'src/config/version.h')
    data_dir = project_dir / 'data'
    revision = asset_revision(data_dir)
    query = '?v=' + quote(versions['WEB_UI_VERSION'], safe='._-') + '&amp;ui=' + revision
    for path in sorted(data_dir.rglob('*.html')):
        write_if_changed(path, rewrite_asset_urls(path.read_text(encoding='utf-8'), query))
    manifest = dict(schemaVersion=1, webuiVersion=versions['WEB_UI_VERSION'],
                    requiresFirmwareApi={'min': versions['WEB_UI_MIN_API_VERSION'],
                                         'max': versions['WEB_UI_MAX_API_VERSION']})
    write_if_changed(data_dir / 'build-info.json', json.dumps(manifest, indent=2) + '\n')
    # Update current-release markers in both languages, never historical examples.
    for name, label in (('README.md', 'Current version'), ('README.hu.md', 'Jelenlegi verzió')):
        readme = project_dir / name
        if readme.exists():
            text = readme.read_text(encoding='utf-8')
            text = re.sub(rf'(?m)(^> {re.escape(label)}: \*\*)[^*]+(\*\*)',
                          lambda m: m[1] + versions['APP_VERSION'] + m[2], text)
            write_if_changed(readme, text)
    return versions, revision
