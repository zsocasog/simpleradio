from pathlib import Path
import re
import shutil

Import("env")

PROJECT_DIR = Path(env.subst("$PROJECT_DIR"))
CONFIG_PATH = PROJECT_DIR / "src" / "config" / "hardware_config.h"
DATA_DIR = PROJECT_DIR / "data"
I18N_DIR = DATA_DIR / "i18n"
TARGET_PATH = DATA_DIR / "i18n.js"


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
