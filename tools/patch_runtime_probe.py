"""Opt-in measurement build: observe, never replace or retry an I2S write.

Runs after patch_audio_output.py. The separate measurement build enables this;
normal dependencies and normal audio paths retain their previous behaviour.
"""
import hashlib
from pathlib import Path
import re
import shutil

INCLUDE = '#include "SimpleRadioRuntimeProbe.h"\n'
HASH = 'bce32e20bdc48017a0c21df8b3caf06ca36108520ddf1d5367a514da437d4ddd'
START = 'i2swrite:\n'
END = '    // ---- statistics, bytes written to I2S (every 10s)'

def patch_write_source(source):
    source = source.replace('\r\n', '\n')
    matches = list(re.finditer(r'(?ms)^void IRAM_ATTR Audio::playChunk\(.*?^}', source))
    if len(matches) != 1: raise RuntimeError('Runtime probe: unfamiliar playChunk')
    match = matches[0]; function = match.group()
    prefix = START + '    {\n    const uint32_t probeStartedUs = micros();\n'
    suffix = ('    RuntimeProbe::written(m_validSamples * BYTES_PER_STEREOFRAME, '
              'm_plCh.i2s_bytesConsumed, m_plCh.err, micros() - probeStartedUs);\n    }\n\n' + END)
    already = INCLUDE in source
    original = function
    if already:
        if function.count(prefix) != 1 or function.count(suffix) != 1:
            raise RuntimeError('Runtime probe: incomplete patch')
        original = function.replace(prefix, START).replace(suffix, END)
    if hashlib.sha256(original.encode()).hexdigest() != HASH:
        raise RuntimeError('Runtime probe: pinned playChunk changed')
    if already: return source
    function = original.replace(START, prefix, 1).replace(END, suffix, 1)
    if function == original: raise RuntimeError('Runtime probe: missing anchor')
    source = source[:match.start()] + function + source[match.end():]
    anchor = '#include "SimpleRadioAudioOutput.h"\n'
    if source.count(anchor) != 1: raise RuntimeError('Runtime probe: output hook must run first')
    return source.replace(anchor, anchor + INCLUDE, 1)

DECODER_HASH = '5810981301359377df1f7a4d92c0a7ab34d7c14afb75d46a6923208df48552d8'
DECODER_OLD = '''        xSemaphoreTake(mutex_audioTask, 0.3 * configTICK_RATE_HZ);
        playAudioData();'''
DECODER_NEW = '''        const uint32_t probeStart = micros();
        xSemaphoreTake(mutex_audioTask, 0.3 * configTICK_RATE_HZ);
        const uint32_t probeAcquired = micros();
        const bool probePending = m_validSamples != 0;
        playAudioData();
        RuntimeProbe::decoder(probeStart, probeAcquired, micros(), m_pad.bytesToDecode,
                              InBuff.getMaxBlockSize(), probePending);'''

def patch_source(source):
    source = patch_write_source(source)
    matches=list(re.finditer(r'(?ms)^void Audio::performAudioTask\(.*?^}',source))
    if len(matches)!=1: raise RuntimeError('Runtime probe: missing decoder task')
    match=matches[0];function=match.group();original=function.replace(DECODER_NEW,DECODER_OLD)
    if hashlib.sha256(original.encode()).hexdigest()!=DECODER_HASH:
        raise RuntimeError('Runtime probe: pinned decoder task changed')
    if DECODER_NEW in function:return source
    if function.count(DECODER_OLD)!=1:raise RuntimeError('Runtime probe: decoder anchor changed')
    return source[:match.start()]+function.replace(DECODER_OLD,DECODER_NEW,1)+source[match.end():]

if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        root = Path(env.subst('$PROJECT_DIR'))
        target = Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env.subst('$PIOENV') / 'ESP32-audioI2S/src'
        source = target / 'Audio.cpp'
        original = source.read_text(encoding='utf-8'); patched = patch_source(original)
        if patched != original: source.write_text(patched, encoding='utf-8', newline='\n')
        shutil.copyfile(root / 'src/diagnostics/runtime_probe.h', target / 'SimpleRadioRuntimeProbe.h')
        print('SimpleRadio runtime probe: read-only I2S write measurements enabled')
