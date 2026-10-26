# SimpleRadio

[Magyar dokumentáció](README.hu.md)

**SimpleRadio** is an ESP32-S3 internet-radio firmware with a modern web interface and a dedicated LCD player view. It targets a self-built radio with I2S audio, physical controls and optional smart-home integration.

> Current version: **0.8.24** · ESP32-S3 N16R8 · LittleFS · English and Hungarian UI

![SimpleRadio LCD player](.screenshots/lcd/player1.jpg)

## Highlights

- LCD player with station artwork, metadata, volume screen, station picker, VU/footer modes and idle clocks.
- Optional 24-band, 1024-point FFT spectrum footer with ERB frequency spacing, Hann-window-corrected RMS band energy and the symmetric VU's full-width grid. Select **Spectrum (24 bands, FFT)** under **Display → Bottom display band**. There are 24 overlapping triangular bands uniformly spaced in ERB-rate between 20 Hz and 18 kHz: a perceptual FFT approximation, not a full gammatone or loudness model. Approximate centers are 67, 122, 188, 266, 358, 469, 599, 754, 939, 1157, 1417, 1726, 2092, 2527, 3043, 3656, 4384, 5249, 6275, 7494, 8941, 10660, 12700 and 15123 Hz. Weights are integrated over each FFT cell; complementary interior triangles conserve energy, while the two outer ramps taper to zero. The Hz axis stays fixed and bin mapping follows sample rate/Nyquist. Precomputed weights use about 48 KiB of PSRAM and are rebuilt only on sample-rate changes. Post-EQ stereo Q31 input, volume compensation, about 40 measurements/second, up to about 30 LCD fps, fixed sensitivity, 12/50 ms attack/release and natural stop decay are retained. There is no per-band AGC. A fixed visual-only −6/−4/−2 dB taper applies to the first three ERB bands (~67/122/188 Hz); bands four and above have no correction. This changes drawn height only: playback audio, measured band energy and logged dB remain unchanged. The 16 PCM buffers still use 128 KiB of PSRAM; the audio callback performs no FFT, allocation or waiting. The separate FFT task analyzes available windows ahead of presentation and stores timed results in about 2 KiB of additional PSRAM. The LCD consumes only due results and merges per-band peaks from at most 33 ms of adjacent measurements between refreshes, without retaining that peak as a new baseline. Old peaks are not replayed after a long drawing stall. `presented` counts measurement windows supplied to the LCD; `merged` counts extra windows combined into a frame during each five-second reporting period. Startup self-tests check overlapping band energy, cached weights, stereo, quiet volume and DC/silence. The serial marker is `[spectrum] ERB v1`. An independent idle-priority task writes diagnostics to USB from a single overwrite mailbox; a closed or full monitor may lose reports, while the FFT never waits for USB output. `log-write-max` is the longest individual write since startup; `log-skipped` counts skipped writes since startup. This trial needs firmware upload only; data and artwork handling are unchanged. [ERB scale formula](https://www.mathworks.com/help/audio/ref/hz2erb.html).
- Web UI for playback, station editing and search, EQ/balance, display settings, encoders, IR remote, WiFi, MQTT and OTA.
- MP3, AAC/AAC+, FLAC, OGG/Vorbis, Opus and other stream formats supported by `ESP32-audioI2S`.
- Artwork from local files, station URLs, ICY metadata or Radio Browser; LCD-ready cache keeps repeated playback responsive.
- Searched JPEG/PNG album covers use a bounded two-slot PSRAM store for both the web image and the center-cropped LCD pixels, without per-track flash writes. Web transfers retain their exact image until complete; unavailable memory falls back to the station logo. Covers are temporary and do not survive a reboot. Audio-library version and task priorities are unchanged; `[album-art] timing RAM-*` lines report preparation time.
- One or two rotary encoders, optional IR receiver and optional front-panel RGB LED. The UI automatically disables controls for hardware not enabled in the firmware profile.
- MQTT discovery and an optional [Home Assistant Lovelace card](home-assistant/README.md).

## Support

If you found SimpleRadio useful, you can buy me a coffee!

<a href="https://ko-fi.com/zsoltsogorka" target="_blank" rel="noopener noreferrer"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi"></a>

Thank you!

## Hardware profile

The tested target is an **ESP32-S3 N16R8** with an **ILI9488 480x320 SPI display** and I2S output (for example, two MAX98357A modules for stereo). ST7796 480x320 and ILI9341 320x240 profiles are also available.

Before the first build, configure the language, display, pins and optional hardware in [`src/config/hardware_config.h`](src/config/hardware_config.h). The shipped profile uses one rotary encoder and an IR receiver.

## Add a language

The interface language is selected at build time with `UI_LANGUAGE` in `hardware_config.h`; built-in values are `hu`, `en` and the `eng` alias. To add your own language, copy the [firmware template](src/i18n/lang_template.h) to `lang_xx.h` and the [web template](data/i18n/template.js) to `xx.js`, translate both while preserving keys and placeholders, set `#define UI_LANGUAGE xx`, then rebuild firmware and LittleFS/data. See the complete [language guide](data/i18n/README.md).

## Install and update

Open the project in VS Code with PioArduino or PlatformIO, configure `hardware_config.h`, then upload both firmware and the data image:

```powershell
pio run
pio run -t upload
pio run -t uploadfs
pio device monitor -b 115200
```

The first installation requires both uploads. Re-upload the data image after changing files under `data/`; C++ changes only require a firmware upload. If no WiFi is stored, the radio starts the `ESP32-WebRadio` access point for provisioning.

After the first wired upload, firmware and data updates are available from the System page. A data OTA replaces LittleFS; WiFi, configuration, state and stations are backed up, while the artwork cache is regenerated.

Firmware and WebUI/data have separate release versions plus a shared Web API compatibility level. Different release versions may run together when their API levels are compatible. If the WebUI manifest is missing or incompatible, the firmware serves a LittleFS-independent recovery OTA page instead of the normal interface, allowing the matching firmware or data image to be installed. `data/build-info.json` is generated automatically during builds from `src/config/version.h`.

While playback is requested, an interrupted stream is retried indefinitely when stream retry is enabled; the delay increases up to 60 seconds. After WiFi loss, the firmware explicitly attempts reconnection every five seconds and resumes stream recovery when the saved network returns. The LCD distinguishes WiFi loss, station connection and stream retry states.

`secrets.ini` is optional and intentionally ignored by Git. Create it from [`secrets.example.ini`](secrets.example.ini) only for local build-time overrides such as fixed test WiFi, MQTT credentials or a custom OTA password.

To preconfigure Last.fm, add `-D SIMPLE_RADIO_LASTFM_API_KEY=\"YourLastFmApiKey\"` to the existing `build_src_flags` list in your local `[env:esp32-s3-devkitc1-n16r8]` section. The System page recognizes this key without exposing it. A key saved in the web interface takes priority; clearing that saved key restores the compiled default. Removing the compiled key requires rebuilding and uploading firmware without that flag. Never commit real keys; compiled firmware also contains the key. No data upload is needed for this setting.

The pinned audio library remains unchanged in version. During builds, `tools/patch_audio_hls.py` applies a narrowly scoped HLS playlist URL-resolution fix (including `../` parent paths) to the local dependency. It adds no network requests and refuses an unfamiliar library source rather than silently applying an incompatible patch.

MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS and MQTT_ROOT_TOPIC build definitions in secrets.ini can preconfigure the broker connection. An existing saved nonempty broker host takes priority together with its saved settings, including intentional empty credentials. Supplying defaults does not enable MQTT. Add definitions to the existing local build_src_flags list; the example file shows the format.

Deleting a Last.fm key on the System page is a one-shot button action, enabled only when a web-saved key exists. It does not erase the compiled fallback key; the status distinguishes that source.

Station-logo downsizing applies to public HTTP(S) logo sources for newly added stations in general. Known official small variants take priority; other public sources use wsrv.nl with aspect-preserving JPEG output up to 176×176 pixels. Only the public image URL is passed to the service. Local uploads, IP literals, internal hostnames and credential-bearing URLs stay on the original path. Cache identity remains the original URL and failed resizing falls back to the original image. The existing generic 150×150 browser preparation when saving stations remains in place. Album and embedded artwork keep their established search and display paths.

Dragging VU/spectrum sensitivity sends RAM-only previews. Releasing the slider saves its latest value once, coalescing rapid adjustments; concurrent configuration responses cannot reset a slider being edited. Atomic JSON saves batch writes into 512-byte blocks and retain the previous file on incomplete writes. This update requires both firmware and data uploads.

Station JPEGs are checked before storage. Progressive, extended and unsupported color encodings use a compatible resized alternative for any station. Proven unsupported JPEGs in the old cache are retired for repair only when no ready LCD pixels exist; user uploads and sources that merely encounter temporary decoding-memory pressure are retained.

While stopped, the selected station's logo takes priority, followed by missing saved-station logos serially. Background starts have a three-second scheduling interval, prepared images are skipped and failed sources have a retry delay. Playback suppresses station-list scans. Serial messages include idle station prewarm queued, prewarm download start and LCD station logo ready. This LCD-compatibility/preloading fix needs only a firmware upload when keeping the latest WebUI/data.

Album artwork lookup tolerates one small spelling edit in titles of at least 6 letters, or up to two in titles of at least 12 letters, while retaining the existing strict artist check. Exact matches rank first; differing numbers and live/remix/cover markers remain protected. Last.fm autocorrection is requested and its returned artist is still checked locally. Metadata responses are bounded at 256 KiB instead of 192 KiB in PSRAM; size-limit failures and missing Last.fm album/image fields have separate diagnostics.

After a complete, known-length, non-chunked HTTP(S) body, the one-shot connection closes immediately to avoid a misleading TLS receive error from a framework cleanup probe. Incomplete bodies still fail; HTTPClient retains its existing chunked and unknown-length handling. Station-logo preloading, source selection, image processing, and audio/spectrum code are preserved. These search and connection-cleanup changes require only the firmware upload with the latest data kept in place.

Parsed artwork JSON documents also use PSRAM exclusively, with a 512 KiB document budget and 512 KiB external-memory headroom; there is no internal-RAM fallback. This prevents small allocations from large MusicBrainz release lists from consuming the internal memory required by file-operation and audio system locks. MusicBrainz filtering retains every field used for track/release verification, while Archive metadata retains only file-server fields. On allocation failure the partial document is released and existing fallback lookup continues. Large responses log internal memory before/after parsing in the JSON memory line. This fix requires only firmware upload; data and spectrum code are unchanged.

After a MusicBrainz HTTP 503, the current song immediately advances to the next provider. All further MusicBrainz requests, including Last.fm album-ID verification, move to the end of the round. If no own-album image has been downloaded and time remains, at most one MusicBrainz API request is retried; a deferred Last.fm release ID gets priority for targeted verification. A successful other provider stops the search. There is no timed cooldown: each new song starts in the original order. The 35-second search budget, image-time reservation, 1.1-second MusicBrainz request spacing and track-change cancellation remain in effect.

After full-title and minor-typo checks, an optional bracketed subtitle may match a missing subtitle on the other side when the artist and main title agree (for example Diamond Eyes / Diamond Eyes (Boom-Lay Boom-Lay Boom)). This weaker match requires a verified artist-owned album. The whole annotation is checked before omission, so live/remix/demo/karaoke/instrumental markers in later or nested brackets, other artists and differing explicit subtitles remain rejected on this path. Serial diagnostics include subtitle match, MusicBrainz HTTP 503: deferred and MusicBrainz retry. These changes require firmware upload only; data is unchanged.

## Screenshots

### LCD in use

| Player | Player with artwork |
| --- | --- |
| ![LCD player](.screenshots/lcd/player1.jpg) | ![LCD player with artwork](.screenshots/lcd/player2.jpg) |
| Station picker | Volume |
| ![LCD station picker](.screenshots/lcd/station_picker.jpg) | ![LCD volume screen](.screenshots/lcd/volume.jpg) |

### Web interface

| Player | Stations |
| --- | --- |
| ![Player page](.screenshots/en/player.png) | ![Stations page](.screenshots/en/stations.png) |
| Sound | Display |
| ![Sound page](.screenshots/en/sound.png) | ![Display page](.screenshots/en/display.png) |
| Controls | Remote control |
| ![Controls page](.screenshots/en/controls.png) | ![Remote control page](.screenshots/en/ir.png) |
| System | |
| ![System page](.screenshots/en/system.png) | |

## Project structure

```text
data/             Web UI, languages, default stations and provisioning page
home-assistant/   Lovelace card and Home Assistant setup
src/              Firmware: audio, display, inputs, MQTT, stations and web server
tools/            Build helpers
```

## License

SimpleRadio is licensed under the [GNU GPL v3](LICENSE). Direct dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
