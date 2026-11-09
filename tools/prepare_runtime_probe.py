"""Create an isolated opt-in measurement build; never flash a device."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
ENV = 'esp32-s3-devkitc1-n16r8'

def prepare(destination):
    destination = destination.resolve()
    allowed = (ROOT / '.pio').resolve()
    if allowed not in destination.parents or destination == allowed:
        raise ValueError('Measurement build must be a fresh directory under this project .pio')
    if destination.exists(): raise FileExistsError(destination)
    destination.mkdir(parents=True)
    for folder in ('src', 'include', 'lib', 'tools', 'data'):
        shutil.copytree(ROOT / folder, destination / folder,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for name in ('secrets.ini', 'partitions_16mb_large_littlefs.csv'):
        shutil.copyfile(ROOT / name, destination / name)
    config = (ROOT / 'platformio.ini').read_text(encoding='utf-8')
    anchor = '    post:tools/patch_audio_output.py'
    if config.count(anchor) != 1: raise ValueError('Unknown build scripts')
    config = config.replace(anchor, anchor + '\n    post:tools/patch_runtime_probe.py')
    config = config.replace('build_flags =\n', 'build_flags =\n    -D SIMPLE_RADIO_RUNTIME_DIAGNOSTICS=1\n', 1)
    (destination / 'platformio.ini').write_text(config, encoding='utf-8')
    cached = ROOT / '.pio/libdeps' / ENV
    if cached.is_dir(): shutil.copytree(cached, destination / '.pio/libdeps' / ENV)
    hashes = {str(p.relative_to(destination)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (destination / 'src').rglob('*') if p.is_file()}
    (destination / 'source-hashes.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    return destination

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / '.pio/runtime-probe-project')
    args = parser.parse_args()
    print(prepare(args.out))
