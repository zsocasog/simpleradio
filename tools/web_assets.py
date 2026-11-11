"""Precompress WebUI text on the build PC; browsers decode it, never the ESP."""
import gzip
from pathlib import Path


def prepare_web_assets(data_dir):
    data_dir = Path(data_dir)
    assets = sorted(p for p in data_dir.iterdir() if p.is_file() and p.suffix in ('.js', '.css'))
    targets = {p.with_name(p.name + '.gz') for p in assets}
    # Only own top-level generated JS/CSS companions. Never touch uploads,
    # artwork, configuration, language sources or user-provided image files.
    for pattern in ('*.js.gz', '*.css.gz'):
        for stale in data_dir.glob(pattern):
            if stale not in targets:
                stale.unlink()
    plain = compressed = 0
    for source in assets:
        body = source.read_bytes()
        encoded = gzip.compress(body, compresslevel=9, mtime=0)
        target = source.with_name(source.name + '.gz')
        if not target.exists() or target.read_bytes() != encoded:
            target.write_bytes(encoded)
        plain += len(body)
        compressed += len(encoded)
    return len(assets), plain, compressed
