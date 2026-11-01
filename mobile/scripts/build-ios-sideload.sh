#!/usr/bin/env bash
set -euo pipefail

mobile_dir="$(cd "$(dirname "$0")/.." && pwd)"
export EAS_PROJECT_ROOT="$(cd "$mobile_dir/.." && pwd)"
export EAS_NO_VCS=1
cd "$mobile_dir"
exec bunx eas-cli@27.2.0 build --platform ios --profile sidestore "$@"
