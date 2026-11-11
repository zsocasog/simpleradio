"""Hoist verified FLAC sample bounds out of the LPC inner loop.

The pinned decoder checks/logs ps_ptr[] bounds for every coefficient of every
sample. Validate the complete span once, then use the same int64_t arithmetic.
The original checked path remains verbatim for an invalid/short allocation.
No codec settings, sample buffers, allocation or task scheduling change.
"""
import hashlib
from pathlib import Path
import re

HASH = '9a47b54fc89241beb17cfa6998f4202d12c8c825d21f6273d3e0fb95cec92d20'
BUFFER_HASH = '68275dc6939655b3e88cc6a91731555fd76343c6bd01353387eea249aacf086d'
FAST = '''    // SimpleRadio: one span check, identical 64-bit LPC math.
    const size_t count = m_numOfOutSamples;
    // ps_ptr::size() reports allocated bytes, not an element count.
    if (ch < FLAC_MAX_CHANNELS && m_samplesBuffer[ch].get() &&
        count <= m_samplesBuffer[ch].size() / sizeof(int64_t)) {
        int64_t* const samples = m_samplesBuffer[ch].get();
        const int32_t* const coefficients = coefs.data();
        const int32_t order = static_cast<int32_t>(coefs.size());
        for (int32_t i = order; i < m_numOfOutSamples; i++) {
            int64_t sum = 0;
            for (int32_t j = 0; j < order; j++) { sum += samples[i - 1 - j] * coefficients[j]; }
            samples[i] += (sum >> shift);
        }
        return;
    }
'''


def verify_buffer_header(source):
    if hashlib.sha256(source.replace('\r\n', '\n').encode()).hexdigest() != BUFFER_HASH:
        raise RuntimeError('FLAC prediction: unfamiliar sample buffer size/bounds semantics')


def patch_source(source):
    source = source.replace('\r\n', '\n')
    matches = list(re.finditer(r'(?ms)^void FlacDecoder::restoreLinearPrediction\(.*?^}', source))
    if len(matches) != 1:
        raise RuntimeError('FLAC prediction: missing/duplicate pinned function')
    match = matches[0]
    function = match.group()
    original = function.replace(FAST, '')
    if hashlib.sha256(original.encode()).hexdigest() != HASH:
        raise RuntimeError('FLAC prediction: unfamiliar pinned function')
    if FAST in function:
        return source
    if 'SimpleRadio: one span check' in function:
        raise RuntimeError('FLAC prediction: incomplete patch')
    opening = function.index('\n') + 1
    return source[:match.start()] + function[:opening] + FAST + function[opening:] + source[match.end():]


if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        path = (Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env.subst('$PIOENV') /
                'ESP32-audioI2S/src/flac_decoder/flac_decoder.cpp')
        verify_buffer_header((path.parent.parent / 'psram_unique_ptr.hpp').read_text(encoding='utf-8'))
        original = path.read_text(encoding='utf-8')
        patched = patch_source(original)
        if patched != original:
            path.write_text(patched, encoding='utf-8', newline='\n')
        print('SimpleRadio FLAC: once-checked LPC span, identical int64 math verified')
