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
# iOS 17+ requires explicit IP exceptions; the local-network flag alone is insufficient.
for range in 100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  /usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSExceptionDomains:$range:NSExceptionAllowsInsecureHTTPLoads" "$app/Info.plist" | grep -qx true
done

# Preserve embedded frameworks in the IPA.
ditto "$app" "$output/Payload/Ambra.app"
(
  cd "$output"
  ditto -c -k --keepParent Payload Ambra.ipa
)
echo "Unsigned IPA ready: $output/Ambra.ipa"
