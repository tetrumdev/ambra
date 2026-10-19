# AMBRA

### (A Much Better Roon Alternative)

The <i><b>perfect</b></i> music player built with performance in mind.

## To-Do
<b>For Initial Release</b>
- [x] Create Functional UI
- [x] Add streaming support
  - [x] Tidal
  - [x] Qobuz
  - [x] Spotify
  - [ ] Local Files
- [ ] Finish UI
- [x] Lyrics Support
- [ ] Playback Sync
- [x] Equalizer with Rust Libraries
- [ ] Mobile Apps
- [ ] Server UI
- [x] Home Page

<b>Future Features</b>

- [ ] Serverless Streaming and Downloading
  - [ ] P2P Sync
- [ ] Multi-User Support
- [ ] P2P Support
- [ ] Spotify Connect with all services
- [ ] Room Autocorrection
- [ ] Stats
- [ ] Add download support
  - [ ] Tidal
  - [ ] Qobuz
  - [ ] Spotify
- [ ] Visualizer
- [ ] Add additional streaming and downloading support
  - [ ] Youtube Music
  - [ ] Jellyfin
  - [ ] Navidrome
  - [ ] Deezer
  - [ ] Pandora
  - [ ] Youtube Music

## Tech Stack

### Languages

Rust and TypeScript

### Tools

Tauri, Vite, React, and Bun

## Additional Info

### Streaming service login

The desktop app uses the separate Ambra server for playlists, queue and playback
history, playback track and position, library ordering, and hidden tracks. When
the server or saved state is unavailable, the client opens local tracks with a
temporary session. Streaming features and shared state require the server. The
client does not bundle or start the server:

```sh
cd server
cargo run
```

Run the client separately from `desktop` with `tauri dev`. Building or running
the client does not require a server binary. Closing the client leaves a
separately running server alone; stop the server with Ctrl+C in its terminal.

From the repository root, `bun run dev` installs the desktop dependencies and
launches the client. `bun run build` builds the standalone client.
`bun run tauri dev` also works from the repository root and forwards to the
desktop CLI. Tauri's frontend hooks explicitly run in `desktop` so they cannot
re-enter the root scripts and start another client or build.

The server only accepts requests from the Ambra app itself. Set
`AMBRA_ALLOWED_ORIGINS` (comma-separated) to admit another front end.

Ambra restores working saved sessions when the server starts. To connect a
missing service, open **My Library** in the desktop app and choose the `+`
button in the upper-right corner. Tidal and Qobuz open their login page and ask
you to paste the resulting callback URL into Ambra. Spotify opens its login
page and completes its local callback automatically.

Ambra never stores runtime data in the source tree. Provider sessions are
private files in the operating system's application-config directory, durable
libraries and desktop state use its application-data directory, and metadata
and audio caches use its cache directory. Set `AMBRA_CONFIG_DIR`,
`AMBRA_DATA_DIR`, or `AMBRA_CACHE_DIR` to override those locations when running
the server directly. The server saves listening state in
`AMBRA_DATA_DIR/user-state.v1.json`; clients connected to that server restore the
same state. UI and search preferences, audio output/DSP settings, window bounds,
local audio files, and rebuildable client caches remain on each client.
App volume is saved separately for each output, including System Default, and
restored when selecting that output or restarting the client.

Home shows recently played songs, your playlists, and songs last played at least
30 days ago. Last-played times and track metadata are saved in server listening
state, independently of editable queue history. Playback is recorded when audio
starts, including automatic track advances; restoring a paused session does not
record a play. Existing server queue history seeds Home on the first launch.
Update and restart the server alongside this client to accept the new history key.

On the first connection to a server without listening state, the client imports
its previous local playlists, queue/history, playback position, ordering, and
hidden-track IDs. Existing server state always takes precedence over another
client's legacy data. Old client state stays untouched for rollback; it is no
longer updated. Back up the server data directory before downgrading. An older
client reads its old local snapshot, not subsequent server changes.

The client tries to load server state before opening the library. If loading
fails, local tracks remain available without cached streaming tracks or service
playlists. Local session changes stay in memory and are never uploaded over
saved server state. Choose **Reconnect** to restore server state; the temporary
local session is replaced after a successful connection.

After server state has loaded, failed saves remain
pending in memory and retry while the client is open; normal desktop window
closure waits for a successful save. Force-quitting can lose pending changes.
Concurrent edits from stale clients are rejected and require explicitly
reloading server state. This shares durable state, not live playback control or
automatic playback handoff. Local track paths still require the corresponding
files on the playback machine. Provider login material remains on the server.

Repository hooks and CI reject credential/session files and recognizable secret
values. Enable the versioned hooks after cloning with:

```sh
git config core.hooksPath .githooks
```

### AI Usage

We at Quantium Labs really care about quality in our products over everything else. While AI is a fantastic tool, it isn't sufficient to replace the work and effort of programmers. Do we use AI in our products? Yes. Do we avoid it when we can? Also yes. If you have any skills you'd like to contribute to the team to further reduce our AI usage, feel free to get in touch!

### Contact Us

[This is where we'll have our contact email when we have a domain]
