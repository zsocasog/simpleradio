#include "audio_spectrum.h"

#include <esp_dsp.h>
#include <esp_heap_caps.h>
#include <math.h>
#include <cstring>
#include <algorithm>

namespace {
constexpr BaseType_t SPECTRUM_TASK_CORE = 1;
// Below the audio pump/decoder (2), but not idle priority: drawing/network work
// must not starve the analyzer until every queued frame has expired.
constexpr UBaseType_t SPECTRUM_TASK_PRIORITY = 1;

float powerDb(float power, float playbackGainDb = 0) {
  // Do not compensate an epsilon/noise-floor constant: at a low volume that
  // would turn actual zeros into a false nonzero spectrum.
  return power > 0 ? max(SpectrumMath::SILENCE_DB, 10.0f * log10f(power) - playbackGainDb)
                   : SpectrumMath::SILENCE_DB;
}
}

AudioSpectrum& AudioSpectrum::instance() {
  static AudioSpectrum spectrum;
  return spectrum;
}

bool AudioSpectrum::begin() {
  if (initialized_) return true;
  const uint32_t now = millis();
  if (lastInitAttemptMs_ && now - lastInitAttemptMs_ < 5000) return false;
  lastInitAttemptMs_ = now;

  // The audio driver initializes ESP-DSP in setPinout(). Its internal FFT is
  // only 256 points. Use a PRIVATE 1024-point coefficient table: do not resize
  // or deinitialize the driver's shared tables while audio is playing.
  if (!sampleStorage_) {
    // Keep queued PCM in external RAM. Doubling the FFT must not consume the
    // internal heap used by playback, TLS and file-system locks.
    sampleStorage_ = static_cast<int32_t*>(heap_caps_malloc(
        frames_.size() * SpectrumMath::POINT_COUNT * 2 * sizeof(int32_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!sampleStorage_) {
      Serial.println("[spectrum] PSRAM sample queue unavailable; analyzer not started");
      return false;
    }
    for (size_t i = 0; i < frames_.size(); ++i) frames_[i].samples = sampleStorage_ + i * SpectrumMath::POINT_COUNT * 2;
  }
  if (!dsps_fft2r_initialized ||
      dsps_gen_w_r2_fc32(coefficients_.data(), SpectrumMath::POINT_COUNT) != ESP_OK ||
      dsps_bit_rev_fc32_ansi(coefficients_.data(), SpectrumMath::POINT_COUNT / 2) != ESP_OK) {
    Serial.println("[spectrum] FFT initialization failed");
    return false;
  }
  windowEnergy_ = 0;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT; ++i) {
    // Periodic Hann for the DFT; its squared sum calibrates band RMS power.
    window_[i] = 0.5f * (1.0f - cosf(2.0f * M_PI * i / SpectrumMath::POINT_COUNT));
    windowEnergy_ += window_[i] * window_[i];
  }
#if CONFIG_DSP_OPTIMIZED && dsps_fft2r_fc32_aes3_enabled
  optimizedFft_ = true;
#endif
  if (!fftSelfTest()) {
    if (optimizedFft_) {
      optimizedFft_ = false;
      Serial.println("[spectrum] optimized FFT self-test failed; checking ANSI backend");
    }
    if (!fftSelfTest()) {
      Serial.println("[spectrum] FFT self-test FAILED; analyzer not started");
      return false;
    }
  }
  Serial.printf("[spectrum] FFT self-test passed (stereo, windowed RMS, DC/silence, %s)\n", optimizedFft_ ? "S3" : "ANSI");
  if (xTaskCreatePinnedToCore(taskEntry, "spectrum", 4096, this, SPECTRUM_TASK_PRIORITY,
                              &task_, SPECTRUM_TASK_CORE) != pdPASS) {
    task_ = nullptr;
    Serial.println("[spectrum] worker task allocation failed");
    return false;
  }
  portENTER_CRITICAL(&mux_);
  initialized_ = true;
  portEXIT_CRITICAL(&mux_);
  Serial.println("[spectrum] ready: 24 bands, 1024-point FFT, post-EQ Q31, 40 Hz sample clock, PSRAM queue");
  return true;
}

int AudioSpectrum::transform() {
  esp_err_t result;
#if CONFIG_DSP_OPTIMIZED && dsps_fft2r_fc32_aes3_enabled
  if (optimizedFft_) result = dsps_fft2r_fc32_aes3_(work_.data(), SpectrumMath::POINT_COUNT, coefficients_.data());
  else
#endif
    result = dsps_fft2r_fc32_ansi_(work_.data(), SpectrumMath::POINT_COUNT, coefficients_.data());
  return result == ESP_OK ? dsps_bit_rev_fc32_ansi(work_.data(), SpectrumMath::POINT_COUNT) : result;
}

bool AudioSpectrum::fftSelfTest() {
  // Three transforms total, before the worker starts: full-level Q31 PCM,
  // quiet-volume Q31 PCM, and DC/silence. Distinct L/R tones check the linked
  // backend, private coefficients, ordering, window, RMS and stereo unpacking.
  constexpr uint32_t sampleRate = 48000;
  constexpr size_t rmsLeftBin = 36, rmsRightBin = 73;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT; ++i) {
    const float phase = 2.0f * M_PI * i / SpectrumMath::POINT_COUNT;
    frames_[0].samples[i * 2] = static_cast<int32_t>(268435456.0f + 1073741824.0f * cosf(phase * rmsLeftBin));
    frames_[0].samples[i * 2 + 1] = static_cast<int32_t>(-134217728.0f + 536870912.0f * cosf(phase * rmsRightBin));
  }
  SpectrumMath::prepareFrame(frames_[0].samples, window_.data(), work_.data(), 2147483648.0f);
  if (transform() != ESP_OK) return false;
  const auto powers = SpectrumMath::bandPowers(work_.data(), sampleRate, windowEnergy_);
  const int leftBand = SpectrumMath::bandForBin(rmsLeftBin, sampleRate);
  const int rightBand = SpectrumMath::bandForBin(rmsRightBin, sampleRate);
  constexpr float rmsLeft = 0.0625f, rmsRight = 0.015625f; // A^2/2, stereo mean.
  if (leftBand < 0 || rightBand < 0 || leftBand == rightBand ||
      fabsf(powers[leftBand] - rmsLeft) > rmsLeft * 0.02f ||
      fabsf(powers[rightBand] - rmsRight) > rmsRight * 0.02f) return false;
  float otherPower = 0;
  for (size_t band = 0; band < SpectrumMath::BAND_COUNT; ++band) {
    if (static_cast<int>(band) != leftBand && static_cast<int>(band) != rightBand) otherPower += powers[band];
  }
  if (!isfinite(otherPower) || otherPower > (rmsLeft + rmsRight) * 0.001f) return false;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT * 2; ++i) frames_[0].samples[i] = static_cast<int32_t>(frames_[0].samples[i] * 0.01f);
  SpectrumMath::prepareFrame(frames_[0].samples, window_.data(), work_.data(), 2147483648.0f);
  if (transform() != ESP_OK) return false;
  const auto quiet = SpectrumMath::bandPowers(work_.data(), sampleRate, windowEnergy_);
  if (fabsf(powerDb(quiet[leftBand], -40) - powerDb(rmsLeft)) > 0.1f ||
      fabsf(powerDb(quiet[rightBand], -40) - powerDb(rmsRight)) > 0.1f) return false;
  std::fill_n(frames_[0].samples, SpectrumMath::POINT_COUNT * 2, 12000 << 16); // DC, not organ pipes.
  SpectrumMath::prepareFrame(frames_[0].samples, window_.data(), work_.data(), 2147483648.0f);
  if (transform() != ESP_OK) return false;
  const auto silence = SpectrumMath::bandPowers(work_.data(), sampleRate, windowEnergy_);
  for (float power : silence) if (!isfinite(power) || power > 1.0e-12f) return false;
  return powerDb(0, -60) == SpectrumMath::SILENCE_DB;
}

void AudioSpectrum::resetLocked() {
  ++generation_;
  ++diagnostics_.resets;
  for (Frame& frame : frames_) {
    if (frame.state != BufferState::Processing) frame.state = BufferState::Free;
  }
  writeBuffer_ = -1;
  writePosition_ = 0;
  captureClock_ = {};
  nextWindowFrame_ = 0;
  published_ = {};
  firstFrame_ = true;
}

void AudioSpectrum::setEnabled(bool enabled, uint32_t sampleRate, float playbackGainDb) {
  if (enabled && (!sampleRate || !begin())) enabled = false;
  bool changed = false;
  portENTER_CRITICAL(&mux_);
  playbackGainDb_ = enabled ? max(-60.0f, min(0.0f, playbackGainDb)) : 0;
  if (enabled_ != enabled || (enabled && sampleRate_ != sampleRate)) {
    enabled_ = enabled;
    sampleRate_ = enabled ? sampleRate : 0;
    resetLocked();
    changed = true;
  }
  portEXIT_CRITICAL(&mux_);
  if (changed && task_) xTaskNotifyGive(task_);
}

void AudioSpectrum::setDisplayVisible(bool visible) {
  bool changed = false;
  portENTER_CRITICAL(&mux_);
  if (visible_ != visible) {
    visible_ = visible;
    resetLocked();
    changed = true;
  }
  portEXIT_CRITICAL(&mux_);
  if (changed && task_) xTaskNotifyGive(task_);
}

void AudioSpectrum::capture(const int32_t* samples, int16_t frames) {
  if (!samples || frames <= 0) return;
  const uint32_t startedUs = micros();
  const uint32_t now = millis();
  uint32_t generation = 0;
  uint64_t packetStart = 0;
  portENTER_CRITICAL(&mux_);
  if (!initialized_ || !enabled_ || !visible_) {
    portEXIT_CRITICAL(&mux_);
    return;
  }
  ++diagnostics_.callbacks;
  diagnostics_.pcmFrames += frames;
  lastPcmMs_ = now;
  if (captureClock_.discontinuity(now, sampleRate_)) resetLocked();
  if (!captureClock_.ready) captureClock_.start(now);
  packetStart = captureClock_.append(frames);
  generation = generation_;
  portEXIT_CRITICAL(&mux_);

  bool ready = false;
  size_t offset = 0;
  while (offset < static_cast<size_t>(frames)) {
    portENTER_CRITICAL(&mux_);
    if (generation != generation_ || !enabled_ || !visible_) {
      portEXIT_CRITICAL(&mux_);
      break;
    }
    const uint64_t cursor = packetStart + offset;
    if (writeBuffer_ < 0 && cursor < nextWindowFrame_) {
      offset += min<size_t>(frames - offset, nextWindowFrame_ - cursor);
      portEXIT_CRITICAL(&mux_);
      continue;
    }
    if (writeBuffer_ < 0) {
      for (size_t i = 0; i < frames_.size(); ++i) {
        if (frames_[i].state != BufferState::Free) continue;
        writeBuffer_ = static_cast<int8_t>(i);
        Frame& frame = frames_[i];
        frame.state = BufferState::Writing;
        frame.generation = generation_;
        frame.sampleRate = sampleRate_;
        frame.capturedMs = captureClock_.timeAt(nextWindowFrame_ + SpectrumMath::POINT_COUNT / 2, sampleRate_);
        frame.playbackGainDb = playbackGainDb_;
        writePosition_ = 0;
        break;
      }
      if (writeBuffer_ < 0) {
        ++diagnostics_.busyDrops;
        nextWindowFrame_ += SpectrumCapture::windowHop(sampleRate_);
        portEXIT_CRITICAL(&mux_);
        continue; // Full analyzer queue: skip a window, NEVER wait for the worker.
      }
    }
    const uint8_t index = static_cast<uint8_t>(writeBuffer_);
    const size_t start = writePosition_;
    const size_t count = min<size_t>(frames - offset, SpectrumMath::POINT_COUNT - start);
    portEXIT_CRITICAL(&mux_);

    // Read-only contiguous Q31 copies. No scan for the loudest part of a packet,
    // decimation, allocations, FFT or LCD work in the playback callback.
    memcpy(frames_[index].samples + start * 2, samples + offset * 2, count * 2 * sizeof(int32_t));
    offset += count;
    portENTER_CRITICAL(&mux_);
    if (generation == generation_ && frames_[index].state == BufferState::Writing) {
      writePosition_ += count;
      if (writePosition_ == SpectrumMath::POINT_COUNT) {
        ++diagnostics_.captured;
        frames_[index].state = BufferState::Ready;
        writeBuffer_ = -1;
        writePosition_ = 0;
        nextWindowFrame_ += SpectrumCapture::windowHop(sampleRate_);
        ready = true;
      }
    }
    portEXIT_CRITICAL(&mux_);
  }
  portENTER_CRITICAL(&mux_);
  diagnostics_.maxCaptureUs = max(diagnostics_.maxCaptureUs, static_cast<uint32_t>(micros() - startedUs));
  portEXIT_CRITICAL(&mux_);
  if (ready && task_) xTaskNotifyGive(task_);
}

bool AudioSpectrum::takeFrame(uint8_t& index) {
  int newest = -1;
  const uint32_t now = millis();
  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < frames_.size(); ++i) {
    if (frames_[i].state != BufferState::Ready) continue;
    if (!enabled_ || !visible_ || frames_[i].generation != generation_) {
      frames_[i].state = BufferState::Free;
      continue;
    }
    if (SpectrumMath::beforeDeadline(now, frames_[i].capturedMs)) continue;
    if (newest < 0 || static_cast<int32_t>(frames_[i].capturedMs - frames_[newest].capturedMs) > 0) {
      newest = static_cast<int>(i);
    }
  }
  if (newest >= 0) {
    index = static_cast<uint8_t>(newest);
    frames_[index].state = BufferState::Processing;
    for (size_t i = 0; i < frames_.size(); ++i) {
      if (frames_[i].state == BufferState::Ready && !SpectrumMath::beforeDeadline(now, frames_[i].capturedMs)) {
        frames_[i].state = BufferState::Free;
        ++diagnostics_.staleDrops;
      }
    }
  }
  portEXIT_CRITICAL(&mux_);
  return newest >= 0;
}

void AudioSpectrum::processFrame(uint8_t index) {
  Frame& frame = frames_[index];
  const uint32_t queueMs = millis() - frame.capturedMs;
  portENTER_CRITICAL(&mux_);
  diagnostics_.maxQueueMs = max(diagnostics_.maxQueueMs, queueMs);
  if (queueMs > SpectrumMath::MAX_QUEUE_AGE_MS) ++diagnostics_.staleDrops;
  portEXIT_CRITICAL(&mux_);
  if (queueMs > SpectrumMath::MAX_QUEUE_AGE_MS) return;
  const uint32_t startedUs = micros();
  const float inputPower = SpectrumMath::prepareFrame(frame.samples, window_.data(), work_.data(), 2147483648.0f);
  uint32_t nearClipSamples = 0;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT * 2; ++i) {
    const int32_t sample = frame.samples[i];
    if (sample >= 0x7f000000 || sample <= -0x7f000000) ++nearClipSamples;
  }

  const int resultCode = transform();
  if (resultCode != ESP_OK) {
    const uint32_t now = millis();
    if (!lastErrorMs_ || now - lastErrorMs_ >= 5000) {
      lastErrorMs_ = now;
      Serial.printf("[spectrum] FFT failed: %d\n", static_cast<int>(resultCode));
    }
    return;
  }

  const auto powers = SpectrumMath::bandPowers(work_.data(), frame.sampleRate, windowEnergy_);
  AudioSpectrumSnapshot result;
  float minDb = 0;
  float maxDb = SpectrumMath::SILENCE_DB;
  for (size_t band = 0; band < SpectrumMath::BAND_COUNT; ++band) {
    const float db = powerDb(powers[band], frame.playbackGainDb);
    if (SpectrumMath::bandUpperHz(band, frame.sampleRate) > SpectrumMath::BAND_EDGES_HZ[band]) {
      minDb = min(minDb, db);
      maxDb = max(maxDb, db);
    }
    result.bandDb[band] = db;
  }
  result.active = true;
  result.updatedMs = frame.capturedMs;
  result.generation = frame.generation;
  result.peakDb = maxDb;
  result.rmsDb = powerDb(inputPower, frame.playbackGainDb);
  result.outputRmsDb = powerDb(inputPower);
  bool report = false;
  portENTER_CRITICAL(&mux_);
  if (enabled_ && visible_ && frame.generation == generation_) {
    published_ = result;
    ++diagnostics_.processed;
    diagnostics_.maxProcessingUs = max(diagnostics_.maxProcessingUs, static_cast<uint32_t>(micros() - startedUs));
    diagnostics_.nearClipSamples += nearClipSamples;
    lastMinDb_ = minDb;
    lastMaxDb_ = maxDb;
    report = firstFrame_;
    firstFrame_ = false;
  }
  portEXIT_CRITICAL(&mux_);
  if (report) Serial.printf("[spectrum] first frame: %lu Hz, processing %lu us\n",
                            static_cast<unsigned long>(frame.sampleRate),
                            static_cast<unsigned long>(micros() - startedUs));
  if (report) Serial.printf("[spectrum] timeline v3: 1024-point third-octave RMS, upper limit %lu Hz; fixed display scale, volume-compensated, no AGC\n",
                            static_cast<unsigned long>(SpectrumMath::bandUpperHz(SpectrumMath::BAND_COUNT - 1,
                                                                               frame.sampleRate)));
}

void AudioSpectrum::taskEntry(void* parameter) {
  static_cast<AudioSpectrum*>(parameter)->taskLoop();
}

void AudioSpectrum::taskLoop() {
  for (;;) {
    uint8_t index = 0;
    while (takeFrame(index)) {
      processFrame(index);
      portENTER_CRITICAL(&mux_);
      frames_[index].state = BufferState::Free;
      portEXIT_CRITICAL(&mux_);
      taskYIELD();
    }
    reportDiagnostics();
    uint32_t waitMs = 1000;
    portENTER_CRITICAL(&mux_);
    const bool active = enabled_ && visible_;
    const uint32_t now = millis();
    for (const Frame& frame : frames_) {
      if (frame.state != BufferState::Ready) continue;
      const int32_t until = static_cast<int32_t>(frame.capturedMs - now);
      waitMs = min<uint32_t>(waitMs, until > 0 ? until : 1);
    }
    portEXIT_CRITICAL(&mux_);
    // PCM arrival wakes us early; already queued FLAC windows also wake us at
    // their own sample time, instead of collapsing one packet into one frame.
    ulTaskNotifyTake(pdTRUE, active ? max<TickType_t>(1, pdMS_TO_TICKS(waitMs)) : portMAX_DELAY);
  }
}

void AudioSpectrum::reportDiagnostics() {
  const uint32_t now = millis();
  if (now - lastDiagnosticsMs_ < 5000) return;
  Diagnostics stats;
  long inputAge = -1;
  long outputAge = -1;
  AudioSpectrumSnapshot measured;
  portENTER_CRITICAL(&mux_);
  if (!enabled_ || !visible_) {
    portEXIT_CRITICAL(&mux_);
    return;
  }
  stats = diagnostics_;
  measured = published_;
  diagnostics_ = {};
  if (lastPcmMs_) inputAge = static_cast<long>(now - lastPcmMs_);
  if (published_.active) outputAge = static_cast<long>(now - published_.updatedMs);
  portEXIT_CRITICAL(&mux_);
  lastDiagnosticsMs_ = now;
  Serial.printf("[spectrum] pcm=%lu queued=%lu fft=%lu busy=%lu stale=%lu resets=%lu queue-max=%lums fft-max=%luus input-age=%ldms output-age=%ldms dB=%.1f..%.1f copy-max=%luus near-clip=%lu output-rms=%.1f music-rms=%.1f pcm-frames=%lu\n",
                static_cast<unsigned long>(stats.callbacks), static_cast<unsigned long>(stats.captured),
                static_cast<unsigned long>(stats.processed), static_cast<unsigned long>(stats.busyDrops),
                static_cast<unsigned long>(stats.staleDrops), static_cast<unsigned long>(stats.resets),
                static_cast<unsigned long>(stats.maxQueueMs), static_cast<unsigned long>(stats.maxProcessingUs),
                inputAge, outputAge, lastMinDb_, lastMaxDb_,
                static_cast<unsigned long>(stats.maxCaptureUs), static_cast<unsigned long>(stats.nearClipSamples),
                measured.outputRmsDb, measured.rmsDb, static_cast<unsigned long>(stats.pcmFrames));
  if (measured.active) {
    char bands[200] = {};
    size_t used = 0;
    for (float db : measured.bandDb) {
      const int written = snprintf(bands + used, sizeof(bands) - used, "%s%.0f", used ? "," : "", db);
      if (written < 0 || static_cast<size_t>(written) >= sizeof(bands) - used) break;
      used += written;
    }
    Serial.printf("[spectrum] bands-dB low->high: %s\n", bands);
  }
}

AudioSpectrumSnapshot AudioSpectrum::snapshot() {
  AudioSpectrumSnapshot result;
  portENTER_CRITICAL(&mux_);
  result = published_;
  portEXIT_CRITICAL(&mux_);
  return result;
}
