#!/usr/bin/env python3
"""Inspect built client bundles, including installer contents; never infer from configuration."""
from pathlib import Path
import subprocess
import sys
import zipfile

blocked_names = ("ambra-server", "soloist", "vbcable", "vbaudio_cable", "vbmmecable")
root = Path(sys.argv[1]).resolve()
if not root.exists():
    raise SystemExit(f"Package output missing: {root}")
files = list(root.rglob("*")) if root.is_dir() else [root]
for path in files:
    if path.is_file() and path.name.lower().startswith(blocked_names):
        raise SystemExit(f"Server, Soloist, or virtual audio driver found in client distribution: {path}")
apps = [root] if root.suffix == ".app" else [path for path in files if path.suffix == ".app"]
installers = [path for path in files if path.suffix.lower() in (".exe", ".msi")]
mobile = [path for path in files if path.suffix.lower() in (".apk", ".aab", ".ipa")]
for package in mobile:
    with zipfile.ZipFile(package) as archive:
        for member in archive.namelist():
            if Path(member).name.lower().startswith(blocked_names):
                raise SystemExit(f"Server, Soloist, or virtual audio driver found inside {package}: {member}")
if not apps and not installers and not mobile:
    raise SystemExit("No built desktop application or installer found")
for installer in installers:
    listing = subprocess.check_output(["7z", "l", str(installer)], text=True)
    if any(name in listing.lower() for name in blocked_names):
        raise SystemExit(f"Server, Soloist, or virtual audio driver found inside {installer}")
print(f"PASS inspected {len(apps)} app bundle(s), {len(installers)} installer(s); {len(mobile)} mobile package(s); no server, Soloist, or virtual audio driver")
