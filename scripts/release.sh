#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "usage: $0 <version>   e.g. $0 0.1.3" >&2
  exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "tag v$version already exists" >&2
  exit 1
fi

sed -i '' -E "s/^(  \"version\": )\"[^\"]+\"/\1\"$version\"/" desktop/package.json desktop/src-tauri/tauri.conf.json
sed -i '' -E "1,/^version = / s/^version = \"[^\"]+\"/version = \"$version\"/" desktop/src-tauri/Cargo.toml server/Cargo.toml

(cd desktop/src-tauri && cargo update -p AMBRA --offline --quiet)
(cd server && cargo update -p ambra-server --offline --quiet)

./scripts/check-sensitive-files.sh

git add desktop/package.json desktop/src-tauri/tauri.conf.json \
  desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock \
  server/Cargo.toml server/Cargo.lock
git commit -m "release: v$version"
git tag "v$version"

echo "Tagged v$version. Run 'git push origin main v$version' to build the release."
