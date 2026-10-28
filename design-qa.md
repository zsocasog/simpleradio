# SimpleRadio UI review — 2026-10-28

final result: passed

## Icon follow-up — live device, 2026-10-28

final result: passed

- Restored the reference's WiFi/cloud/storage, MQTT/Last.fm, GitHub/external-link,
  saved-state, volume, selected-station, LED, file and password-visibility icons.
  Disclosures use the same themed chevrons, including the remote mappings.
- All additions use the existing pinned Tabler outline sprite. Decorative SVGs
  are hidden from accessibility names; password visibility has translated labels
  and a pressed state, while the input retains its own explicit label.
- The local fixture verified Blue (`rgb(132,178,255)`) and the physical radio
  verified Amber (`rgb(245,206,116)`) for the new decorative icons. The shared
  firmware/LCD theme setting and all playback/artwork/spectrum code are unchanged.
- The physical radio at `http://192.168.0.213/` serves the exact updated assets;
  configuration, all four stations and both uploaded logos were verified against
  a fresh backup. Only the data partition was uploaded; firmware stays 1.0.27.
- Ten live desktop captures and a mobile System capture are saved in
  `.pio/artifacts/theme-icons/live/`. `kepernyokepek.md`, `index.html` and the ZIP
  collect these actual screenshots; the contact sheet only scales those captures.
- Live mobile content width equals viewport width (375 CSS px), without page
  overflow. All ten views open and the live browser reports no JavaScript errors.
- JavaScript syntax, 174 existing regression tests, LittleFS build and whitespace
  checks passed. Playback was tested at 0% and stopped afterwards.

Scope: browser implementation of the approved design direction. The firmware
build covers the LCD changes; an LCD hardware acceptance test is still required.

## Visual references and normalization

Selected source folder:
`C:/Users/zsoca/.codex/visualizations/2026/09/26/01a0ddc2-ba4f-75d1-9099-949e8a98f255/webui-review-2026-10-27/concepts/`

Sources: `player.png`, `display.png`, `remote.png`, `system.png`,
`system-connections.png`, `system-update.png`, `system-advanced.png`.
The station list follows the previously selected simple list + separate reorder
mode and on-demand drawer, rather than the former always-visible tools column.

Implementation: `http://127.0.0.1:8765/`, a local in-memory fixture serving the
actual production HTML/CSS/JS. It never contacts or updates the physical radio.

Browser: Codex in-app Chromium. Desktop override: 1738 × 905 CSS pixels, density 1.
Sources are 1738 × 905 pixels (Connections: 1737 × 905). Captures are 1738 × 905,
or 1723 × 897 where the browser excludes its scrollbar/content edge. Contact
sheets normalize each image to at most 869 pixels wide without stretching.
Mobile check: 390 × 844 override, 375 CSS pixels of usable document width.

## Evidence

Local captures and combined source/implementation comparisons are in
`.pio/artifacts/ui-refresh/`:

- `player.jpg`, `stations.jpg`, `display.jpg`, `sound.jpg`, `controls.jpg`
- `remote.jpg` (VOL+ selected, waiting for a signal)
- `system-overview.jpg`, `system-connections.jpg` (MQTT drawer open)
- `system-update.jpg` (test file staged, password entered, confirmation checked)
- `system-advanced.jpg`
- `mobile-sound-en.jpg`, `mobile-display-en.jpg`
- `compare-player.png`, `compare-display.png`, `compare-remote.png`
- `compare-system-overview.png`, `compare-system-connections.png`,
  `compare-system-update.png`, `compare-system-advanced.png`

Full-view paired comparisons were inspected together, including the drawer
fields, selected remote key and display control region. These full-view pairs
make the relevant regions legible; separate crop comparisons were unnecessary.

## Comparison history

1. [P2, fixed] Existing setting-grid rules halved select widths and clipped range
   values. Restored full track widths and a dedicated value column; mobile and
   desktop captures confirm readable controls.
2. [P2, fixed] The old 1240px width still constrained the wide player. Removed the
   conflicting width, restored the large artwork/title/queue proportions and
   adjusted typography. `compare-player.png` is the post-fix evidence.
3. [P2, fixed] Excess display spacing pushed important standby controls below
   the desktop view. Grouped day/night time and level controls, moved the standby
   switch into its heading, and removed redundant display descriptions.
   `compare-display.png` shows the corrected result.
4. [P2, fixed] A numeric-input flex basis became a tall MQTT port field inside
   the column layout. Scoped the drawer's numeric input sizing; the final
   `compare-system-connections.png` confirms normal field height.
5. [P2, fixed] Selected remote text inherited the same accent as its background.
   The selected key now has a tinted surface, accent outline and readable label;
   the learning view shows “Waiting for a signal” in the selected language.
6. [P2, fixed] The update confirmation appeared before file selection. Restored
   target → file → password → confirmation → explicit upload order. Changing
   target clears the staged file and confirmation; the accessible upload label
   also follows the selected target.

## Required fidelity surfaces

- Typography: existing local system/Inter fallback retained; hierarchy and wide
  player sizes corrected. HU/EN labels fit; the English EQ label is “Midrange”.
- Layout: seven familiar pages retained; system has four local tabs. Desktop
  columns, small-screen stacking, native dialog focus and visible actions tested.
- Colors: surfaces are flat and all accent colors use the existing theme tokens.
  A Blue selection generated a config save with `themeAccent=blue`; the firmware
  display still reads that same setting in `Display::applyConfig`.
- Assets: existing runtime station/album artwork is reused; no generated album
  artwork is shipped. Tabler SVG icons are bundled locally with their MIT notice.
- Copy: HU, EN and the language template have the same keys and placeholders.
  User station names and track text are excluded from static translation.

## Interaction verification

- All seven pages and all four system tabs open.
- Overview → MQTT opens Connections and the MQTT drawer; cancel restores the
  saved host. Explicit save applies the new host and closes the drawer.
- Unrelated config saves exclude connection/API key drafts (automated coverage).
- Last.fm identifies a compiled key correctly and hides inapplicable delete UI.
- Manual/scheduled brightness and standby options reveal the relevant fields;
  time zone remains available for scheduled brightness with clock mode off.
- Reorder mode exposes move controls; station menus open the existing editor.
- Remote selection enters learning mode and cancel exits it.
- Selecting an update file sends no OTA request. Upload becomes available only
  after file/password/confirmation; target changes invalidate that preparation.
- Existing slider release/persistence regression tests remain green.
- No application JavaScript errors in the checked browser states. The fixture
  can emit an existing cross-origin artwork-cache warning for remote logos;
  this is not an artwork-download change or an on-device result.

## Accepted production adaptations / P3 follow-up

- Reference artwork and sample names are illustrative; production uses the
  radio's actual data and existing logo fallback.
- The layout preview uses actual artwork/text and names the footer mode. It
  does not fabricate a live FFT trace in the browser.
- Update target selection uses a native select. Arbitrary existing standby
  durations remain editable in seconds, rather than being limited to presets.
- Precise font rendering differs from generated images. Long optional help
  content can scroll, especially on phones; primary actions remain accessible.
- Physical remote key markings retain the lettering printed on the remote;
  the surrounding action names are translated.

## Remaining hardware check

Upload both firmware and data, then inspect title wrapping and picker logos on
the real LCD and exercise playback/slider responsiveness. This review does not
claim that a firmware upload, physical IR capture or audio test was performed.

## Responsive follow-up and footer simplification

The footer now contains only the SimpleRadio link, one separator and version.
The descriptive ESP32 tagline remains available in the About/technical section.

Checked all seven pages at 320×740, 360×800, 390×844, 768×1024, 820×1180,
844×390, 1024×768 and 1280×800: 56 page/viewport checks. Additionally checked
Connections, Update, Advanced and the MQTT drawer at 320, 768 and 1024 pixels:
12 additional checks. This is browser viewport validation, not a physical
iOS/Android/Safari device test.

Fixed during this follow-up:

- Minimum grid tracks clipped Display controls at 320px; shrinking tracks and
  an explicit zero-minimum section track now keep them inside the content area.
- The inherited stacked-tablet layout retained a column divider/indent. It now
  clears at the same 980px breakpoint as the column stack.
- Mobile status-card padding allowed icons to overlap labels; text now keeps an
  explicit icon gutter.
- Tablet headers use two explicit rows, and very narrow phones use an accessible
  icon-only transport button to preserve space for the brand.
- Narrow reorder mode hides playback/overflow actions, preserving room for the
  station name and move controls. The normal mode retains all station actions.

No document-level horizontal overflow or clipped visible controls remained in
the recorded checks. The navigation strips intentionally scroll horizontally.
MQTT fields fit their drawer; the port input remains 44px high.

Evidence: `.pio/artifacts/ui-refresh/responsive/checks.json`, the viewport
screenshots alongside it, `320-reorder.jpg`, `phone-player-full.jpg` and
`tablet-player-full.jpg`. These screenshots were visually inspected in addition
to the geometry checks. Application console errors: none in the tested states.

## Accepted compact controls and simplified settings — 2026-10-28

Scope: production WebUI only; existing artwork, audio, spectrum and LCD theme
configuration preserved. Version remains 1.0.27. Data upload is sufficient.

Source visual truth:
- `C:/Users/zsoca/.codex/generated_images/01a0ddc2-ba4f-75d1-9099-949e8a98f255/exec-1ef5a34e-c2e6-4fec-9d41-9cad173facc4.png`
- `C:/Users/zsoca/.codex/generated_images/01a0ddc2-ba4f-75d1-9099-949e8a98f255/exec-330bf276-698b-447c-b7e4-5c1dc21f9329.png`
- `C:/Users/zsoca/.codex/generated_images/01a0ddc2-ba4f-75d1-9099-949e8a98f255/exec-77498304-c166-404e-9944-0abb9b4b3267.png`

Browser evidence: `.pio/artifacts/ui-final-20261028/qa/`.
Full source/implementation comparisons: `comparison-player-normalized.jpg`,
`comparison-remote.jpg`, `comparison-update-mobile.jpg`. Source presentation
headings and example-state board were excluded from player normalization;
1738x905 desktop capture uses 1 image pixel per CSS pixel. 390x844/900 phone
captures and 820x1000 tablet captures use the same density. Generated references
are concept boards, so source crop width is normalized, not treated as a device
pixel density. Live metadata differs intentionally. The central button is round
at the user's explicit request; screenshots also cover muted state separately.

Fonts/typography: retained existing UI font and hierarchy; song title remains
primary, artist uses shared accent. Transport and volume are compact, centered
within the metadata region. Source icons use the existing pinned Tabler outline
library, no remote font/icon dependencies. Volume is an interactive native range
under the existing 24-bar boot motif, not a fabricated audio visualization.
Theme colors use firmware-backed CSS variables; blue/amber selection was tested
on the fixture without touching the radio. No changes to LCD theme commands.
Images use the existing production artwork path; no replacement search logic.

Iteration findings and fixes:
- [P2, fixed] At 1280px the header tab strip needed horizontal scrolling.
  Compact intermediate-width tab spacing and a two-row tablet header now fit;
  tab clientWidth and scrollWidth are both 738px in recorded checks.
- [P2, fixed] Expanding all IR mappings stretched remote button spacing.
  Remote now keeps natural dimensions while the teaching panel expands.
  `remote-expanded-fixed.jpg`: remote 488px, expanded panel 967px; collapsed
  panels align at the same resting height (`remote-final.jpg`).
- [P2, fixed] Repeated zero-volume status frames could replace the muted caption
  with 0%. The caption is now refreshed independently of icon memoization; a
  regression test and the browser mute/unmute check cover this behavior.

Primary interactions verified in the browser:
- Mute from 35%, unmute restores 35%; keyboard range Home/ArrowRight works.
- Fixture commands show live volume `persist:false`, then one `persist:true`
  commit per released gesture, with controlEdit begin/end retained.
- Update kind has two accessible radios with keyboard navigation. Selecting a
  file alone does not upload. Explicit file+password+confirmation enables upload.
  Changing to Web interface clears file and confirmation and disables upload.
- All seven main views fit 320, 390, 820 and 1280px without document overflow.
- Mobile bottom navigation, More sheet, destination selection and close work.
- Three System tabs; LED controls belong to Display, stream retry to Controls;
  restart and one System information disclosure belong to Overview.
- Hungarian and English UI and translation template keys are complete.
- Browser console application errors: none in tested flows.

Validation: 176 automated tests passed; app.js/ui.js syntax and diff whitespace
checks passed. LittleFS build passed. Later live upload/capture evidence is
recorded separately alongside the device verification and screenshots.

Remaining P3: native sliders retain browser-specific thumb appearance outside the
custom player volume control. This is intentional for existing settings behavior.

final result: passed

### Live-device acceptance — compact controls

Data-only USB upload succeeded with image readback/hash verification. Final live
assets match local files. Four saved stations, both uploaded logos and all
configuration fields are unchanged. Firmware/WebUI: 1.0.27, compatible.

One additional live finding was fixed: frequent device status messages remounted
both transport SVGs, briefly hiding the pause icon. Transport now updates icons
only when playback state changes, and the legacy small-button renderer leaves
that SVG mounted. Regression test added; final automated run: 177/177 passed.
`01-player-album.jpg` and `14-tablet-player.jpg` verify the visible pause icon on
the actual device after the final upload.

Live artwork proof: Danubius, Boney M. — Brown Girl in the Ring, Nightflight to
Venus, served by `/api/artwork/album?id=325d78bc-00000001`. The existing artwork
pipeline logged compressed=25903 bytes, LCD=176x176, flash writes=0. The album
image was captured in desktop, mobile and tablet views; it was not substituted
by a mock. Other page captures retain the actual radio state at capture time.

All nine main views plus mobile and expanded LED variants are available in
`.pio/artifacts/ui-final-20261028/live/kepernyokepek.md` (14 actual screenshots).
The gallery ZIP includes screenshots and their metadata only; private runtime
backups/credentials are excluded.

End state verified from the radio's WebSocket and HTTP APIs: stationId=1 (original
BDPST ROCK FLAC station), playing=false, volume=0; persisted volume is also 0.
Browser console application errors: none in the tested live flows.

final result: passed

## Requested alignment and settings refinements — 2026-10-28

Source: `C:/Users/zsoca/.codex/attachments/8529b0b0-6bf3-4d1e-9016-544d7ed05ae4/codex-clipboard-e4a1deeb-ea36-4103-ad62-3dc7494e19a0.png`
(1736x906 pixels, annotated reference). Source and browser output are compared
side-by-side in `.pio/artifacts/ui-align-20261028/qa/comparison.jpg`. The output
uses the requested relocated controls and a two-line fixture title at 50% volume;
track artwork differs because this is the isolated fixture, not a live capture.
Desktop screenshots: 1738x960 CSS/image pixels, 1:1 density. Shared content width
is normalized in the comparison; responsive font changes only concern narrower
side-by-side layouts. Existing palette, artwork path and icon library retained.

Implemented all five refinements: encoder-related controls in one column, LED
below Appearance, compact More dialog, shared centered transport/volume geometry
and three-button header transport with shared playback state. The volume range
DOM node and existing release-to-persist handlers are retained. Shared LCD/Web
theme configuration and artwork/audio/spectrum code are unchanged.

Geometry evidence: `qa/geometry.json` for 1738,1280,820,600,390,320px. At 50% the
range/pattern midpoint equals the play-button midpoint. Pattern edges equal the
Tabler skip-icon vertical stems within 0.006 CSS pixels. In side-by-side layouts
at 1738,1280,820 the pattern bottom and cover bottom match exactly, including a
two-line title. Smaller screens stack the cover and metadata naturally.

Iteration: initial tablet check had a 12px bottom error caused by the legacy
340px minimum stage height. Removing that minimum fixed the mismatch. Below
740px, stacked layout also prevents long station/title text from crowding the
controls. At 320px the three-line title remains readable without overlap.

The More dialog now measures 240x247px (previously 360px wide with large nested
padding). Direct navigation choices retain 44px touch height. Appearance has a
single separator before LED instead of duplicate margins/borders.

Verification: all 28 page/viewport checks (seven main views at 320,390,820,1280)
passed without horizontal document overflow. Header tabs also fit in tablet and
desktop checks. Header previous/next commands changed the fixture station; the
header and player play/pause icons follow either control. Native keyboard volume
at 50% works. Browser console application errors: none. Translation key parity,
177 tests, JavaScript syntax, whitespace checks and LittleFS build passed.

final result: passed

### Live acceptance for alignment refinements

Final data-only USB upload and hash readback succeeded. The live assets match
local files; all four stations, both uploaded logos and configuration are
preserved. Firmware/WebUI remain 1.0.27 and compatible. The live header Next
control selected the original station, and its play/stop control stopped playback;
HTTP/WebSocket verification confirms stationId=1, playing=false, volume=0, with
persisted volume also zero. No application console errors in the live checks.

Fourteen updated real screenshots are in
`.pio/artifacts/ui-align-20261028/live/kepernyokepek.md`. The player capture shows
the real station-logo fallback: the external cover search for this run reached
its network budget before image download. No artwork code was changed for this
UI task. The 50% two-line-title fixture screenshots are separately labelled QA
evidence and are not presented as real-device captures.

final result: passed
