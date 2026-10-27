#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/../.." && pwd)"
manifest="$project_dir/crates/ambra-mobile-bridge/Cargo.toml"
module_dir="$project_dir/mobile/modules/ambra-network"
case "${1:-}" in
  ios)
    xcodebuild -version >/dev/null 2>&1 || { echo 'Full Xcode is required.' >&2; exit 1; }
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
    for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
      cargo build --locked --release --manifest-path "$manifest" --target "$target"
    done
    build_dir="$project_dir/crates/ambra-mobile-bridge/target"
    mkdir -p "$build_dir/ios-simulator"
    lipo -create "$build_dir/aarch64-apple-ios-sim/release/libambra_mobile.a" "$build_dir/x86_64-apple-ios/release/libambra_mobile.a" -output "$build_dir/ios-simulator/libambra_mobile.a"
    rm -rf "$module_dir/ios/AmbraNetwork.xcframework"
    xcodebuild -create-xcframework -library "$build_dir/aarch64-apple-ios/release/libambra_mobile.a" -headers "$module_dir/ios" -library "$build_dir/ios-simulator/libambra_mobile.a" -headers "$module_dir/ios" -output "$module_dir/ios/AmbraNetwork.xcframework"
    ;;
  android)
    command -v cargo-ndk >/dev/null || { echo 'Install cargo-ndk and Android NDK first.' >&2; exit 1; }
    rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
    cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o "$module_dir/android/src/main/jniLibs" build --locked --release --manifest-path "$manifest"
    ;;
  *) echo 'Usage: build-network.sh ios|android' >&2; exit 2 ;;
esac
