#include "../../src/artwork/station_logo_policy.h"

using StationLogoPolicy::smallerOfficialUrl;
constexpr std::string_view danubius =
    "https://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png";
static_assert(std::string_view(smallerOfficialUrl(danubius)).find("/176x0/smart/") != std::string_view::npos);
static_assert(std::string_view(smallerOfficialUrl(
    "http://www.bdpstrock.hu/assets/img/front/favicon.ico")).find("/176x0/smart/") != std::string_view::npos);
static_assert(std::string_view(smallerOfficialUrl("https://other.example/logo.png")).empty());
static_assert(std::string_view(smallerOfficialUrl(
    "https://danubiusradio.hu.evil.example/assets/img/front/danubius_radio_album_cover_v2.png")).empty());
static_assert(std::string_view(smallerOfficialUrl(
    "https://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png?other=1")).empty());

using StationLogoPolicy::canUsePublicResizer;
static_assert(canUsePublicResizer("https://somafm.com/img3/groovesalad-400.jpg"));
static_assert(canUsePublicResizer("https://new-station.example/radio.png?v=2&size=500"));
static_assert(canUsePublicResizer("http://www.example.org:80/path/logo.svg"));
static_assert(canUsePublicResizer("https://i.imgur.com/abcdefg.png"));
static_assert(!canUsePublicResizer("/logos/upload.png"));
static_assert(!canUsePublicResizer("https://user:password@example.org/logo.png"));
static_assert(!canUsePublicResizer("http://192.168.1.3/logo.png"));
static_assert(!canUsePublicResizer("http://127.0.0.1/logo.png"));
static_assert(!canUsePublicResizer("http://[::1]/logo.png"));
static_assert(!canUsePublicResizer("http://radio.local/logo.png"));
static_assert(!canUsePublicResizer("http://radio.LOCAL/logo.png"));
static_assert(!canUsePublicResizer("http://radio/logo.png"));
static_assert(!canUsePublicResizer("https://wsrv.nl/?url=other.example/logo.png"));
static_assert(!canUsePublicResizer("https://example.org/logo.png?token=private"));
static_assert(!canUsePublicResizer("https://example.org/logo.png?X-Amz-Signature=private"));
static_assert(!canUsePublicResizer("https://example.org/logo.png?%74oken=private"));
static_assert(!canUsePublicResizer("https://example.org:8443/logo.png"));
