#include "audio_spectrum.h"

#include <esp_dsp.h>
#include <math.h>

namespace {
constexpr uint32_t CAPTURE_INTERVAL_MS = 50;
constexpr uint32_t MAX_CAPTURE_SPAN_MS = 250;
constexpr BaseType_t SPECTRUM_TASK_CORE = 1;
// Below the audio pump/decoder (2), but not idle priority: drawing/network work
// must not starve the analyzer until every queued frame has expired.
constexpr UBaseType_t SPECTRUM_TASK_PRIORITY = 1;
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
  // only 256 points. Use a PRIVATE 512-point coefficient table: do not resize
  // or deinitialize the driver's shared tables while audio is playing.
  if (!dsps_fft2r_initialized ||
      dsps_gen_w_r2_fc32(coefficients_.data(), SpectrumMath::POINT_COUNT) != ESP_OK ||
      dsps_bit_rev_fc32_ansi(coefficients_.data(), SpectrumMath::POINT_COUNT / 2) != ESP_OK) {
    Serial.println("[spectrum] FFT initialization failed");
    return false;
  }
  windowSum_ = 0;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT; ++i) {
    window_[i] = 0.5f * (1.0f - cosf(2.0f * M_PI * i / (SpectrumMath::POINT_COUNT - 1)));
    windowSum_ += window_[i];
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
  Serial.printf("[spectrum] FFT self-test passed (stereo test tones, %s)\n", optimizedFft_ ? "S3" : "ANSI");
  if (xTaskCreatePinnedToCore(taskEntry, "spectrum", 4096, this, SPECTRUM_TASK_PRIORITY,
                              &task_, SPECTRUM_TASK_CORE) != pdPASS) {
    task_ = nullptr;
    Serial.println("[spectrum] worker task allocation failed");
    return false;
  }
  portENTER_CRITICAL(&mux_);
  initialized_ = true;
  portEXIT_CRITICAL(&mux_);
  Serial.println("[spectrum] ready: 24 bands, 512-point FFT, up to 20 Hz capture");
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
  // Run the actual linked DSP backend BEFORE the worker starts. Distinct,
  // bin-aligned L/R tones catch wrong coefficient tables, ordering and unpacking.
  constexpr size_t leftBin = 12;
  constexpr size_t rightBin = 73;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT; ++i) {
    const float phase = 2.0f * M_PI * i / SpectrumMath::POINT_COUNT;
    work_[i * 2] = 0.5f * cosf(phase * leftBin);
    work_[i * 2 + 1] = 0.25f * cosf(phase * rightBin);
  }
  if (transform() != ESP_OK) return false;
  float leftPower = 0;
  float rightPower = 0;
  float leakage = 0;
  for (size_t bin = 1; bin < SpectrumMath::POINT_COUNT / 2; ++bin) {
    const size_t mirror = SpectrumMath::POINT_COUNT - bin;
    const float power = SpectrumMath::stereoBinPower(work_[bin * 2], work_[bin * 2 + 1],
                                                    work_[mirror * 2], work_[mirror * 2 + 1]);
    if (bin == leftBin) leftPower = power;
    else if (bin == rightBin) rightPower = power;
    else leakage += power;
  }
  const float expectedLeft = SpectrumMath::POINT_COUNT * SpectrumMath::POINT_COUNT * 0.25f / 8.0f;
  const float expectedRight = expectedLeft * 0.25f;
  return isfinite(leftPower) && isfinite(rightPower) && isfinite(leakage) &&
         fabsf(leftPower - expectedLeft) < expectedLeft * 0.02f &&
         fabsf(rightPower - expectedRight) < expectedRight * 0.02f &&
         leakage < (expectedLeft + expectedRight) * 0.001f;
}

void AudioSpectrum::resetLocked() {
  ++generation_;
  ++diagnostics_.resets;
  for (Frame& frame : frames_) {
    if (frame.state != BufferState::Processing) frame.state = BufferState::Free;
  }
  writeBuffer_ = -1;
  writePosition_ = 0;
  nextCaptureMs_ = 0;
  published_ = {};
  firstFrame_ = true;
}

void AudioSpectrum::setEnabled(bool enabled, uint32_t sampleRate) {
  if (enabled && (!sampleRate || !begin())) enabled = false;
  bool changed = false;
  portENTER_CRITICAL(&mux_);
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
  const uint32_t now = millis();
  uint8_t index = 0;
  uint32_t generation = 0;
  size_t start = 0;
  size_t count = 0;
  portENTER_CRITICAL(&mux_);
  if (!initialized_ || !enabled_ || !visible_) {
    portEXIT_CRITICAL(&mux_);
    return;
  }
  ++diagnostics_.callbacks;
  lastPcmMs_ = now;
  if (SpectrumMath::beforeDeadline(now, nextCaptureMs_)) {
    portEXIT_CRITICAL(&mux_);
    return;
  }
  if (writeBuffer_ >= 0 && now - frames_[writeBuffer_].capturedMs > MAX_CAPTURE_SPAN_MS) {
    ++diagnostics_.staleDrops;
    frames_[writeBuffer_].state = BufferState::Free;
    writeBuffer_ = -1;
    writePosition_ = 0;
  }
  if (writeBuffer_ < 0) {
    for (size_t i = 0; i < frames_.size(); ++i) {
      if (frames_[i].state != BufferState::Free) continue;
      writeBuffer_ = static_cast<int8_t>(i);
      frames_[i].state = BufferState::Writing;
      frames_[i].generation = generation_;
      frames_[i].sampleRate = sampleRate_;
      frames_[i].capturedMs = now;
      writePosition_ = 0;
      break;
    }
  }
  if (writeBuffer_ < 0) {
    ++diagnostics_.busyDrops;
    portEXIT_CRITICAL(&mux_);
    return; // Never wait for the analyzer in the audio callback.
  }
  index = static_cast<uint8_t>(writeBuffer_);
  generation = generation_;
  start = writePosition_;
  count = min<size_t>(static_cast<size_t>(frames), SpectrumMath::POINT_COUNT - start);
  portEXIT_CRITICAL(&mux_);

  // Preserve L/R separately; this is a bounded copy, not FFT or rendering.
  // 32-bit interleaved PCM -> signed 16-bit visualization samples.
  for (size_t i = 0; i < count; ++i) {
    frames_[index].samples[(start + i) * 2] = static_cast<int16_t>(samples[i * 2] >> 16);
    frames_[index].samples[(start + i) * 2 + 1] = static_cast<int16_t>(samples[i * 2 + 1] >> 16);
  }

  bool ready = false;
  portENTER_CRITICAL(&mux_);
  if (generation == generation_ && enabled_ && visible_ &&
      frames_[index].state == BufferState::Writing) {
    writePosition_ = start + count;
    if (writePosition_ == SpectrumMath::POINT_COUNT) {
      ++diagnostics_.captured;
      frames_[index].state = BufferState::Ready;
      writeBuffer_ = -1;
      writePosition_ = 0;
      nextCaptureMs_ = frames_[index].capturedMs + CAPTURE_INTERVAL_MS;
      ready = true;
    }
  }
  portEXIT_CRITICAL(&mux_);
  if (ready && task_) xTaskNotifyGive(task_);
}

bool AudioSpectrum::takeFrame(uint8_t& index) {
  int newest = -1;
  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < frames_.size(); ++i) {
    if (frames_[i].state != BufferState::Ready) continue;
    if (!enabled_ || !visible_ || frames_[i].generation != generation_) {
      frames_[i].state = BufferState::Free;
      continue;
    }
    if (newest < 0 || static_cast<int32_t>(frames_[i].capturedMs - frames_[newest].capturedMs) > 0) {
      newest = static_cast<int>(i);
    }
  }
  if (newest >= 0) {
    index = static_cast<uint8_t>(newest);
    frames_[index].state = BufferState::Processing;
    for (size_t i = 0; i < frames_.size(); ++i) {
      if (frames_[i].state == BufferState::Ready) {
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
  float meanLeft = 0;
  float meanRight = 0;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT; ++i) {
    meanLeft += frame.samples[i * 2];
    meanRight += frame.samples[i * 2 + 1];
  }
  meanLeft /= SpectrumMath::POINT_COUNT;
  meanRight /= SpectrumMath::POINT_COUNT;
  for (size_t i = 0; i < SpectrumMath::POINT_COUNT; ++i) {
    work_[i * 2] = (frame.samples[i * 2] - meanLeft) * window_[i] / 32768.0f;
    work_[i * 2 + 1] = (frame.samples[i * 2 + 1] - meanRight) * window_[i] / 32768.0f;
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

  std::array<float, SpectrumMath::BAND_COUNT> powers{};
  std::array<float, SpectrumMath::BAND_COUNT> weights{};
  for (size_t band = 0; band < SpectrumMath::BAND_COUNT; ++band) {
    const SpectrumMath::BinRange bins = SpectrumMath::binsForBand(band, frame.sampleRate);
    for (size_t bin = bins.first; bin <= bins.last; ++bin) {
      const size_t mirror = SpectrumMath::POINT_COUNT - bin;
      const float weight = SpectrumMath::binBandWeight(bin, band, frame.sampleRate);
      weights[band] += weight;
      powers[band] += weight *
          SpectrumMath::stereoBinPower(work_[bin * 2], work_[bin * 2 + 1],
                                       work_[mirror * 2], work_[mirror * 2 + 1]);
    }
  }
  AudioSpectrumSnapshot result;
  const float normalization = 2.0f / windowSum_;
  float minDb = 0;
  float maxDb = -200;
  for (size_t band = 0; band < SpectrumMath::BAND_COUNT; ++band) {
    const float amplitude = sqrtf(SpectrumMath::meanBandPower(powers[band], weights[band])) * normalization;
    const float db = 20.0f * log10f(amplitude + 1.0e-9f);
    if (weights[band] > 0) {
      minDb = min(minDb, db);
      maxDb = max(maxDb, db);
    }
    result.bands[band] = static_cast<uint8_t>(lroundf(SpectrumMath::levelFromDb(db)));
  }
  result.active = true;
  result.updatedMs = frame.capturedMs;
  bool report = false;
  portENTER_CRITICAL(&mux_);
  if (enabled_ && visible_ && frame.generation == generation_) {
    published_ = result;
    ++diagnostics_.processed;
    diagnostics_.maxProcessingUs = max(diagnostics_.maxProcessingUs, static_cast<uint32_t>(micros() - startedUs));
    lastMinDb_ = minDb;
    lastMaxDb_ = maxDb;
    report = firstFrame_;
    firstFrame_ = false;
  }
  portEXIT_CRITICAL(&mux_);
  if (report) Serial.printf("[spectrum] first frame: %lu Hz, processing %lu us\n",
                            static_cast<unsigned long>(frame.sampleRate),
                            static_cast<unsigned long>(micros() - startedUs));
  if (report) Serial.printf("[spectrum] third-octave bands, upper limit %lu Hz, mean spectral power\n",
                            static_cast<unsigned long>(SpectrumMath::bandUpperHz(SpectrumMath::BAND_COUNT - 1,
                                                                               frame.sampleRate)));
}

void AudioSpectrum::taskEntry(void* parameter) {
  static_cast<AudioSpectrum*>(parameter)->taskLoop();
}

void AudioSpectrum::taskLoop() {
  for (;;) {
    portENTER_CRITICAL(&mux_);
    const bool active = enabled_ && visible_;
    portEXIT_CRITICAL(&mux_);
    // Stay asleep while hidden; while visible a timeout also diagnoses missing
    // PCM, even when no callback arrives to wake the analyzer.
    ulTaskNotifyTake(pdTRUE, active ? pdMS_TO_TICKS(1000) : portMAX_DELAY);
    uint8_t index = 0;
    while (takeFrame(index)) {
      processFrame(index);
      portENTER_CRITICAL(&mux_);
      frames_[index].state = BufferState::Free;
      portEXIT_CRITICAL(&mux_);
      taskYIELD();
    }
    reportDiagnostics();
  }
}

void AudioSpectrum::reportDiagnostics() {
  const uint32_t now = millis();
  if (now - lastDiagnosticsMs_ < 5000) return;
  Diagnostics stats;
  long inputAge = -1;
  long outputAge = -1;
  portENTER_CRITICAL(&mux_);
  if (!enabled_ || !visible_) {
    portEXIT_CRITICAL(&mux_);
    return;
  }
  stats = diagnostics_;
  diagnostics_ = {};
  if (lastPcmMs_) inputAge = static_cast<long>(now - lastPcmMs_);
  if (published_.active) outputAge = static_cast<long>(now - published_.updatedMs);
  portEXIT_CRITICAL(&mux_);
  lastDiagnosticsMs_ = now;
  Serial.printf("[spectrum] pcm=%lu queued=%lu fft=%lu busy=%lu stale=%lu resets=%lu queue-max=%lums fft-max=%luus input-age=%ldms output-age=%ldms dB=%.1f..%.1f\n",
                static_cast<unsigned long>(stats.callbacks), static_cast<unsigned long>(stats.captured),
                static_cast<unsigned long>(stats.processed), static_cast<unsigned long>(stats.busyDrops),
                static_cast<unsigned long>(stats.staleDrops), static_cast<unsigned long>(stats.resets),
                static_cast<unsigned long>(stats.maxQueueMs), static_cast<unsigned long>(stats.maxProcessingUs),
                inputAge, outputAge, lastMinDb_, lastMaxDb_);
}

AudioSpectrumSnapshot AudioSpectrum::snapshot() {
  AudioSpectrumSnapshot result;
  portENTER_CRITICAL(&mux_);
  result = published_;
  portEXIT_CRITICAL(&mux_);
  return result;
}
