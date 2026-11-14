#include "../../src/stations/station_import_policy.h"
using namespace StationImportPolicy;
static_assert(validName("Forrás Rádió"));
static_assert(!validName(""));
static_assert(!validName("Name\nOther"));
static_assert(!validName("Name\tOther"));
static_assert(!validName(std::string_view("Name\0", 5)));
static_assert(validUrl("https://stream.example:8443/live?token=a,b;c"));
static_assert(validUrl("HTTP://192.168.1.1:8000/live"));
static_assert(!validUrl("https:///missing-host"));
static_assert(!validUrl("http://"));
static_assert(!validUrl("javascript:alert(1)"));
static_assert(!validUrl("https://example.org/a b"));
static_assert(!validUrl("https://example.org/\r\n"));
static_assert(!validUrl(std::string_view("http://a\0b", 10)));
static_assert(sameUrl(" https://example.org/live ", "https://example.org/live"));
static_assert(!sameUrl("http://example.org/A", "http://example.org/a"));
static_assert(!sameUrl("http://example.org", "https://example.org"));
static_assert(MAX_STATIONS == 500 && MAX_BYTES == 131072);
