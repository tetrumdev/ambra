# Local patch to souvlaki 0.8.3

The macOS artwork loader now checks for a nil NSURL/NSImage before sending
messages, and skips artwork publication for missing images or invalid sizes.

This fixes the 2026-09-06 Ambra crash in `load_image_from_url` when optional
Now Playing artwork fails to load. Upstream source and licenses are retained.

Regression checks: `cargo test --manifest-path vendor/souvlaki/Cargo.toml --target-dir target --lib artwork_tests` from desktop/src-tauri.
