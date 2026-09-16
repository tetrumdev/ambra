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

Packaged desktop builds start the bundled server automatically. During
development, start it separately:

```sh
cd server
cargo run
```

Ambra restores working saved sessions when the server starts. To connect a
missing service, open **My Library** in the desktop app and choose the `+`
button in the upper-right corner. Tidal and Qobuz open their login page and ask
you to paste the resulting callback URL into Ambra. Spotify opens its login
page and completes its local callback automatically.

Tidal stores its session in `server/.tidal-session.json`. Qobuz stores its
session in `server/.qobuz-session.json`. Spotify stores its login under
`server/.spotify-cache`. These paths are ignored by Git.

### AI Usage

We at Quantium Labs really care about quality in our products over everything else. While AI is a fantastic tool, it isn't sufficient to replace the work and effort of programmers. Do we use AI in our products? Yes. Do we avoid it when we can? Also yes. If you have any skills you'd like to contribute to the team to further reduce our AI usage, feel free to get in touch!

### Contact Us

[This is where we'll have our contact email when we have a domain]
