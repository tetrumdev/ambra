# AMBRA

### (A Much Better Roon Alternative)

The <i><b>perfect</b></i> music player built with performance in mind.

## To-Do

- [x] Create Functional UI
- [ ] Add streaming support
  - [x] Tidal
  - [x] Qobuz
  - [x] Spotify
  - [ ] Youtube Music
  - [ ] Local Files
- [ ] Finish UI
- [ ] Add download support
  - [ ] Tidal
  - [ ] Qobuz
  - [ ] Spotify
  - [ ] Youtube Music
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
- [ ] Add additional streaming support
  - [ ] Jellyfin
  - [ ] Navidrome
  - [ ] Deezer
  - [ ] Pandora

## Tech Stack

### Languages

Rust and TypeScript

### Tools

Tauri, Vite, React, Bun, and NodeJS

## Additional Info

### Qobuz setup

Ambra reuses the Qobuz API implementation from
[`qbz`](https://github.com/vicrodh/qbz), pinned to its 2.0.2 source revision.
Qobuz credentials remain in the Rust server and are never returned to the
desktop.

For first login, start the server with the terminal OAuth flow:

```sh
cd server
AMBRA_QOBUZ_INTERACTIVE_LOGIN=1 cargo run
```

Open the printed Qobuz URL, complete login, then paste the callback URL back
into the terminal. Ambra stores the resulting session in
`server/.qobuz-session.json` with private file permissions. Later starts use
that session automatically. A pre-existing token can instead be supplied with
`AMBRA_QOBUZ_USER_AUTH_TOKEN`.

`AMBRA_QOBUZ_QUALITY` selects the preferred format (`5`, `6`, `7`, or `27`);
default is `27` with qbz's automatic fallback to available lower qualities.
Paste either a Tidal or Qobuz album URL into the desktop's library form.

Streaming metadata uses one provider-neutral contract: provider IDs, title and
version, primary/all artists, album artists and version, cover, release date,
label, genres, UPC, track/disc numbers, duration, explicit flag, ISRC,
copyright, delivered quality, maximum sample rate/bit depth, and a server-owned
playback descriptor. Spotify and YouTube Music adapters can populate the same
contract later without changing player components.

### Spotify setup

Spotify playback uses librespot and requires Spotify Premium. Start server once with browser login enabled:

```sh
cd server
AMBRA_SPOTIFY_INTERACTIVE_LOGIN=1 cargo run
```

Login is cached under `server/.spotify-cache`. Later starts reuse cached credentials. Headless alternatives: set `AMBRA_SPOTIFY_ACCESS_TOKEN`, or set both `AMBRA_SPOTIFY_USERNAME` and `AMBRA_SPOTIFY_PASSWORD`. Optional `AMBRA_SPOTIFY_QUALITY` values: `96`, `160`, or `320` (default).

### AI Usage

We at Quantium Labs really care about quality in our products over everything else. While AI is a fantastic tool, it isn't sufficient to replace the work and effort of programmers. Do we use AI in our products? Yes. Do we avoid it when we can? Also yes. If you have any skills you'd like to contribute to the team to further reduce our AI usage, feel free to get in touch!

### Contact Us

[This is where we'll have our contact email when we have a domain]

<!--## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)-->
