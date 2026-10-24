#pragma once

#include <string_view>
#include <initializer_list>

namespace StationLogoPolicy {
// Prefer known official variants before the general public-image resizer.
// Existing cache keys keep using the original source URL.
constexpr const char* smallerOfficialUrl(std::string_view source) {
  if (source == "https://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png" ||
      source == "http://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png") {
    return "https://s2.audiostream.hu:9443/unsafe/176x0/smart/https://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png";
  }
  if (source == "https://www.bdpstrock.hu/assets/img/front/favicon.ico" ||
      source == "http://www.bdpstrock.hu/assets/img/front/favicon.ico") {
    return "https://s2.audiostream.hu:9443/unsafe/176x0/smart/https://www.bdpstrock.hu/assets/img/front/favicon.ico";
  }
  return "";
}

constexpr char lower(char c) { return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c; }
constexpr bool containsFold(std::string_view text, std::string_view part) {
  for (size_t i = 0; i + part.size() <= text.size(); ++i) {
    bool same = true;
    for (size_t j = 0; j < part.size(); ++j) {
      if (lower(text[i + j]) != lower(part[j])) { same = false; break; }
    }
    if (same) return true;
  }
  return false;
}
constexpr bool endsWithFold(std::string_view text, std::string_view suffix) {
  return text.size() >= suffix.size() && containsFold(text.substr(text.size() - suffix.size()), suffix);
}

// Only public, credential-free HTTP image URLs leave the radio for resizing.
// Local uploads, IP literals, LAN names and signed/authenticated URLs use the
// original path.
constexpr bool canUsePublicResizer(std::string_view source) {
  const size_t start = source.substr(0, 8) == "https://" ? 8 :
                       source.substr(0, 7) == "http://" ? 7 : 0;
  if (!start || source.size() > 2048 || source.find('#') != source.npos) return false;
  const size_t end = source.find_first_of("/?", start);
  const auto authority = source.substr(start, end == source.npos ? source.size() - start : end - start);
  if (authority.empty() || authority.find_first_of("@\\[]") != authority.npos) return false;
  const size_t colon = authority.find(':');
  if (colon != authority.npos && authority.substr(colon) != ":80" && authority.substr(colon) != ":443") return false;
  const auto host = authority.substr(0, colon);
  if (host.empty() || host.find('.') == host.npos || host.back() == '.') return false;
  bool numeric = true;
  for (char c : host) {
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '.' || c == '-')) return false;
    if (c != '.' && (c < '0' || c > '9')) numeric = false;
  }
  if (numeric) return false;
  for (auto suffix : {".local", ".lan", ".home", ".internal", ".localhost", ".test", ".invalid"}) {
    if (endsWithFold(host, suffix)) return false;
  }
  if (containsFold(host, "wsrv.nl") || containsFold(host, "images.weserv.nl")) return false;
  const size_t question = source.find('?');
  if (question != source.npos) {
    auto query = source.substr(question + 1);
    while (!query.empty()) {
      const size_t amp = query.find('&');
      const auto pair = query.substr(0, amp);
      const auto key = pair.substr(0, pair.find('='));
      if (key.find('%') != key.npos) return false;
      for (auto sensitive : {"key", "token", "auth", "pass", "secret", "sig", "credential", "x-amz-"}) {
        if (containsFold(key, sensitive)) return false;
      }
      if (amp == query.npos) break;
      query.remove_prefix(amp + 1);
    }
  }
  return true;
}
} // namespace StationLogoPolicy
