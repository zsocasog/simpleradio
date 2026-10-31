"""Bound connection waits and make header polling cooperative in pinned audio.

No decoder, PCM, HLS resolution, trust setting or library version changes.
All modified functions are checked against the exact pinned upstream content.
"""
import hashlib
from pathlib import Path
import re
import shutil

INCLUDE = '#include "SimpleRadioAudioNetwork.h"\n'
PATCHES = {
    'void Audio::setConnectionTimeout(': (
        '732787dcf4a8ada041536389d9910d5ac19927cca63bb27e24946aeeeb7091d6',
        ('    if (timeout_ms_ssl) m_timeout_ms_ssl = timeout_ms_ssl;\n',
         '    if (timeout_ms_ssl) m_timeout_ms_ssl = timeout_ms_ssl;\n'
         '    // SimpleRadio: bound the actual TCP and TLS waits, not only reads.\n'
         '    client.setConnectionTimeout(m_timeout_ms);\n'
         '    clientsecure.setConnectionTimeout(m_timeout_ms_ssl);\n'
         '    clientsecure.setHandshakeTimeout((max<uint32_t>(6000, m_timeout_ms_ssl) + 999) / 1000);\n')),
    'bool Audio::connecttohost(': (
        '046dbf8b9edc1b954a30ab4d3ae1d69b949e814137e648cf572acea376cd4d29',
        ('    ps_ptr<char> c_host = host; // copy of host\n',
         '    if (!SimpleRadioAudio::serviceNetwork(true)) { stopSong(); return false; }\n'
         '    ps_ptr<char> c_host = host; // copy of host\n')),
    'bool Audio::httpPrint(': (
        'a8c39b0f470110206f33a29697479be58cfe0b6f15be81dd96065a24f9de4913',
        ('    ps_ptr<char> c_host = host; // copy of host\n',
         '    if (!SimpleRadioAudio::serviceNetwork(true)) { stopSong(); return false; }\n'
         '    ps_ptr<char> c_host = host; // copy of host\n')),
    'bool Audio::parseHttpResponseHeader(': (
        'c4acdafb9b9a4341e3d8466fe8bf438bf4c86211689ac546177d534fe79d7728',
        ('    while (true) { // read the header first and store it in m_httpRespHdrBuff\n',
         '    while (true) { // read the header first and store it in m_httpRespHdrBuff\n'
         '        if (!SimpleRadioAudio::serviceNetwork()) {\n'
         '            m_f_timeout = false;\n'
         '            m_f_running = false;\n'
         '            m_client->stop();\n'
         '            return false;\n'
         '        }\n')),
}


def patch_source(source):
    source = source.replace('\r\n', '\n')
    modified = False
    for signature, (expected_hash, (old, new)) in PATCHES.items():
        matches = list(re.finditer(r'(?ms)^' + re.escape(signature) + r'.*?^}', source))
        if len(matches) != 1:
            raise RuntimeError('Audio network fix: missing/duplicate ' + signature)
        match = matches[0]
        function = match.group()
        original = function.replace(new, old)
        if hashlib.sha256(original.encode()).hexdigest() != expected_hash:
            raise RuntimeError('Audio network fix: unfamiliar pinned source: ' + signature)
        if new in function:
            if function.count(new) != 1:
                raise RuntimeError('Audio network fix: duplicate patch: ' + signature)
            continue
        if function.count(old) != 1:
            raise RuntimeError('Audio network fix: unexpected block: ' + signature)
        source = source[:match.start()] + function.replace(old, new) + source[match.end():]
        modified = True
    if INCLUDE not in source:
        if not modified or source.count('#include "Audio.h"\n') != 1:
            raise RuntimeError('Audio network fix: missing include')
        source = source.replace('#include "Audio.h"\n', '#include "Audio.h"\n' + INCLUDE, 1)
    if source.count(INCLUDE) != 1:
        raise RuntimeError('Audio network fix: duplicate include')
    return source


def apply_patch_to_dependency(env):
    root = Path(env.subst('$PROJECT_DIR'))
    source_dir = Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env.subst('$PIOENV') / 'ESP32-audioI2S' / 'src'
    audio = source_dir / 'Audio.cpp'
    original = audio.read_text(encoding='utf-8')
    patched = patch_source(original)
    header = root / 'src/audio/audio_network_control.h'
    target = source_dir / 'SimpleRadioAudioNetwork.h'
    if not target.is_file() or target.read_bytes() != header.read_bytes():
        shutil.copyfile(header, target)
    if patched != original:
        audio.write_text(patched, encoding='utf-8', newline='\n')
    print('SimpleRadio audio: bounded connection and cooperative headers verified')


if 'Import' in globals():
    Import('env')
    if not env.IsIntegrationDump() and 'clean' not in globals().get('COMMAND_LINE_TARGETS', []):
        apply_patch_to_dependency(env)
