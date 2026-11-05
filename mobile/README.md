# Ambra mobile

`bun run start` starts Metro for an Ambra native development build. Networking requires the local `AmbraNetwork` Expo module and its Rust library. Expo Go cannot load this module. Native iOS/Android device builds have not yet been verified; see [networking validation](../docs/networking/README.md).

Startup restores the paired P2P server and opens the original player directly, with the library behind it. There are no Local music/Server tabs above the player. The player owns the full viewport; connection errors appear inside its existing footer instead of shifting fullscreen and mini-player coordinates. Opening a native bridge clears the previous session, and late responses or queued controls from the old connection cannot replace its current track.

The app sits on true black (#000) for OLED screens. Swipe down on the fullscreen player (or tap its grab handle) to reach the library, and swipe up on the mini-player (or tap it) to return. Both sizes use one persistent player surface, album cover and pair of song labels. The surface expands from the mini-player's exact bounds; artwork moves and scales continuously, while song labels fade out beside the cover and fade back in beneath it. Text changes placement and font size only while invisible, avoiding a path around the artwork. A drag can interrupt and reverse the spring without switching artwork views. The paused cover shrinks only toward the expanded endpoint, leaving mini-player artwork at 44 points. Compact screens reserve room for playback controls. The swirl keeps a fixed viewport and fades in near fullscreen, avoiding GL resizing or clipping during the morph. UI changes use Fast Refresh after installing the native development build. Tap a song to play from it. Hold it for desktop's playback menu (Standalone Play, Play from Here, Play Next and Add to Queue), or tap its ⋯ button for desktop's edit menu (Remove, Add to Library, Add to Playlist, Download, Go to Album, Go to Artist and Credits). Pull to refresh.

The fullscreen player's queue button opens the shared queue. Tap an upcoming song to play from it, hold it to play from here or remove it, or clear upcoming songs. Sheets drag down to close, and every control answers with a haptic. The mini-player has play/pause and skip controls. One continuous blurred dock fills the area from the mini-player to the bottom safe area, with Home, Library, Search and Settings tabs below playback. The dock's blur and tint fade to transparent at the mini-player's midpoint, leaving playback controls sharp. The dock hides until a track menu finishes closing, keeping its native views mounted and avoiding list reordering during the hold. Its native blur stays outside the player's drag gesture. Playlist and queue artwork use cached thumbnails, early resizing and a bounded rendering window to limit native image memory while scrolling. Press animations stop when virtualized rows unmount, and gesture/GL containers keep stable native views. The swirl stops GPU work as soon as the app becomes inactive and resumes on return.

## Library, pages and downloads

The app mirrors desktop's views, laid out for a vertical touchscreen. Each tab keeps its own page stack; pages slide in on top and Back (or Android's back gesture) returns.

- **Home**: Recently Played, Discover and Your Playlists, as desktop's home page.
- **Library**: Tracks, Artists and Albums from the server's saved library, in desktop's saved order and without songs removed on any device; this phone's Downloads; AMBRA playlists (create with +) and each signed-in service's playlists. Playlist pages have Play, Shuffle and desktop's playlist menu: Rename, Duplicate, Download and Delete. Edits go to the server's shared state, so desktop sees them; a change made on another device at the same time is kept, and this phone's change is made again on top of it.
- **Album and artist pages**: an album's songs; an artist's popular songs, albums and biography.
- **Search**: artists and albums above the merged song results; tap one to open its page.

Hold a song in an AMBRA playlist, in Library › Tracks or in the queue, then drag it: as when rearranging an iPhone home screen, the row lifts after the hold, the others slide aside, and the list scrolls near its edges. Letting go of a hold without moving opens the song's menu as before. New orders save to the server's shared state (bound songs stay together), so desktop shows them too.

AMBRA playlists' menus also have Improve Playlist, which runs desktop's search for the best-sounding copy of each song (`desktop/src/utils/playlistUpgrades.ts`, shared by both apps), and Export Playlist, which hands desktop's CSV to the share sheet. Library › Import Music picks audio files on this phone; the native bridge reads their tags and cover, uploads them by content hash and adds them to the server's library, as desktop's importer does. Settings › Music services signs services in or out: Qobuz and Spotify redirect the in-app browser to a loopback address this phone listens on, and Tidal's final address is pasted, as on desktop.

Download opens the same choices as desktop: Download to Server or Download to Client, at Highest (up to 24-bit/192 kHz, the default), Hi-Res, CD or Lossy quality. Any open app can be chosen, this phone included. Songs downloaded to this phone are fetched by the native bridge and encrypted with this installation's own key (`ambra-vault`); the download folder holds no playable audio. A loopback address on a random port and secret path decrypts them for the player as they play. When this phone is the shared output, it plays its own copy of a downloaded song instead of streaming it.

When the server has been out of reach for ten seconds and songs are downloaded here, the app switches to offline playback: Home and Library show this phone's downloads, and the player, queue and lock screen control a phone-only session. It returns to the server's session as soon as the server is reachable. Phone downloads need a rebuilt native app, since the bridge gained the `offline_*` operations.

## Settings and unified search

Open Settings from the bottom dock or the fullscreen player's gear. Change server opens QR/link pairing without deleting the current saved pairing. Back to current server restores it, including when cancellation races with approval. The old phone output stops before switching; leaving an active phone output announces departure to the server. Other devices' selected outputs remain unchanged.

Tidal, Qobuz and Spotify switches are saved securely on this phone. Turning a service off removes its songs from the phone's library view and excludes it from search. Local music remains visible. These switches do not sign out shared server accounts or modify the shared queue. Sign service accounts in or out in Settings; credentials stay on the server.

Search defaults to AMBRA, combining connected, enabled services with desktop's recording deduplication, relevance and quality ranking. Individual service filters remain available. Searches are debounced, canceled when replaced, paginated independently and retryable after provider failures. The result menu retains the chosen recording even if later results change the ranking. Artists and albums from each enabled service's catalog appear above the songs and open their pages.

Track menus use desktop's compact dark glass panels, borders, fonts, icons and playback actions. Existing queue/output sheets retain their larger touch layout.

Tap the output pill at the fullscreen player's bottom left to choose an output on any online device, including this phone. The phone registers with the same server output protocol as desktop, resumes at the current position, and plays through its current system audio route (speaker, headphones or Bluetooth). Switching away releases phone audio. Phone lock-screen pause/play and seeks follow the shared session; native headset and system next/previous commands also go through the server's shared queue. The server advances the queue after a song ends. Files that exist only at a computer's private path must be imported into the server library before the phone can stream them.

Playback requires rebuilding and installing Ambra with its native networking and audio modules. Expo Go cannot apply this project's native capabilities or dependency patches. The audio plugin enables the Android playback service and iOS audio background mode. The phone player keeps its audio session active across pauses so system controls can resume it, and stays in charge of its authenticated stream while using Bluetooth or AirPlay as an audio route. Metadata changes refresh system controls; ordinary position reports do not re-register them.

For an installed iPhone app that runs without Expo Go or Metro, run `bunx eas-cli@latest build --platform ios --profile preview` from `mobile/`, then install the resulting internal-distribution build. EAS requires an Expo account and Apple signing credentials/device registration. `eas.json` also includes a production profile. Locking the screen or switching apps is supported; force-quitting the playback app terminates playback. Validate locked playback, headphone play/pause, next/previous, seeks, track completion, interruptions and output switching on a physical device.

The project is linked to https://expo.dev/accounts/eggwithpants/projects/ambra. The first iOS preview build needs Apple signing setup for `com.quantium.ambra.remote`, plus registration of the test iPhone. A non-interactive build cannot create those initial credentials. Run the preview build command interactively for that first setup; subsequent builds can reuse the saved credentials. The mini-player has an opaque background of its own, independent of the dock's fade mask.

## Lyrics

Tap the lyrics button beside the queue button. The same album cover shrinks into a compact song header, leaving a scrolling lyric viewport above the transport controls. Stack Sans Text uses its exact 650 weight through SDK 58's `fontVariationSettings`, with desktop's tight spacing, line height, directional quotes, singer labels, background vocals and romanization. Lead lyrics are 37.1–52.4 points (42.6 on a 390-point phone), exactly 5% below the previous enlarged size. No extra font asset or native dependency is needed.

Persistent letter views use continuous lift, swell and glow springs driven by the display-rate UI clock. Glyph text and its font settings stay static inside animated view layers. Held-note glows fade a static shadow layer instead of changing native text-shadow properties every frame. Inactive letters and settled scroll ripples stop submitting shared snapshots and view updates; row physics resets when provider retries replace text or timing. These changes reduce sustained native text and animation work after a reported crash while lyrics remained open; a native crash report has not established its cause, and prolonged device playback still needs validation.

One physics pass per nearby row replaces per-letter animation restarts; React updates when the focused line changes. Small playback reports correct the clock gently without reversing the sweep. Shared desktop spring constants and a 75 ms stagger carry neighbouring rows into position, preserving velocity when another line starts mid-wave. Measured list cells anchor the first visual line of wrapped stanzas. Instrumental dots bloom, fill and breathe on the same clock. Native opacity fades retain desktop's focus hierarchy; CSS text blur remains desktop-only.

Lyrics come from the paired server's existing `/api/lyrics` endpoint using the recording's metadata and identifiers. Responses are validated, successful results are cached in memory for thirty minutes, and changing songs or closing lyrics cancels pending requests. Word-synced and line-synced lyrics follow playback; tapping a timed line seeks the shared session. Manual scrolling pauses following for five seconds, or tap Live lyrics to return immediately. Plain lyrics, instrumental songs, unavailable lyrics and failed requests have separate states with retry where applicable. Reduced motion keeps highlighting while suppressing letter lift, swell and animated scrolling.

Opening lyrics midway through playback starts from the current session position and refreshes the server clock to account for network delay. Live lyrics forces the list back to the current line, including rows outside its rendered window. Sync opens a fresh playback re-sync, 0.1/0.5-second timing nudges, reset, and a per-song switch to plain lyrics. Timing changes save on this phone without seeking playback or changing desktop settings. Spaces stay attached to the preceding word so wrapped lines cannot start with an accidental indent.

Scroll gestures belong to the lyrics list while this view is open. Collapse the player by dragging or tapping the top grab handle. Gesture callbacks retain the JavaScript input path used for the Expo Go crash fix. The shared lyric wire model lives in the existing desktop utilities watch folder, so an Expo Go reload picks it up without changing Metro's watched folders or rebuilding native code. The iOS JavaScript export checks bundling, but layout, touch behavior and audio synchronization still need a physical-device check.

## SideStore with a free Apple Account

From the repository root, run:

```sh
bun install --cwd mobile --frozen-lockfile
bun run --cwd mobile build:ios:sideload
```

Sign in to Expo when prompted, or supply `EXPO_TOKEN` through your shell's secret manager. No Apple credentials are needed for this unsigned profile. The script pins EAS CLI 27.2.0 and uploads the repository root even without Git, preserving the shared desktop assets and Rust crates. Running EAS with only `mobile/` as its upload root is insufficient.

This custom EAS build compiles a Release app for a real iPhone on a cloud Mac, skips Apple signing, and packages `Ambra.ipa`. Download the IPA from the build page and import it with SideStore's add-app button or your existing sideloading tool. The app includes its JavaScript bundle and works without Expo Go or Metro. Native background audio and the patched system playback controls are included. Version 1.0.1 uses iOS build number 9.

Keep the existing Expo/React Native implementation for this build. Local iOS native compilation requires macOS with full Xcode; xtool is not a drop-in replacement for this app's CocoaPods, Expo and native audio dependencies. Linux can run the tests, typecheck and iOS JavaScript export, but that export is not an installable IPA.

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

### Changing networks

Playback continues when the phone changes Wi-Fi networks or leaves Wi-Fi for cellular:

- The bridge downloads each song to the app's storage as fast as the connection allows and plays it from there. When a connection drops, the download resumes with a byte range on the next connection while the player keeps reading what is already on disk. The next song in the queue is downloaded before it starts, including every segment of HLS songs. Up to three songs are kept, excluded from backups and cleared on each launch.
- While on the LAN, the phone keeps a warm, unauthenticated HyperDHT session open. If the LAN connection is lost, that session is authorized in one request instead of rediscovering the server.
- iOS (`NWPathMonitor`) and Android (`ConnectivityManager`) report network changes to Rust at once. Connections that no longer answer within two seconds are replaced, rather than left hanging until keepalives time out. While on HyperDHT, the phone moves back to the LAN when it becomes reachable, checking every 30 seconds and on each network change.
- If the current song ends while the server is unreachable, the phone starts the queued song by itself, and the server advances its queue when the phone reports in.
- The phone keeps playing for up to 85 seconds without reaching the server. The server holds the session for 90 seconds (`RECONNECT_GRACE`) before pausing a silent output, so update the server too.

Foreground resumption asks the native manager to reconnect and refreshes session state. Background audio capabilities remain enabled. iOS may suspend networking when the phone is not playing audio; no extra background networking daemon or silent audio lease is introduced.

The old `start:tailscale` script remains only for legacy development environments while device builds are validated. Application onboarding and connection selection do not use Tailscale, MagicDNS, Metro host probes, or VPN fallback.

## System media controls

When this phone is the selected output, Ambra publishes track metadata and playback state through the system Now Playing session. The normal iOS Lock Screen, Control Center and headset controls operate the shared playback session. Actual phone audio uses the background audio capability. There is no custom Live Activity, widget extension, shared app group, or silent keepalive player. iOS decides how its own Now Playing interface appears, including on Dynamic Island.

Validation:

```
bun run lint
bun run typecheck
bun run test
bunx expo export --platform ios --output-dir /tmp/ambra-mobile-ios-export
bun test --cwd ../desktop tests/mobileApp.test.tsx
bun test --cwd ../desktop tests/audioSession.test.ts tests/mobileClient.test.ts tests/mobileLyrics.test.ts tests/mobileLyricsAnimation.test.ts tests/mobileLyricsSync.test.ts tests/mobileQueue.test.ts tests/phonePlayback.test.ts tests/playerGeometry.test.ts
cargo test --manifest-path ../server/Cargo.toml --locked local_music::tests
```
