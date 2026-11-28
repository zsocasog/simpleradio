#pragma once

#include <cmath>
#include <cstdint>
#include <ctime>

namespace SolarBrightness {
// NOAA solar position equations, https://gml.noaa.gov/grad/solcalc/solareqns.PDF
// UTC avoids civil-date and DST discontinuities. Longitude is positive east.
inline bool isDay(const tm& utc, int16_t latitudeE2, int16_t longitudeE2) {
  constexpr double rad = 0.017453292519943295;
  const int year = utc.tm_year + 1900;
  const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  const int minutes = utc.tm_hour * 60 + utc.tm_min;
  const double phase = 360 * rad / (leap ? 366 : 365) *
      (utc.tm_yday + (minutes - 720) / 1440.0);
  const double s = std::sin(phase), c = std::cos(phase);
  const double s2 = std::sin(2 * phase), c2 = std::cos(2 * phase);
  const double equation = 229.18 * (0.000075 + 0.001868*c - 0.032077*s - 0.014615*c2 - 0.040849*s2);
  const double decl = 0.006918 - 0.399912*c + 0.070257*s - 0.006758*c2 + 0.000907*s2
                      - 0.002697*std::cos(3 * phase) + 0.00148*std::sin(3 * phase);
  const double hourAngle = ((minutes + equation) / 4 + longitudeE2 / 100.0 - 180) * rad;
  const double lat = latitudeE2 * rad / 100;
  const double elevationSine = std::sin(lat)*std::sin(decl) + std::cos(lat)*std::cos(decl)*std::cos(hourAngle);
  return elevationSine >= -0.01453808;  // Sun's centre at or above -0.833 degrees.
}

class MinuteCache {
public:
  bool daylight(time_t now, int16_t latitude, int16_t longitude) {
    const time_t minute = now / 60;
    if (minute != lastMinute || latitude != lastLatitude || longitude != lastLongitude) {
      tm utc{};
      gmtime_r(&now, &utc);
      day = isDay(utc, latitude, longitude);
      lastMinute = minute;
      lastLatitude = latitude;
      lastLongitude = longitude;
    }
    return day;
  }
private:
  time_t lastMinute = -1;
  int16_t lastLatitude = 0, lastLongitude = 0;
  bool day = false;
};
}
