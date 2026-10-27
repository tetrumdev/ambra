#!/usr/bin/env python3
"""Run the existing native probe against an independently running Kubuntu server.
The operator launches this through icmp-launch in a private Terminal. This script
runs unprivileged, never calls sudo, and never reads or handles a password.
SSH carries management only. DHT carries a signed endpoint control record only.
The pairing probe disables LAN and HyperDHT data attempts and asserts Pwnat.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", help="Authorized SSH management host")
    parser.add_argument("remote_directory", help="Isolated server test directory")
    parser.add_argument("audio", type=Path, help="WAV fixture to verify byte for byte")
    args = parser.parse_args()
    if os.getuid() == 0 or os.geteuid() == 0:
        raise SystemExit("Refusing to run the probe as root. Use icmp-launch to drop privileges first.")
    try:
        descriptor = int(os.environ["AMBRA_PWNAT_ICMP_FD"])
        os.fstat(descriptor)
    except (KeyError, ValueError, OSError):
        raise SystemExit("Missing inherited ICMP socket. Run through the dedicated icmp-launch helper.")
    import hashlib
    root = Path(__file__).resolve().parents[2]
    examples = root / "crates/ambra-net/target/debug/examples"
    probe = examples / "pairing_probe"
    diagnostics = examples / "pwnat_probe"
    directory = Path(tempfile.mkdtemp(prefix="ambra-pwnat-macos-result-"))
    print("ARTIFACTS", directory, flush=True)
    environment = os.environ.copy()
    environment["RUST_LOG"] = "ambra_net=info"
    # Never pass the ICMP descriptor to SSH or other management subprocesses.
    def cli(*words):
        remote = Path(args.remote_directory)
        assignments = [f"AMBRA_{kind}_DIR={remote / kind.lower()}" for kind in ("CONFIG", "DATA", "CACHE")]
        command = "env " + " ".join(shlex.quote(value) for value in assignments)
        command += " /home/llewyn/ambra/server/target/debug/ambra-server "
        command += " ".join(shlex.quote(word) for word in words)
        return subprocess.check_output(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.host, command], text=True, timeout=20)
    capability = subprocess.check_output([str(diagnostics), "capability"], env=environment, pass_fds=(descriptor,), text=True)
    print(capability.strip(), flush=True)
    assert json.loads(capability.splitlines()[0])["available"], "Inherited raw socket unavailable"
    status = json.loads(cli("network", "status"))
    key = status["publicKey"]
    # Resolve the signed record before disabling the DHT data transport. This
    # avoids counting a fresh bootstrap against the pwnat connection deadline.
    lookup = subprocess.check_output([str(diagnostics), "lookup", key], env=environment, text=True, timeout=25)
    endpoint = lookup.strip().removeprefix("SIGNED_PWNAT_CANDIDATE ")
    print(lookup.strip(), flush=True)
    payload = {"version": 1, "publicKey": key, "name": "pwnat WAN investigation", "localAddresses": [], "publicEndpoint": endpoint}
    link = "ambra://pair/" + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    audio = args.audio.resolve()
    file_id = hashlib.sha256(audio.read_bytes()).hexdigest() + ".wav"
    output_path = directory / "probe-output.log"
    errors_path = directory / "client.log"
    with output_path.open("w") as output, errors_path.open("w") as errors:
        client = subprocess.Popen([str(probe), link, file_id, "--pwnat-only", "--client-id", "pwnat-manual-test", "--audio-file", str(audio), "--control"],
                                  env=environment, pass_fds=(descriptor,), stdout=output, stderr=errors, stdin=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                lines = output_path.read_text().splitlines()
                if lines and lines[0].startswith("CODE "): break
                if client.poll() is not None: raise RuntimeError(errors_path.read_text())
                time.sleep(0.1)
            else: raise RuntimeError("pwnat did not reach encrypted pairing within its deadline")
            print("Approving isolated pwnat test pairing over SSH management", flush=True)
            cli("pair", "approve", lines[0].split()[1])
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                lines = output_path.read_text().splitlines()
                if "READY" in lines: break
                if client.poll() is not None: raise RuntimeError(errors_path.read_text())
                time.sleep(0.1)
            else: raise RuntimeError("pwnat pairing or WAV transfer did not finish")
            client.communicate("rebind\nping\nstream\nstatus\nquit\n", timeout=45)
            transcript = output_path.read_text()
            print(transcript, flush=True)
            assert client.returncode == 0 and '"method":"Pwnat"' in transcript
            assert "PING ok" in transcript and transcript.count("STREAM ok") == 2
            print("VERIFIED WORKING: pwnat-only QUIC/Noise, pairing, exact WAV/range, and reconnect", flush=True)
            print("Confirm server ICMP quotation logs and public endpoint routes before claiming Internet NAT traversal.", flush=True)
        finally:
            if client.poll() is None:
                client.terminate(); client.wait(timeout=5)


if __name__ == "__main__":
    main()
