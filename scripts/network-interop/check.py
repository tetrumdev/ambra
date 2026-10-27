#!/usr/bin/env python3
"""Opt-in: use actual public bootstrap/discovery with a temporary Node reference peer."""
from pathlib import Path
import signal
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
subprocess.run(["cargo", "build", "--manifest-path", str(root / "crates/ambra-net/Cargo.toml"), "--example", "hyperdht_probe"], check=True)
reference = subprocess.Popen(["node", str(Path(__file__).with_name("reference.cjs"))], stdout=subprocess.PIPE, text=True)
try:
    key = None
    for line in reference.stdout:
        if line.startswith("KEY "):
            key = line.split()[1]
            break
    if not key:
        raise RuntimeError("Reference server did not announce")
    result = subprocess.run([str(root / "crates/ambra-net/target/debug/examples/hyperdht_probe"), key], timeout=55)
    sys.exit(result.returncode)
finally:
    reference.send_signal(signal.SIGTERM)
    try:
        reference.wait(timeout=5)
    except subprocess.TimeoutExpired:
        reference.kill()
        reference.wait()
