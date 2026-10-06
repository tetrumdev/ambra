# AMBRA

### (A Much Better Roon Alternative)

The <i><b>perfect</b></i> music player built with performance in mind.

## To-Do

- [x] Create Functional UI
- [x] Add streaming support
  - [x] Tidal
  - [x] Qobuz
  - [x] Spotify
  - [ ] Local Files
- [ ] Finish UI
- [ ] Add download support
  - [ ] Tidal
  - [ ] Qobuz
  - [ ] Spotify
- [ ] Playback Sync
- [ ] Spotify Connect with all services
- [ ] Equalizer with CamillaDSP
- [ ] Room Autocorrection
- [ ] Mobile Apps
- [ ] P2P Support

<b>Future Features</b>

- [ ] Serverless Streaming and Downloading
  - [ ] P2P Sync
- [ ] Stats
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

Tauri, Vite, React, Bun, and NodeJS

## Additional Info

### Streaming service login

The desktop app runs by itself for local music. Streaming features use the
Ambra server, which the app bundles, starts, and restarts automatically (its
log is `ambra-server.log` in the app's log directory). Build it into the app
once per machine before `tauri dev` or `tauri build`:

```sh
scripts/build-server-sidecar.sh
```

During server development, run it directly instead; the app uses a server
that is already listening rather than starting its own:

```sh
cd server
cargo run
```

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
the server directly. A stable or synchronized `AMBRA_DATA_DIR` lets another
installation restore the library, playlists, preferences, queue, and ordering;
provider login material remains separate and must be authorized per machine.

Repository hooks and CI reject credential/session files and recognizable secret
values. Enable the versioned hooks after cloning with:

```sh
git config core.hooksPath .githooks
```

### AI Usage

We at Quantium Labs really care about quality in our products over everything else. While AI is a fantastic tool, it isn't sufficient to replace the work and effort of programmers. Do we use AI in our products? Yes. Do we avoid it when we can? Also yes. If you have any skills you'd like to contribute to the team to further reduce our AI usage, feel free to get in touch!

### Contact Us

[This is where we'll have our contact email when we have a domain]
