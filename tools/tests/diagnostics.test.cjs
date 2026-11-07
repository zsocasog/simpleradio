const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const read = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');

test('normal firmware omits periodic spectrum reports but retains errors and a once-only configuration marker', () => {
  const config = read('src/config/diagnostics.h'), source = read('src/audio/audio_spectrum.cpp');
  assert.match(config, /#ifndef SIMPLE_RADIO_SPECTRUM_DIAGNOSTICS\s*#define SIMPLE_RADIO_SPECTRUM_DIAGNOSTICS 0/);
  const report = source.slice(source.indexOf('void AudioSpectrum::reportDiagnostics()'), source.indexOf('void AudioSpectrum::noteDisplayFrame('));
  const start = report.indexOf('#if SIMPLE_RADIO_SPECTRUM_DIAGNOSTICS');
  assert.ok(start > 0);
  assert.doesNotMatch(report.slice(0, start), /SpectrumLog::post|snprintf/);
  assert.match(report.slice(start), /bands-dB[\s\S]*timing:[\s\S]*sync:[\s\S]*DMA:[\s\S]*#endif/);
  assert.match(source, /report = report && !configurationLogged/);
  assert.match(source, /#else\s*SpectrumLog::postEvent\("\[spectrum\] ERB v1:[^\n]+rhythm v6:/);
  assert.match(source, /FFT failed: %d/);
});

test('artwork stays detailed now, and the later basic mode filters before formatting or queueing', () => {
  const config = read('src/config/diagnostics.h'), source = read('src/artwork/artwork_cache.cpp');
  assert.match(config, /#ifndef SIMPLE_RADIO_ALBUM_ART_DETAILS\s*#define SIMPLE_RADIO_ALBUM_ART_DETAILS 1/);
  assert.match(source, /static void albumArtTrace\(const char\* format, \.\.\.\) \{\s*if \(!RadioDiagnostics::ALBUM_ART_DETAILS && !RadioDiagnostics::basicAlbumArtEvent\(format\)\) return;/);
  assert.match(source, /JSON fetch %s: %lums, %u bytes/);
  assert.match(source, /JSON parse %s: %lums%s/);
  assert.match(source, /ArtworkJson::BoundedReader<decltype\(parseStopped\)>/);
  assert.match(source, /if \(reader.stopped\(\) \|\| parseStopped\(\)\) \{\s*doc.clear\(\)/);
});
