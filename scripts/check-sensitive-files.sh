#!/usr/bin/env bash
set -euo pipefail

mode="${1:-working-tree}"
if [[ "$mode" != "working-tree" && "$mode" != "--staged" && "$mode" != "--history" && "$mode" != "--push" ]]; then
  echo "usage: $0 [--staged|--history|--push]" >&2
  exit 2
fi

history_baseline="5b939b6f852d3396d469d38716e71e14c71bd5b1"
blocked_path='(^|/)(\.env($|\.)|[^/]*(credential|credentials|session|secret)s?\.(json|ya?ml|toml)|[^/]*metadata-cache\.json|\.?streaming-library\.json|\.?library-track-ids\.json|desktop-state\.json)$|(^|/)\.?spotify-cache/|^docs/(networking|p2p)/results/|\.(har|pcap|pcapng)$'
secret_content='-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{20,}'
assigned_secret="(\"?(access_token|refresh_token|user_auth_token|client_secret|password|auth_data)\"?[[:space:]]*[:=][[:space:]]*(\"[A-Za-z0-9_+/.=-]{16,}\"|'[A-Za-z0-9_+/.=-]{16,}'|[A-Za-z0-9_+/.=-]{16,}[[:space:]]*$))"
failed=0

check_blob() {
  local path="$1"
  local temporary_file="$2"
  local context="$3"
  if grep -IEn -- "$secret_content|$assigned_secret" "$temporary_file" >/dev/null 2>&1; then
    echo "sensitive-content guard: possible secret in $path ($context)" >&2
    failed=1
  fi
}

check_path() {
  local path="$1"
  local source="$2"
  local context="$3"
  temporary_file="$(mktemp)"
  if [[ "$source" == "working-tree" ]]; then
    cp "$path" "$temporary_file" 2>/dev/null || true
  elif [[ "$source" == "index" ]]; then
    git show ":$path" >"$temporary_file" 2>/dev/null || true
  else
    git show "$source:$path" >"$temporary_file" 2>/dev/null || true
  fi
  if [[ "$path" =~ $blocked_path ]]; then
    echo "sensitive-file guard: blocked path $path ($context)" >&2
    failed=1
  fi
  check_blob "$path" "$temporary_file" "$context"
  rm -f "$temporary_file"
}

check_commits() {
  while IFS= read -r commit; do
    [[ -n "$commit" ]] || continue
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      git cat-file -e "$commit:$path" 2>/dev/null || continue
      check_path "$path" "$commit" "commit ${commit:0:12}"
    done < <(git diff-tree --no-commit-id --name-only -r --root "$commit")
  done < <(git rev-list --reverse "$@")
}

if [[ "$mode" == "--history" || "$mode" == "--push" ]]; then
  git cat-file -e "$history_baseline^{commit}" 2>/dev/null || {
    echo "Sensitive-file history baseline is unavailable; fetch full Git history." >&2
    exit 2
  }
fi

if [[ "$mode" == "--history" ]]; then
  check_commits "$history_baseline..HEAD"
elif [[ "$mode" == "--push" ]]; then
  # pre-push stdin: <local ref> <local sha> <remote ref> <remote sha>; scan only commits no remote has yet.
  while read -r _ local_sha _ _; do
    [[ -n "$local_sha" && ! "$local_sha" =~ ^0+$ ]] || continue
    check_commits "$local_sha" "^$history_baseline" --not --remotes
  done
elif [[ "$mode" == "--staged" ]]; then
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    check_path "$path" "index" "staged tree"
  done < <(git diff --cached --name-only --diff-filter=ACMR)
else
  while IFS= read -r path; do
    [[ -n "$path" && -f "$path" ]] || continue
    check_path "$path" "working-tree" "working tree"
  done < <(git ls-files --cached)
fi

if (( failed != 0 )); then
  echo "Sensitive files or credentials must stay outside the repository." >&2
  exit 1
fi

echo "Sensitive-file check passed ($mode)."
