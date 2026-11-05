#pragma once

#include <driver/i2s_std.h>

class AudioSpectrum;

// Installed into the pinned library by the reviewed build patch. These hooks
// observe output only: never change a sample, DMA settings or a write result.
namespace SimpleRadioAudioOutput {
bool attach(i2s_chan_handle_t handle);
void start(uint32_t sampleRate);
void stop();
}

namespace SpectrumOutput {
struct Statistics {
  uint32_t blocks = 0;
  uint32_t dropped = 0;
  uint32_t expired = 0;
  uint32_t copyMaxUs = 0;
  uint32_t handoffMaxMs = 0;
};
bool begin(AudioSpectrum& spectrum);
void setEnabled(bool enabled);
bool isCurrent(uint32_t epoch);
Statistics statistics();
}
