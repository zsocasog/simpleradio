from pathlib import Path
import re
import shutil

Import("env")

PROJECT_DIR = Path(env.subst("$PROJECT_DIR"))
CONFIG_PATH = PROJECT_DIR / "src" / "config" / "hardware_config.h"
VERSION_PATH = PROJECT_DIR / "src" / "config" / "version.h"
DATA_DIR = PROJECT_DIR / "data"
I18N_DIR = DATA_DIR / "i18n"
TARGET_PATH = DATA_DIR / "i18n.js"
BUILD_INFO_PATH = DATA_DIR / "build-info.json"


def selected_language():
    if not CONFIG_PATH.exists():
        return "hu"
    text = CONFIG_PATH.read_text(encoding="utf-8", errors="ignore")
    match = re.search(r"^\s*#\s*define\s+UI_LANGUAGE\s+([A-Za-z0-9_]+)\s*$", text, re.MULTILINE)
    if not match:
        match = re.search(r"^\s*#\s*define\s+SIMPLE_RADIO_LANGUAGE\s+([A-Za-z0-9_]+)\s*$", text, re.MULTILINE)
    lang = match.group(1).strip().lower() if match else "hu"
    return {"eng": "en"}.get(lang, lang)


lang = selected_language()
source_path = I18N_DIR / f"{lang}.js"

if not source_path.exists():
    raise RuntimeError(
        f"Missing web UI language file: {source_path}. "
        "Copy data/i18n/template.js to that name and translate it."
    )

shutil.copyfile(source_path, TARGET_PATH)
print(f"SimpleRadio language: {lang} -> {TARGET_PATH.relative_to(PROJECT_DIR)}")


def version_macro(name, default=None):
    text = VERSION_PATH.read_text(encoding="utf-8", errors="ignore")
    match = re.search(rf'^\s*#\s*define\s+{re.escape(name)}\s+(?:"([^"]+)"|(\d+))\s*$', text, re.MULTILINE)
    if not match:
        if default is not None:
            return default
        raise RuntimeError(f"Missing {name} in {VERSION_PATH}")
    return match.group(1) if match.group(1) is not None else int(match.group(2))


build_info = (
    "{\n"
    "  \"schemaVersion\": 1,\n"
    f"  \"webuiVersion\": \"{version_macro('APP_VERSION')}\",\n"
    "  \"requiresFirmwareApi\": {\n"
    f"    \"min\": {version_macro('WEB_UI_MIN_API_VERSION')},\n"
    f"    \"max\": {version_macro('WEB_UI_MAX_API_VERSION')}\n"
    "  }\n"
    "}\n"
)
if not BUILD_INFO_PATH.exists() or BUILD_INFO_PATH.read_text(encoding="utf-8", errors="ignore") != build_info:
    BUILD_INFO_PATH.write_text(build_info, encoding="utf-8", newline="\n")
print(f"SimpleRadio WebUI manifest: {BUILD_INFO_PATH.relative_to(PROJECT_DIR)}")
