# Ambra

Ambra is an open-source music player for local music and supported streaming services. Listen on one device, or use an independent Ambra Server to share a queue and control playback on another device.

## Get started

- [Download Ambra](https://github.com/tetrumdev/ambra/releases) for desktop or download the standalone server.
- [Set up shared playback](docs/cross-device-playback.md) to install a server, pair clients, and select an audio output.
- [Set up the mobile app](mobile/README.md) for iOS or Android.
- [Browse the documentation](docs/README.md) for client behavior, music integrations, and development references.

## Build from source

Install Bun, Rust, and the [platform prerequisites for Tauri](https://v2.tauri.app/start/prerequisites/). Run these commands from the repository root.

```sh
bun run dev             # Run the desktop app in development
bun run server:install  # Build and install the standalone server
ambra-server start     # Start the server in the background
```

Run `bun run build` to build the desktop package. See the [mobile README](mobile/README.md) for native module builds and device installation. To report an issue, use [GitHub Issues](https://github.com/tetrumdev/ambra/issues).

## Screenshots

| Lyrics | Playlist | Search |
| --- | --- | --- |
| ![Lyrics view](https://github.com/user-attachments/assets/0c5ae64e-53ad-4c66-8c70-744ae68852d7) | ![Playlist view](https://github.com/user-attachments/assets/f59cd9d6-74f3-4979-8ab9-db97ae304472) | ![Search view](https://github.com/user-attachments/assets/48165221-9540-4336-8088-06cc7d02fdcd) |

Ambra is licensed under the [MIT license](LICENSE).
