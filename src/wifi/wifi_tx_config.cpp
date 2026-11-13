#include <esp_wifi.h>

extern "C" esp_err_t __real_esp_wifi_init(const wifi_init_config_t* config);

// Arduino permits 32 dynamic TX frames, larger than the available internal
// heap under audio/display load. Bound copies without changing RX, AMPDU,
// credentials, feature flags, or the SDK's native error handling.
extern "C" esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t* config) {
  if (!config || config->tx_buf_type != 1 || config->dynamic_tx_buf_num <= 8)
    return __real_esp_wifi_init(config);
  wifi_init_config_t bounded = *config;
  // Two HTTP windows can occupy four frames. Leave room for audio TCP ACKs,
  // control/WebSocket frames and retransmission instead of using the whole pool.
  bounded.dynamic_tx_buf_num = 8;
  return __real_esp_wifi_init(&bounded);
}
