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

If the selected output app exits, the server keeps the queue and last reported playback
position. Reopening that app reloads the current song at that position and clears the
output-offline warning automatically. A paused song stays paused; reconnecting does not
advance the queue or count another play. Output availability is separate from server availability.

The background process runs a versioned copy of the server executable from the server's
data directory. Updating the app or installed CLI therefore does not need to overwrite a
running executable. Starting twice reuses the existing server; a file lock prevents two
server processes from opening the same library concurrently.

## Disconnecting a music service

Settings → Services → Disconnect signs the service out of this Ambra server for every
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

`server/src/session.rs` owns transport and queue changes. Session responses include the
queue when the client's queue revision differs; otherwise clients retain their existing
snapshot. Conflicting queue edits retry against the server's returned snapshot. Track-list
preloading goes to the selected output computer, so browsing on a remote prepares audio
where it will play. Output transport commands cannot bypass the core.

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
