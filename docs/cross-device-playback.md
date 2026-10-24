# Shared server playback

Each server owns one queue, playback position, listening history and selected audio output.
Every connected app controls and displays that same session. Apps expose their audio devices
to the server and execute its audio commands. Choosing another output moves the current song
and position there. This currently supports one selected output, rather than synchronized
playback across several outputs at once.

Opening the app never automatically starts a server. It connects to a previously selected server or, before one
has been selected, tries an already running local server at `127.0.0.1:38147`. If that is
unavailable it shows a connection screen with LAN discovery and manual address entry.
Pair once with your chosen server; later launches remember it and wait for it when offline.
There is no automatic fallback to a different server.

The server shares itself on the LAN by default. Join from the connection screen or Settings
→ Server, then approve the pairing code on the host. Joining adopts the server's saved state;
the joining computer's old library is not automatically imported.

## Install and start the server

In the app's connection screen, choose **Start server on this computer**. The bundled server
starts in the background and the app connects to it. On Windows the server has a small
native system tray icon with a **Stop server** menu item. It has no webview or app window.
You can close the app window and the server continues running.

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
Use `ambra-server stop`, Settings → Server → Stop server, or the tray menu to stop it.
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

The background process runs a versioned copy of the server executable from the server's
data directory. Updating the app or installed CLI therefore does not need to overwrite a
running executable. Starting twice reuses the existing server; a file lock prevents two
server processes from opening the same library concurrently.

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

`server/src/session.rs` owns transport and queue changes. Its session responses include the
queue, so clients display a consistent song and position; conflicting queue edits retry
against the server's returned snapshot. Output transport commands cannot bypass the core.
`server/src/local_music.rs` owns permanent files and the local catalog. `/api/music/local/`
uses normal paired-device access; `/api/local/` is reserved for host-only administration.

Automated checks cover queue playback and progression using a simulated output, pause,
stale queue edits, frontend command ordering, imported file persistence across restart,
authenticated downloads, byte ranges, duplicate imports, upload integrity and Windows-path
migration. Browser checks cover existing library, queue and settings interactions.

Physical audio playback, output handoff and OS media controls still need a two-computer
hardware check. Existing lyrics, playback-clock and search-grouping regressions are outside
this change. The HTTP proxy test for large upstream header counts also failed on later runs;
see the test output for the current failures.
