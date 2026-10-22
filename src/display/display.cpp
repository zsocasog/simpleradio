#include "display.h"
#include <LittleFS.h>
#include <LovyanGFX.hpp>
#include "../audio/audio_meter.h"
#include "../artwork/artwork_cache.h"
#include "../config/app_config.h"
#include "../config/hardware_config.h"
#include "../config/logging.h"
#include "../i18n/i18n.h"
#include "../config/pins.h"
#include "../led/status_led.h"
#include "../state/player_state.h"
#include "../stations/station_manager.h"
#include "../web/web_server.h"
#include "lcd_font_data.h"
#include <math.h>
#include <string.h>
#include <time.h>

static constexpr bool PANEL_REQUIRES_INVERT = DISPLAY_INVERT_PANEL;

class LGFX : public lgfx::LGFX_Device {
#if DISPLAY_DRIVER == DISPLAY_ILI9341
  lgfx::Panel_ILI9341 panel;
#elif DISPLAY_DRIVER == DISPLAY_ST7796
  lgfx::Panel_ST7796 panel;
#else
  lgfx::Panel_ILI9488 panel;
#endif
  lgfx::Bus_SPI bus;

public:
  LGFX() {
    auto b = bus.config();
    b.spi_host = DISPLAY_SPI_HOST;
    b.spi_mode = DISPLAY_SPI_MODE;
    b.freq_write = DISPLAY_SPI_WRITE_HZ;
    b.pin_sclk = TFT_SCLK;
    b.pin_mosi = TFT_MOSI;
    b.pin_miso = -1;
    b.pin_dc = TFT_DC;
    bus.config(b);
    panel.setBus(&bus);

    auto p = panel.config();
    p.pin_cs = TFT_CS;
    p.pin_rst = TFT_RST;
    p.panel_width = DISPLAY_PANEL_WIDTH;
    p.panel_height = DISPLAY_PANEL_HEIGHT;
    p.offset_x = DISPLAY_OFFSET_X;
    p.offset_y = DISPLAY_OFFSET_Y;
    p.invert = PANEL_REQUIRES_INVERT;
    panel.config(p);

    setPanel(&panel);
  }
};

static LGFX lcd;

static constexpr int BASE_SCREEN_W = 480;
static constexpr int BASE_SCREEN_H = 320;
static constexpr int SCREEN_W = DISPLAY_WIDTH;
static constexpr int SCREEN_H = DISPLAY_HEIGHT;
static constexpr int sx(int value) {
  return (value * SCREEN_W + BASE_SCREEN_W / 2) / BASE_SCREEN_W;
}
static constexpr int sy(int value) {
  return (value * SCREEN_H + BASE_SCREEN_H / 2) / BASE_SCREEN_H;
}
static constexpr int ss(int value) {
  int scaledX = sx(value);
  int scaledY = sy(value);
  return scaledX < scaledY ? scaledX : scaledY;
}
static constexpr bool COMPACT_LCD = SCREEN_W < 400 || SCREEN_H < 280;
static constexpr uint8_t FONT_SMALL = 1;
static constexpr uint8_t FONT_MEDIUM = COMPACT_LCD ? 1 : 2;
static constexpr uint8_t FONT_LARGE = COMPACT_LCD ? 2 : 3;
static constexpr int PLAYER_X = 0;
static constexpr int PLAYER_Y = 0;
static constexpr int PLAYER_W = SCREEN_W;
static constexpr int PLAYER_H = SCREEN_H;
static constexpr int ART_X = sx(22);
static constexpr int ART_Y = sy(52);
static constexpr int ART_SIZE = ss(176);
static constexpr int INFO_X = sx(214);
static constexpr int INFO_W = SCREEN_W - INFO_X - sx(22);
static constexpr int TITLE_CENTER_Y = sy(98);
static constexpr int ARTIST_CENTER_Y = sy(202);
static constexpr int BAR_Y = sy(290);
static constexpr int ART_REGION_X = ART_X - ss(6);
static constexpr int ART_REGION_Y = ART_Y - ss(6);
static constexpr int ART_REGION_W = ART_SIZE + ss(12);
static constexpr int ART_REGION_H = ART_SIZE + ss(12);
static constexpr int INFO_REGION_X = INFO_X - sx(8);
static constexpr int INFO_REGION_Y = sy(36);
static constexpr int INFO_REGION_W = SCREEN_W - INFO_REGION_X - sx(14);
static constexpr int INFO_REGION_H = sy(198);
static constexpr int FOOTER_REGION_X = 0;
static constexpr int FOOTER_REGION_Y = sy(252);
static constexpr int FOOTER_REGION_W = SCREEN_W;
static constexpr int FOOTER_REGION_H = SCREEN_H - FOOTER_REGION_Y;
static constexpr unsigned long METER_RENDER_MS = 42;
static constexpr int VU_BAR_COUNT = 24;
static constexpr int VU_HALF_COUNT = VU_BAR_COUNT / 2;
static constexpr int VU_BAR_W = ss(9);
static constexpr int VU_BAR_GAP = ss(7);
static constexpr int VU_BASELINE_Y = SCREEN_H - sy(13);
static constexpr int VU_MAX_H = sy(42);
static constexpr int VU_SYMMETRIC_CENTER_Y = SCREEN_H - sy(28);
static constexpr int VU_SYMMETRIC_MAX_H = sy(25);
static constexpr int VU_MIN_H = sy(2) > 1 ? sy(2) : 1;
static constexpr unsigned long VOLUME_SCREEN_MS = 5000;
static constexpr int VOLUME_DIAL_CX = SCREEN_W / 2;
static constexpr int VOLUME_DIAL_CY = sy(186);
static constexpr int VOLUME_DIAL_R = ss(112);
static constexpr int VOLUME_KNOB_R = ss(68);
static constexpr int VOLUME_TICK_COUNT = 20;
static constexpr float VOLUME_ARC_START_DEG = 165.0f;
static constexpr float VOLUME_ARC_SPAN_DEG = 210.0f;
static constexpr int VOLUME_POPUP_X = INFO_X + sx(2);
static constexpr int VOLUME_POPUP_Y = sy(126);
static constexpr int VOLUME_POPUP_W = SCREEN_W - VOLUME_POPUP_X - sx(20);
static constexpr int VOLUME_POPUP_H = sy(112);
static constexpr int VOLUME_METER_AXIS_Y = SCREEN_H / 2 + sy(4);
static constexpr int VOLUME_TITLE_Y = VOLUME_METER_AXIS_Y - VU_SYMMETRIC_MAX_H - sy(78);
static constexpr int VOLUME_VALUE_Y = VOLUME_METER_AXIS_Y + VU_SYMMETRIC_MAX_H + sy(58);
static constexpr unsigned long IDLE_LCD_GUARD_MS = 10UL * 60UL * 1000UL;
static constexpr unsigned long IDLE_LCD_GUARD_BLACK_MS = 450;
static constexpr int PICKER_BOX_X = 0;
static constexpr int PICKER_BOX_Y = 0;
static constexpr int PICKER_BOX_W = SCREEN_W;
static constexpr int PICKER_BOX_H = SCREEN_H;
static constexpr int PICKER_ROW_H = sy(48);
static constexpr int PICKER_VISIBLE_ROWS = 5;
static constexpr int PICKER_ROW_X = sx(26);
static constexpr int PICKER_ROW_W = SCREEN_W - sx(52);
static constexpr int PICKER_ROW_Y = sy(64);
static constexpr int PICKER_NUMBER_X = PICKER_ROW_X + sx(10);
static constexpr int PICKER_NUMBER_W = sx(48);
static constexpr int PICKER_TEXT_X = PICKER_ROW_X + PICKER_NUMBER_W + sx(20);
static constexpr int PICKER_TEXT_W = PICKER_ROW_X + PICKER_ROW_W - PICKER_TEXT_X - sx(10);
static constexpr int PICKER_TEXT_H = PICKER_ROW_H - sy(6);
static constexpr unsigned long PICKER_MARQUEE_MS = 110;
static constexpr unsigned long PICKER_MARQUEE_HOLD_MS = 650;
static constexpr int PICKER_MARQUEE_STEP = sx(4) > 2 ? sx(4) : 2;
static constexpr float CLOCK_PI = 3.14159265358979323846f;
static constexpr uint32_t DISPLAY_TASK_STACK = 12288;

static uint16_t cBg;
static uint16_t cPanel;
static uint16_t cPanelAlt;
static uint16_t cText;
static uint16_t cMuted;
static uint16_t cAccent;
static uint16_t cOnAccent;
static uint16_t cLine;
static const LcdFont* currentUiFont = &kLcdFontSmall;
static uint8_t vuBars[VU_BAR_COUNT] = {0};
static uint8_t renderedVuBars[VU_BAR_COUNT] = {0};
static bool vuRendered = false;
static uint8_t vuRenderedStyleKey = 255;
static int vuRenderedClearY = 0;
static int vuRenderedClearH = 0;
static uint16_t vuFrame = 0;
static uint16_t vuRefLevel = 80;
static uint8_t vuScaledL = 0;
static uint8_t vuScaledR = 0;
static uint8_t vuAutoIdleFrames = 0;
static bool vuAutoScaleReady = false;
static unsigned long lastVuRefReleaseMs = 0;
static uint8_t lastVuLevelL = 0;
static uint8_t lastVuLevelR = 0;
static uint8_t vuMotionL = 0;
static uint8_t vuMotionR = 0;
static uint8_t vuHistoryL[VU_HALF_COUNT] = {0};
static uint8_t vuHistoryR[VU_HALF_COUNT] = {0};
static unsigned long lastVuHistoryPushMs = 0;
static uint8_t volumeMeterBars[VU_BAR_COUNT] = {0};
static bool volumeRestoreInProgress = false;
static int32_t volumeMeterSweepUnits = 0;
static int8_t volumeMeterSweepDirection = 1;
static bool volumeMeterSweepActive = false;
static int32_t dateTimeFooterMinuteStamp = -1;
static unsigned long dateTimeFooterLastCheckMs = 0;
static bool dateTimeFooterRendered = false;
static bool analogClockHandsValid = false;
static float analogClockLastHourAngle = 0.0f;
static float analogClockLastMinuteAngle = 0.0f;
static float analogClockLastSecondAngle = 0.0f;
static const uint8_t kVuShape[VU_BAR_COUNT] = {
  92, 142, 204, 126, 232, 166,
  108, 190, 248, 154, 212, 116,
  132, 226, 172, 104, 198, 244,
  150, 214, 122, 184, 236, 138
};
static const uint8_t kVuSeed[VU_BAR_COUNT] = {
  11, 79, 147, 41, 203, 97,
  169, 23, 219, 131, 57, 187,
  31, 211, 103, 173, 13, 239,
  89, 151, 45, 197, 121, 7
};

struct GlyphInfo {
  uint16_t code = 0;
  uint32_t offset = 0;
  uint8_t width = 0;
  uint8_t height = 0;
  int8_t xOffset = 0;
  int8_t yOffset = 0;
  uint8_t xAdvance = 0;
};

static const LcdFont* uiFontForSize(uint8_t size) {
  if (size >= 3) return COMPACT_LCD ? &kLcdFontMedium : &kLcdFontLarge;
  if (size == 2) return COMPACT_LCD ? &kLcdFontSmall : &kLcdFontMedium;
  return &kLcdFontSmall;
}

static const LcdFont& titleFont() {
  return COMPACT_LCD ? kLcdFontArtist : kLcdFontTitle;
}

static const LcdFont& artistFont() {
  return COMPACT_LCD ? kLcdFontMedium : kLcdFontArtist;
}

static uint16_t blend565(uint16_t fg, uint16_t bg, uint8_t alpha) {
  if (alpha == 255) return fg;
  if (alpha == 0) return bg;

  uint8_t fr = ((fg >> 11) & 0x1F) * 255 / 31;
  uint8_t fg2 = ((fg >> 5) & 0x3F) * 255 / 63;
  uint8_t fb = (fg & 0x1F) * 255 / 31;
  uint8_t br = ((bg >> 11) & 0x1F) * 255 / 31;
  uint8_t bg2 = ((bg >> 5) & 0x3F) * 255 / 63;
  uint8_t bb = (bg & 0x1F) * 255 / 31;

  uint8_t r = (fr * alpha + br * (255 - alpha)) / 255;
  uint8_t g = (fg2 * alpha + bg2 * (255 - alpha)) / 255;
  uint8_t b = (fb * alpha + bb * (255 - alpha)) / 255;
  return lcd.color565(r, g, b);
}

static uint8_t fontLineHeight(const LcdFont& font) {
  return pgm_read_byte(&font.lineHeight);
}

static const LcdGlyph* fontGlyphs(const LcdFont& font) {
  return reinterpret_cast<const LcdGlyph*>(pgm_read_ptr(&font.glyphs));
}

static const uint8_t* fontBitmap(const LcdFont& font) {
  return reinterpret_cast<const uint8_t*>(pgm_read_ptr(&font.bitmap));
}

static uint16_t fontGlyphCount(const LcdFont& font) {
  return pgm_read_word(&font.glyphCount);
}

static uint32_t nextUtf8Codepoint(const char*& cursor) {
  uint8_t c = static_cast<uint8_t>(*cursor++);
  if (c < 0x80) return c;
  if ((c & 0xE0) == 0xC0) {
    uint8_t c2 = static_cast<uint8_t>(*cursor++);
    return ((c & 0x1F) << 6) | (c2 & 0x3F);
  }
  if ((c & 0xF0) == 0xE0) {
    uint8_t c2 = static_cast<uint8_t>(*cursor++);
    uint8_t c3 = static_cast<uint8_t>(*cursor++);
    return ((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F);
  }
  if ((c & 0xF8) == 0xF0) {
    cursor += 3;
  }
  return '?';
}

static bool readGlyphAt(const LcdFont& font, uint16_t index, GlyphInfo& out) {
  if (index >= fontGlyphCount(font)) return false;
  const LcdGlyph* glyph = &fontGlyphs(font)[index];
  out.code = pgm_read_word(&glyph->code);
  out.offset = pgm_read_dword(&glyph->offset);
  out.width = pgm_read_byte(&glyph->width);
  out.height = pgm_read_byte(&glyph->height);
  out.xOffset = static_cast<int8_t>(pgm_read_byte(&glyph->xOffset));
  out.yOffset = static_cast<int8_t>(pgm_read_byte(&glyph->yOffset));
  out.xAdvance = pgm_read_byte(&glyph->xAdvance);
  return true;
}

static bool findGlyph(const LcdFont& font, uint32_t code, GlyphInfo& out) {
  uint16_t lo = 0;
  uint16_t hi = fontGlyphCount(font);
  while (lo < hi) {
    uint16_t mid = lo + (hi - lo) / 2;
    GlyphInfo glyph;
    readGlyphAt(font, mid, glyph);
    if (glyph.code == code) {
      out = glyph;
      return true;
    }
    if (glyph.code < code) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return code != '?' && findGlyph(font, '?', out);
}

static int32_t uiTextWidth(const String& text, const LcdFont& font) {
  int32_t width = 0;
  const char* cursor = text.c_str();
  while (*cursor) {
    uint32_t code = nextUtf8Codepoint(cursor);
    GlyphInfo glyph;
    if (findGlyph(font, code, glyph)) width += glyph.xAdvance;
  }
  return width;
}

static int32_t uiTextWidth(const String& text) {
  return uiTextWidth(text, *currentUiFont);
}

static void drawUiText(const String& text, int32_t x, int32_t y, const LcdFont& font, uint16_t color, uint16_t bg, textdatum_t datum = top_left) {
  int32_t width = uiTextWidth(text, font);
  int32_t height = fontLineHeight(font);

  switch (datum) {
    case top_center:
      x -= width / 2;
      break;
    case top_right:
      x -= width;
      break;
    case middle_center:
      x -= width / 2;
      y -= height / 2;
      break;
    case middle_left:
      y -= height / 2;
      break;
    case middle_right:
      x -= width;
      y -= height / 2;
      break;
    case bottom_center:
      x -= width / 2;
      y -= height;
      break;
    case bottom_left:
      y -= height;
      break;
    case bottom_right:
      x -= width;
      y -= height;
      break;
    default:
      break;
  }

  int32_t penX = x;
  const char* cursor = text.c_str();
  const uint8_t* bitmap = fontBitmap(font);

  lcd.startWrite();
  while (*cursor) {
    uint32_t code = nextUtf8Codepoint(cursor);
    GlyphInfo glyph;
    if (!findGlyph(font, code, glyph)) continue;

    for (uint8_t row = 0; row < glyph.height; ++row) {
      for (uint8_t col = 0; col < glyph.width; ++col) {
        uint32_t pixelIndex = static_cast<uint32_t>(row) * glyph.width + col;
        uint8_t packed = pgm_read_byte(&bitmap[glyph.offset + pixelIndex / 2]);
        uint8_t alpha4 = (pixelIndex & 1) ? (packed & 0x0F) : (packed >> 4);
        if (!alpha4) continue;
        uint16_t blended = blend565(color, bg, alpha4 * 17);
        lcd.writePixel(penX + glyph.xOffset + col, y + glyph.yOffset + row, blended);
      }
    }
    penX += glyph.xAdvance;
  }
  lcd.endWrite();
}

static void drawUiTextClipped(const String& text,
                              int32_t x,
                              int32_t y,
                              const LcdFont& font,
                              uint16_t color,
                              uint16_t bg,
                              int32_t clipX,
                              int32_t clipY,
                              int32_t clipW,
                              int32_t clipH) {
  int32_t penX = x;
  const char* cursor = text.c_str();
  const uint8_t* bitmap = fontBitmap(font);
  const int32_t clipRight = clipX + clipW;
  const int32_t clipBottom = clipY + clipH;

  lcd.startWrite();
  while (*cursor) {
    uint32_t code = nextUtf8Codepoint(cursor);
    GlyphInfo glyph;
    if (!findGlyph(font, code, glyph)) continue;

    int32_t glyphLeft = penX + glyph.xOffset;
    int32_t glyphRight = glyphLeft + glyph.width;
    if (glyphRight > clipX && glyphLeft < clipRight) {
      for (uint8_t row = 0; row < glyph.height; ++row) {
        int32_t py = y + glyph.yOffset + row;
        if (py < clipY || py >= clipBottom) continue;

        for (uint8_t col = 0; col < glyph.width; ++col) {
          int32_t px = glyphLeft + col;
          if (px < clipX || px >= clipRight) continue;

          uint32_t pixelIndex = static_cast<uint32_t>(row) * glyph.width + col;
          uint8_t packed = pgm_read_byte(&bitmap[glyph.offset + pixelIndex / 2]);
          uint8_t alpha4 = (pixelIndex & 1) ? (packed & 0x0F) : (packed >> 4);
          if (!alpha4) continue;
          uint16_t blended = blend565(color, bg, alpha4 * 17);
          lcd.writePixel(px, py, blended);
        }
      }
    }
    penX += glyph.xAdvance;
  }
  lcd.endWrite();
}

static void drawUiTextOnSprite(lgfx::LGFX_Sprite& sprite,
                               const String& text,
                               int32_t x,
                               int32_t y,
                               const LcdFont& font,
                               uint16_t color,
                               uint16_t bg,
                               int32_t clipW,
                               int32_t clipH) {
  int32_t penX = x;
  const char* cursor = text.c_str();
  const uint8_t* bitmap = fontBitmap(font);

  sprite.startWrite();
  while (*cursor) {
    uint32_t code = nextUtf8Codepoint(cursor);
    GlyphInfo glyph;
    if (!findGlyph(font, code, glyph)) continue;

    int32_t glyphLeft = penX + glyph.xOffset;
    int32_t glyphRight = glyphLeft + glyph.width;
    if (glyphRight > 0 && glyphLeft < clipW) {
      for (uint8_t row = 0; row < glyph.height; ++row) {
        int32_t py = y + glyph.yOffset + row;
        if (py < 0 || py >= clipH) continue;

        for (uint8_t col = 0; col < glyph.width; ++col) {
          int32_t px = glyphLeft + col;
          if (px < 0 || px >= clipW) continue;

          uint32_t pixelIndex = static_cast<uint32_t>(row) * glyph.width + col;
          uint8_t packed = pgm_read_byte(&bitmap[glyph.offset + pixelIndex / 2]);
          uint8_t alpha4 = (pixelIndex & 1) ? (packed & 0x0F) : (packed >> 4);
          if (!alpha4) continue;
          uint16_t blended = blend565(color, bg, alpha4 * 17);
          sprite.writePixel(px, py, blended);
        }
      }
    }
    penX += glyph.xAdvance;
  }
  sprite.endWrite();
}

static void setBaseFont(uint8_t size = 1) {
  lcd.setFont(&fonts::Font0);
  lcd.setTextSize(size);
}

static void setUiFont(uint8_t size) {
  currentUiFont = uiFontForSize(size);
}

static void removeLastUtf8Char(String& text) {
  int index = text.length() - 1;
  while (index > 0 && (static_cast<uint8_t>(text[index]) & 0xC0) == 0x80) {
    --index;
  }
  text.remove(index);
}

static String lcdSafeText(String text) {
  text.replace("\r", " ");
  text.replace("\n", " ");
  return text;
}

struct ImageSize {
  uint16_t width = 0;
  uint16_t height = 0;
};

Display& Display::instance() {
  static Display d;
  return d;
}

static constexpr BaseType_t DISPLAY_TASK_CORE = 1;

static void displayTaskEntry(void*) {
  for (;;) {
    Display::instance().taskLoop();
    vTaskDelay(pdMS_TO_TICKS(8));
  }
}

struct ThemeAccentRgb {
  uint8_t r;
  uint8_t g;
  uint8_t b;
};

static uint8_t hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

static bool parseHexRgb(const String& value, uint8_t& r, uint8_t& g, uint8_t& b) {
  String color = value;
  color.trim();
  if (color.length() != 7 || color[0] != '#') return false;
  r = (hexNibble(color[1]) << 4) | hexNibble(color[2]);
  g = (hexNibble(color[3]) << 4) | hexNibble(color[4]);
  b = (hexNibble(color[5]) << 4) | hexNibble(color[6]);
  return true;
}

static ThemeAccentRgb themeAccentRgb(const String& theme) {
  // Use the saturated WebUI accent-strong palette on the LCD. Previously the
  // normal palette was pastel and inverted mode selected a much darker color,
  // so the same named theme appeared as two different shades.
  if (theme == "amber") return {220, 168, 79};
  if (theme == "blue") return {93, 141, 240};
  if (theme == "cyan") return {66, 200, 216};
  if (theme == "red" || theme == "ruby") return {242, 2, 2};
  if (theme == "custom") {
    uint8_t r;
    uint8_t g;
    uint8_t b;
    if (parseHexRgb(AppConfig::instance().themeCustomColor, r, g, b)) {
      return {r, g, b};
    }
  }
  return {105, 229, 141};
}

static void applyPalette(bool inverted, const String& theme) {
  ThemeAccentRgb accent = themeAccentRgb(theme);
  if (inverted) {
    cBg = lcd.color565(236, 241, 234);
    cPanel = lcd.color565(222, 229, 220);
    cPanelAlt = lcd.color565(246, 248, 242);
    cText = lcd.color565(9, 12, 11);
    cMuted = lcd.color565(79, 91, 84);
    cAccent = lcd.color565(accent.r, accent.g, accent.b);
    cOnAccent = TFT_BLACK;
    cLine = lcd.color565(160, 174, 164);
  } else {
    cBg = TFT_BLACK;
    cPanel = lcd.color565(4, 6, 6);
    cPanelAlt = lcd.color565(10, 13, 12);
    cText = lcd.color565(232, 246, 226);
    cMuted = lcd.color565(105, 122, 112);
    cAccent = lcd.color565(accent.r, accent.g, accent.b);
    cOnAccent = TFT_BLACK;
    cLine = lcd.color565(26, 34, 30);
  }
}

static String fitText(String text, int32_t maxWidth) {
  text = lcdSafeText(text);
  if (uiTextWidth(text) <= maxWidth) return text;

  while (text.length() > 3) {
    removeLastUtf8Char(text);
    String candidate = text + "...";
    if (uiTextWidth(candidate) <= maxWidth) return candidate;
  }
  return "...";
}

static String fitTextForFont(String text, int32_t maxWidth, const LcdFont& font) {
  text = lcdSafeText(text);
  if (uiTextWidth(text, font) <= maxWidth) return text;

  while (text.length() > 3) {
    removeLastUtf8Char(text);
    String candidate = text + "...";
    if (uiTextWidth(candidate, font) <= maxWidth) return candidate;
  }
  return "...";
}

static String fittingTextPrefix(const String& text, int32_t maxWidth, int& consumedBytes) {
  consumedBytes = 0;
  const char* start = text.c_str();
  const char* cursor = start;

  while (*cursor) {
    const char* next = cursor;
    nextUtf8Codepoint(next);
    int bytes = static_cast<int>(next - start);
    if (uiTextWidth(text.substring(0, bytes)) > maxWidth) break;
    consumedBytes = bytes;
    cursor = next;
  }

  // Always make progress, even if a single glyph is wider than the available area.
  if (consumedBytes == 0 && text.length()) {
    const char* next = start;
    nextUtf8Codepoint(next);
    consumedBytes = static_cast<int>(next - start);
  }

  return text.substring(0, consumedBytes);
}

static void drawTextLine(const String& text, int32_t x, int32_t y, int32_t maxWidth, uint8_t size, uint16_t color) {
  setUiFont(size);
  drawUiText(fitText(text, maxWidth), x, y, *currentUiFont, color, cBg);
}

static void drawWrappedText(String text, int32_t x, int32_t y, int32_t maxWidth, uint8_t size, uint16_t color, uint8_t maxLines, uint16_t bg) {
  text = lcdSafeText(text);
  setUiFont(size);

  int32_t lineHeight = fontLineHeight(*currentUiFont) + 4;
  uint8_t line = 0;

  text.trim();
  while (text.length() && line < maxLines) {
    String candidate;
    String rest = text;

    while (rest.length()) {
      int space = rest.indexOf(' ');
      String word = space >= 0 ? rest.substring(0, space) : rest;
      String next = candidate.length() ? candidate + " " + word : word;

      if (uiTextWidth(next) > maxWidth) break;

      candidate = next;
      if (space < 0) {
        rest = "";
      } else {
        rest = rest.substring(space + 1);
      }
    }

    if (!candidate.length()) {
      candidate = fitText(text, maxWidth);
      rest = "";
    }

    if (line == maxLines - 1 && rest.length()) {
      candidate = fitText(candidate + " " + rest, maxWidth);
      rest = "";
    }

    drawUiText(candidate, x, y + line * lineHeight, *currentUiFont, color, bg);
    text = rest;
    text.trim();
    line++;
  }
}

static void drawWrappedText(String text, int32_t x, int32_t y, int32_t maxWidth, uint8_t size, uint16_t color, uint8_t maxLines) {
  drawWrappedText(text, x, y, maxWidth, size, color, maxLines, cBg);
}

static void drawCenteredWrappedText(String text, int32_t centerX, int32_t centerY, int32_t maxWidth, uint8_t size, uint16_t color, uint8_t maxLines, uint16_t bg) {
  text = lcdSafeText(text);
  setUiFont(size);

  String lines[4];
  uint8_t lineCount = 0;
  int32_t lineHeight = fontLineHeight(*currentUiFont) + 5;

  text.trim();
  while (text.length() && lineCount < maxLines && lineCount < 4) {
    String candidate;
    String rest = text;

    while (rest.length()) {
      int space = rest.indexOf(' ');
      String word = space >= 0 ? rest.substring(0, space) : rest;
      String next = candidate.length() ? candidate + " " + word : word;

      if (uiTextWidth(next) > maxWidth) break;

      candidate = next;
      rest = space < 0 ? "" : rest.substring(space + 1);
    }

    if (!candidate.length()) {
      int consumedBytes = 0;
      candidate = fittingTextPrefix(text, maxWidth, consumedBytes);
      rest = text.substring(consumedBytes);
    }

    if (lineCount == maxLines - 1 && rest.length()) {
      candidate = fitText(candidate + " " + rest, maxWidth);
      rest = "";
    }

    lines[lineCount++] = candidate;
    text = rest;
    text.trim();
  }

  int32_t startY = centerY - (static_cast<int32_t>(lineCount) * lineHeight - 5) / 2;
  for (uint8_t i = 0; i < lineCount; ++i) {
    drawUiText(lines[i], centerX, startY + i * lineHeight, *currentUiFont, color, bg, top_center);
  }
}

static void drawCenteredWrappedTextWithFont(String text, int32_t centerX, int32_t centerY, int32_t maxWidth, const LcdFont& font, uint16_t color, uint8_t maxLines, uint16_t bg) {
  text = lcdSafeText(text);

  String lines[4];
  uint8_t lineCount = 0;
  int32_t lineHeight = fontLineHeight(font) + 5;

  text.trim();
  while (text.length() && lineCount < maxLines && lineCount < 4) {
    String candidate;
    String rest = text;

    while (rest.length()) {
      int space = rest.indexOf(' ');
      String word = space >= 0 ? rest.substring(0, space) : rest;
      String next = candidate.length() ? candidate + " " + word : word;

      if (uiTextWidth(next, font) > maxWidth) break;

      candidate = next;
      rest = space < 0 ? "" : rest.substring(space + 1);
    }

    if (!candidate.length()) {
      candidate = fitTextForFont(text, maxWidth, font);
      rest = "";
    }

    if (lineCount == maxLines - 1 && rest.length()) {
      candidate = fitTextForFont(candidate + " " + rest, maxWidth, font);
      rest = "";
    }

    lines[lineCount++] = candidate;
    text = rest;
    text.trim();
  }

  int32_t startY = centerY - (static_cast<int32_t>(lineCount) * lineHeight - 5) / 2;
  for (uint8_t i = 0; i < lineCount; ++i) {
    drawUiText(lines[i], centerX, startY + i * lineHeight, font, color, bg, top_center);
  }
}

static uint16_t readBe16(File& file) {
  uint8_t b[2];
  if (file.read(b, 2) != 2) return 0;
  return (static_cast<uint16_t>(b[0]) << 8) | b[1];
}

static uint32_t readLe32From(const uint8_t* b) {
  return static_cast<uint32_t>(b[0]) |
         (static_cast<uint32_t>(b[1]) << 8) |
         (static_cast<uint32_t>(b[2]) << 16) |
         (static_cast<uint32_t>(b[3]) << 24);
}

static bool readPngSize(const String& path, ImageSize& size) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  uint8_t signature[24];
  bool ok = file.read(signature, sizeof(signature)) == sizeof(signature) &&
            signature[0] == 0x89 &&
            signature[1] == 'P' &&
            signature[2] == 'N' &&
            signature[3] == 'G';

  if (ok) {
    uint32_t width = (static_cast<uint32_t>(signature[16]) << 24) |
                     (static_cast<uint32_t>(signature[17]) << 16) |
                     (static_cast<uint32_t>(signature[18]) << 8) |
                     signature[19];
    uint32_t height = (static_cast<uint32_t>(signature[20]) << 24) |
                      (static_cast<uint32_t>(signature[21]) << 16) |
                      (static_cast<uint32_t>(signature[22]) << 8) |
                      signature[23];

    if (width <= UINT16_MAX && height <= UINT16_MAX) {
      size.width = static_cast<uint16_t>(width);
      size.height = static_cast<uint16_t>(height);
    }
  }

  file.close();
  return ok && size.width && size.height;
}

static bool readJpgSize(const String& path, ImageSize& size) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  if (readBe16(file) != 0xFFD8) {
    file.close();
    return false;
  }

  while (file.available()) {
    uint8_t markerPrefix = file.read();
    if (markerPrefix != 0xFF) continue;

    uint8_t marker = file.read();
    while (marker == 0xFF) marker = file.read();

    if (marker == 0xD9 || marker == 0xDA) break;

    uint16_t segmentLength = readBe16(file);
    if (segmentLength < 2) break;

    bool sof = (marker >= 0xC0 && marker <= 0xC3) ||
               (marker >= 0xC5 && marker <= 0xC7) ||
               (marker >= 0xC9 && marker <= 0xCB) ||
               (marker >= 0xCD && marker <= 0xCF);

    if (sof) {
      file.read();
      size.height = readBe16(file);
      size.width = readBe16(file);
      file.close();
      return size.width && size.height;
    }

    file.seek(file.position() + segmentLength - 2);
  }

  file.close();
  return false;
}

static bool readBmpSize(const String& path, ImageSize& size) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  uint8_t header[26] = {0};
  bool ok = file.read(header, sizeof(header)) == sizeof(header) &&
            header[0] == 'B' &&
            header[1] == 'M';
  file.close();
  if (!ok) return false;

  int32_t width = static_cast<int32_t>(readLe32From(header + 18));
  int32_t height = static_cast<int32_t>(readLe32From(header + 22));
  if (height < 0) height = -height;

  if (width <= 0 || height <= 0 || width > UINT16_MAX || height > UINT16_MAX) return false;
  size.width = static_cast<uint16_t>(width);
  size.height = static_cast<uint16_t>(height);
  return true;
}

static bool readImageSize(const String& path, ImageSize& size) {
  String lower = path;
  lower.toLowerCase();

  if (lower.endsWith(".png")) return readPngSize(path, size);
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return readJpgSize(path, size);
  if (lower.endsWith(".bmp")) return readBmpSize(path, size);
  return false;
}

static void drawPlayerSurfaceRegion(int32_t x, int32_t y, int32_t w, int32_t h) {
  if (w <= 0 || h <= 0) return;

  int32_t x0 = max<int32_t>(0, x);
  int32_t y0 = max<int32_t>(0, y);
  int32_t x1 = min<int32_t>(SCREEN_W, x + w);
  int32_t y1 = min<int32_t>(SCREEN_H, y + h);
  if (x1 <= x0 || y1 <= y0) return;

  lcd.startWrite();
  for (int32_t yy = y0; yy < y1; ++yy) {
    uint16_t color = cBg;
    if (yy < sy(78)) {
      uint8_t alpha = 54 - yy / max<int32_t>(1, sy(2));
      color = blend565(cPanelAlt, cBg, alpha);
    } else if (yy >= SCREEN_H - sy(96)) {
      uint8_t alpha = 14 + (yy - (SCREEN_H - sy(96))) / max<int32_t>(1, sy(3));
      color = blend565(cPanel, cBg, alpha);
    }
    lcd.drawFastHLine(x0, yy, x1 - x0, color);
  }

  lcd.endWrite();
}

static void drawPlayerSurface() {
  drawPlayerSurfaceRegion(0, 0, SCREEN_W, SCREEN_H);
}

static uint16_t logoMatLine() {
  return blend565(cAccent, cLine, 88);
}

static void drawArtFrame(uint16_t fill, uint16_t line) {
  const int thickness = max(1, ss(3));
  lcd.fillRoundRect(ART_X - thickness,
                    ART_Y - thickness,
                    ART_SIZE + thickness * 2,
                    ART_SIZE + thickness * 2,
                    ss(8),
                    fill);
  for (int pad = thickness; pad > 0; --pad) {
    lcd.drawRoundRect(ART_X - pad,
                      ART_Y - pad,
                      ART_SIZE + pad * 2,
                      ART_SIZE + pad * 2,
                      max(1, ss(5) + pad),
                      line);
  }
}

static bool drawLcdThumbnail(const String& path) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  uint8_t header[8] = {0};
  bool headerOk = file.read(header, sizeof(header)) == sizeof(header) &&
                  header[0] == 'S' &&
                  header[1] == 'R' &&
                  header[2] == '5' &&
                  header[3] == '6';
  uint16_t width = static_cast<uint16_t>(header[4]) | (static_cast<uint16_t>(header[5]) << 8);
  uint16_t height = static_cast<uint16_t>(header[6]) | (static_cast<uint16_t>(header[7]) << 8);
  if (!headerOk || width != ART_SIZE || height != ART_SIZE) {
    file.close();
    return false;
  }

  static constexpr int THUMB_ROWS_PER_CHUNK = 4;
  static uint16_t rows[ART_SIZE * THUMB_ROWS_PER_CHUNK];
  bool ok = true;
  lcd.startWrite();
  lcd.setAddrWindow(ART_X, ART_Y, ART_SIZE, ART_SIZE);
  for (int y = 0; y < ART_SIZE; y += THUMB_ROWS_PER_CHUNK) {
    int rowCount = min(THUMB_ROWS_PER_CHUNK, ART_SIZE - y);
    size_t bytes = static_cast<size_t>(ART_SIZE) * rowCount * sizeof(uint16_t);
    if (file.read(reinterpret_cast<uint8_t*>(rows), bytes) != static_cast<int>(bytes)) {
      ok = false;
      break;
    }
    lcd.writePixels(rows, ART_SIZE * rowCount, false);
  }
  lcd.endWrite();
  file.close();

  if (!ok) return false;
  return true;
}

static void drawArtPlaceholder(const DisplayModel& m) {
  uint16_t placeholderBg = blend565(cAccent, cBg, 28);
  uint16_t placeholderLine = blend565(cAccent, cLine, 96);
  drawArtFrame(placeholderBg, placeholderLine);

  String label = m.station.length() ? m.station : I18n::SIMPLE_RADIO;
  label = lcdSafeText(label);
  label.trim();
  const int32_t textWidth = ART_SIZE - sx(24);
  uint8_t fontSize = 3;
  String remaining = label;

  // Keep the large placeholder font whenever complete words fit. For a long
  // station name such as "Poptarisznya", step down only as far as necessary
  // so the word can remain intact instead of being split in the middle.
  while (fontSize > 1) {
    const LcdFont& font = *uiFontForSize(fontSize);
    bool wordsFit = true;
    remaining = label;
    remaining.trim();
    while (remaining.length()) {
      int space = remaining.indexOf(' ');
      String word = space >= 0 ? remaining.substring(0, space) : remaining;
      if (uiTextWidth(word, font) > textWidth) {
        wordsFit = false;
        break;
      }
      remaining = space < 0 ? "" : remaining.substring(space + 1);
      remaining.trim();
    }
    if (wordsFit) break;
    --fontSize;
  }

  drawCenteredWrappedText(label, ART_X + ART_SIZE / 2, ART_Y + ART_SIZE / 2, textWidth, fontSize, cAccent, 3, placeholderBg);
}

static void drawArt(const DisplayModel& m) {
  drawPlayerSurfaceRegion(ART_REGION_X, ART_REGION_Y, ART_REGION_W, ART_REGION_H);

  if (!m.logoPath.length() || !LittleFS.exists(m.logoPath)) {
    if (m.logoPath.length()) {
      Serial.printf("[display] logo missing: %s\n", m.logoPath.c_str());
    }
    drawArtPlaceholder(m);
    return;
  }

  String path = m.logoPath;
  path.toLowerCase();

  uint16_t matLine = logoMatLine();
  drawArtFrame(cBg, matLine);

  String thumbPath = ArtworkCache::instance().lcdThumbnailPath(m.logoPath, m.isAlbumArtwork);
  if (thumbPath.length()) {
    if (LittleFS.exists(thumbPath) && drawLcdThumbnail(thumbPath)) {
      return;
    }
    if (m.playing) {
      drawArtPlaceholder(m);
      return;
    }
    ArtworkCache::instance().ensureLcdThumbnail(m.logoPath, m.isAlbumArtwork);
    if (LittleFS.exists(thumbPath) && drawLcdThumbnail(thumbPath)) {
      return;
    }
  }

  ImageSize size;
  if (!readImageSize(m.logoPath, size)) {
    Serial.printf("[display] unsupported logo file: %s\n", m.logoPath.c_str());
    drawArtPlaceholder(m);
    return;
  }

  float scale = m.isAlbumArtwork
                  ? max(static_cast<float>(ART_SIZE) / size.width, static_cast<float>(ART_SIZE) / size.height)
                  : min(static_cast<float>(ART_SIZE) / size.width, static_cast<float>(ART_SIZE) / size.height);
  int32_t scaledW = static_cast<int32_t>(ceilf(size.width * scale));
  int32_t scaledH = static_cast<int32_t>(ceilf(size.height * scale));
  int32_t drawX = ART_X + (ART_SIZE - scaledW) / 2;
  int32_t drawY = ART_Y + (ART_SIZE - scaledH) / 2;

  bool drawn = false;
  lgfx::LGFX_Sprite art(&lcd);
  art.setPsram(true);
  art.setColorDepth(16);
  void* buffer = art.createSprite(ART_SIZE, ART_SIZE);
  if (buffer) {
    art.fillSprite(cBg);
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
      drawn = art.drawJpgFile(LittleFS, m.logoPath.c_str(), drawX - ART_X, drawY - ART_Y, ART_SIZE, ART_SIZE, 0, 0, scale, scale, top_left);
    } else if (path.endsWith(".png")) {
      drawn = art.drawPngFile(LittleFS, m.logoPath.c_str(), drawX - ART_X, drawY - ART_Y, ART_SIZE, ART_SIZE, 0, 0, scale, scale, top_left);
      art.releasePngMemory();
    } else if (path.endsWith(".bmp")) {
      drawn = art.drawBmpFile(LittleFS, m.logoPath.c_str(), drawX - ART_X, drawY - ART_Y, ART_SIZE, ART_SIZE, 0, 0, scale, scale, top_left);
    }
    if (drawn) art.pushSprite(ART_X, ART_Y);
    art.deleteSprite();
  }

  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
    if (!drawn) {
      drawn = lcd.drawJpgFile(LittleFS, m.logoPath.c_str(), drawX, drawY, ART_SIZE, ART_SIZE, 0, 0, scale, scale, top_left);
    }
  } else if (path.endsWith(".png")) {
    if (!drawn) {
      drawn = lcd.drawPngFile(LittleFS, m.logoPath.c_str(), drawX, drawY, ART_SIZE, ART_SIZE, 0, 0, scale, scale, top_left);
      lcd.releasePngMemory();
    }
  } else if (path.endsWith(".bmp")) {
    if (!drawn) {
      drawn = lcd.drawBmpFile(LittleFS, m.logoPath.c_str(), drawX, drawY, ART_SIZE, ART_SIZE, 0, 0, scale, scale, top_left);
    }
  }

  if (drawn) {
    Serial.printf("[display] logo drawn: %s %ux%u scale=%.2f\n", m.logoPath.c_str(), size.width, size.height, scale);
  } else {
    Serial.printf("[display] logo draw failed: %s %ux%u scale=%.2f\n", m.logoPath.c_str(), size.width, size.height, scale);
    drawArtPlaceholder(m);
  }
}

String Display::artRenderKeyFor(const DisplayModel& m) const {
  if (!m.logoPath.length() || !LittleFS.exists(m.logoPath)) {
    return String("placeholder:") + m.station;
  }

  String thumbPath = ArtworkCache::instance().lcdThumbnailPath(m.logoPath, m.isAlbumArtwork);
  if (thumbPath.length() && LittleFS.exists(thumbPath)) {
    return String("thumb:") + thumbPath;
  }

  if (m.playing) {
    return String("placeholder:") + m.station + ":" + m.logoPath;
  }

  return String("source:") + m.logoPath;
}

void Display::drawArtIfNeeded(const DisplayModel& m, bool force) {
  String beforeKey = artRenderKeyFor(m);
  if (!force && beforeKey == lastRenderedArtKey) return;

  drawArt(m);
  lastRenderedArtKey = artRenderKeyFor(m);
}

static bool readyArtKey(const String& key) {
  return key.startsWith("thumb:") || key.startsWith("source:");
}

static String formatFooterBitrate(String bitrate) {
  bitrate.trim();
  if (!bitrate.length()) return "";

  bool numeric = true;
  for (size_t i = 0; i < bitrate.length(); ++i) {
    char c = bitrate[i];
    if (!isDigit(c) && c != ' ') {
      numeric = false;
      break;
    }
  }

  if (numeric) {
    uint32_t value = static_cast<uint32_t>(bitrate.toInt());
    if (!value) return "";
    if (value >= 1000) value = (value + 500) / 1000;
    return String(value) + " kbps";
  }

  String lowered = bitrate;
  lowered.toLowerCase();
  if (lowered.indexOf("kb") >= 0 || lowered.indexOf("bit") >= 0) return bitrate;
  return bitrate;
}

static String footerStreamInfo(const DisplayModel& m) {
  String codec = m.codec;
  codec.trim();
  codec.toUpperCase();

  String bitrate = formatFooterBitrate(m.bitrate);
  if (codec.length() && bitrate.length()) return codec + " " + bitrate;
  if (codec.length()) return codec;
  return bitrate;
}

static void drawProgressBar(const DisplayModel& m, int32_t barY) {
  const int32_t barX = sx(22);
  const int32_t barW = SCREEN_W - sx(44);
  const int32_t barH = sy(10);
  uint16_t track = blend565(cLine, cBg, 190);
  uint16_t knobEdge = blend565(cPanelAlt, cBg, 230);

  lcd.fillRoundRect(barX, barY, barW, barH, ss(5), track);
  int32_t fillW = map(m.volume, 0, 100, 0, barW);
  lcd.fillRoundRect(barX, barY, fillW, barH, ss(5), cAccent);
  lcd.fillCircle(barX + fillW, barY + barH / 2, ss(7), cAccent);
  lcd.drawCircle(barX + fillW, barY + barH / 2, ss(8), knobEdge);

  setUiFont(1);
  drawUiText(m.ip, ART_X, SCREEN_H - sy(14), *currentUiFont, cMuted, cBg);

  String streamInfo = lcdSafeText(footerStreamInfo(m));
  if (streamInfo.length()) {
    drawUiText(fitText(streamInfo, sx(156)), SCREEN_W / 2, SCREEN_H - sy(14), *currentUiFont, cMuted, cBg, top_center);
  }

  String volume = lcdSafeText(String(I18n::VOLUME_LOWER_PREFIX) + String(m.volume) + "%");
  drawUiText(volume, SCREEN_W - sx(22), SCREEN_H - sy(14), *currentUiFont, cMuted, cBg, top_right);
}

static DisplayFooterMode footerMode() {
  return AppConfig::instance().displayFooterModeId;
}

static bool vuSymmetricStyle() {
  return AppConfig::instance().displayVuStyleId == DisplayVuStyle::Symmetric;
}

static bool vuClassicStyle() {
  return AppConfig::instance().displayVuStyleId == DisplayVuStyle::Classic;
}

static uint8_t footerRenderKey() {
  DisplayFooterMode mode = footerMode();
  uint8_t key = static_cast<uint8_t>(mode);
  if (mode == DisplayFooterMode::Vu) {
    key |= static_cast<uint8_t>(AppConfig::instance().displayVuStyleId) << 4;
  }
  return key;
}

static uint8_t triWave8(uint16_t x) {
  x &= 0xFF;
  return x < 128 ? static_cast<uint8_t>(x * 2) : static_cast<uint8_t>((255 - x) * 2);
}

static bool vuBarsHaveSignal() {
  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    if (vuBars[i] > 0) return true;
  }
  return false;
}

static void resetRenderedVuMeter() {
  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    renderedVuBars[i] = 0;
  }
  vuRendered = false;
  vuRenderedStyleKey = 255;
  vuRenderedClearY = 0;
  vuRenderedClearH = 0;
}

static void clearVuBars() {
  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    vuBars[i] = 0;
  }
}

static void resetVuAutoScale() {
  vuRefLevel = 80;
  vuScaledL = 0;
  vuScaledR = 0;
  vuAutoIdleFrames = 0;
  vuAutoScaleReady = false;
  lastVuLevelL = 0;
  lastVuLevelR = 0;
  vuMotionL = 0;
  vuMotionR = 0;
  for (int i = 0; i < VU_HALF_COUNT; ++i) {
    vuHistoryL[i] = 0;
    vuHistoryR[i] = 0;
  }
  lastVuHistoryPushMs = 0;
  lastVuRefReleaseMs = millis();
}

static uint8_t updateVuAutoScaleChannel(uint8_t raw, uint8_t& outputValue) {
  static constexpr uint8_t kNoiseFloor = 2;

  if (raw <= kNoiseFloor) {
    outputValue = outputValue > 12 ? outputValue - 12 : 0;
    return outputValue;
  }

  if (!vuAutoScaleReady) {
    outputValue = min<uint8_t>(70, raw);
  }

  uint8_t target = static_cast<uint8_t>(min<uint16_t>(127, (static_cast<uint16_t>(raw) * 127U) / max<uint16_t>(50, vuRefLevel)));

  if (target > outputValue) {
    uint8_t rise = max<uint8_t>(8, (target - outputValue + 1) / 2);
    outputValue = min<uint8_t>(target, outputValue + rise);
  } else if (outputValue > target) {
    uint8_t fall = max<uint8_t>(4, (outputValue - target + 2) / 3);
    outputValue = outputValue > fall ? max<uint8_t>(target, outputValue - fall) : target;
  }

  return outputValue;
}

static void updateVuAutoScale(uint8_t& left, uint8_t& right, bool hasSignal) {
  if (!hasSignal) {
    if (vuAutoIdleFrames < 250) ++vuAutoIdleFrames;
    vuScaledL = vuScaledL > 10 ? vuScaledL - 10 : 0;
    vuScaledR = vuScaledR > 10 ? vuScaledR - 10 : 0;
    left = vuScaledL;
    right = vuScaledR;
    if (vuAutoIdleFrames > 18 && vuScaledL == 0 && vuScaledR == 0) {
      resetVuAutoScale();
    }
    return;
  }

  vuAutoIdleFrames = 0;
  uint8_t maxVu = max(left, right);
  if (maxVu > vuRefLevel) {
    vuRefLevel = maxVu;
  }
  if (vuRefLevel < 50) {
    vuRefLevel = 50;
  }

  unsigned long now = millis();
  if (now - lastVuRefReleaseMs >= 2000) {
    lastVuRefReleaseMs = now;
    if (vuRefLevel > 60) {
      vuRefLevel -= 10;
    }
  }

  left = updateVuAutoScaleChannel(left, vuScaledL);
  right = updateVuAutoScaleChannel(right, vuScaledR);
  vuAutoScaleReady = true;
}

static uint8_t applyVuSensitivity(uint8_t value) {
  uint16_t sensitivity = constrain(AppConfig::instance().displayVuSensitivity, 50, 200);
  return static_cast<uint8_t>(min<uint16_t>(127, (static_cast<uint16_t>(value) * sensitivity + 50U) / 100U));
}

static void updateVuMotion(uint8_t left, uint8_t right, bool hasSignal) {
  if (!hasSignal) {
    vuMotionL = vuMotionL > 8 ? vuMotionL - 8 : 0;
    vuMotionR = vuMotionR > 8 ? vuMotionR - 8 : 0;
    lastVuLevelL = 0;
    lastVuLevelR = 0;
    return;
  }

  uint8_t deltaL = left > lastVuLevelL ? left - lastVuLevelL : lastVuLevelL - left;
  uint8_t deltaR = right > lastVuLevelR ? right - lastVuLevelR : lastVuLevelR - right;
  vuMotionL = max<uint8_t>(vuMotionL > 5 ? vuMotionL - 5 : 0, min<uint8_t>(64, deltaL * 3));
  vuMotionR = max<uint8_t>(vuMotionR > 5 ? vuMotionR - 5 : 0, min<uint8_t>(64, deltaR * 3));
  lastVuLevelL = left;
  lastVuLevelR = right;
}

static void pushVuHistory(uint8_t left, uint8_t right, bool hasSignal, unsigned long now) {
  if (lastVuHistoryPushMs && now - lastVuHistoryPushMs < METER_RENDER_MS - 4) return;
  lastVuHistoryPushMs = now;

  for (int i = VU_HALF_COUNT - 1; i > 0; --i) {
    vuHistoryL[i] = vuHistoryL[i - 1];
    vuHistoryR[i] = vuHistoryR[i - 1];
  }

  if (hasSignal) {
    vuHistoryL[0] = left;
    vuHistoryR[0] = right;
  } else {
    vuHistoryL[0] = 0;
    vuHistoryR[0] = 0;
    for (int i = 1; i < VU_HALF_COUNT; ++i) {
      vuHistoryL[i] = vuHistoryL[i] > 8 ? vuHistoryL[i] - 8 : 0;
      vuHistoryR[i] = vuHistoryR[i] > 8 ? vuHistoryR[i] - 8 : 0;
    }
  }
}

static uint8_t shapedVuHeight(uint8_t level, int index, uint8_t maxHeight, uint8_t motion) {
  if (level <= 2) return 0;
  uint8_t seed = kVuSeed[index % VU_BAR_COUNT];
  uint8_t contour = kVuShape[index % VU_BAR_COUNT];
  uint8_t pulse = triWave8(static_cast<uint16_t>(vuFrame * 3 + seed));
  int16_t shape = static_cast<int16_t>(contour) + ((static_cast<int16_t>(pulse) - 128) * min<uint8_t>(motion, 48)) / 160;
  shape = constrain(shape, 76, 246);
  uint32_t shaped = static_cast<uint32_t>(level) * static_cast<uint16_t>(shape) * maxHeight;
  uint8_t target = static_cast<uint8_t>(min<uint32_t>(maxHeight, shaped / (127UL * 255UL)));
  return target > 0 ? max<uint8_t>(VU_MIN_H, target) : 0;
}

static uint8_t classicVuHeightForIndex(int index, uint8_t maxHeight) {
  uint8_t shape = kVuShape[index % VU_BAR_COUNT];
  uint8_t minHeight = max<uint8_t>(VU_MIN_H + 2, maxHeight / 4);
  uint32_t scaled = static_cast<uint32_t>(shape) * (maxHeight - minHeight);
  return min<uint8_t>(maxHeight, minHeight + scaled / 255);
}

static uint8_t classicVuActiveBars(uint8_t level) {
  static constexpr uint8_t kNoiseFloor = 5;
  const int half = VU_HALF_COUNT;
  if (level <= kNoiseFloor) return 0;

  float normalized = static_cast<float>(level - kNoiseFloor) / static_cast<float>(127 - kNoiseFloor);
  uint8_t bars = static_cast<uint8_t>(roundf(sqrtf(normalized) * 10.5f));
  if (level > 124) {
    bars = half;
  }
  return min<uint8_t>(half, bars);
}

static bool updateVuBars(bool playing) {
  AudioMeterSnapshot meter = AudioMeter::instance().snapshot();
  unsigned long now = millis();
  bool fresh = meter.active && playing && now - meter.updatedMs < 260;
  uint8_t left = fresh ? meter.left : 0;
  uint8_t right = fresh ? meter.right : 0;
  bool hasFreshSignal = fresh && max(left, right) > 2;
  updateVuAutoScale(left, right, hasFreshSignal);
  left = applyVuSensitivity(left);
  right = applyVuSensitivity(right);
  hasFreshSignal = max(left, right) > 2;
  updateVuMotion(left, right, hasFreshSignal);
  pushVuHistory(left, right, hasFreshSignal, now);
  bool classic = vuClassicStyle();
  uint8_t maxHeight = (vuSymmetricStyle() || classic) ? VU_SYMMETRIC_MAX_H : VU_MAX_H;
  bool changed = false;
  uint8_t classicLeftBars = classic ? classicVuActiveBars(max<uint8_t>(left, vuHistoryL[0])) : 0;
  uint8_t classicRightBars = classic ? classicVuActiveBars(max<uint8_t>(right, vuHistoryR[0])) : 0;
  vuFrame++;

  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    int halfIndex = i < VU_HALF_COUNT ? i : i - VU_HALF_COUNT;
    int historyIndex = classic
      ? halfIndex
      : (i < VU_HALF_COUNT ? VU_HALF_COUNT - 1 - halfIndex : halfIndex);
    uint8_t level = i < VU_HALF_COUNT ? vuHistoryL[historyIndex] : vuHistoryR[historyIndex];
    uint8_t motion = i < VU_HALF_COUNT ? vuMotionL : vuMotionR;

    uint8_t target = 0;
    if (hasFreshSignal) {
      if (classic) {
        const int half = VU_HALF_COUNT;
        int distanceFromCenter = i < half ? i : i - half;
        uint8_t activeBars = i < half ? classicLeftBars : classicRightBars;
        target = distanceFromCenter < activeBars ? shapedVuHeight(level, i, maxHeight, motion) : 0;
      } else {
        target = shapedVuHeight(level, i, maxHeight, motion);
      }
    }

    uint8_t current = vuBars[i];
    uint8_t next = current;
    if (classic) {
      next = target;
    } else if (target > current) {
      uint8_t rise = max<uint8_t>(12, (target - current) * 6 / 7);
      next = min<uint8_t>(target, current + rise);
    } else if (current > target) {
      uint8_t fall = hasFreshSignal ? max<uint8_t>(10, (current - target + 1) * 5 / 7) : 18;
      next = current > fall ? current - fall : target;
      if (next < target) next = target;
    }

    if (next != current) {
      vuBars[i] = next;
      changed = true;
    }
  }

  return changed || hasFreshSignal || vuBarsHaveSignal();
}

struct VuLayout {
  bool symmetric = false;
  bool classic = false;
  uint8_t styleKey = 0;
  int meterW = 0;
  int meterX = 0;
  int centerX = 0;
  int axisY = 0;
  int maxH = 0;
  int clearY = 0;
  int clearH = 0;
};

static VuLayout currentVuLayout() {
  DisplayVuStyle style = AppConfig::instance().displayVuStyleId;
  bool symmetric = style == DisplayVuStyle::Symmetric;
  bool classic = style == DisplayVuStyle::Classic;
  const int gapCount = VU_BAR_COUNT - 1;
  const int meterW = VU_BAR_COUNT * VU_BAR_W + max(0, gapCount) * VU_BAR_GAP;
  VuLayout layout;
  layout.symmetric = symmetric;
  layout.classic = classic;
  layout.styleKey = static_cast<uint8_t>(style);
  layout.meterW = meterW;
  layout.meterX = (SCREEN_W - meterW) / 2;
  layout.centerX = layout.meterX + meterW / 2;
  layout.axisY = (symmetric || classic) ? VU_SYMMETRIC_CENTER_Y : VU_BASELINE_Y;
  layout.maxH = (symmetric || classic) ? VU_SYMMETRIC_MAX_H : VU_MAX_H;
  layout.clearY = layout.axisY - layout.maxH - 4;
  layout.clearH = SCREEN_H - layout.clearY;
  return layout;
}

static int vuBarXInLayout(const VuLayout& layout, int index) {
  if (!layout.classic) {
    return layout.meterX + index * (VU_BAR_W + VU_BAR_GAP);
  }
  const int half = VU_BAR_COUNT / 2;
  const int centerGapLeft = VU_BAR_GAP / 2;
  if (index < half) {
    return layout.centerX - centerGapLeft - (index + 1) * VU_BAR_W - index * VU_BAR_GAP;
  }
  const int rightIndex = index - half;
  return layout.centerX + (VU_BAR_GAP - centerGapLeft) + rightIndex * (VU_BAR_W + VU_BAR_GAP);
}

static uint16_t vuBarColor() {
  // Bar height already represents the signal level. Keep every active bar on
  // the exact theme accent instead of mixing it with the background/text;
  // those mixes made red pastel in dark mode and grey-black in light mode.
  return cAccent;
}

static void drawVuBarInLayout(const VuLayout& layout, int index, int height) {
  if (height <= 0) return;
  height = min<int>(height, layout.maxH);

  int x = vuBarXInLayout(layout, index);
  int y = layout.axisY - height;
  int barH = (layout.symmetric || layout.classic) ? height * 2 + 1 : height;
  lcd.fillRoundRect(x, y, VU_BAR_W, barH, 3, vuBarColor());
}

static void restoreVuRect(int x, int y, int w, int h) {
  if (w <= 0 || h <= 0) return;
  drawPlayerSurfaceRegion(x, y, w, h);
}

static void restoreShrinkingVuBar(const VuLayout& layout, int index, int oldHeight, int newHeight) {
  oldHeight = min<int>(oldHeight, layout.maxH);
  newHeight = min<int>(newHeight, layout.maxH);
  if (oldHeight <= newHeight) return;

  int x = vuBarXInLayout(layout, index);
  int exposed = oldHeight - newHeight;

  if (layout.symmetric || layout.classic) {
    restoreVuRect(x - 1, layout.axisY - oldHeight - 1, VU_BAR_W + 2, exposed + 3);
    restoreVuRect(x - 1, layout.axisY + newHeight - 1, VU_BAR_W + 2, exposed + 3);
  } else {
    restoreVuRect(x - 1, layout.axisY - oldHeight - 1, VU_BAR_W + 2, exposed + 3);
  }
}

static void drawVuBaselineInLayout(const VuLayout& layout, int x, int w) {
  const uint16_t base = blend565(cLine, cBg, 150);
  lcd.drawFastHLine(x, layout.axisY, w, base);
}

static void clearRenderedVuArea(const VuLayout& layout) {
  lcd.startWrite();
  if (vuRendered && vuRenderedClearH > 0) {
    int y = min(layout.clearY, vuRenderedClearY);
    int bottom = max(layout.clearY + layout.clearH, vuRenderedClearY + vuRenderedClearH);
    drawPlayerSurfaceRegion(0, y, SCREEN_W, bottom - y);
  } else {
    drawPlayerSurfaceRegion(0, layout.clearY, SCREEN_W, layout.clearH);
  }
  lcd.endWrite();
  resetRenderedVuMeter();
}

static void drawVuMeter(const DisplayModel& m, bool forceFull = false) {
  VuLayout layout = currentVuLayout();
  if (!m.playing && !vuBarsHaveSignal()) {
    if (vuRendered || forceFull) {
      clearRenderedVuArea(layout);
    }
    return;
  }

  forceFull = forceFull ||
              !vuRendered ||
              vuRenderedStyleKey != layout.styleKey ||
              vuRenderedClearY != layout.clearY ||
              vuRenderedClearH != layout.clearH;

  if (forceFull) {
    clearRenderedVuArea(layout);
    lcd.startWrite();
    if (!layout.classic) {
      drawVuBaselineInLayout(layout, layout.meterX, layout.meterW);
    }
    for (int i = 0; i < VU_BAR_COUNT; ++i) {
      drawVuBarInLayout(layout, i, vuBars[i]);
      renderedVuBars[i] = vuBars[i];
    }
    lcd.endWrite();
    vuRendered = true;
    vuRenderedStyleKey = layout.styleKey;
    vuRenderedClearY = layout.clearY;
    vuRenderedClearH = layout.clearH;
    return;
  }

  lcd.startWrite();
  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    if (renderedVuBars[i] == vuBars[i]) continue;
    restoreShrinkingVuBar(layout, i, renderedVuBars[i], vuBars[i]);
    int x = vuBarXInLayout(layout, i);
    if (!layout.classic) {
      drawVuBaselineInLayout(layout, x, VU_BAR_W);
    }
    drawVuBarInLayout(layout, i, vuBars[i]);
    renderedVuBars[i] = vuBars[i];
  }
  lcd.endWrite();
}

static void displayTitleArtist(const DisplayModel& m, String& title, String& artist) {
  if (m.playing) {
    if (!m.networkConnected || m.streamConnectionState == StreamConnectionState::WaitingForNetwork) {
      title = m.station.length() ? m.station : I18n::SIMPLE_RADIO;
      artist = I18n::WIFI_CONNECTION_LOST;
    } else if (m.streamConnectionState == StreamConnectionState::Connecting) {
      title = m.station.length() ? m.station : I18n::SIMPLE_RADIO;
      artist = I18n::STREAM_CONNECTING;
    } else if (m.streamConnectionState == StreamConnectionState::RetryWaiting) {
      title = m.station.length() ? m.station : I18n::SIMPLE_RADIO;
      artist = I18n::STREAM_RETRYING;
      if (m.streamConnectFailures > 0) {
        artist += " (" + String(m.streamConnectFailures) + ")";
      }
    } else if (m.streamConnectionState == StreamConnectionState::Failed) {
      title = m.station.length() ? m.station : I18n::SIMPLE_RADIO;
      artist = I18n::STREAM_FAILED;
    } else if (m.title.length() || m.artist.length()) {
      title = m.title.length() ? m.title : (m.station.length() ? m.station : I18n::SIMPLE_RADIO);
      artist = m.artist;
    } else {
      title = m.station.length() ? m.station : I18n::SIMPLE_RADIO;
      artist = "";
    }
  } else {
    title = m.station.length() ? m.station : I18n::SIMPLE_RADIO;
    artist = I18n::PLAYBACK_PAUSED;
  }
}

static void drawInfoRegion(const DisplayModel& m) {
  drawPlayerSurfaceRegion(INFO_REGION_X, INFO_REGION_Y, INFO_REGION_W, INFO_REGION_H);

  String title;
  String artist;
  displayTitleArtist(m, title, artist);

  const int32_t infoCenterX = INFO_X + INFO_W / 2;
  drawCenteredWrappedTextWithFont(title, infoCenterX, TITLE_CENTER_Y, INFO_W, titleFont(), cText, 3, cBg);
  drawCenteredWrappedTextWithFont(artist, infoCenterX, ARTIST_CENTER_Y, INFO_W, artistFont(), cAccent, 2, cBg);
}

static void drawStationFooter(const DisplayModel& m) {
  drawPlayerSurfaceRegion(FOOTER_REGION_X, FOOTER_REGION_Y, FOOTER_REGION_W, FOOTER_REGION_H);
  resetRenderedVuMeter();

  String station = lcdSafeText(m.station.length() ? m.station : I18n::NO_STATION);
  setUiFont(2);
  drawUiText(fitText(station, SCREEN_W - sx(44)),
             SCREEN_W / 2,
             FOOTER_REGION_Y + FOOTER_REGION_H / 2,
             *currentUiFont,
             cAccent,
             cBg,
             middle_center);
}

static void resetDateTimeFooter() {
  dateTimeFooterMinuteStamp = -1;
  dateTimeFooterLastCheckMs = 0;
  dateTimeFooterRendered = false;
}

static int32_t footerDateTimeMinuteStamp(const struct tm& timeinfo, bool haveTime) {
  if (!haveTime) return -1;
  int32_t year = constrain(timeinfo.tm_year + 1900, 0, 9999);
  return year * 525600L + timeinfo.tm_yday * 1440L + timeinfo.tm_hour * 60L + timeinfo.tm_min;
}

static String footerDateTimeText(const struct tm& timeinfo, bool haveTime) {
  if (!haveTime) return I18n::TIME_SYNC;

  int year = constrain(timeinfo.tm_year + 1900, 0, 9999);
  int month = constrain(timeinfo.tm_mon + 1, 1, 12);
  int day = constrain(timeinfo.tm_mday, 1, 31);
  int hour = constrain(timeinfo.tm_hour, 0, 23);
  int minute = constrain(timeinfo.tm_min, 0, 59);
  char out[28];

  if (strcmp(I18n::LANGUAGE_CODE, "hu") == 0) {
    snprintf(out, sizeof(out), "%04d.%02d.%02d.  %02d:%02d", year, month, day, hour, minute);
  } else {
    snprintf(out, sizeof(out), "%04d-%02d-%02d  %02d:%02d", year, month, day, hour, minute);
  }

  return String(out);
}

static void drawDateTimeFooter(bool force = false) {
  unsigned long now = millis();
  if (!force && dateTimeFooterRendered && now - dateTimeFooterLastCheckMs < 1000) return;
  dateTimeFooterLastCheckMs = now;

  struct tm timeinfo;
  bool haveTime = getLocalTime(&timeinfo, 5);
  int32_t stamp = footerDateTimeMinuteStamp(timeinfo, haveTime);
  if (!force && dateTimeFooterRendered && stamp == dateTimeFooterMinuteStamp) return;

  drawPlayerSurfaceRegion(FOOTER_REGION_X, FOOTER_REGION_Y, FOOTER_REGION_W, FOOTER_REGION_H);
  resetRenderedVuMeter();

  String line = lcdSafeText(footerDateTimeText(timeinfo, haveTime));
  setUiFont(2);
  drawUiText(fitText(line, SCREEN_W - sx(44)),
             SCREEN_W / 2,
             FOOTER_REGION_Y + FOOTER_REGION_H / 2,
             *currentUiFont,
             cAccent,
             cBg,
             middle_center);

  dateTimeFooterMinuteStamp = stamp;
  dateTimeFooterRendered = true;
}

static void drawFooterRegion(const DisplayModel& m) {
  DisplayFooterMode mode = footerMode();
  if (mode == DisplayFooterMode::Volume) {
    resetDateTimeFooter();
    drawPlayerSurfaceRegion(FOOTER_REGION_X, FOOTER_REGION_Y, FOOTER_REGION_W, FOOTER_REGION_H);
    resetRenderedVuMeter();
    drawProgressBar(m, BAR_Y);
  } else if (mode == DisplayFooterMode::Vu) {
    resetDateTimeFooter();
    if (volumeRestoreInProgress) {
      drawPlayerSurfaceRegion(FOOTER_REGION_X, FOOTER_REGION_Y, FOOTER_REGION_W, FOOTER_REGION_H);
      resetRenderedVuMeter();
    } else {
      drawVuMeter(m, true);
    }
  } else if (mode == DisplayFooterMode::Station) {
    resetDateTimeFooter();
    drawStationFooter(m);
  } else if (mode == DisplayFooterMode::DateTime) {
    drawDateTimeFooter(true);
  } else {
    resetDateTimeFooter();
    drawPlayerSurfaceRegion(FOOTER_REGION_X, FOOTER_REGION_Y, FOOTER_REGION_W, FOOTER_REGION_H);
    resetRenderedVuMeter();
  }
}

static void drawApMode(const DisplayModel& m) {
  lcd.fillScreen(cBg);
  setUiFont(3);
  drawUiText(I18n::WIFI_SETUP_TITLE, SCREEN_W / 2, sy(96), *currentUiFont, cText, cBg, middle_center);
  setUiFont(2);
  drawUiText("ESP32-WebRadio", SCREEN_W / 2, sy(150), *currentUiFont, cAccent, cBg, middle_center);
  setUiFont(1);
  drawUiText(I18n::WIFI_SETUP_HINT, SCREEN_W / 2, sy(196), *currentUiFont, cMuted, cBg, middle_center);
  drawUiText(m.ip, SCREEN_W / 2, sy(222), *currentUiFont, cMuted, cBg, middle_center);
}

static void drawStationPicker(int selectedId) {
  StationManager& manager = StationManager::instance();
  size_t stationCount = manager.count();
  if (!stationCount) return;

  int selectedIndex = manager.indexOfStation(selectedId);
  if (selectedIndex < 0) selectedIndex = 0;

  const int boxX = sx(42);
  const int boxY = sy(32);
  const int boxW = SCREEN_W - sx(84);
  const int rowH = PICKER_ROW_H;
  const int visibleRows = PICKER_VISIBLE_ROWS;
  const int boxH = sy(58) + visibleRows * rowH;

  int start = selectedIndex - visibleRows / 2;
  if (start < 0) start = 0;
  if (start + visibleRows > static_cast<int>(stationCount)) {
    start = max(0, static_cast<int>(stationCount) - visibleRows);
  }

  lcd.fillRoundRect(boxX, boxY, boxW, boxH, ss(5), cPanel);
  lcd.drawRoundRect(boxX, boxY, boxW, boxH, ss(5), cAccent);

  setUiFont(2);
  drawUiText(I18n::STATIONS_TITLE, boxX + sx(16), boxY + sy(14), *currentUiFont, cAccent, cPanel);

  setUiFont(1);
  String hint = I18n::STATION_PICKER_HINT_SHORT;
  drawUiText(hint, boxX + boxW - sx(16), boxY + sy(20), *currentUiFont, cMuted, cPanel, top_right);

  for (int row = 0; row < visibleRows; ++row) {
    int index = start + row;
    if (index >= static_cast<int>(stationCount)) break;

    Station station;
    if (!manager.stationAtIndex(index, station)) continue;

    int y = boxY + sy(50) + row * rowH;
    bool selected = station.id == selectedId || (selectedId < 0 && index == selectedIndex);
    if (selected) {
      lcd.fillRect(boxX + sx(10), y, boxW - sx(20), rowH - sy(6), cAccent);
      setUiFont(3);
      drawUiText(fitText(station.name, boxW - sx(44)), boxX + sx(20), y + sy(3), *currentUiFont, cOnAccent, cAccent);
    } else {
      setUiFont(3);
      drawUiText(fitText(station.name, boxW - sx(44)), boxX + sx(20), y + sy(3), *currentUiFont, cText, cPanel);
    }
  }
}

static int clampPickerWindowStart(int start, int stationCount) {
  if (stationCount <= PICKER_VISIBLE_ROWS) return 0;
  if (start < 0) return 0;
  int maxStart = stationCount - PICKER_VISIBLE_ROWS;
  return start > maxStart ? maxStart : start;
}

static int pickerPageStartForIndex(int selectedIndex, int stationCount) {
  if (selectedIndex < 0) selectedIndex = 0;
  int start = (selectedIndex / PICKER_VISIBLE_ROWS) * PICKER_VISIBLE_ROWS;
  return clampPickerWindowStart(start, stationCount);
}

static void drawStationPickerPagedRow(int row, int stationIndex, int selectedId, int scrollOffset = 0) {
  StationManager& manager = StationManager::instance();
  int y = PICKER_ROW_Y + row * PICKER_ROW_H;

  Station station;
  if (!manager.stationAtIndex(stationIndex, station)) return;

  bool selected = station.id == selectedId;
  String stationName = lcdSafeText(station.name);
  const int rowH = PICKER_ROW_H - sy(6);
  const uint16_t rowBg = selected ? cAccent : blend565(cPanel, cBg, 222);
  const uint16_t rowBorder = selected ? blend565(cText, cAccent, 110) : blend565(cLine, cBg, 160);
  const uint16_t numberBg = selected ? blend565(cOnAccent, cAccent, 48) : blend565(cAccent, cBg, 70);
  const uint16_t numberFg = selected ? cOnAccent : cAccent;
  const uint16_t textFg = selected ? cOnAccent : cText;

  lcd.fillRoundRect(PICKER_ROW_X, y, PICKER_ROW_W, rowH, ss(7), rowBg);
  lcd.drawRoundRect(PICKER_ROW_X, y, PICKER_ROW_W, rowH, ss(7), rowBorder);
  lcd.fillRoundRect(PICKER_NUMBER_X, y + sy(7), PICKER_NUMBER_W, rowH - sy(14), ss(6), numberBg);
  setUiFont(2);
  drawUiText(String(stationIndex + 1),
             PICKER_NUMBER_X + PICKER_NUMBER_W / 2,
             y + rowH / 2,
             *currentUiFont,
             numberFg,
             numberBg,
             middle_center);
  setUiFont(3);
  const int textY = y + (rowH - fontLineHeight(*currentUiFont)) / 2;

  if (selected) {
    if (scrollOffset > 0 && uiTextWidth(stationName) > PICKER_TEXT_W) {
      drawUiTextClipped(stationName,
                        PICKER_TEXT_X - scrollOffset,
                        textY,
                        *currentUiFont,
                        textFg,
                        rowBg,
                        PICKER_TEXT_X,
                        y + sy(2),
                        PICKER_TEXT_W,
                        rowH - sy(4));
    } else {
      drawUiText(fitText(stationName, PICKER_TEXT_W), PICKER_TEXT_X, textY, *currentUiFont, textFg, rowBg);
    }
  } else {
    drawUiText(fitText(stationName, PICKER_TEXT_W), PICKER_TEXT_X, textY, *currentUiFont, textFg, rowBg);
  }
}

static void drawStationPickerMarqueeText(int row, const String& stationName, int scrollOffset) {
  static lgfx::LGFX_Sprite textSprite(&lcd);
  static bool spriteReady = false;
  if (!spriteReady) {
    textSprite.setPsram(true);
    textSprite.setColorDepth(16);
    spriteReady = textSprite.createSprite(PICKER_TEXT_W, PICKER_TEXT_H) != nullptr;
  }

  const int y = PICKER_ROW_Y + row * PICKER_ROW_H;
  setUiFont(3);
  const uint16_t rowBg = cAccent;
  const uint16_t textFg = cOnAccent;
  const int rowH = PICKER_ROW_H - sy(6);
  const int textY = y + (rowH - fontLineHeight(*currentUiFont)) / 2;
  const int spriteTextY = (rowH - fontLineHeight(*currentUiFont)) / 2;

  if (!spriteReady) {
    lcd.fillRect(PICKER_TEXT_X, y, PICKER_TEXT_W, rowH, rowBg);
    if (scrollOffset > 0) {
      drawUiTextClipped(stationName,
                        PICKER_TEXT_X - scrollOffset,
                        textY,
                        *currentUiFont,
                        textFg,
                        rowBg,
                        PICKER_TEXT_X,
                        y,
                        PICKER_TEXT_W,
                        rowH);
    } else {
      drawUiText(fitText(stationName, PICKER_TEXT_W), PICKER_TEXT_X, textY, *currentUiFont, textFg, rowBg);
    }
    return;
  }

  textSprite.fillSprite(rowBg);
  if (scrollOffset > 0) {
    drawUiTextOnSprite(textSprite,
                       stationName,
                       -scrollOffset,
                       spriteTextY,
                       *currentUiFont,
                       textFg,
                       rowBg,
                       PICKER_TEXT_W,
                       PICKER_TEXT_H);
  } else {
    drawUiTextOnSprite(textSprite,
                       fitText(stationName, PICKER_TEXT_W),
                       0,
                       spriteTextY,
                       *currentUiFont,
                       textFg,
                       rowBg,
                       PICKER_TEXT_W,
                       PICKER_TEXT_H);
  }
  textSprite.pushSprite(PICKER_TEXT_X, y);
}

static void drawStationPickerPagedPage(int selectedId, int windowStart) {
  StationManager& manager = StationManager::instance();
  int stationCount = static_cast<int>(manager.count());
  if (!stationCount) return;

  int start = clampPickerWindowStart(windowStart, stationCount);

  drawPlayerSurface();

  setUiFont(3);
  drawUiText(I18n::STATIONS_TITLE, sx(28), sy(18), *currentUiFont, cText, cBg);

  setUiFont(1);
  drawUiText(I18n::STATION_PICKER_HINT_FULL,
             SCREEN_W - sx(28),
             sy(22),
             *currentUiFont,
             cMuted,
             cBg,
             top_right);
  drawUiText(String(stationCount) + I18n::STATIONS_SAVED_SUFFIX,
             SCREEN_W - sx(28),
             sy(40),
             *currentUiFont,
             blend565(cMuted, cBg, 180),
             cBg,
             top_right);

  for (int row = 0; row < PICKER_VISIBLE_ROWS; ++row) {
    int index = start + row;
    if (index >= stationCount) break;
    drawStationPickerPagedRow(row, index, selectedId);
  }
}

static void drawStationPickerPaged(int selectedId, int& windowStart, int& renderedSelectedId, bool forceFull) {
  StationManager& manager = StationManager::instance();
  int stationCount = static_cast<int>(manager.count());
  if (!stationCount) return;

  int selectedIndex = manager.indexOfStation(selectedId);
  if (selectedIndex < 0) selectedIndex = 0;

  windowStart = clampPickerWindowStart(windowStart, stationCount);
  bool outsideWindow = selectedIndex < windowStart || selectedIndex >= windowStart + PICKER_VISIBLE_ROWS;
  if (forceFull || windowStart < 0 || renderedSelectedId < 0 || outsideWindow) {
    windowStart = pickerPageStartForIndex(selectedIndex, stationCount);
    drawStationPickerPagedPage(selectedId, windowStart);
    renderedSelectedId = selectedId;
    return;
  }

  int previousIndex = manager.indexOfStation(renderedSelectedId);
  if (previousIndex >= windowStart && previousIndex < windowStart + PICKER_VISIBLE_ROWS) {
    drawStationPickerPagedRow(previousIndex - windowStart, previousIndex, selectedId);
  }
  drawStationPickerPagedRow(selectedIndex - windowStart, selectedIndex, selectedId);
  renderedSelectedId = selectedId;
}

static void drawVolumePopup(uint8_t volume) {
  const int boxW = sx(250);
  const int boxH = sy(74);
  const int boxX = (SCREEN_W - boxW) / 2;
  const int boxY = SCREEN_H - boxH - sy(42);
  const int barX = boxX + sx(22);
  const int barY = boxY + sy(46);
  const int barW = boxW - sx(44);
  const uint16_t popupBg = blend565(cPanelAlt, cBg, 245);
  const uint16_t track = blend565(cLine, popupBg, 190);

  lcd.fillRoundRect(boxX, boxY, boxW, boxH, ss(6), popupBg);
  lcd.drawRoundRect(boxX, boxY, boxW, boxH, ss(6), cAccent);
  setUiFont(2);
  drawUiText(lcdSafeText(String(I18n::VOLUME_TITLE) + " " + String(volume) + "%"), boxX + 22, boxY + 14, *currentUiFont, cText, popupBg);

  lcd.fillRoundRect(barX, barY, barW, sy(10), ss(5), track);
  int fill = map(volume, 0, 100, 0, barW);
  lcd.fillRoundRect(barX, barY, fill, sy(10), ss(5), cAccent);
}

static void drawSpeakerIcon(int32_t x, int32_t y, uint16_t color, uint16_t bg) {
  lcd.fillRoundRect(x, y + sy(15), sx(10), sy(18), ss(3), color);
  lcd.fillTriangle(x + sx(9), y + sy(15), x + sx(31), y + sy(3), x + sx(31), y + sy(45), color);
  lcd.fillTriangle(x + sx(10), y + sy(33), x + sx(31), y + sy(45), x + sx(31), y + sy(3), color);

  for (int i = 0; i < 2; ++i) {
    int radius = ss(13 + i * 10);
    uint16_t arcColor = i == 1 ? blend565(color, bg, 190) : color;
    for (int a = -40; a <= 40; a += 5) {
      float rad = static_cast<float>(a) * CLOCK_PI / 180.0f;
      int px = x + sx(32) + static_cast<int>(cosf(rad) * radius);
      int py = y + sy(24) + static_cast<int>(sinf(rad) * radius);
      lcd.drawPixel(px, py, arcColor);
      lcd.drawPixel(px + 1, py, arcColor);
      lcd.drawPixel(px, py + 1, arcColor);
    }
  }
}

static uint16_t volumeScreenBg() {
  return cBg;
}

static uint16_t volumeTextColor() {
  return cText;
}

static uint16_t volumeMutedColor() {
  return cMuted;
}

static uint16_t volumeAccentColor() {
  return cAccent;
}

static void drawVolumeTickLine(int x1, int y1, int x2, int y2, float rad, bool majorTick, uint16_t color) {
  const int thickness = max<int>(2, ss(majorTick ? 5 : 4));
  const float nx = -sinf(rad);
  const float ny = cosf(rad);
  const float center = (thickness - 1) / 2.0f;

  for (int i = 0; i < thickness; ++i) {
    float offset = static_cast<float>(i) - center;
    int ox = static_cast<int>(roundf(nx * offset));
    int oy = static_cast<int>(roundf(ny * offset));
    lcd.drawLine(x1 + ox, y1 + oy, x2 + ox, y2 + oy, color);
  }
}

static void drawVolumeTicks(uint8_t volume) {
  const uint16_t bg = volumeScreenBg();
  const uint16_t tickOff = blend565(cLine, bg, 150);
  const uint16_t tickOn = volumeAccentColor();
  const uint16_t tickHot = blend565(cText, cAccent, 145);

  lcd.startWrite();
  for (int i = 0; i <= VOLUME_TICK_COUNT; ++i) {
    float ratio = static_cast<float>(i) / static_cast<float>(VOLUME_TICK_COUNT);
    float deg = VOLUME_ARC_START_DEG + ratio * VOLUME_ARC_SPAN_DEG;
    float rad = deg * CLOCK_PI / 180.0f;
    bool majorTick = (i % 2) == 0;
    int outer = VOLUME_DIAL_R;
    int inner = majorTick ? VOLUME_DIAL_R - ss(18) : VOLUME_DIAL_R - ss(10);
    int tickPercent = i * 5;
    bool active = volume > 0 && tickPercent <= volume;
    uint16_t color = active ? (tickPercent >= 85 ? tickHot : tickOn) : tickOff;
    int x1 = VOLUME_DIAL_CX + static_cast<int>(cosf(rad) * inner);
    int y1 = VOLUME_DIAL_CY + static_cast<int>(sinf(rad) * inner);
    int x2 = VOLUME_DIAL_CX + static_cast<int>(cosf(rad) * outer);
    int y2 = VOLUME_DIAL_CY + static_cast<int>(sinf(rad) * outer);
    drawVolumeTickLine(x1, y1, x2, y2, rad, majorTick, color);
  }
  lcd.endWrite();
}

static void drawVolumeValue(uint8_t volume, uint16_t knobBg) {
  const uint16_t text = volumeTextColor();
  const uint16_t muted = volumeMutedColor();

  lcd.fillCircle(VOLUME_DIAL_CX, VOLUME_DIAL_CY, VOLUME_KNOB_R - ss(2), knobBg);

  setBaseFont();
  lcd.setFont(&fonts::Font7);
  lcd.setTextDatum(middle_center);
  lcd.setTextColor(text, knobBg);
  String value = String(volume);
  lcd.drawString(value, VOLUME_DIAL_CX, VOLUME_DIAL_CY - sy(10));

  setUiFont(2);
  drawUiText("%",
             VOLUME_DIAL_CX,
             VOLUME_DIAL_CY + sy(38),
             *currentUiFont,
             muted,
             knobBg,
             middle_center);
}

static void drawVolumeDial(uint8_t volume, bool fullRedraw) {
  const uint16_t bg = volumeScreenBg();
  const uint16_t muted = volumeMutedColor();
  const uint16_t knobBg = blend565(cAccent, bg, 34);
  const uint16_t knobEdge = blend565(cAccent, cLine, 92);

  if (fullRedraw) {
    const float minRad = VOLUME_ARC_START_DEG * CLOCK_PI / 180.0f;
    const float maxRad = (VOLUME_ARC_START_DEG + VOLUME_ARC_SPAN_DEG) * CLOCK_PI / 180.0f;

    setUiFont(1);
    drawUiText("MIN",
               VOLUME_DIAL_CX + static_cast<int>(cosf(minRad) * (VOLUME_DIAL_R + ss(12))),
               VOLUME_DIAL_CY + static_cast<int>(sinf(minRad) * (VOLUME_DIAL_R + ss(12))) + sy(24),
               *currentUiFont,
               muted,
               bg,
               middle_center);
    drawUiText("MAX",
               VOLUME_DIAL_CX + static_cast<int>(cosf(maxRad) * (VOLUME_DIAL_R + ss(12))),
               VOLUME_DIAL_CY + static_cast<int>(sinf(maxRad) * (VOLUME_DIAL_R + ss(12))) + sy(24),
               *currentUiFont,
               muted,
               bg,
               middle_center);

    lcd.fillCircle(VOLUME_DIAL_CX + sx(3), VOLUME_DIAL_CY + sy(4), VOLUME_KNOB_R, blend565(cLine, bg, 42));
    lcd.fillCircle(VOLUME_DIAL_CX, VOLUME_DIAL_CY, VOLUME_KNOB_R, knobBg);
    lcd.drawCircle(VOLUME_DIAL_CX, VOLUME_DIAL_CY, VOLUME_KNOB_R, knobEdge);
  }

  drawVolumeTicks(volume);
  drawVolumeValue(volume, knobBg);
}

static VuLayout volumeMeterLayout() {
  const int gapCount = VU_BAR_COUNT - 1;
  const int meterW = VU_BAR_COUNT * VU_BAR_W + max(0, gapCount) * VU_BAR_GAP;
  VuLayout layout;
  layout.symmetric = true;
  layout.classic = false;
  layout.styleKey = 0;
  layout.meterW = meterW;
  layout.meterX = (SCREEN_W - meterW) / 2;
  layout.centerX = layout.meterX + meterW / 2;
  layout.axisY = VOLUME_METER_AXIS_Y;
  layout.maxH = VU_SYMMETRIC_MAX_H;
  layout.clearY = layout.axisY - layout.maxH - sy(7);
  layout.clearH = layout.maxH * 2 + sy(14);
  return layout;
}

static uint8_t volumeMeterGhostHeight(int index, int maxH) {
  uint8_t shape = kVuShape[index % VU_BAR_COUNT];
  return max<uint8_t>(VU_MIN_H, static_cast<uint8_t>((static_cast<uint16_t>(shape) * maxH) / (255U * 3U)));
}

static uint8_t volumeMeterTargetHeight(int index, int maxH, unsigned long now, bool animate) {
  uint8_t seed = kVuSeed[index % VU_BAR_COUNT];
  int16_t live = 0;
  if (animate) {
    // Keep the VU contour and height range, but add a faster coherent wave
    // across the bars so the volume screen feels alive without growing taller.
    uint8_t traveling = triWave8(static_cast<uint16_t>(now / 2 + index * 18 + 19));
    uint8_t organic = triWave8(static_cast<uint16_t>(now / (6 + ((seed >> 3) & 0x03)) + seed * 5));
    live = ((static_cast<int16_t>(traveling) - 128) / 4) +
           ((static_cast<int16_t>(organic) - 128) / 8);
  }
  int16_t shape = constrain(static_cast<int16_t>(kVuShape[index % VU_BAR_COUNT]) + live, 76, 246);
  return max<uint8_t>(VU_MIN_H, static_cast<uint8_t>((static_cast<uint16_t>(shape) * maxH) / 255));
}

static void drawVolumeMeterBar(lgfx::LGFX_Sprite* sprite,
                               const VuLayout& layout,
                               int index,
                               int originX,
                               uint8_t height,
                               uint16_t color) {
  if (!height) return;
  height = min<uint8_t>(height, layout.maxH);
  int x = vuBarXInLayout(layout, index) - originX;
  int y = layout.axisY - height;
  int localY = y - layout.clearY;
  int radius = min<int>(3, max<int>(1, VU_BAR_W / 2));
  if (sprite) {
    sprite->fillRoundRect(x, localY, VU_BAR_W, height * 2 + 1, radius, color);
  } else {
    lcd.fillRoundRect(x + originX, y, VU_BAR_W, height * 2 + 1, radius, color);
  }
}

static uint32_t volumeMeterFillUnits(uint8_t volume) {
  return (static_cast<uint32_t>(constrain(volume, 0, 100)) * VU_BAR_COUNT * 256U + 50U) / 100U;
}

static void startVolumeMeterSweep(uint8_t volume) {
  const uint32_t fillUnits = volumeMeterFillUnits(volume);
  volumeMeterSweepUnits = volumeMeterSweepDirection < 0 ? static_cast<int32_t>(fillUnits) : 0;
  volumeMeterSweepActive = fillUnits > 0;
}

static void resetVolumeMeterAnimation(uint8_t volume) {
  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    volumeMeterBars[i] = 0;
  }
  startVolumeMeterSweep(volume);
}

static void restartVolumeMeterSweep(uint8_t volume) {
  startVolumeMeterSweep(volume);
}

static void drawVolumeMeter(uint8_t volume, bool playing) {
  const uint16_t bg = volumeScreenBg();
  const VuLayout layout = volumeMeterLayout();
  unsigned long now = millis();
  uint32_t fillUnits = volumeMeterFillUnits(volume);
  uint16_t ghost = blend565(cLine, bg, 118);

  static lgfx::LGFX_Sprite meterSprite(&lcd);
  static int spriteW = 0;
  static int spriteH = 0;
  static bool spriteReady = false;
  const int spritePad = sx(6);
  const int drawX = layout.meterX - spritePad;
  const int drawW = layout.meterW + spritePad * 2;

  if (volumeMeterSweepActive) {
    if (fillUnits == 0) {
      volumeMeterSweepActive = false;
    } else if (volumeMeterSweepDirection < 0) {
      volumeMeterSweepUnits -= 320;
      if (volumeMeterSweepUnits <= 0) {
        volumeMeterSweepUnits = 0;
        volumeMeterSweepActive = false;
      }
    } else {
      volumeMeterSweepUnits += 320;
      if (volumeMeterSweepUnits >= static_cast<int32_t>(fillUnits)) {
        volumeMeterSweepUnits = static_cast<int32_t>(fillUnits);
        volumeMeterSweepActive = false;
      }
    }
  }

  if (!spriteReady || spriteW != drawW || spriteH != layout.clearH) {
    if (spriteW || spriteH) meterSprite.deleteSprite();
    meterSprite.setPsram(true);
    meterSprite.setColorDepth(16);
    spriteReady = meterSprite.createSprite(drawW, layout.clearH) != nullptr;
    spriteW = spriteReady ? drawW : 0;
    spriteH = spriteReady ? layout.clearH : 0;
  }

  lgfx::LGFX_Sprite* canvas = spriteReady ? &meterSprite : nullptr;
  if (canvas) {
    canvas->fillSprite(bg);
  } else {
    lcd.startWrite();
    lcd.fillRect(drawX, layout.clearY, drawW, layout.clearH, bg);
  }

  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    uint8_t ghostHeight = volumeMeterGhostHeight(i, layout.maxH);
    drawVolumeMeterBar(canvas, layout, i, drawX, ghostHeight, ghost);

    int32_t rawFill = static_cast<int32_t>(fillUnits) - i * 256;
    uint8_t target = 0;
    if (rawFill > 0) {
      uint16_t barFill = static_cast<uint16_t>(min<int32_t>(256, rawFill));
      uint8_t liveHeight = volumeMeterTargetHeight(i, layout.maxH, now, playing);
      target = static_cast<uint8_t>(max<uint16_t>(VU_MIN_H, (static_cast<uint16_t>(liveHeight) * barFill) / 256U));
    }

    uint8_t current = volumeMeterBars[i];
    if (!playing) {
      // While stopped, keep the volume shape fixed. The sweep below remains
      // active so the recent volume change still gets its visual feedback.
      current = target;
    } else if (target > current) {
      uint8_t rise = max<uint8_t>(5, static_cast<uint8_t>((target - current + 2) * 2 / 3));
      current = min<uint8_t>(target, current + rise);
    } else if (current > target) {
      uint8_t fall = max<uint8_t>(4, static_cast<uint8_t>((current - target + 2) / 2));
      current = current > fall ? max<uint8_t>(target, current - fall) : target;
    }
    volumeMeterBars[i] = current;

    if (current > 0) {
      uint8_t drawHeight = current;
      uint16_t color = vuBarColor();
      if (volumeMeterSweepActive) {
        const int32_t barCenter = i * 256 + 128;
        const int32_t distance = abs(barCenter - volumeMeterSweepUnits);
        if (distance < 384) {
          const uint8_t highlight = static_cast<uint8_t>(
            max<int32_t>(0, 220 - (distance * 220) / 384));
          // The glint stays warm white in both display polarities. Only a
          // stopped meter gets the synchronized height lift; during playback
          // the live bar motion already supplies the geometry animation.
          const uint16_t glint = lcd.color565(255, 255, 244);
          color = blend565(glint, color, highlight);
          if (!playing) {
            drawHeight = min<uint8_t>(layout.maxH, current + 1 + highlight / 74);
          }
        }
      }
      drawVolumeMeterBar(canvas, layout, i, drawX, drawHeight, color);
    }
  }

  if (canvas) {
    canvas->pushSprite(drawX, layout.clearY);
  } else {
    lcd.endWrite();
  }
}

static VuLayout bootMeterLayout() {
  VuLayout layout = volumeMeterLayout();
  layout.axisY = sy(198);
  layout.clearY = layout.axisY - layout.maxH - sy(7);
  return layout;
}

static void drawBootProgressMeter(uint8_t progress, unsigned long now) {
  const uint16_t bg = cBg;
  const VuLayout layout = bootMeterLayout();
  const int drawX = layout.meterX - sx(6);
  const int drawW = layout.meterW + sx(12);
  const uint32_t fillUnits = volumeMeterFillUnits(progress);
  const uint16_t ghost = blend565(cLine, bg, 118);
  const uint16_t glint = lcd.color565(255, 255, 244);
  const int32_t sweepSpan = static_cast<int32_t>(fillUnits) + 768;
  const int32_t sweepUnits = fillUnits
                                 ? static_cast<int32_t>((static_cast<uint32_t>(now) * 4U) % sweepSpan) - 384
                                 : -1024;

  static lgfx::LGFX_Sprite bootMeterSprite(&lcd);
  static int spriteW = 0;
  static int spriteH = 0;
  static bool spriteReady = false;
  if (!spriteReady || spriteW != drawW || spriteH != layout.clearH) {
    if (spriteW || spriteH) bootMeterSprite.deleteSprite();
    bootMeterSprite.setPsram(true);
    bootMeterSprite.setColorDepth(16);
    spriteReady = bootMeterSprite.createSprite(drawW, layout.clearH) != nullptr;
    spriteW = spriteReady ? drawW : 0;
    spriteH = spriteReady ? layout.clearH : 0;
  }

  lgfx::LGFX_Sprite* canvas = spriteReady ? &bootMeterSprite : nullptr;
  if (canvas) {
    canvas->fillSprite(bg);
  } else {
    lcd.startWrite();
    lcd.fillRect(drawX, layout.clearY, drawW, layout.clearH, bg);
  }

  for (int i = 0; i < VU_BAR_COUNT; ++i) {
    drawVolumeMeterBar(canvas,
                       layout,
                       i,
                       drawX,
                       volumeMeterGhostHeight(i, layout.maxH),
                       ghost);

    const int32_t rawFill = static_cast<int32_t>(fillUnits) - i * 256;
    if (rawFill <= 0) continue;

    const uint16_t barFill = static_cast<uint16_t>(min<int32_t>(256, rawFill));
    const uint8_t baseHeight = volumeMeterTargetHeight(i, layout.maxH, now, false);
    uint8_t height = static_cast<uint8_t>(
        max<uint16_t>(VU_MIN_H, (static_cast<uint16_t>(baseHeight) * barFill) / 256U));
    uint16_t color = vuBarColor();

    const int32_t distance = abs(i * 256 + 128 - sweepUnits);
    if (distance < 384) {
      const uint8_t highlight = static_cast<uint8_t>(
          max<int32_t>(0, 220 - (distance * 220) / 384));
      color = blend565(glint, color, highlight);
      height = min<uint8_t>(layout.maxH, height + 1 + highlight / 74);
    }
    drawVolumeMeterBar(canvas, layout, i, drawX, height, color);
  }

  if (canvas) {
    canvas->pushSprite(drawX, layout.clearY);
  } else {
    lcd.endWrite();
  }
}

static void drawBootScreen(uint8_t progress) {
  lcd.fillScreen(cBg);
  setUiFont(3);
  drawUiText("SimpleRadio",
             SCREEN_W / 2,
             sy(112),
             *currentUiFont,
             cText,
             cBg,
             middle_center);
  drawBootProgressMeter(progress, millis());
}

static void drawVolumeScreenValue(uint8_t volume) {
  const uint16_t bg = volumeScreenBg();
  lcd.fillRect(0, VOLUME_VALUE_Y - sy(30), SCREEN_W, sy(62), bg);

  setBaseFont();
  lcd.setFont(&fonts::Font7);
  lcd.setTextDatum(middle_center);
  lcd.setTextColor(volumeTextColor(), bg);
  String value = String(volume);
  int valueW = lcd.textWidth(value);
  int percentGap = sx(6);
  setUiFont(2);
  int percentW = uiTextWidth("%", *currentUiFont);
  int groupW = valueW + percentGap + percentW;
  int valueCenterX = SCREEN_W / 2 - groupW / 2 + valueW / 2;
  lcd.setFont(&fonts::Font7);
  lcd.drawString(value, valueCenterX, VOLUME_VALUE_Y);
  drawUiText("%",
             SCREEN_W / 2 - groupW / 2 + valueW + percentGap,
             VOLUME_VALUE_Y + sy(4),
             *currentUiFont,
             volumeTextColor(),
             bg,
             middle_left);
}

static void drawVolumePopupModern(uint8_t volume, bool playing) {
  const uint16_t bg = volumeScreenBg();
  lcd.fillScreen(bg);
  resetVolumeMeterAnimation(volume);

  setUiFont(3);
  drawUiText(I18n::VOLUME_TITLE, SCREEN_W / 2, VOLUME_TITLE_Y, *currentUiFont, volumeTextColor(), bg, top_center);
  drawVolumeScreenValue(volume);
  drawVolumeMeter(volume, playing);
}

static void drawVolumePopupModernValueOnly(uint8_t volume, bool playing, bool valueChanged) {
  if (valueChanged) {
    drawVolumeScreenValue(volume);
    restartVolumeMeterSweep(volume);
  }
  drawVolumeMeter(volume, playing);
}

static bool rectsOverlap(int ax, int ay, int aw, int ah, int bx, int by, int bw, int bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

static void redrawVolumePopupArea(const DisplayModel& m) {
  const int popupX = VOLUME_POPUP_X - sx(10);
  const int popupY = VOLUME_POPUP_Y - sy(10);
  const int popupW = VOLUME_POPUP_W + sx(26);
  const int popupH = VOLUME_POPUP_H + sy(30);

  drawPlayerSurfaceRegion(popupX, popupY, popupW, popupH);
  if (rectsOverlap(popupX, popupY, popupW, popupH, ART_REGION_X, ART_REGION_Y, ART_REGION_W, ART_REGION_H)) {
    drawArt(m);
  }
  if (rectsOverlap(popupX, popupY, popupW, popupH, INFO_REGION_X, INFO_REGION_Y, INFO_REGION_W, INFO_REGION_H)) {
    drawInfoRegion(m);
  }
  if (rectsOverlap(popupX, popupY, popupW, popupH, FOOTER_REGION_X, FOOTER_REGION_Y, FOOTER_REGION_W, FOOTER_REGION_H)) {
    drawFooterRegion(m);
  }
}

static void redrawStationPickerArea(const DisplayModel& m) {
  const int pickerX = PICKER_BOX_X - sx(8);
  const int pickerY = PICKER_BOX_Y - sy(8);
  const int pickerW = PICKER_BOX_W + sx(16);
  const int pickerH = PICKER_BOX_H + sy(16);

  drawPlayerSurfaceRegion(pickerX, pickerY, pickerW, pickerH);
  if (rectsOverlap(pickerX, pickerY, pickerW, pickerH, ART_REGION_X, ART_REGION_Y, ART_REGION_W, ART_REGION_H)) {
    drawArt(m);
  }
  if (rectsOverlap(pickerX, pickerY, pickerW, pickerH, INFO_REGION_X, INFO_REGION_Y, INFO_REGION_W, INFO_REGION_H)) {
    drawInfoRegion(m);
  }
  if (rectsOverlap(pickerX, pickerY, pickerW, pickerH, FOOTER_REGION_X, FOOTER_REGION_Y, FOOTER_REGION_W, FOOTER_REGION_H)) {
    drawFooterRegion(m);
  }
}

static bool displayModelsDifferForPlaybackInteraction(const DisplayModel& a, const DisplayModel& b) {
  return a.apMode != b.apMode ||
         a.playing != b.playing ||
         a.stationId != b.stationId;
}

void Display::renderVolumePopupFrame(bool forceFull) {
  unsigned long now = millis();
  if (stationPickerActive || !volumePopupUntil || now >= volumePopupUntil) return;

  bool full = forceFull || !volumePopupDrawn;
  if (!full && now - lastVolumePopupDrawMs < 40) return;

  if (full) {
    drawVolumePopupModern(popupVolume, lastModel.playing);
    volumePopupDrawn = true;
  } else {
    drawVolumePopupModernValueOnly(popupVolume, lastModel.playing, renderedPopupVolume != popupVolume);
  }

  renderedPopupVolume = popupVolume;
  volumePopupDirty = false;
  lastVolumePopupDrawMs = now;
}

void Display::dismissVolumePopupNow() {
  volumePopupUntil = 0;
  volumePopupDrawn = false;
  volumePopupDirty = false;
  renderedPopupVolume = 255;
  lastVolumePopupDrawMs = 0;
  volumeRestoreInProgress = false;
}

static String twoDigits(int value) {
  char out[3];
  snprintf(out, sizeof(out), "%02d", value);
  return String(out);
}

static String clockDateLine(const struct tm& timeinfo) {
  int year = constrain(timeinfo.tm_year + 1900, 0, 9999);
  int month = constrain(timeinfo.tm_mon + 1, 1, 12);
  int day = constrain(timeinfo.tm_mday, 1, 31);
  char date[16];
  snprintf(date, sizeof(date), "%04d.%02d.%02d",
           year,
           month,
           day);

  String out = date;
  out += "  ";
  out += I18n::weekday(timeinfo.tm_wday % 7);
  return out;
}

static void drawClockSurfaceRegion(int32_t x, int32_t y, int32_t w, int32_t h) {
  int32_t x0 = max<int32_t>(0, x);
  int32_t y0 = max<int32_t>(0, y);
  int32_t x1 = min<int32_t>(SCREEN_W, x + w);
  int32_t y1 = min<int32_t>(SCREEN_H, y + h);
  if (x1 <= x0 || y1 <= y0) return;

  for (int32_t yy = y0; yy < y1; ++yy) {
    uint16_t color = cBg;
    if (yy < SCREEN_H / 2) {
      color = blend565(cPanelAlt, cBg, 34 - yy / 12);
    } else {
      color = blend565(cPanel, cBg, 12 + (yy - SCREEN_H / 2) / 8);
    }
    lcd.drawFastHLine(x0, yy, x1 - x0, color);
  }

  for (int32_t lineX = sx(16); lineX < SCREEN_W; lineX += sx(32)) {
    if (lineX >= x0 && lineX < x1) {
      lcd.drawFastVLine(lineX, y0, y1 - y0, blend565(cLine, cBg, 28));
    }
  }

  int32_t lineY = SCREEN_H - sy(16);
  if (lineY >= y0 && lineY < y1) {
    lcd.drawFastHLine(max<int32_t>(sx(28), x0), lineY, min<int32_t>(SCREEN_W - sx(28), x1) - max<int32_t>(sx(28), x0), blend565(cAccent, cBg, 120));
  }
}

static void drawClockSurface() {
  drawClockSurfaceRegion(0, 0, SCREEN_W, SCREEN_H);
}

static void drawDigitalClockText(const struct tm& timeinfo, bool haveTime) {
  drawClockSurfaceRegion(sx(20), sy(44), SCREEN_W - sx(40), sy(184));
  String timeText = haveTime
                      ? twoDigits(timeinfo.tm_hour) + ":" + twoDigits(timeinfo.tm_min)
                      : "--:--";

  setBaseFont();
  lcd.setFont(COMPACT_LCD ? &fonts::Font7 : &fonts::Font8);
  lcd.setTextDatum(middle_center);
  lcd.setTextColor(cText, cBg);
  lcd.drawString(timeText, SCREEN_W / 2, sy(128));

  setUiFont(2);
  String subtitle = haveTime ? clockDateLine(timeinfo) : I18n::TIME_SYNC;
  drawUiText(subtitle, SCREEN_W / 2, sy(220), *currentUiFont, cAccent, cBg, middle_center);
}

static void drawDigitalClockSecondBar(const struct tm& timeinfo, bool haveTime) {
  int second = haveTime ? timeinfo.tm_sec : (millis() / 1000) % 60;
  const int barX = sx(118);
  const int barY = sy(256);
  const int barW = SCREEN_W - barX * 2;
  drawClockSurfaceRegion(barX - sx(4), barY - sy(4), barW + sx(8), sy(18));
  lcd.fillRoundRect(barX, barY, barW, sy(8), ss(4), blend565(cLine, cBg, 170));
  lcd.fillRoundRect(barX, barY, map(second, 0, 59, 0, barW), sy(8), ss(4), cAccent);
}

static void drawDigitalClockFooter() {
  drawClockSurfaceRegion(0, sy(284), SCREEN_W, sy(30));
  setUiFont(1);
  drawUiText(I18n::SIMPLE_RADIO, SCREEN_W / 2, sy(298), *currentUiFont, cMuted, cBg, middle_center);
}

static void drawDigitalClock(const struct tm& timeinfo, bool haveTime) {
  drawClockSurface();
  drawDigitalClockText(timeinfo, haveTime);
  drawDigitalClockSecondBar(timeinfo, haveTime);
  drawDigitalClockFooter();
}

static void drawClockHand(int cx, int cy, float angle, int length, uint16_t color, uint8_t width) {
  float px = -sinf(angle);
  float py = cosf(angle);
  int x2 = cx + static_cast<int>(cosf(angle) * length);
  int y2 = cy + static_cast<int>(sinf(angle) * length);
  int halfWidth = max<int>(1, width / 2);

  for (int offset = -halfWidth; offset <= halfWidth; ++offset) {
    int ox = static_cast<int>(px * offset);
    int oy = static_cast<int>(py * offset);
    lcd.drawLine(cx + ox, cy + oy, x2 + ox, y2 + oy, color);
  }
}

static void resetAnalogClockHandCache() {
  analogClockHandsValid = false;
}

static void analogClockAngles(const struct tm& timeinfo, bool haveTime, float& hourAngle, float& minuteAngle, float& secondAngle) {
  const int second = haveTime ? timeinfo.tm_sec : (millis() / 1000) % 60;
  const int minute = haveTime ? timeinfo.tm_min : 0;
  const int hour = haveTime ? timeinfo.tm_hour % 12 : 10;

  hourAngle = ((static_cast<float>(hour) + minute / 60.0f) / 12.0f) * CLOCK_PI * 2.0f - CLOCK_PI / 2.0f;
  minuteAngle = (static_cast<float>(minute) / 60.0f) * CLOCK_PI * 2.0f - CLOCK_PI / 2.0f;
  secondAngle = (static_cast<float>(second) / 60.0f) * CLOCK_PI * 2.0f - CLOCK_PI / 2.0f;
}

static void drawAnalogClockMarks(int cx, int cy, int radius, uint16_t faceBg) {
  for (int i = 0; i < 60; ++i) {
    float angle = (static_cast<float>(i) / 60.0f) * CLOCK_PI * 2.0f - CLOCK_PI / 2.0f;
    int outer = radius;
    int inner = (i % 5 == 0) ? radius - ss(14) : radius - ss(7);
    uint16_t color = (i % 5 == 0) ? cText : cMuted;
    int x1 = cx + static_cast<int>(cosf(angle) * inner);
    int y1 = cy + static_cast<int>(sinf(angle) * inner);
    int x2 = cx + static_cast<int>(cosf(angle) * outer);
    int y2 = cy + static_cast<int>(sinf(angle) * outer);
    lcd.drawLine(x1, y1, x2, y2, color);
  }

  setUiFont(2);
  drawUiText("12", cx, cy - radius + sy(26), *currentUiFont, cText, faceBg, middle_center);
  drawUiText("3", cx + radius - sx(28), cy, *currentUiFont, cText, faceBg, middle_center);
  drawUiText("6", cx, cy + radius - sy(28), *currentUiFont, cText, faceBg, middle_center);
  drawUiText("9", cx - radius + sx(28), cy, *currentUiFont, cText, faceBg, middle_center);
}

static void drawAnalogClockHands(float hourAngle, float minuteAngle, float secondAngle) {
  const int cx = SCREEN_W / 2;
  const int cy = sy(148);
  drawClockHand(cx, cy, hourAngle, ss(52), cText, ss(6));
  drawClockHand(cx, cy, minuteAngle, ss(78), cText, ss(4));
  drawClockHand(cx, cy, secondAngle, ss(90), cAccent, ss(2));
  lcd.fillCircle(cx, cy, ss(8), cAccent);
  lcd.fillCircle(cx, cy, ss(3), cOnAccent);
}

static void drawAnalogClockFace(const struct tm& timeinfo, bool haveTime) {
  const int cx = SCREEN_W / 2;
  const int cy = sy(148);
  const int radius = ss(106);
  const uint16_t faceBg = blend565(cPanelAlt, cBg, 150);

  lcd.fillCircle(cx, cy, radius + ss(14), faceBg);
  lcd.drawCircle(cx, cy, radius + ss(14), blend565(cLine, cBg, 190));
  lcd.drawCircle(cx, cy, radius, blend565(cAccent, cBg, 170));
  drawAnalogClockMarks(cx, cy, radius, faceBg);

  float hourAngle;
  float minuteAngle;
  float secondAngle;
  analogClockAngles(timeinfo, haveTime, hourAngle, minuteAngle, secondAngle);
  drawAnalogClockHands(hourAngle, minuteAngle, secondAngle);
  analogClockLastHourAngle = hourAngle;
  analogClockLastMinuteAngle = minuteAngle;
  analogClockLastSecondAngle = secondAngle;
  analogClockHandsValid = true;
}

static void drawAnalogClockHandsOnly(const struct tm& timeinfo, bool haveTime) {
  const int cx = SCREEN_W / 2;
  const int cy = sy(148);
  const int radius = ss(106);
  const uint16_t faceBg = blend565(cPanelAlt, cBg, 150);

  float hourAngle;
  float minuteAngle;
  float secondAngle;
  analogClockAngles(timeinfo, haveTime, hourAngle, minuteAngle, secondAngle);

  if (!analogClockHandsValid) {
    drawAnalogClockFace(timeinfo, haveTime);
    return;
  }

  drawClockHand(cx, cy, analogClockLastHourAngle, ss(52), faceBg, ss(8));
  drawClockHand(cx, cy, analogClockLastMinuteAngle, ss(78), faceBg, ss(6));
  drawClockHand(cx, cy, analogClockLastSecondAngle, ss(90), faceBg, ss(4));
  lcd.fillCircle(cx, cy, ss(10), faceBg);
  drawAnalogClockMarks(cx, cy, radius, faceBg);
  drawAnalogClockHands(hourAngle, minuteAngle, secondAngle);

  analogClockLastHourAngle = hourAngle;
  analogClockLastMinuteAngle = minuteAngle;
  analogClockLastSecondAngle = secondAngle;
  analogClockHandsValid = true;
}

static void drawAnalogClockCaption(const struct tm& timeinfo, bool haveTime) {
  drawClockSurfaceRegion(0, sy(262), SCREEN_W, sy(44));
  setUiFont(2);
  String bottom = haveTime
                    ? twoDigits(timeinfo.tm_hour) + ":" + twoDigits(timeinfo.tm_min) + "  " + clockDateLine(timeinfo)
                    : I18n::TIME_SYNC;
  drawUiText(bottom, SCREEN_W / 2, sy(284), *currentUiFont, cAccent, cBg, middle_center);
}

static void drawAnalogClock(const struct tm& timeinfo, bool haveTime) {
  drawClockSurface();
  resetAnalogClockHandCache();
  drawAnalogClockFace(timeinfo, haveTime);
  drawAnalogClockCaption(timeinfo, haveTime);
}

void Display::startTask() {
  if (taskStarted) return;
  if (!pendingMutex) {
    pendingMutex = xSemaphoreCreateMutex();
  }
  if (!pendingMutex) {
    Serial.println("[display] pending mutex create failed");
    return;
  }

  BaseType_t ok = xTaskCreatePinnedToCore(
    displayTaskEntry,
    "display",
    DISPLAY_TASK_STACK,
    nullptr,
    1,
    &taskHandle,
    DISPLAY_TASK_CORE
  );
  if (ok == pdPASS) {
    taskStarted = true;
    Serial.printf("[display] task started on core %d\n", DISPLAY_TASK_CORE);
  } else {
    taskHandle = nullptr;
    Serial.println("[display] task start failed");
  }
}

void Display::taskLoop() {
  DisplayModel model;
  bool hasModel = false;
  bool applyConfigRequest = false;
  bool activityRequest = false;
  bool artworkRefreshRequest = false;
  int bootProgressRequest = -1;
  bool bootFinishRequest = false;
  int pickerAction = 0;
  int pickerStationId = -1;

  if (pendingMutex && xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
    if (hasPendingModel) {
      model = pendingModel;
      hasModel = true;
      hasPendingModel = false;
    }
    applyConfigRequest = pendingConfigApply;
    pendingConfigApply = false;
    activityRequest = pendingActivity;
    pendingActivity = false;
    artworkRefreshRequest = pendingArtworkRefresh;
    pendingArtworkRefresh = false;
    bootProgressRequest = pendingBootProgress;
    pendingBootProgress = -1;
    bootFinishRequest = pendingBootFinish;
    pendingBootFinish = false;
    pickerAction = pendingPickerAction;
    pickerStationId = pendingPickerStationId;
    pendingPickerAction = 0;
    pendingPickerStationId = -1;
    xSemaphoreGive(pendingMutex);
  }

  if (activityRequest) notifyActivityNow();
  if (applyConfigRequest) applyConfigNow();
  if (bootProgressRequest >= 0) showBootProgressNow(static_cast<uint8_t>(bootProgressRequest));
  if (bootFinishRequest) finishBootNow();
  if (hasModel) renderNow(model);
  if (artworkRefreshRequest) refreshArtworkNow();
  if (pickerAction == 1) {
    showStationPickerNow(pickerStationId);
  } else if (pickerAction == 2) {
    hideStationPickerNow();
  }
  tickNow();
}

void Display::begin() {
  lcd.init();
  lcd.setRotation(DISPLAY_ROTATION);
  lcd.setColorDepth(16);
  lcd.invertDisplay(false);
#if TFT_BL >= 0
  pinMode(TFT_BL, OUTPUT);
  ledcAttach(TFT_BL, 5000, 8);
#endif

  AppConfig& config = AppConfig::instance();
  lastThemeAccent = config.themeAccent;
  lastThemeCustomColor = config.themeCustomColor;
  applyPalette(false, lastThemeAccent);

  lcd.fillScreen(cBg);
  lastActivityMs = millis();
  applyConfigNow();
  bootActive = true;
  bootFinishRequested = false;
  bootProgress = 0;
  bootProgressTarget = 0;
  lastBootFrameMs = 0;
  bootFullSinceMs = 0;
  hasDeferredBootModel = false;
  drawBootScreen(0);
  startTask();
}

void Display::showBootProgress(uint8_t progress) {
  progress = constrain(progress, 0, 100);
  if (!taskStarted || !pendingMutex) {
    showBootProgressNow(progress);
    return;
  }

  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    pendingBootProgress = max<int>(pendingBootProgress, progress);
    xSemaphoreGive(pendingMutex);
  }
}

void Display::finishBoot() {
  if (!taskStarted || !pendingMutex) {
    finishBootNow();
    return;
  }

  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    pendingBootProgress = 100;
    pendingBootFinish = true;
    xSemaphoreGive(pendingMutex);
  }
}

void Display::showBootProgressNow(uint8_t progress) {
  if (!bootActive) return;
  bootProgressTarget = max<uint8_t>(bootProgressTarget, constrain(progress, 0, 100));
}

void Display::finishBootNow() {
  if (!bootActive) return;
  bootProgressTarget = 100;
  bootFinishRequested = true;
}

void Display::applyConfig() {
  if (!taskStarted || !pendingMutex) {
    applyConfigNow();
    return;
  }

  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    pendingConfigApply = true;
    xSemaphoreGive(pendingMutex);
  }
}

void Display::applyConfigNow() {
  AppConfig& config = AppConfig::instance();

  bool themeChanged = config.themeAccent != lastThemeAccent ||
                      config.themeCustomColor != lastThemeCustomColor;
  if (config.displayInvert != lastInvert || themeChanged) {
    lastInvert = config.displayInvert;
    lastThemeAccent = config.themeAccent;
    lastThemeCustomColor = config.themeCustomColor;
    lcd.invertDisplay(false);
    applyPalette(config.displayInvert, config.themeAccent);
    if (idleClockActive) {
      lastClockStamp = -1;
      lastClockMinuteStamp = -1;
      renderIdleClock(true);
    } else if (hasRenderedModel) {
      renderCurrent();
    }
  }

  bool idleEligible = !lastModel.playing;
  bool idle = idleEligible &&
              config.displayIdleEnabled &&
              lastActivityMs > 0 &&
              millis() - lastActivityMs >= static_cast<unsigned long>(config.displayIdleSeconds) * 1000UL;

  uint8_t targetBrightness = idle ? config.displayIdleBrightness : config.brightness;
  if (!idle && config.autoBrightness) {
    struct tm timeinfo;
    if (getLocalTime(&timeinfo, 5)) {
      uint16_t minute = timeinfo.tm_hour * 60 + timeinfo.tm_min;
      bool isDay;
      if (config.dayStartMinute <= config.nightStartMinute) {
        isDay = minute >= config.dayStartMinute && minute < config.nightStartMinute;
      } else {
        isDay = minute >= config.dayStartMinute || minute < config.nightStartMinute;
      }
      targetBrightness = isDay ? config.dayBrightness : config.nightBrightness;
    }
  }

  bool canShowIdle = idle && !lastModel.apMode && !stationPickerActive;
  bool clockRequested = canShowIdle && config.displayClockEnabled;

  if (clockRequested) {
    String style = config.displayClockStyleId == DisplayClockStyle::Analog ? "analog" : "digital";
    if (!idleClockActive || lastClockStyle != style) {
      idleClockActive = true;
      idleBlanked = false;
      lastClockStamp = -1;
      renderIdleClock(true);
    }
  } else if (idleClockActive) {
    idleClockActive = false;
    lastClockStamp = -1;
    lastClockMinuteStamp = -1;
    if (hasRenderedModel) renderCurrent();
  }

  if (!clockRequested && idle && config.displayIdleBlank && !idleBlanked && !lastModel.apMode) {
    idleBlanked = true;
    idleGuardBlanked = false;
    lcd.fillScreen(TFT_BLACK);
  }

  unsigned long now = millis();
  bool guardEligible = idle &&
                       !idleBlanked &&
                       !lastModel.apMode &&
                       !stationPickerActive &&
                       !volumePopupUntil;
  if (!guardEligible) {
    idleGuardBlanked = false;
    idleGuardLastMs = now;
    idleGuardRestoreMs = 0;
  } else if (!idleGuardBlanked) {
    if (idleGuardLastMs == 0) idleGuardLastMs = now;
    if (now - idleGuardLastMs >= IDLE_LCD_GUARD_MS) {
      idleGuardBlanked = true;
      idleGuardRestoreMs = now + IDLE_LCD_GUARD_BLACK_MS;
      lcd.fillScreen(TFT_BLACK);
    }
  }

  if (targetBrightness != lastBrightness) {
    lastBrightness = targetBrightness;
#if TFT_BL >= 0
    ledcWrite(TFT_BL, targetBrightness);
#endif
  }

  StatusLed::instance().setDisplayBacklight(targetBrightness, idle && !idleBlanked, idleBlanked);
}

bool Display::isVolumeScreenActive() const {
  return volumePopupUntil && millis() < volumePopupUntil;
}

void Display::render(const DisplayModel& m) {
  if (!taskStarted || !pendingMutex) {
    renderNow(m);
    return;
  }

  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    pendingModel = m;
    hasPendingModel = true;
    xSemaphoreGive(pendingMutex);
  }
}

void Display::renderNow(const DisplayModel& m) {
  if (bootActive) {
    deferredBootModel = m;
    hasDeferredBootModel = true;
    return;
  }

  auto finishRender = [](bool) {};

  uint8_t currentFooterMode = footerRenderKey();
  bool footerModeChanged = currentFooterMode != lastFooterMode;
  if (m.equals(lastModel) && !footerModeChanged && !idleGuardBlanked) return;

  DisplayModel previous = lastModel;
  bool hadRenderedModel = hasRenderedModel;
  bool volumeChanged = m.volume != previous.volume;
  bool playbackChanged = displayModelsDifferForPlaybackInteraction(previous, m);
  bool dismissVolumePopup = hasRenderedModel &&
                            volumePopupUntil &&
                            millis() < volumePopupUntil &&
                            playbackChanged;

  if (dismissVolumePopup) {
    dismissVolumePopupNow();
  }

  if (hasRenderedModel && !m.apMode && volumeChanged && !playbackChanged) {
    volumeMeterSweepDirection = m.volume < previous.volume ? -1 : 1;
    popupVolume = m.volume;
    volumePopupUntil = millis() + VOLUME_SCREEN_MS;
    volumePopupDirty = true;
    notifyActivityNow();
  }
  lastModel = m;
  lastFooterMode = currentFooterMode;
  hasRenderedModel = true;

  if (dismissVolumePopup) {
    renderCurrent();
    finishRender(true);
    return;
  }

  if (stationPickerActive && hadRenderedModel && !m.apMode && previous.apMode == m.apMode) {
    finishRender(false);
    return;
  }

  if ((idleBlanked || idleClockActive || idleGuardBlanked) && m.playing) {
    idleBlanked = false;
    idleClockActive = false;
    idleGuardBlanked = false;
    idleGuardLastMs = millis();
    idleGuardRestoreMs = 0;
    lastClockStamp = -1;
    lastClockMinuteStamp = -1;
    lastBrightness = 255;
    applyConfigNow();
    renderCurrent();
    finishRender(true);
    return;
  }

  if (idleGuardBlanked) {
    finishRender(false);
    return;
  }

  if (!hadRenderedModel ||
      m.apMode ||
      previous.apMode != m.apMode) {
    renderCurrent();
    finishRender(true);
    return;
  }

  renderPartial(previous, footerModeChanged);
  finishRender(false);
}

void Display::renderCurrent() {
  if (idleBlanked || idleClockActive || idleGuardBlanked) return;

  const DisplayModel& m = lastModel;

  if (m.apMode) {
    drawApMode(m);
    return;
  }

  if (stationPickerActive) {
    drawStationPickerPaged(stationPickerSelectedId, stationPickerWindowStart, stationPickerRenderedSelectedId, true);
    return;
  }

  if (volumePopupUntil && millis() < volumePopupUntil) {
    renderVolumePopupFrame(true);
    return;
  }

  drawPlayerSurface();
  drawArtIfNeeded(m, true);
  deferredArtworkRefresh = false;

  drawInfoRegion(m);
  drawFooterRegion(m);
}

void Display::renderPartial(const DisplayModel& previous, bool footerModeChanged) {
  if (idleBlanked || idleClockActive) return;

  const DisplayModel& m = lastModel;

  bool logoMissing = !m.logoPath.length() || (m.logoPath.startsWith("/") && !LittleFS.exists(m.logoPath));
  String previousArtKey = artRenderKeyFor(previous);
  String currentArtKey = artRenderKeyFor(m);
  bool equivalentStationLogoSwap = previous.logoPath != m.logoPath &&
                                   previous.station == m.station &&
                                   !previous.hasStreamImage &&
                                   !m.hasStreamImage &&
                                   !previous.albumArtworkMode &&
                                   !m.albumArtworkMode &&
                                   readyArtKey(previousArtKey) &&
                                   readyArtKey(currentArtKey);
  if (equivalentStationLogoSwap) {
    lastRenderedArtKey = currentArtKey;
  }
  bool artChanged = (!equivalentStationLogoSwap && previous.logoPath != m.logoPath) ||
                    (logoMissing && previous.station != m.station);
  bool infoChanged = previous.station != m.station ||
                     previous.artist != m.artist ||
                     previous.title != m.title ||
                     previous.playing != m.playing ||
                     previous.networkConnected != m.networkConnected ||
                     previous.streamConnectionState != m.streamConnectionState ||
                     previous.streamConnectFailures != m.streamConnectFailures;
  bool volumeChanged = previous.volume != m.volume;
  bool popupActive = volumePopupUntil && millis() < volumePopupUntil;
  if (popupActive) {
    renderVolumePopupFrame(false);
    return;
  }

  DisplayFooterMode currentFooterMode = footerMode();
  bool footerChanged = footerModeChanged ||
                       previous.ip != m.ip ||
                       previous.bitrate != m.bitrate ||
                       previous.codec != m.codec ||
                       (currentFooterMode == DisplayFooterMode::Station && previous.station != m.station) ||
                       (currentFooterMode == DisplayFooterMode::Volume && volumeChanged && !popupActive);

  if (deferredArtworkRefresh) {
    drawArtIfNeeded(m);
    deferredArtworkRefresh = false;
  } else if (artChanged) {
    drawArtIfNeeded(m);
  }

  if (infoChanged) {
    drawInfoRegion(m);
  }

  if (footerChanged) {
    drawFooterRegion(m);
  }

}

void Display::tick() {
  if (!taskStarted) {
    tickNow();
  }
}

void Display::resetStationPickerMarqueeNow(int selectedStationId) {
  stationPickerMarqueeSelectedId = selectedStationId;
  stationPickerMarqueeOffset = 0;
  stationPickerMarqueeDirection = 1;
  stationPickerMarqueeLastMs = 0;
  stationPickerMarqueeHoldUntil = millis() + PICKER_MARQUEE_HOLD_MS;
}

void Display::renderStationPickerMarqueeFrame() {
  if (!stationPickerActive ||
      !hasRenderedModel ||
      idleBlanked ||
      idleClockActive ||
      lastModel.apMode ||
      stationPickerWindowStart < 0 ||
      stationPickerRenderedSelectedId < 0) {
    return;
  }

  unsigned long now = millis();
  if (stationPickerMarqueeSelectedId != stationPickerSelectedId) {
    resetStationPickerMarqueeNow(stationPickerSelectedId);
  }
  if (now - stationPickerMarqueeLastMs < PICKER_MARQUEE_MS) return;

  StationManager& manager = StationManager::instance();
  int selectedIndex = manager.indexOfStation(stationPickerSelectedId);
  if (selectedIndex < 0 ||
      selectedIndex < stationPickerWindowStart ||
      selectedIndex >= stationPickerWindowStart + PICKER_VISIBLE_ROWS) {
    return;
  }

  Station station;
  if (!manager.stationAtIndex(selectedIndex, station)) return;

  setUiFont(3);
  String stationName = lcdSafeText(station.name);
  int32_t textWidth = uiTextWidth(stationName);
  if (textWidth <= PICKER_TEXT_W) {
    stationPickerMarqueeOffset = 0;
    return;
  }

  if (now < stationPickerMarqueeHoldUntil) return;

  stationPickerMarqueeLastMs = now;
  int maxOffset = max(0, static_cast<int>(textWidth - PICKER_TEXT_W));
  stationPickerMarqueeOffset += PICKER_MARQUEE_STEP * (stationPickerMarqueeDirection >= 0 ? 1 : -1);
  if (stationPickerMarqueeOffset >= maxOffset) {
    stationPickerMarqueeOffset = maxOffset;
    stationPickerMarqueeDirection = -1;
    stationPickerMarqueeHoldUntil = now + PICKER_MARQUEE_HOLD_MS;
  } else if (stationPickerMarqueeOffset <= 0) {
    stationPickerMarqueeOffset = 0;
    stationPickerMarqueeDirection = 1;
    stationPickerMarqueeHoldUntil = now + PICKER_MARQUEE_HOLD_MS;
  }

  int row = selectedIndex - stationPickerWindowStart;
  drawStationPickerMarqueeText(row, stationName, stationPickerMarqueeOffset);
}

void Display::tickNow() {
  if (bootActive) {
    unsigned long now = millis();
    if (!lastBootFrameMs || now - lastBootFrameMs >= METER_RENDER_MS) {
      if (bootProgress < bootProgressTarget) {
        uint8_t remaining = bootProgressTarget - bootProgress;
        uint8_t step = max<uint8_t>(1, static_cast<uint8_t>((remaining + 5) / 6));
        bootProgress = min<uint8_t>(bootProgressTarget, bootProgress + step);
      }
      drawBootProgressMeter(bootProgress, now);
      lastBootFrameMs = now;

      if (bootFinishRequested && bootProgress >= 100) {
        if (!bootFullSinceMs) {
          bootFullSinceMs = now;
        } else if (now - bootFullSinceMs >= 220) {
          bootActive = false;
          bootFinishRequested = false;
          bootFullSinceMs = 0;
          if (hasDeferredBootModel) {
            DisplayModel model = deferredBootModel;
            hasDeferredBootModel = false;
            renderNow(model);
          }
          return;
        }
      }
    }
    applyConfigNow();
    return;
  }

  if (idleGuardBlanked) {
    unsigned long now = millis();
    if (now < idleGuardRestoreMs) return;
    idleGuardBlanked = false;
    idleGuardLastMs = now;
    idleGuardRestoreMs = 0;
    lastClockStamp = -1;
    lastClockMinuteStamp = -1;
    if (idleClockActive) {
      renderIdleClock(true);
    } else if (hasRenderedModel && !idleBlanked && !lastModel.apMode) {
      renderCurrent();
    }
  }

  if (idleClockActive) {
    renderIdleClock(false);
  }

  renderAudioMeterFrame(false);
  renderDateTimeFooterFrame(false);
  renderStationPickerMarqueeFrame();

  bool popupExpired = volumePopupUntil && millis() >= volumePopupUntil;
  if (popupExpired) {
    dismissVolumePopupNow();
    volumeRestoreInProgress = true;
    renderCurrent();
    volumeRestoreInProgress = false;
  }
  renderVolumePopupFrame(false);
  applyConfigNow();
}

void Display::renderDateTimeFooterFrame(bool force) {
  if (!hasRenderedModel ||
      idleBlanked ||
      idleClockActive ||
      lastModel.apMode ||
      stationPickerActive ||
      (volumePopupUntil && millis() < volumePopupUntil) ||
      footerMode() != DisplayFooterMode::DateTime) {
    return;
  }

  drawDateTimeFooter(force);
}

void Display::renderAudioMeterFrame(bool force) {
  if (!hasRenderedModel ||
      idleBlanked ||
      idleClockActive ||
      lastModel.apMode ||
       stationPickerActive ||
       volumePopupUntil ||
       footerMode() != DisplayFooterMode::Vu) {
    return;
  }

  unsigned long now = millis();
  if (!force && now - lastMeterRenderMs < METER_RENDER_MS) return;
  lastMeterRenderMs = now;

  if (!lastModel.playing) {
    if (vuBarsHaveSignal() || force) {
      clearVuBars();
      drawVuMeter(lastModel);
    }
    return;
  }

  bool active = updateVuBars(lastModel.playing);
  if (!force && !active) return;
  drawVuMeter(lastModel);
}

void Display::showStationPicker(int selectedStationId) {
  if (!taskStarted || !pendingMutex) {
    showStationPickerNow(selectedStationId);
    return;
  }

  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    pendingActivity = true;
    pendingPickerAction = 1;
    pendingPickerStationId = selectedStationId;
    xSemaphoreGive(pendingMutex);
  }
}

void Display::showStationPickerNow(int selectedStationId) {
  bool wasActive = stationPickerActive;
  bool selectionChanged = !stationPickerActive || stationPickerSelectedId != selectedStationId;
  notifyActivityNow();
  stationPickerActive = true;
  stationPickerSelectedId = selectedStationId;
  if (selectionChanged) {
    resetStationPickerMarqueeNow(selectedStationId);
  }

  if (!hasRenderedModel || idleBlanked || idleClockActive || lastModel.apMode) {
    stationPickerWindowStart = -1;
    stationPickerRenderedSelectedId = -1;
    renderCurrent();
    return;
  }

  if (wasActive && hasRenderedModel && !idleBlanked && !idleClockActive && !lastModel.apMode) {
    drawStationPickerPaged(stationPickerSelectedId, stationPickerWindowStart, stationPickerRenderedSelectedId, false);
    return;
  }

  stationPickerWindowStart = -1;
  stationPickerRenderedSelectedId = -1;
  drawStationPickerPaged(stationPickerSelectedId, stationPickerWindowStart, stationPickerRenderedSelectedId, true);
}

void Display::hideStationPicker() {
  if (!taskStarted || !pendingMutex) {
    hideStationPickerNow();
    return;
  }

  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    pendingActivity = true;
    pendingPickerAction = 2;
    pendingPickerStationId = -1;
    xSemaphoreGive(pendingMutex);
  }
}

void Display::hideStationPickerNow() {
  notifyActivityNow();
  if (!stationPickerActive) return;
  stationPickerActive = false;
  stationPickerWindowStart = -1;
  stationPickerRenderedSelectedId = -1;
  stationPickerMarqueeSelectedId = -1;
  stationPickerMarqueeOffset = 0;
  stationPickerMarqueeDirection = 1;
  stationPickerMarqueeLastMs = 0;
  stationPickerMarqueeHoldUntil = 0;

  if (hasRenderedModel && !idleBlanked && !idleClockActive && !lastModel.apMode) {
    renderCurrent();
  } else {
    renderCurrent();
  }
}

void Display::notifyActivity() {
  if (!taskStarted || !pendingMutex) {
    notifyActivityNow();
    return;
  }

  if (xSemaphoreTake(pendingMutex, 0) == pdTRUE) {
    pendingActivity = true;
    xSemaphoreGive(pendingMutex);
  }
}

void Display::notifyActivityNow() {
  lastActivityMs = millis();
  bool wasIdle = idleBlanked || idleClockActive || idleGuardBlanked;
  idleGuardBlanked = false;
  idleGuardLastMs = lastActivityMs;
  idleGuardRestoreMs = 0;
  if (!wasIdle) return;

  idleBlanked = false;
  idleClockActive = false;
  lastClockStamp = -1;
  lastClockMinuteStamp = -1;
  lastBrightness = 255;
  applyConfigNow();
  renderCurrent();
}

void Display::refreshArtwork() {
  if (!taskStarted || !pendingMutex) {
    refreshArtworkNow();
    return;
  }

  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    pendingArtworkRefresh = true;
    xSemaphoreGive(pendingMutex);
  }
}

void Display::refreshArtworkNow() {
  if (!hasRenderedModel ||
      idleBlanked ||
      idleClockActive ||
      lastModel.apMode ||
      stationPickerActive ||
      (volumePopupUntil && millis() < volumePopupUntil)) {
    deferredArtworkRefresh = true;
    return;
  }

  drawArtIfNeeded(lastModel);
  deferredArtworkRefresh = false;
}

void Display::renderIdleClock(bool force) {
  AppConfig& config = AppConfig::instance();
  String style = config.displayClockStyleId == DisplayClockStyle::Analog ? "analog" : "digital";

  struct tm timeinfo;
  bool haveTime = getLocalTime(&timeinfo, 5);
  int stamp;
  if (haveTime) {
    stamp = timeinfo.tm_hour * 3600 + timeinfo.tm_min * 60 + timeinfo.tm_sec;
  } else {
    stamp = static_cast<int>((millis() / 1000UL) % 86400UL);
    memset(&timeinfo, 0, sizeof(timeinfo));
  }
  int minuteStamp = stamp / 60;

  bool styleChanged = style != lastClockStyle;
  if (!force && !styleChanged && stamp == lastClockStamp) return;

  if (force || styleChanged || lastClockStamp < 0) {
    if (style == "analog") {
      drawAnalogClock(timeinfo, haveTime);
    } else {
      resetAnalogClockHandCache();
      drawDigitalClock(timeinfo, haveTime);
    }
    lastClockStamp = stamp;
    lastClockMinuteStamp = minuteStamp;
    lastClockStyle = style;
    return;
  }

  if (style == "analog") {
    drawAnalogClockHandsOnly(timeinfo, haveTime);
    if (minuteStamp != lastClockMinuteStamp) {
      drawAnalogClockCaption(timeinfo, haveTime);
    }
  } else {
    resetAnalogClockHandCache();
    if (minuteStamp != lastClockMinuteStamp) {
      drawDigitalClockText(timeinfo, haveTime);
    }
    drawDigitalClockSecondBar(timeinfo, haveTime);
  }

  lastClockStamp = stamp;
  lastClockMinuteStamp = minuteStamp;
  lastClockStyle = style;
}
