#!/usr/bin/env bash
set -euo pipefail

mode="${1:-working-tree}"
if [[ "$mode" != "working-tree" && "$mode" != "--staged" && "$mode" != "--history" ]]; then
  echo "usage: $0 [--staged|--history]" >&2
  exit 2
fi

history_baseline="ed2c8a388537062d215539e9b32f287d695c9ca5"
blocked_path='(^|/)(\.env($|\.)|[^/]*(credential|credentials|session|secret)s?\.(json|ya?ml|toml)|[^/]*metadata-cache\.json|\.?streaming-library\.json|\.?library-track-ids\.json|desktop-state\.json)$|(^|/)\.?spotify-cache/'
secret_content='-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{20,}'
assigned_secret='("?(access_token|refresh_token|user_auth_token|client_secret|password|auth_data)"?[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9_+/.=-]{16,})'
failed=0

check_blob() {
  local path="$1"
  local temporary_file="$2"
  local context="$3"
  if grep -IEn "$secret_content|$assigned_secret" "$temporary_file" >/dev/null 2>&1; then
    echo "sensitive-content guard: possible secret in $path ($context)" >&2
    failed=1
  fi
}

check_path() {
  local path="$1"
  local source="$2"
  local context="$3"
  if [[ "$path" =~ $blocked_path ]]; then
    echo "sensitive-file guard: blocked path $path ($context)" >&2
    failed=1
    return
  fi

  temporary_file="$(mktemp)"
  if [[ "$source" == "working-tree" ]]; then
    cp "$path" "$temporary_file" 2>/dev/null || true
  elif [[ "$source" == "index" ]]; then
    git show ":$path" >"$temporary_file" 2>/dev/null || true
  else
    git show "$source:$path" >"$temporary_file" 2>/dev/null || true
  fi
  check_blob "$path" "$temporary_file" "$context"
  rm -f "$temporary_file"
}

if [[ "$mode" == "--history" ]]; then
  git cat-file -e "$history_baseline^{commit}" 2>/dev/null || {
    echo "Sensitive-file history baseline is unavailable; fetch full Git history." >&2
    exit 2
  }
  while IFS= read -r commit; do
    [[ -n "$commit" ]] || continue
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      git cat-file -e "$commit:$path" 2>/dev/null || continue
      check_path "$path" "$commit" "commit ${commit:0:12}"
    done < <(git diff-tree --no-commit-id --name-only -r --root "$commit")
  done < <(git rev-list --reverse "$history_baseline..HEAD")
else
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    if [[ "$mode" == "working-tree" ]]; then
      [[ -f "$path" ]] || continue
      check_path "$path" "working-tree" "working tree"
    else
      git cat-file -e ":$path" 2>/dev/null || continue
      check_path "$path" "index" "staged tree"
    fi
  done < <(git ls-files --cached)
fi

if (( failed != 0 )); then
  echo "Sensitive files or credentials must stay outside the repository." >&2
  exit 1
fi

echo "Sensitive-file check passed ($mode)."
