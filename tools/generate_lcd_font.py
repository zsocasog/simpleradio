from pathlib import Path
from PIL import Image, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "display" / "lcd_font_data.h"
FONT_REGULAR = Path(r"C:\Windows\Fonts\NotoSans-Regular.ttf")
FONT_BOLD = Path(r"C:\Windows\Fonts\NotoSans-Bold.ttf")

ASCII = "".join(chr(c) for c in range(32, 127))
HUNGARIAN = "ÁÉÍÓÖŐÚÜŰáéíóöőúüű"
PUNCT = "\u00a0°–—‘’“”…•×"
CHARS = sorted(set(ASCII + HUNGARIAN + PUNCT), key=ord)

FONTS = [
    ("Small", FONT_REGULAR, 12),
    ("Medium", FONT_REGULAR, 20),
    ("Artist", FONT_REGULAR, 22),
    ("Title", FONT_BOLD, 28),
    ("Large", FONT_BOLD, 32),
]


def pack_alpha(image):
    pixels = list(image.getdata())
    out = []
    for i in range(0, len(pixels), 2):
        hi = pixels[i] >> 4
        lo = pixels[i + 1] >> 4 if i + 1 < len(pixels) else 0
        out.append((hi << 4) | lo)
    return out


def glyph_for(font, ch):
    if ch == " ":
        bbox = font.getbbox(ch)
        return {
            "code": ord(ch),
            "width": 0,
            "height": 0,
            "x_offset": 0,
            "y_offset": 0,
            "x_advance": max(1, round(font.getlength(ch))),
            "data": [],
        }

    bbox = font.getbbox(ch)
    if bbox is None:
        bbox = (0, 0, 0, 0)
    left, top, right, bottom = bbox
    width = max(0, right - left)
    height = max(0, bottom - top)
    image = Image.new("L", (width, height), 0)
    draw_font = ImageFont.FreeTypeFont(font.path, font.size)
    from PIL import ImageDraw

    draw = ImageDraw.Draw(image)
    draw.text((-left, -top), ch, fill=255, font=draw_font)
    return {
        "code": ord(ch),
        "width": width,
        "height": height,
        "x_offset": left,
        "y_offset": top,
        "x_advance": max(1, round(font.getlength(ch))),
        "data": pack_alpha(image),
    }


def emit_array(name, values, per_line=16):
    lines = [f"static const uint8_t {name}[] PROGMEM = {{"]
    for i in range(0, len(values), per_line):
        chunk = values[i : i + per_line]
        lines.append("  " + ", ".join(f"0x{value:02x}" for value in chunk) + ",")
    lines.append("};")
    return "\n".join(lines)


def main():
    if not FONT_REGULAR.exists() or not FONT_BOLD.exists():
        raise SystemExit("NotoSans fonts not found in C:\\Windows\\Fonts")

    body = [
        "#pragma once",
        "#include <Arduino.h>",
        "",
        "struct LcdGlyph {",
        "  uint16_t code;",
        "  uint16_t offset;",
        "  uint8_t width;",
        "  uint8_t height;",
        "  int8_t xOffset;",
        "  int8_t yOffset;",
        "  uint8_t xAdvance;",
        "};",
        "",
        "struct LcdFont {",
        "  const LcdGlyph* glyphs;",
        "  const uint8_t* bitmap;",
        "  uint16_t glyphCount;",
        "  uint8_t lineHeight;",
        "  uint8_t baseline;",
        "};",
        "",
    ]

    font_names = []
    for suffix, font_path, size in FONTS:
        font = ImageFont.truetype(str(font_path), size)
        ascent, descent = font.getmetrics()
        glyphs = []
        bitmap = []
        for ch in CHARS:
            glyph = glyph_for(font, ch)
            glyph["offset"] = len(bitmap)
            bitmap.extend(glyph["data"])
            glyphs.append(glyph)

        bitmap_name = f"kLcdFont{suffix}Bitmap"
        glyph_name = f"kLcdFont{suffix}Glyphs"
        font_name = f"kLcdFont{suffix}"
        font_names.append(font_name)

        body.append(emit_array(bitmap_name, bitmap))
        body.append("")
        body.append(f"static const LcdGlyph {glyph_name}[] PROGMEM = {{")
        for glyph in glyphs:
            body.append(
                "  "
                + "{"
                + f"0x{glyph['code']:04x}, {glyph['offset']}, {glyph['width']}, {glyph['height']}, "
                + f"{glyph['x_offset']}, {glyph['y_offset']}, {glyph['x_advance']}"
                + "},"
            )
        body.append("};")
        body.append("")
        line_height = ascent + descent
        body.append(
            f"static const LcdFont {font_name} PROGMEM = "
            + "{"
            + f"{glyph_name}, {bitmap_name}, {len(glyphs)}, {line_height}, {ascent}"
            + "};"
        )
        body.append("")

    OUT.write_text("\n".join(body), encoding="utf-8", newline="\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
