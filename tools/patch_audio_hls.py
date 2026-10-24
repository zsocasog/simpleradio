"""Reproducible, version-guarded URL fix for the pinned ESP32-audioI2S.

Only master-playlist redirection changes; decoding and task timing stay intact.
The dependency remains pinned, and no extra playlist fetch is introduced.
"""

import hashlib
from pathlib import Path
import re
import shutil

ORIGINAL_HASH = "1ef3da481e3cf485c758f1e5f255c9fa20b9fc2e4a28aceaab0b3eb01f48d9ec"
INCLUDE = '#include "SimpleRadioHlsUrl.h"\n'
MARKER = "// SimpleRadio: bounded HLS URL resolution, no additional requests."
ORIGINAL_URL_BLOCK = '''    if (line.starts_with("../")) {
        // ../../2093120-b/RISMI/stream01/streamPlaylist.m3u8
        while (line.starts_with("../")) { line.remove_prefix("../"); }
        result.clone_from(m_currentHost);
        int idx = result.last_index_of('/');
        if (idx > 0 && (size_t)idx != result.strlen() - 1) result.truncate_at((size_t)idx + 1);
        result.append(line.get());
    } else if (!line.starts_with_icase("http")) {

        // http://arcast.com.ar:1935/radio/radionar.stream/playlist.m3u8               m_lastHost
        // chunklist_w789468022.m3u8                                                   line
        // http://arcast.com.ar:1935/radio/radionar.stream/chunklist_w789468022.m3u8   --> result

        result.clone_from(m_currentHost);
        int pos = m_currentHost.last_index_of('/');
        if (pos > 0) {
            result.truncate_at((size_t)pos + 1);
            result.append(line.get());
        }
    } else {
        result.clone_from(line);
    }
'''
PATCHED_URL_BLOCK = '''    // SimpleRadio: bounded HLS URL resolution, no additional requests.
    const auto resolved = SimpleRadioHls::resolve(m_currentHost.get(), line.get());
    if (!resolved.valid) {
        AUDIO_LOG_ERROR("HLS playlist URL could not be resolved");
        return {};
    }
    result.clone_from(resolved.text);
'''


def patch_source(source):
    source = source.replace("\r\n", "\n")
    matches = list(re.finditer(r"(?ms)^ps_ptr<char> Audio::m3u8redirection\(uint8_t\* codec\) \{.*?^\}", source))
    if len(matches) != 1:
        raise RuntimeError("HLS fix: expected exactly one pinned m3u8redirection function")
    match = matches[0]
    function = match.group()
    original = function.replace(PATCHED_URL_BLOCK, ORIGINAL_URL_BLOCK)
    if hashlib.sha256(original.encode("utf-8")).hexdigest() != ORIGINAL_HASH:
        raise RuntimeError("HLS fix: unfamiliar audio source; review the patch before changing the library")
    if MARKER in function:
        if function.count(PATCHED_URL_BLOCK) != 1 or source.count(INCLUDE) != 1:
            raise RuntimeError("HLS fix: incomplete existing patch")
        return source
    if function.count(ORIGINAL_URL_BLOCK) != 1 or INCLUDE in source:
        raise RuntimeError("HLS fix: unexpected URL block/include")
    function = function.replace(ORIGINAL_URL_BLOCK, PATCHED_URL_BLOCK)
    source = source[:match.start()] + function + source[match.end():]
    if source.count('#include "Audio.h"\n') != 1:
        raise RuntimeError("HLS fix: audio header include not found")
    return source.replace('#include "Audio.h"\n', '#include "Audio.h"\n' + INCLUDE, 1)


def apply_patch_to_dependency(env):
    source_dir = Path(env.subst("$PROJECT_LIBDEPS_DIR")) / env.subst("$PIOENV") / "ESP32-audioI2S" / "src"
    audio_path = source_dir / "Audio.cpp"
    if not audio_path.is_file():
        raise RuntimeError("HLS fix: pinned ESP32-audioI2S dependency was not installed")
    original = audio_path.read_text(encoding="utf-8")
    patched = patch_source(original)
    header = Path(env.subst("$PROJECT_DIR")) / "src" / "audio" / "hls_url.h"
    target = source_dir / "SimpleRadioHlsUrl.h"
    if not target.is_file() or target.read_bytes() != header.read_bytes():
        shutil.copyfile(header, target)
    if patched != original:
        audio_path.write_text(patched, encoding="utf-8", newline="\n")
    print("SimpleRadio HLS: pinned-library URL resolution fix verified")


# SCons injects Import; ordinary imports remain side-effect free for tests.
if "Import" in globals():
    Import("env")
    if not env.IsIntegrationDump() and "clean" not in globals().get("COMMAND_LINE_TARGETS", []):
        apply_patch_to_dependency(env)
