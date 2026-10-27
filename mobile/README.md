# Ambra mobile

`bun run start` starts Metro for an Ambra native development build. Networking requires the local `AmbraNetwork` Expo module and its Rust library. Expo Go cannot load this module. Native iOS/Android device builds have not yet been verified; see [networking validation](../docs/networking/README.md).

Startup restores the paired P2P server and opens the original player and MEGA library directly. There are no Local music/Server tabs above the player. The player owns the full viewport; connection errors appear inside its existing footer instead of shifting fullscreen and mini-player coordinates. Opening a native bridge clears the previous session, and late responses or queued controls from the old connection cannot replace its current track.

The app sits on true black (#000) for OLED screens. Swipe down on the fullscreen player (or tap its grab handle) to reach MEGA, and swipe up on the mini-player (or tap it) to return. Both sizes use one persistent player surface, album cover and pair of song labels. The surface expands from the mini-player's exact bounds; artwork moves and scales continuously, while song labels fade out beside the cover and fade back in beneath it. Text changes placement and font size only while invisible, avoiding a path around the artwork. A drag can interrupt and reverse the spring without switching artwork views. The paused cover shrinks only toward the expanded endpoint, leaving mini-player artwork at 44 points. Compact screens reserve room for playback controls. The swirl keeps a fixed viewport and fades in near fullscreen, avoiding GL resizing or clipping during the morph. UI changes use Fast Refresh after installing the native development build. MEGA uses the server's saved songs and order, with desktop's Play and Shuffle; bound song groups stay together when shuffled. Tap a song to play from it, or hold it (or tap its options) for desktop's playback menu: Standalone Play, Play from Here, Play Next and Add to Queue. Pull to refresh the playlist.

The fullscreen player's queue button opens the shared queue. Tap an upcoming song to play from it, hold it to play from here or remove it, or clear upcoming songs. Sheets drag down to close, and every control answers with a haptic. The mini-player has play/pause and skip controls. One continuous blurred dock fills the area from the mini-player to the bottom safe area, with text-only Home, Search and Library labels below playback and Library selected. The dock's blur and tint fade to transparent at the mini-player's midpoint, leaving playback controls sharp. These labels reserve the navigation layout for future screens. The dock hides until a track menu finishes closing, keeping its native views mounted and avoiding list reordering during the hold. Its native blur stays outside the player's drag gesture. Playlist and queue artwork use cached thumbnails, early resizing and a bounded rendering window to limit native image memory while scrolling. Press animations stop when virtualized rows unmount, and gesture/GL containers keep stable native views. The swirl stops GPU work as soon as the app becomes inactive and resumes on return.

Tap the output pill at the fullscreen player's bottom left to choose an output on any online device, including this phone. The phone registers with the same server output protocol as desktop, resumes at the current position, and plays through its current system audio route (speaker, headphones or Bluetooth). Switching away releases phone audio. Phone lock-screen pause/play and seeks follow the shared session; native headset and system next/previous commands also go through the server's shared queue. The server advances the queue after a song ends. Files that exist only at a computer's private path must be imported into the server library before the phone can stream them.

Playback requires rebuilding and installing Ambra with its native networking and audio modules. Expo Go cannot apply this project's native capabilities or dependency patches. The audio plugin enables the Android playback service and iOS audio background mode. The phone player keeps its audio session active across pauses so system controls can resume it, and stays in charge of its authenticated stream while using Bluetooth or AirPlay as an audio route. Metadata changes refresh system controls; ordinary position reports do not re-register them.

For an installed iPhone app that runs without Expo Go or Metro, run `bunx eas-cli@latest build --platform ios --profile preview` from `mobile/`, then install the resulting internal-distribution build. EAS requires an Expo account and Apple signing credentials/device registration. `eas.json` also includes a production profile. Locking the screen or switching apps is supported; force-quitting the playback app terminates playback. Validate locked playback, headphone play/pause, next/previous, seeks, track completion, interruptions and output switching on a physical device.

The project is linked to https://expo.dev/accounts/eggwithpants/projects/ambra. The first iOS preview build needs Apple signing setup for `com.quantium.ambra.remote`, plus registration of the test iPhone. A non-interactive build cannot create those initial credentials. Run the preview build command interactively for that first setup; subsequent builds can reuse the saved credentials. The mini-player has an opaque background of its own, independent of the dock's fade mask.

## Lyrics in Expo Go

Tap the lyrics button beside the queue button. The same album cover shrinks into a compact song header, leaving a scrolling lyric viewport above the transport controls. Stack Sans Text uses its exact 650 weight through SDK 58's `fontVariationSettings`, with desktop's tight spacing, line height, directional quotes, singer labels, background vocals and romanization. Lead lyrics are 37.1–52.4 points (42.6 on a 390-point phone), exactly 5% below the previous enlarged size. No extra font asset or native dependency is needed.

Persistent letter views use continuous lift, swell and glow springs driven by the display-rate UI clock. Glyph text and its font settings stay static inside animated view layers. Held-note glows fade a static shadow layer instead of changing native text-shadow properties every frame. Inactive letters and settled scroll ripples stop submitting shared snapshots and view updates; row physics resets when provider retries replace text or timing. These changes reduce sustained native text and animation work after a reported crash while lyrics remained open; a native crash report has not established its cause, and prolonged device playback still needs validation.

One physics pass per nearby row replaces per-letter animation restarts; React updates when the focused line changes. Small playback reports correct the clock gently without reversing the sweep. Shared desktop spring constants and a 75 ms stagger carry neighbouring rows into position, preserving velocity when another line starts mid-wave. Measured list cells anchor the first visual line of wrapped stanzas. Instrumental dots bloom, fill and breathe on the same clock. Native opacity fades retain desktop's focus hierarchy; CSS text blur remains desktop-only.

Lyrics come from the paired server's existing `/api/lyrics` endpoint using the recording's metadata and identifiers. Responses are validated, successful results are cached in memory for thirty minutes, and changing songs or closing lyrics cancels pending requests. Word-synced and line-synced lyrics follow playback; tapping a timed line seeks the shared session. Manual scrolling pauses following for five seconds, or tap Live lyrics to return immediately. Plain lyrics, instrumental songs, unavailable lyrics and failed requests have separate states with retry where applicable. Reduced motion keeps highlighting while suppressing letter lift, swell and animated scrolling.

Opening lyrics midway through playback starts from the current session position and refreshes the server clock to account for network delay. Live lyrics forces the list back to the current line, including rows outside its rendered window. Sync opens a fresh playback re-sync, 0.1/0.5-second timing nudges, reset, and a per-song switch to plain lyrics. Timing changes save on this phone without seeking playback or changing desktop settings. Spaces stay attached to the preceding word so wrapped lines cannot start with an accidental indent.

Scroll gestures belong to the lyrics list while this view is open. Collapse the player by dragging or tapping the top grab handle. Gesture callbacks retain the JavaScript input path used for the Expo Go crash fix. The shared lyric wire model lives in the existing desktop utilities watch folder, so an Expo Go reload picks it up without changing Metro's watched folders or rebuilding native code. The iOS JavaScript export checks bundling, but layout, touch behavior and audio synchronization still need a physical-device check.

## SideStore with a free Apple Account

Run `bunx eas-cli@latest build --platform ios --profile sidestore` from `mobile/`. This custom EAS build compiles a Release app for a real iPhone on a cloud Mac, skips Apple signing, and packages `Ambra.ipa`. Download the IPA from the build page and import it with SideStore's add-app button. The app includes its JavaScript bundle and works without Expo Go or Metro. Native background audio and the patched system playback controls are included.

SideStore signs and installs the IPA using your own free Apple Account. Keep its normal seven-day refresh active. Free accounts allow three installed apps including SideStore, and ten App IDs in a week. Ambra uses one app identifier and includes no widget extension or shared app group.

Use LocalDevVPN while installing or refreshing through SideStore. If it replaces your Tailscale connection, reconnect Tailscale afterward so Ambra can reach a server paired through its Tailscale address. Then select the phone output, play a song, lock the screen, and check that audio continues and headphone play/pause and skips work. Force-quitting Ambra terminates playback.

The custom build is defined in `.eas/build/sidestore.yml`; `scripts/build-sidestore.sh` archives with signing disabled and checks that the bundled app declares background audio before packaging. The repository's `.easignore` uploads only the mobile app and its shared desktop assets, excluding desktop/server build output and local environment files. No Apple signing credentials are sent to EAS for this profile.

`patches/expo-audio@58.0.10.patch` adds a player-specific `remoteCommand` event on iOS and Android, and routes Android media-session skip commands to that event instead of an empty native playlist. Bun applies it during install. `expo-audio` is pinned to that exact version; review and regenerate the patch when upgrading it. Expo Go retains basic native play/pause and seeks, but cannot acquire these additional skip handlers through a JavaScript reload.

The swirl accepts weighted palettes and older servers' four-color responses. Saved tracks without `nativeCover` can use their displayed provider cover. Imported local artwork uses `/api/music/local/files/{id}/palette`, so update the server too for local-song colors. Missing or failed artwork returns the swirl to black instead of retaining the previous album's colors. Songs sharing artwork naturally share a palette.

Press feedback uses React Native Animated with the native driver. Player and sheet gesture callbacks run on the React Native JavaScript thread, while their release animations still run on the UI thread. This avoids the Worklets touch-callback path that crashed during playlist scrolling, long presses and player dismissal in Expo Go on iOS 27. The user confirmed these interactions worked after switching paths; the native crash itself did not produce an available app crash report. Lint, typechecking and an iOS JavaScript export also pass. Sustained locked playback and the patched native media commands still require validation in an installed build.

## Native networking and pairing

Build the Rust library before building the native application:

```sh
bun install
# macOS with full Xcode and Rust installed:
bun run network:ios
bunx expo run:ios
# Android SDK/NDK, Rust and cargo-ndk installed:
bun run network:android
bunx expo run:android
```

Expo autolinks `modules/ambra-network` on iOS and Android. EAS post-install runs the corresponding Rust build script; builders must have the documented Rust/native prerequisites. iOS creates a device/simulator XCFramework. Android packages JNI libraries for arm64-v8a, armeabi-v7a and x86_64. Preserve the Rust source and vendor directories in the EAS archive. Neither build needs a JavaScript networking runtime in the installed application.

Run `ambra-server pair qr` or open desktop Settings, Server, Show QR code. Scan the code or paste its public pairing link. Approve the phone's six-digit code on that server. Existing address-only pairings require explicit re-pairing to pin the public key. SecureStore keeps the device token and public pairing information; Rust keeps its private device key in protected application storage.

Rust chooses LAN, then available pwnat with a known public endpoint, then native HyperDHT, then offline. All media and API requests use the same private loopback bridge; React Native does not discover remote endpoints or implement NAT traversal. Media URLs contain an ephemeral bridge capability, not the server's device token. The native module skips raw ICMP on iOS/Android. UDP and HyperDHT behavior still need physical-device testing.

Foreground resumption asks the native manager to reconnect and refreshes session state. Background audio capabilities remain enabled. iOS may suspend networking when the phone is not playing audio; no extra background networking daemon or silent audio lease is introduced.

The old `start:tailscale` script remains only for legacy development environments while device builds are validated. Application onboarding and connection selection do not use Tailscale, MagicDNS, Metro host probes, or VPN fallback.

## System media controls

When this phone is the selected output, Ambra publishes track metadata and playback state through the system Now Playing session. The normal iOS Lock Screen, Control Center and headset controls operate the shared playback session. Actual phone audio uses the background audio capability. There is no custom Live Activity, widget extension, shared app group, or silent keepalive player. iOS decides how its own Now Playing interface appears, including on Dynamic Island.

Validation:

```
bun run lint
bunx tsc --noEmit
bun test --cwd ../desktop tests/mobileApp.test.tsx
bun test --cwd ../desktop tests/audioSession.test.ts tests/mobileClient.test.ts tests/mobileLyrics.test.ts tests/mobileLyricsAnimation.test.ts tests/mobileLyricsSync.test.ts tests/mobileQueue.test.ts tests/phonePlayback.test.ts tests/playerGeometry.test.ts
cargo test --manifest-path ../server/Cargo.toml --locked local_music::tests
```
