#!/bin/sh
# Builds the server and places it where Tauri bundles it beside the app
# (desktop/src-tauri/binaries/ambra-server-<target-triple>).
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
triple=$(rustc -vV | sed -n 's/^host: //p')
suffix=""
case "$triple" in *windows*) suffix=".exe" ;; esac

cargo build --release --manifest-path "$root/server/Cargo.toml"
mkdir -p "$root/desktop/src-tauri/binaries"
cp "$root/server/target/release/ambra-server$suffix" \
  "$root/desktop/src-tauri/binaries/ambra-server-$triple$suffix"
echo "Bundled server for $triple"
