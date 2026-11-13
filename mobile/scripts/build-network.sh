#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/../.." && pwd)"
manifest="$project_dir/crates/ambra-mobile-bridge/Cargo.toml"
module_dir="$project_dir/mobile/modules/ambra-network"
build_dir="${CARGO_TARGET_DIR:-$project_dir/crates/ambra-mobile-bridge/target}"
case "$build_dir" in /*) ;; *) build_dir="$PWD/$build_dir" ;; esac
export CARGO_TARGET_DIR="$build_dir"
command -v go >/dev/null || { echo 'Install Go 1.27.4 to build bundled Tailcat native library.' >&2; exit 1; }
case "${1:-}" in
  ios)
    xcodebuild -version >/dev/null 2>&1 || { echo 'Full Xcode is required.' >&2; exit 1; }
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
    for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
      cargo build --locked --release --manifest-path "$manifest" --target "$target"
    done
    # Keep headers outside the output directory so xcodebuild cannot copy its own XCFramework recursively.
    header_dir="$build_dir/ios-headers"
    mkdir -p "$build_dir/ios-simulator" "$header_dir"
    cp "$module_dir/ios/AmbraNetwork.h" "$header_dir/AmbraNetwork.h"
    lipo -create "$build_dir/aarch64-apple-ios-sim/release/libambra_mobile.a" "$build_dir/x86_64-apple-ios/release/libambra_mobile.a" -output "$build_dir/ios-simulator/libambra_mobile.a"
    rm -rf "$module_dir/ios/AmbraNetwork.xcframework"
    xcodebuild -create-xcframework -library "$build_dir/aarch64-apple-ios/release/libambra_mobile.a" -headers "$header_dir" -library "$build_dir/ios-simulator/libambra_mobile.a" -headers "$header_dir" -output "$module_dir/ios/AmbraNetwork.xcframework"
    ;;
  android)
    command -v cargo-ndk >/dev/null || { echo 'Install cargo-ndk and Android NDK first.' >&2; exit 1; }
    rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
    (cd "$(dirname "$manifest")" && cargo ndk -P 24 -t arm64-v8a -t armeabi-v7a -t x86_64 -o "$module_dir/android/src/main/jniLibs" build --locked --release)
    for pair in arm64-v8a:aarch64-linux-android armeabi-v7a:armv7-linux-androideabi x86_64:x86_64-linux-android; do
      abi="${pair%%:*}"
      target="${pair#*:}"
      cp "$build_dir/$target/release/libambra_tailcat.so" "$module_dir/android/src/main/jniLibs/$abi/libambra_tailcat.so"
    done
    ;;
  *) echo 'Usage: build-network.sh ios|android' >&2; exit 2 ;;
esac
