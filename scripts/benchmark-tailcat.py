#!/usr/bin/env python3
"""Benchmark an enrolled, isolated Ambra server using production Rust components.

SSH collects administrative socket evidence only. Audio and API data use the
selected Ambra transport. Raw logs remain in the protected probe profile; the
output report removes addresses and never includes credentials.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import time


def sanitize(value):
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"\btc[A-Za-z0-9_-]{20,}", "[secret removed]", value)
        return re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b", "[endpoint removed]", value)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--server-key", required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--host", default="llewyn@100.95.127.9")
    parser.add_argument("--mode", choices=["native", "tailcat", "roam"], required=True)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--physical", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.rounds <= 10 or args.host.startswith("-"):
        parser.error("Use 1..10 rounds and an SSH host")
    args.profile.mkdir(parents=True, exist_ok=True)
    args.profile.chmod(0o700)
    if args.physical:
        warp = subprocess.check_output(["warp-cli", "status"], text=True)
        if "Disconnected" not in warp:
            raise RuntimeError("Physical baseline requires WARP disconnected")
        route = subprocess.check_output(["route", "-n", "get", "default"], text=True)
        if "interface: en0" not in route:
            raise RuntimeError("Physical baseline requires school Wi-Fi en0")
    environment = os.environ.copy()
    environment["AMBRA_BENCH_AUDIO"] = str(args.audio.resolve())
    environment["RUST_LOG"] = "ambra_net=debug"
    mode = "run" if args.mode == "native" else args.mode
    command = [str(args.probe.resolve()), mode, str(args.profile.resolve()), args.server_key, str(args.rounds)]
    raw_log = args.profile / f"{args.output.stem}.log"
    samples = []
    diagnostic_failures = []
    def capture(command, kind, timeout):
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            diagnostic_failures.append({"tool": kind, "timed_out": True})
            return ""
        if result.returncode:
            diagnostic_failures.append({"tool": kind, "exit_code": result.returncode})
        return result.stdout
    started = time.monotonic()
    with raw_log.open("w") as log:
        raw_log.chmod(0o600)
        process = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            while True:
                try:
                    output, _ = process.communicate(timeout=3)
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() - started > 360:
                        raise TimeoutError("Bounded benchmark exceeded 360 seconds")
                    local = capture(["lsof", "-a", "-p", str(process.pid), "-iTCP", "-sTCP:ESTABLISHED", "-nP"], "local sockets", 10)
                    remote = capture(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", args.host, "ss -tinpH 'sport = :443'"], "administrative SSH sockets", 15)
                    samples.append({"local": local, "remote": remote})
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    records = []
    for line in output.splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and "pairingCode" not in value:
            records.append(value)
    raw = raw_log.read_text()
    public_peer = False
    for peer in re.findall(r"peer=(\d+\.\d+\.\d+\.\d+):\d+", raw):
        address = ipaddress.ip_address(peer)
        if address.is_global and address not in ipaddress.ip_network("100.64.0.0/10"):
            public_peer = True
    report = {
        "mode": args.mode,
        "physical_cross_network": args.physical,
        "exit_code": process.returncode,
        "elapsed_seconds": time.monotonic() - started,
        "audio_bytes": args.audio.stat().st_size,
        "records": records,
        "native_path_evidence": {
            "public_peer_in_authenticated_socket_log": public_peer,
            "client_native_interface_logged": "interface=en0" in raw,
            "home_tcp443_socket_samples": sum(bool(sample["remote"].strip()) for sample in samples),
            "sample_count": len(samples),
            "tcp_rtt_ms_samples": [float(rtt) for sample in samples for rtt in re.findall(r"\brtt:([0-9.]+)/", sample["remote"])],
        },
        "diagnostic_failures": diagnostic_failures,
        "tailcat_started": "ConnectingTailcat" in raw,
        "failed_native_methods": re.findall(r"Transport attempt failed.*?method=(Lan|Public|TcpPunch|HyperDHT|Pwnat)\b", raw),
        "pwnat_skipped": "ConnectingPwnat" not in raw,
        "native_exhaustion_logged": "All eligible native transports exhausted" in raw,
        "hardware_playback": False,
        "management_transport": "Tailscale SSH; application requests originate in Rust probe",
        "qualification": "API latency includes server work; it is not a raw network RTT. Public DERP runs are bounded functional tests, not saturation tests.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(sanitize(report), indent=2) + "\n")
    print(json.dumps({"report": str(args.output), "exit_code": process.returncode, "records": len(records)}))
    return process.returncode


if __name__ == "__main__":
    raise SystemExit(main())
