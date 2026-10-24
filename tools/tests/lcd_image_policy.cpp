#include "../../src/artwork/lcd_image_policy.h"

using LcdImagePolicy::Jpeg;
using LcdImagePolicy::inspect;
constexpr uint8_t baseline[] = {
  0xFF,0xD8, 0xFF,0xE0,0,4,12,34,
  0xFF,0xC0,0,17,8,0,176,0,176,3,1,0x11,0,2,0x11,0,3,0x11,0
};
constexpr uint8_t progressive[] = {
  0xFF,0xD8, 0xFF,0xC2,0,17,8,0,176,0,176,3,1,0x11,0,2,0x11,0,3,0x11,0
};
constexpr uint8_t extended[] = {
  0xFF,0xD8, 0xFF,0xC1,0,17,8,0,176,0,176,3,1,0x11,0,2,0x11,0,3,0x11,0
};
constexpr uint8_t grayscale[] = {
  0xFF,0xD8, 0xFF,0xC0,0,11,8,0,100,0,100,1,1,0x11,0
};
constexpr uint8_t cmyk[] = {
  0xFF,0xD8, 0xFF,0xC0,0,20,8,0,100,0,100,4,1,0x11,0,2,0x11,0,3,0x11,0,4,0x11,0
};
constexpr uint8_t twelveBit[] = {
  0xFF,0xD8, 0xFF,0xC0,0,11,12,0,100,0,100,1,1,0x11,0
};
constexpr uint8_t png[] = {0x89,'P','N','G',13,10,26,10};
constexpr uint8_t badLength[] = {0xFF,0xD8,0xFF,0xE0,0,1};
static_assert(inspect(baseline, sizeof baseline) == Jpeg::Baseline);
static_assert(inspect(grayscale, sizeof grayscale) == Jpeg::Baseline);
static_assert(inspect(progressive, sizeof progressive) == Jpeg::Unsupported);
static_assert(inspect(extended, sizeof extended) == Jpeg::Unsupported);
static_assert(inspect(cmyk, sizeof cmyk) == Jpeg::Unsupported);
static_assert(inspect(twelveBit, sizeof twelveBit) == Jpeg::Unsupported);
static_assert(inspect(png, sizeof png) == Jpeg::NotJpeg);
static_assert(inspect(baseline, sizeof baseline - 1) == Jpeg::Malformed);
static_assert(inspect(badLength, sizeof badLength) == Jpeg::Malformed);
static_assert(!LcdImagePolicy::needsConversion(inspect(baseline, sizeof baseline)));
static_assert(LcdImagePolicy::needsConversion(inspect(progressive, sizeof progressive)));
