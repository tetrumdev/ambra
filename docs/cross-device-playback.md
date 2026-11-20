# Shared server playback

Native clients now use encrypted Rust networking and pinned server identities. Legacy address-only pairings require explicit re-pairing. See [native networking setup and validation](networking/README.md) for QR pairing, CLI diagnostics, platform support, and current limitations.

Each server owns its shared queue, playback position, shared listening history, and selected
output. Desktop clients normally keep their own local queue and playback. Enable **Shared
playback session** in Settings → Server to control the shared session and expose this device's
output. Mobile's Server tab retains the existing shared player; Local music uses its own queue.
Choosing another shared output moves the server's song and position there. A session can also
play on several outputs at once, in sync; see [Synced outputs](#synced-outputs).

A server runs several **sessions**, each with its own queue, position and output, so different
rooms can play different music at once. Every server has a `Main` session, which can be renamed
but not removed. Create, rename, follow and remove sessions in Settings → Server → Sessions; the
volume menu switches between them once there are two or more. Each desktop remembers the session
it follows. Choosing an output that another session uses moves it: that session keeps its song
and position and waits for a new output. Spotify plays one stream at a time, so starting Spotify
in one session pauses Spotify in another. Plays from every session count in the one listening
history. Mobile and the web remote follow `Main`.

Spotify uses librespot for its primary integration and automatic High playback. Optional
server-owned Soloist rendering automatically prefers Lossless when ready. Linux private
PulseAudio capture, macOS process taps, and Windows WASAPI process capture are implemented.
Windows requires an optional signed VB-CABLE driver installed and configured only on the server
to provide a silent virtual output. Missing capture support retains High. Soloist works in normal server builds, including
release builds, after server setup and pairing; no development build or runtime opt-in is required.
See [Soloist setup and verification](spotify-soloist.md) for consent, automatic downloads,
updates, platform limitations, and tests. Clients contain no Soloist administration.

Opening the app restores local settings, playlists, and playback first. A saved pairing reconnects
in the background through the Rust connection manager. An unavailable server leaves the local
player visible. No server is selected implicitly, and clients never start a server.

Connect through Settings → Server → Connect to Ambra Server. LAN discovery, manual addresses,
and server-generated `ambra://pair/` links use encrypted pairing. Approve the code with
`ambra-server pair approve <code>` on the server machine. Joining, switching, and disconnecting
preserve device files, playlists, history, and settings. See [ownership and migration](local-clients.md).

## Synced outputs

In the volume menu, the box beside an output (or a right-click on it) adds that output to the
ones playing, or takes it away; clicking the output itself plays there alone. Each output
playing has its own volume slider under it; the volume keys and the wheel move them all by the
same step. Several outputs of one computer can play at once: the app plays the first itself and
starts a spare player for each other one (`satellite` in the core's commands, `satellites` in the
app's reports). Phones and apps from before synced playback can't join a group yet.

The first output chosen leads the group; the core follows its reports, as with a single output.
Every start (a new song, a resume, a seek) is coordinated: each output prepares the audio and
holds its first sample, then the core tells all of them when the group hears which position, on
the server's clock. That moment leaves room for the longest resync delay any output in the group
needs, so no output cuts the start of a song short to keep up with the others. A pause or stop
goes to every output at once.

Each output lines itself up on its own (`desktop/src-tauri/src/native_audio/sync.rs`). Outputs
follow the server's clock through `/api/session/clock`, trusting the quickest of recent round
trips. Before its first sample an output writes exactly as much silence as puts that sample on
time, or drops what it's already too late for. While playing it compares the position it is
heard at with the group's timeline and drops or doubles single frames, spread out (at most one in
200, usually one in 1000), so its sound card's clock can't drift from the others'. A stall of
more than 150 ms lines it up again. Gapless song changes keep every output together; a change of
format, which reopens each device, starts the next song later by the group's longest resync
delay on every output alike.

Each output also counts the delay its platform reports after the samples leave the app: on
macOS the I/O buffer, safety offset and device and stream latency; on Windows the stream latency.
Delay inside a device that the app can't measure, such as Bluetooth or a receiver, is set per
output as **Sync latency** in Settings → Outputs; that output then sends its audio that much earlier.
An output joining a group that already plays prepares from where the group will be and joins
in step. Spotify's lossless stream reaches one output, so a group plays Spotify as High.

## Install and start the independent server

In the desktop app, Settings → Server → **Run a server on this computer** downloads the
`ambra-server` build matching the app's release and adds it to PATH (`~/.local/bin` through
`~/.zprofile` on macOS, `%LOCALAPPDATA%\Ambra\bin` on Windows). The app package itself never
contains the server. Each GitHub release also offers the server as a separate download.

From the repository, install the standalone command once:

```powershell
bun run server:install
```

This runs `cargo install --path server --locked` and installs `ambra-server` into Cargo's
bin directory (`~/.cargo/bin`). That directory must be on PATH. You can then run this from
any directory, including your home directory:

```powershell
ambra-server start
```

The command returns after the background server starts; the terminal can be closed.
Use `ambra-server stop` or the tray menu to stop it.
`ambra-server serve` is available for foreground diagnostics and headless use.
With no arguments the command shows help. Configuration, accounts and imported music use
the user's application-data directories, independently of the terminal's current directory.

The CLI can manage a running server from the server machine:

```powershell
ambra-server status
ambra-server stop
ambra-server config show
ambra-server config set bind lan
ambra-server config set bind 192.168.1.20:38147
ambra-server pair list
ambra-server pair approve 123456
ambra-server pair revoke Laptop
```

Binding changes take effect after stopping and starting the server. Opening, closing or
updating the desktop app does not start or stop the server. An app acting as an audio
output must keep running to play sound.

If the selected output app exits, the server keeps the queue and last reported playback
position. Reopening that app and selecting its shared playback mode reloads the shared song at that position. A paused song stays paused; reconnecting does not
advance the queue or count another play. Output availability is separate from server availability.

The background process runs a versioned copy of the server executable from the server's
data directory. Updating the app or installed CLI therefore does not need to overwrite a
running executable. Starting twice reuses the existing server; a file lock prevents two
server processes from opening the same library concurrently.

## Disconnecting a music service

`ambra-server logout spotify|tidal|qobuz` signs the selected service out of this server for every
connected device. It deletes Ambra's saved credentials and pending login, drops the active
session, and prevents automatic reauthorization after restart (including environment tokens).
It does not delete playlists in the service account or change native Ambra playlists.

Service-owned playlists and their cached contents disappear from Ambra. Saved tracks remain
in native playlists and the library as unavailable, grayed-out entries; their three-dot menu
only allows removal, not playback or adding to a collection. Reconnect restores availability.
The server can't fetch a signed-out service's song details, so it only reports their IDs: an
app shows these songs from its own cache, and a device that never loaded them won't list them
until the service is reconnected.
Improve Playlist can replace signed-out tracks with matching copies from connected services,
even when the available replacement is lower quality. Connected tracks retain the normal
quality-upgrade rules, and bound packages still move together to one compatible release.

Signing out of Ambra is separate from revoking the authorization grant at the provider:
where the service does not expose an app-side revocation API, use its account settings too.

## Local music

Put music in Music/Ambra on the importing computer and use Settings → Local → Scan now.
This copies audio and artwork to `local-music` under the server's data directory. The host
also imports its folder automatically after startup. Importing from a joined computer is
explicit. Copies remain on the server when the importing computer disconnects or removes
its originals. Removing a library row hides it through shared library state; it does not
delete the server's stored audio.

Imports use content hashes to avoid duplicate copies and verify completed uploads. A file
may be up to 8 GiB. The server streams imports to disk and serves byte ranges for seeking.
Old host playlists, queue entries and listening history migrate from file paths to the
server's permanent track IDs. Unchanged local files reuse cached hashes on later scans.

## Implementation and verification

`server/src/session.rs` owns transport and queue changes, for every session. Apps name a
session with `?session=<id>` on `/api/session` routes; without one they get `main`, as older apps
expect. `/api/sessions` lists, creates, renames and removes sessions. `Main`'s queue stays in the
shared `ambra.queue.v1` state; other sessions' queues are kept beside it, never sent to apps
through `/api/state`, and their transports in `transport.<id>.v1.json`. Session responses include the
queue when the client's queue revision differs; otherwise clients retain their existing
snapshot. Conflicting queue edits retry against the server's returned snapshot. Track-list
preloading goes to the selected output computer, so browsing on a remote prepares audio
where it will play. Other devices' transport commands cannot bypass the core.

The selected output has full control of its own playback. Play, pause and seek on that device
(its own controls, the lock screen, headphones, media keys) act on its player at once, with no
trip to the server first, and a slow or lost connection never stops it pausing. Each such
change is counted and carried in the output's reports; the core takes it on as newer than
anything it asked for before hearing of it. Each play, pause, seek and load the core sends
carries the count it knows, and the output ignores one decided before its latest own change.
An output that is out of reach keeps playing what it has. If it comes back after the core
gave up on it, still playing the same song, the core keeps that song rather than reloading it.

Every screen shows the position the output is actually playing, not one a network trip old.
The output app sends half its quickest recent report round trip as `latencyMs`, and the core
dates each report by when it was sampled. Session views carry `serverTimeMs`, which marks when
their position was true. Apps line up with that clock through `/api/session/clock`, using the
quickest of recent round trips, NTP-style, and carry the position forward from then. Delay
inside the output device itself, such as Bluetooth buffering, is not measured.
`server/src/local_music.rs` owns permanent files and the local catalog. `/api/music/local/`
uses normal paired-device access; `/api/local/` is reserved for host-only administration.

Physical audio playback, output handoff and OS media controls still need a two-computer
hardware check.
