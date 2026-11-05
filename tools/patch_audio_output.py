"""Read-only DMA observation in the exact pinned audio library.

No write, decoder, timeout, gain or buffer configuration changes. The four
reviewed lifecycle hooks are hash guarded and compose with HLS/network fixes.
"""
import hashlib
from pathlib import Path
import re
import shutil

INCLUDE = '#include "SimpleRadioAudioOutput.h"\n'
PATCHES = {
    'bool Audio::i2s_config(': (
        '76ba1f20f0c32666d28ce467d1dbbb1fd04e1433cbdb53b6fef066f75efd75ac',
        [('    return true;\n',
          '    // SimpleRadio: read-only notification of samples actually sent.\n'
          '    if (!SimpleRadioAudioOutput::attach(m_i2s_tx_handle)) AUDIO_LOG_ERROR("Spectrum output observer unavailable");\n'
          '    return true;\n')]),
    'esp_err_t Audio::I2Sstart(': (
        'c1791edd4060e0df4792b51971083d12f4a85a0c46a0dd44d0a678a8b2e98d33',
        [('        err = i2s_channel_enable(m_i2s_tx_handle);\n',
          '        SimpleRadioAudioOutput::start(m_i2s_std_cfg.clk_cfg.sample_rate_hz);\n'
          '        err = i2s_channel_enable(m_i2s_tx_handle);\n')]),
    'esp_err_t Audio::I2Sstop(': (
        '7913f31b0f9eef66f1abac92462cbb3059e46dc3e02efce74dfe7b104abf5938',
        [('    m_outBuff.clear();', '    SimpleRadioAudioOutput::stop();\n    m_outBuff.clear();')]),
    'void Audio::reconfigI2S(': (
        'cf118c55579a73eb3d12698de0893b436dd1f35b13aecacefd917c4a3523acd6',
        [('    i2s_channel_disable(m_i2s_tx_handle);\n',
          '    SimpleRadioAudioOutput::stop();\n    i2s_channel_disable(m_i2s_tx_handle);\n'),
         ('    i2s_channel_enable(m_i2s_tx_handle);\n',
          '    SimpleRadioAudioOutput::start(m_i2s_std_cfg.clk_cfg.sample_rate_hz);\n'
          '    i2s_channel_enable(m_i2s_tx_handle);\n')]),
}


def patch_source(source):
    source = source.replace('\r\n', '\n')
    already = INCLUDE in source
    for signature, (expected_hash, blocks) in PATCHES.items():
        matches = list(re.finditer(r'(?ms)^' + re.escape(signature) + r'.*?^}', source))
        if len(matches) != 1:
            raise RuntimeError('Audio output observer: missing/duplicate ' + signature)
        match = matches[0]
        function = match.group()
        if not already and any(new in function for _, new in blocks):
            raise RuntimeError('Audio output observer: hook without include ' + signature)
        original = function
        for old, new in blocks:
            if already and original.count(new) != 1:
                raise RuntimeError('Audio output observer: incomplete patch ' + signature)
            original = original.replace(new, old)
        if hashlib.sha256(original.encode()).hexdigest() != expected_hash:
            raise RuntimeError('Audio output observer: unfamiliar pinned source ' + signature)
        if already:
            continue
        function = original
        for old, new in blocks:
            if function.count(old) != 1:
                raise RuntimeError('Audio output observer: ambiguous block ' + signature)
            function = function.replace(old, new)
        source = source[:match.start()] + function + source[match.end():]
    if not already:
        if source.count('#include "Audio.h"\n') != 1:
            raise RuntimeError('Audio output observer: missing library include')
        source = source.replace('#include "Audio.h"\n', '#include "Audio.h"\n' + INCLUDE, 1)
    if source.count(INCLUDE) != 1:
        raise RuntimeError('Audio output observer: duplicate include')
    return source


def apply_patch_to_dependency(env):
    root = Path(env.subst('$PROJECT_DIR'))
    source_dir = Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env.subst('$PIOENV') / 'ESP32-audioI2S' / 'src'
    audio = source_dir / 'Audio.cpp'
    original = audio.read_text(encoding='utf-8')
    patched = patch_source(original)
    header = root / 'src/audio/audio_output.h'
    target = source_dir / 'SimpleRadioAudioOutput.h'
    if not target.is_file() or target.read_bytes() != header.read_bytes():
        shutil.copyfile(header, target)
    if patched != original:
        audio.write_text(patched, encoding='utf-8', newline='\n')
    print('SimpleRadio audio: pinned read-only I2S output observer verified')


if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        apply_patch_to_dependency(env)
