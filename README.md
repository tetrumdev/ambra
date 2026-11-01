# AMBRA

A Much Better Roon Alternative

## What is AMBRA?

AMBRA is an open-source music player for audiophiles, music lovers, and everyday listeners alike. It is designed to provide lossless audio playback from multiple streaming services, syncing across all your devices, and a beautiful and intuitive interface to bring it all together. If you're asking yourself "what's the point of this if I already have a streaming service?", the answer is that, with AMBRA, you get seamless live playback syncing and remote control on nearly every single one of your devices, a powerful DSP (Digital Signal Processing) engine that can make lossless modifications to the audio signal, a fast and responsive UI, and a lot more. We have a long road ahead of us and we hope you'll join us in our journey!

## Desktop Development

Install [Bun](https://bun.sh/) and the stable [Rust toolchain](https://rustup.rs/),
including Cargo. On Linux, also install the
[Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/#linux).
For Arch Linux and CachyOS:

```sh
sudo pacman -S --needed base-devel webkit2gtk-4.1 openssl curl wget file libappindicator-gtk3 librsvg
```

From the repository root, start the native desktop app:

```sh
bun run dev
```

This installs the locked desktop dependencies, starts Vite on port 1420, and
builds and launches the Tauri app. The first Rust build downloads and compiles
dependencies and takes longer than later starts. Keep the command running while
developing; press Ctrl+C to stop it.

The Tauri launcher includes `$CARGO_HOME/bin` (or `~/.cargo/bin` by default) in
its search path, including when started from an editor or non-login shell.
Check the toolchain and native prerequisites with `bun run tauri info`.
Running `bun run dev` inside `desktop` starts only the frontend, not Tauri.

On Linux Wayland sessions with the NVIDIA kernel module loaded, the launcher
defaults `__NV_DISABLE_EXPLICIT_SYNC=1` to work around WebKitGTK's
`Error 71 (Protocol error)` startup crash. This keeps hardware acceleration and
native Wayland enabled. Explicit values for this variable are preserved;
`__NV_DISABLE_EXPLICIT_SYNC=0 bun run dev` opts out. Other GPUs and X11 sessions
are unchanged. If the crash persists, try
`WEBKIT_DISABLE_DMABUF_RENDERER=1 bun run dev` as a fallback.

On Linux, native playback uses ALSA (`alsa-lib` ships with the prerequisites
above). "System Default" plays through the system mixer (PipeWire or
PulseAudio). Exclusive mode needs a specific hardware output and fails while
the system mixer holds that device; free it in your mixer settings first.

Only System Default is enabled initially. Newly discovered audio devices stay
disabled until enabled in Settings → Outputs. Enabled outputs appear first in
both local and remote output settings. Previously saved device choices are preserved.

After five seconds paused or idle, AMBRA closes its audio output so other apps can
use the device. Volume, queue, settings, and repeated Pause commands do not extend
that delay. The track and position stay loaded; Play reopens the selected output.

## Server

Quitting the app that owns the active shared audio output pauses server playback.
The queue and last reported position are kept; reopening the app does not resume
until you press Play. Closing another controller does not interrupt the active output.
If an output crashes or loses its connection, playback pauses after the eight-second
presence timeout instead.

Install the `ambra-server` command globally from the repository root:

```sh
bun run server:install
```

This runs `cargo install --path server --locked`, which puts `ambra-server` in
`$CARGO_HOME/bin` (`~/.cargo/bin` by default). Add that directory to your
`PATH` if your shell does not already include it. Run the same command again to
update after pulling changes.

## Screenshots

### Lyrics

<img width="2560" height="1440" alt="7b883d18-1e17-4ee0-aa21-23a53b205f09" src="https://github.com/user-attachments/assets/0c5ae64e-53ad-4c66-8c70-744ae68852d7" />

### Playlist

<img width="2559" height="1439" alt="image" src="https://github.com/user-attachments/assets/f59cd9d6-74f3-4979-8ab9-db97ae304472" />

### Search

<img width="2328" height="1174" alt="image" src="https://github.com/user-attachments/assets/48165221-9540-4336-8088-06cc7d02fdcd" />

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
- [x] Playback Sync
- [x] Equalizer with Rust Libraries
- [ ] Mobile Apps
- [ ] Server UI
- [x] Home Page

<b>Future Features</b>

- [ ] Serverless Streaming and Downloading
  - [ ] P2P Sync
- [ ] Multi-User Support
- [ ] P2P Support
- [ ] "Spotify Connect" with all services
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

We at Tetrum really care about quality in our products over everything else. While AI is a fantastic tool, it isn't sufficient to replace the work and intention of programmers. Do we use AI in our products? Yes. Do we still ensure the product is _ours_ with intention behind every decision and not mindless slop? Also yes. If you have any skills you'd like to contribute to the team to further reduce our AI usage, feel free to get in touch!

### Contact Us

contact@tetrum.dev
