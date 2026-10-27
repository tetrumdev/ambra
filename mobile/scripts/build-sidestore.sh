#!/usr/bin/env bash
set -euo pipefail

# EAS runs this on a Mac. SideStore supplies the user's signature after download.
cd "$(dirname "$0")/.."
output="$PWD/.expo/sidestore"
mkdir -p "$output/Payload"

xcodebuild \
  -workspace ios/Ambra.xcworkspace \
  -scheme Ambra \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$output/Ambra.xcarchive" \
  archive \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY='' \
  DEVELOPMENT_TEAM=''

app="$output/Ambra.xcarchive/Products/Applications/Ambra.app"
test -d "$app"
test -f "$app/main.jsbundle"
test ! -d "$app/PlugIns"
/usr/libexec/PlistBuddy -c 'Print UIBackgroundModes' "$app/Info.plist" | grep -q audio
# Native Rust networking uses a private loopback HTTP bridge. No VPN/IP-range exceptions.
/usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$app/Info.plist" | grep -qx true

# Preserve embedded frameworks in the IPA.
ditto "$app" "$output/Payload/Ambra.app"
(
  cd "$output"
  ditto -c -k --keepParent Payload Ambra.ipa
)
echo "Unsigned IPA ready: $output/Ambra.ipa"
