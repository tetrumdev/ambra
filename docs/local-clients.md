# Independent clients and server ownership

Desktop and mobile open their local music players without installing, starting, or connecting
to an Ambra server. Desktop scans the existing `Music/Ambra` directory through Tauri and uses
the existing native audio engine. Mobile imports audio into its document directory and uses
the existing Expo `PhonePlayback` engine, including lock-screen commands and interruptions.
No provider integration or streaming backend runs inside either client.

## Data ownership

Device storage owns local files and indexes, local playlists, queues, listening history,
playback positions, UI preferences, audio outputs, and DSP settings. Connecting does not upload
these values. Local scanning never calls the server import API. The retained import API copies
files only when explicitly invoked; scanning and pairing never invoke it.

The independent server owns provider credentials, provider libraries and playlists, shared
music, server playlists, shared playback, synchronized server state, pairing, and authorization.
Desktop presents one playlist collection with its original names and IDs. While connected,
the server's collection is authoritative for display and all playlist operations, including
creation, duplication, and metadata refresh. Playback mode does not change that collection.
Without a connection, standalone playlists remain available in device storage. Private
file paths cannot enter a server playlist or shared queue, and shared output commands reject
private device file sources.

Streaming-library and provider-playlist caches are stored under the paired server's verified
public key. Local playlists may retain cached remote track metadata. Such records carry their
server identity and only rebase onto that same server's current bridge. Switching servers never
rebases one server's cached tracks onto another. Unattributed legacy metadata is preserved with
its original address; it is not silently assigned to a different server.

## Startup and connections

`Root.tsx` waits only for local persistent storage. It renders the normal `App` and starts saved
pairing reconnection independently. Server state hydration never gates mounting the player.
The connection manager retains LAN, pwnat, HyperDHT, then offline, with no relay. An unconfigured
client opens no server bridge. A bridge initialization failure is reported as a disconnected
connection and cannot prevent local startup.

Settings → Server opens the optional `ServerSetup` screen. It supports LAN discovery, manual
IP addresses or hostnames, pasted pairing links, and text-file import of server pairing links.
Desktop does not currently scan QR images directly; mobile retains camera QR scanning. A link
containing only the public key still permits HyperDHT connection attempts.

Successful desktop pairing, choosing another server, and explicit disconnect save local state
and restart the client to reopen its native bridge. This does not restart or manage the server.
A network outage never opens setup or restarts the player. Local playback continues through
connection loss and reconnect. Streaming operations may fail while disconnected.

Desktop starts with local playback, including when a server is available. The explicit **Shared
playback session** switch controls the server queue and registers this computer as a server
output. Returning to local playback restores the separate local queue and position. Loss of
the shared connection returns to local mode. Shared playback does not automatically resume
when the connection returns; choose it again. Mobile similarly separates Local music from its
existing shared Server player. Moving between playback modes stops the previous audio owner.

## Migration and rollback

This migration performs no destructive cleanup:

- Existing localStorage keys remain the local player's working state. The old automatic server
  upload and `localStorage.clear()` adoption flow are removed, as is its destructive native IPC.
- The native `desktop-state` mirror accepts locally owned keys again. Legacy
  `desktop-state.json` remains unchanged. Retrying migration preserves unrelated values.
- The `ambra.local-ownership.v1` marker distinguishes older incomplete mirrors from complete
  new mirrors. Missing new keys in an old mirror do not erase WebView values. Missing keys in a
  complete new mirror represent intentional deletions. First migration seeds all existing local
  values into the native mirror. The native writer commits the ownership marker after those values.
- Existing server snapshots remain on their server and never overwrite the local playlist key.
  A connected client shows that authoritative collection without duplicating stale device copies.
  No empty server is seeded from client state.
- Old unqualified provider cache files remain on disk for rollback. New caches have a separate
  directory per verified server. Credentials and client identity files retain their formats.
- Saved legacy `host` and `fallback` settings remain readable. They no longer select or launch
  a local server. Legacy pairings without a cryptographic key require explicit re-pairing.
- Mobile adds a separate `local-music` document directory. Alternating JSON journal slots retain
  the previous valid snapshot after an interrupted write. Existing SecureStore pairing values
  remain unchanged. Loading rebases owned filenames if an iOS update moves the app container.

To roll back, restore the previous client version and keep the existing data directories.
Older clients continue to read the old key and pairing formats; new local keys and separate
cache directories can remain. The old client will again use its former server-dependent
behavior. Never clear browser storage or delete server data as a rollback step. State already
erased by an older version's adoption flow cannot be recovered without an existing backup;
this migration cannot reconstruct deleted playlists.

## Server administration

All hosting, network settings, QR generation, approval, denial, revocation, and provider
administration run through `ambra-server`. Existing commands remain. Additional provider
controls include:

```sh
ambra-server login spotify
ambra-server login tidal
ambra-server login qobuz
ambra-server login complete tidal
ambra-server login complete qobuz
ambra-server logout spotify
ambra-server services status
ambra-server spotify soloist quality lossless
ambra-server spotify soloist checks on
ambra-server spotify soloist fallback never
ambra-server spotify soloist executable /absolute/path/to/soloist
```

Callback URLs and Soloist API keys use hidden terminal input. Clients display sanitized status.
Provider administration requests, including legacy auth paths, are rejected over encrypted
client connections. The server retains its existing cryptographic identity and authorization.
Release CI builds the server as a separate downloadable executable after verifying that the
desktop distribution does not contain it.

## Verification and limits

```sh
bun run --cwd desktop test
bun run --cwd desktop build
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib
cargo test --manifest-path server/Cargo.toml
cargo test --manifest-path crates/ambra-net/Cargo.toml
cargo build --manifest-path server/Cargo.toml
cargo build --manifest-path crates/ambra-net/Cargo.toml --example pairing_probe
python3 scripts/test-native-network.py
bun run --cwd mobile test
(cd mobile && bunx tsc --noEmit && bun run lint)
bun run tauri build --debug --bundles app
python3 scripts/check-client-package.py desktop/src-tauri/target/debug/bundle/macos/AMBRA.app
```

The network script uses isolated server configuration, data, and caches. An optional first
argument selects a probe built in another Cargo target directory. Tests cover native encrypted
pairing, independent LAN discovery, CLI settings, authorization, audio transfer, and revocation.
Existing network tests cover reconnection and transport order. Package verification inspects
actual `.app` contents and uses 7-Zip to inspect Windows installers in release CI.

Mobile local imports currently use filenames for titles and do not extract embedded album art,
tags, or embedded lyrics. Remote metadata, artwork, synchronized lyrics, and shared playback retain their existing
interfaces. Local codec support follows iOS/Android Expo audio support; unsupported files show a
playback error. The importer accepts common audio extensions but does not claim every codec
works on every device. New picker dependencies require rebuilding native development clients.
Physical audio output, lock-screen behavior, and airplane-mode playback require device checks;
mocked native-engine tests and JavaScript exports do not prove hardware playback. Windows
installer validation requires its release runner. Real pwnat traversal and HyperDHT connectivity
still require appropriate networks and peers; localhost tests cannot prove Internet NAT traversal.

## Implementation map

- Desktop initialization and connection state: `desktop/src/main.tsx`, `Root.tsx`, `App.tsx`,
  and `hooks/ClientConnectionContext.tsx`.
- Local/server ownership: `utils/persistentStorage.ts`, `storageEvents.ts`, `serverState.ts`,
  `preferences.ts`, `libraryCache.ts`, `servicePlaylistCache.ts`, `api/serverConnection.ts`,
  `api/core.ts`, `hooks/usePlaylists.ts`, `useMusicLibrary.ts`, and `useListeningHistory.ts`.
- Audio ownership and output controls: `hooks/useAudioPlayer.ts`, `useCorePlayer.ts`,
  `AudioSettingsContext.tsx`, `utils/nativeAudioSource.ts`, `components/ExtraCtrls.tsx`,
  `SettingsView.tsx`, and `LyricsView.tsx`.
- Client settings: `components/settings/ServerSettings.tsx`, `LocalSettings.tsx`,
  `components/ServiceSettings.tsx`, and `SpotifyPlaybackSettings.tsx`.
- Native desktop: `desktop/src-tauri/src/lib.rs`, `server_link.rs`, `persistence.rs`,
  `remote_endpoint.rs`, and `native_audio.rs`. `local_server.rs` is removed.
- Mobile local functionality: `mobile/App.tsx`, `src/LocalLibraryScreen.tsx`, `localLibrary.ts`,
  and `localFiles.ts`. `expo-document-picker` and the already transitive `expo-file-system`
  are explicit dependencies. Existing native networking and shared player implementations remain.
- Independent server administration: `server/src/cli.rs` and `access.rs`.
- Distribution and proof: Tauri configuration, `run-signed.sh`, release workflow,
  `scripts/check-client-package.py`, `test-native-network.py`, the Rust pairing probe,
  and desktop/mobile regression tests. `scripts/build-server-sidecar.ts` is removed.

No user library was manually migrated during implementation. Migration runs on the next launch;
automated migration tests use isolated storage.


## Results for this change

- Desktop TypeScript: 81 tests passed, including startup/settings UI tests and real desktop
  playback hooks with an isolated native-audio adapter and all network requests rejected.
- Rust: 151 server tests, 33 Tauri tests, 16 `ambra-net` tests, and 1 mobile bridge test passed.
- Mobile: 5 local music/file tests passed. TypeScript and Expo lint checks passed.
- Vite desktop build and Expo iOS/Android JavaScript exports passed.
- Isolated real-server integration passed native LAN discovery, encrypted pairing approval and
  denial, QR/identity CLI commands, configuration, device revocation, shared session access,
  audio upload/range delivery, P2P enable/disable, and clean shutdown.
- A locally built macOS debug `.app` was inspected for server executables. The package check
  passed. Windows installers are covered by the release check but were not built on this Mac.

The host reported `Raw ICMP unavailable without elevation: Operation not permitted (os error 1)`.
Real Internet pwnat traversal was therefore not validated. Hardware audio and native iOS/Android
installation were not exercised; JavaScript export success is not a physical playback result.
