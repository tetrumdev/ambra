#!/bin/sh
set -eu

executable=$1
shift

if [ "${executable##*/}" = "AMBRA" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  source_dir=$(dirname "$script_dir")
  executable_dir=$(CDPATH= cd -- "$(dirname -- "$executable")" && pwd)
  executable_path="$executable_dir/${executable##*/}"
  bundle_path="$executable_dir/AMBRA Dev.app"
  bundle_executable="$bundle_path/Contents/MacOS/AMBRA"

  mkdir -p "$bundle_path/Contents/MacOS"
  cp "$source_dir/Info.plist" "$bundle_path/Contents/Info.plist"
  ln -f "$executable_path" "$bundle_executable"

  /usr/bin/codesign \
    --force \
    --sign - \
    --identifier com.quantium.ambra \
    "$bundle_path"

  exec "$bundle_executable" "$@"
fi

exec "$executable" "$@"
