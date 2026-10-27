# AMBRA

### (A Much Better Roon Alternative)

The <i><b>perfect</b></i> music player built with performance in mind.

## Running the server

Open Ambra and choose **Start server on this computer**, or install the standalone command
once with `bun run server:install` and run `ambra-server start` from any directory.
The server runs in the background with a native Windows tray icon; closing the app or
terminal keeps it running. Stop it from the tray, Settings → Server, or `ambra-server stop`.
Other computers can discover and pair with that server. Opening Ambra never automatically
starts a new server. See [cross-device playback](docs/cross-device-playback.md) and [native networking, setup, validation, and current limitations](docs/networking/README.md).

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

### AI Usage

We at Quantium Labs really care about quality in our products over everything else. While AI is a fantastic tool, it isn't sufficient to replace the work and effort of programmers. Do we use AI in our products? Yes. Do we avoid it when we can? Also yes. If you have any skills you'd like to contribute to the team to further reduce our AI usage, feel free to get in touch!

### Contact Us

contact@tetrum.dev

### Local music discovery

The Home page’s Discover row uses server-owned listening history and a bundled CC0 music metadata database. Recommendations run entirely on your AMBRA server and resolve playable tracks through your connected services. See [recommendation architecture, data licenses, and database regeneration](docs/recommendations.md).
