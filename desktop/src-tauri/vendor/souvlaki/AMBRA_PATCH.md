# Local patch to souvlaki 0.8.3

The macOS artwork loader now checks for a nil NSURL/NSImage before sending
messages, and skips artwork publication for missing images or invalid sizes.

This fixes the 2026-09-06 Ambra crash in `load_image_from_url` when optional
Now Playing artwork fails to load. Upstream source and licenses are retained.

The crate also allows the obsolete `cargo-clippy` cfg emitted by objc 0.2
macros so current Rust versions do not produce false configuration warnings.

Artwork downloads remain asynchronous, but their Now Playing updates run on
the main queue alongside metadata and playback publication. The track counter
is rechecked there so late artwork cannot replace a newer track's state.

Regression checks: `cargo test --manifest-path vendor/souvlaki/Cargo.toml --target-dir target --lib artwork_tests` from desktop/src-tauri.
