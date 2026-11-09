"""Avoid copying the immutable FLAC bit mask on every bit-reader call.

The pinned S3 compiler emits a 132-byte memcpy per call for the original
automatic array. Static const keeps the exact values and bit-reader logic,
without allocating heap/DMA memory or changing codec/library versions.
"""
import hashlib
from pathlib import Path
import re

HASH = 'a8ed1458b82cea19ee6fe6cb9448106b2c625c9dd81fd24ba35421057b09c6af'
OLD = '    const uint32_t mask[33] = '
NEW = '    static const uint32_t mask[33] = '


def patch_source(source):
    source = source.replace('\r\n', '\n')
    matches = list(re.finditer(r'(?ms)^uint32_t FlacDecoder::readUint\(.*?^}', source))
    if len(matches) != 1:
        raise RuntimeError('FLAC mask: missing/duplicate pinned bit reader')
    match = matches[0]
    function = match.group()
    original = function.replace(NEW, OLD)
    if hashlib.sha256(original.encode()).hexdigest() != HASH:
        raise RuntimeError('FLAC mask: unfamiliar pinned bit reader')
    if NEW in function:
        return source
    if function.count(OLD) != 1:
        raise RuntimeError('FLAC mask: ambiguous table')
    return source[:match.start()] + function.replace(OLD, NEW, 1) + source[match.end():]


if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        source = (Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env.subst('$PIOENV') /
                  'ESP32-audioI2S/src/flac_decoder/flac_decoder.cpp')
        original = source.read_text(encoding='utf-8')
        patched = patch_source(original)
        if patched != original:
            source.write_text(patched, encoding='utf-8', newline='\n')
        print('SimpleRadio FLAC: immutable bit mask, no per-read table copy verified')
