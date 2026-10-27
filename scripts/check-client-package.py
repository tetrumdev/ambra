#!/usr/bin/env python3
"""Inspect built client bundles, including installer contents; never infer from configuration."""
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
if not root.exists():
    raise SystemExit(f"Package output missing: {root}")
files = list(root.rglob("*")) if root.is_dir() else [root]
for path in files:
    if path.is_file() and path.name.lower().startswith("ambra-server"):
        raise SystemExit(f"Server executable found in client distribution: {path}")
apps = [root] if root.suffix == ".app" else [path for path in files if path.suffix == ".app"]
installers = [path for path in files if path.suffix.lower() in (".exe", ".msi")]
if not apps and not installers:
    raise SystemExit("No built desktop application or installer found")
for installer in installers:
    listing = subprocess.check_output(["7z", "l", str(installer)], text=True)
    if "ambra-server" in listing.lower():
        raise SystemExit(f"Server executable found inside {installer}")
print(f"PASS inspected {len(apps)} app bundle(s), {len(installers)} installer(s); no Ambra server executable")
