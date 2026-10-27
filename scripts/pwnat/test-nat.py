#!/usr/bin/env python3
"""Opt-in Linux lab: real Ambra, two isolated conntrack NATs, no Internet or VPN path.
Run with sudo on a disposable Linux host after building server and examples and
installing the root-owned CAP_NET_RAW icmp-launch helper. Host firewall, routing,
and forwarding settings are not changed. All namespace resources are removed.
"""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import signal
import struct
import subprocess
import tempfile
import time
import wave

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server/target/debug/ambra-server"
EXAMPLES = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "server/target")) / "debug/examples"
HELPER = Path("/usr/local/libexec/ambra-icmp-launch")


def main():
    if os.geteuid() != 0 or not os.environ.get("SUDO_UID"):
        raise SystemExit("Run with sudo as a non-root user on a disposable Linux host.")
    user = pwd.getpwuid(int(os.environ["SUDO_UID"]))
    prefix = "ap" + str(os.getpid())
    names = [prefix + suffix for suffix in ("s", "a", "i", "b", "c")]
    server_ns, router_a, internet, router_b, client_ns = names
    processes = []
    created = []
    directory = Path(tempfile.mkdtemp(prefix="ambra-pwnat-lab-"))
    os.chown(directory, user.pw_uid, user.pw_gid)
    print("ARTIFACTS", directory, flush=True)

    def run(args, **kwargs):
        return subprocess.run([str(a) for a in args], check=True, text=True, capture_output=True, **kwargs)

    def ns(name, *args):
        return run(["ip", "netns", "exec", name, *args]).stdout

    def user_command(name, executable, *args):
        return ["ip", "netns", "exec", name, "runuser", "-u", user.pw_name, "--", str(executable), *map(str, args)]

    try:
        for name in names:
            run(["ip", "netns", "add", name]); created.append(name)
            ns(name, "ip", "link", "set", "lo", "up")
        links = [(server_ns, "10.201.1.2/24", router_a, "10.201.1.1/24"),
                 (router_a, "11.201.0.1/24", internet, "11.201.0.254/24"),
                 (internet, "11.202.0.254/24", router_b, "11.202.0.1/24"),
                 (router_b, "10.202.1.1/24", client_ns, "10.202.1.2/24")]
        for index, (left, left_ip, right, right_ip) in enumerate(links):
            a, b = f"{prefix}v{index}a", f"{prefix}v{index}b"
            run(["ip", "link", "add", a, "type", "veth", "peer", "name", b])
            run(["ip", "link", "set", a, "netns", left]); run(["ip", "link", "set", b, "netns", right])
            for name, interface, address in ((left, a, left_ip), (right, b, right_ip)):
                ns(name, "ip", "address", "add", address, "dev", interface)
                ns(name, "ip", "link", "set", interface, "up")
        for name, gateway in ((server_ns, "10.201.1.1"), (client_ns, "10.202.1.1"),
                              (router_a, "11.201.0.254"), (router_b, "11.202.0.254")):
            ns(name, "ip", "route", "add", "default", "via", gateway)
        ns(internet, "ip", "address", "add", "192.0.2.1/32", "dev", "lo")
        ns(internet, "sysctl", "-qw", "net.ipv4.icmp_echo_ignore_all=1")
        for name in (router_a, internet, router_b):
            ns(name, "sysctl", "-qw", "net.ipv4.ip_forward=1")
        for name, subnet, public in ((router_a, "10.201.1.0/24", "11.201.0.1"),
                                     (router_b, "10.202.1.0/24", "11.202.0.1")):
            ns(name, "iptables", "-P", "FORWARD", "DROP")
            # Unmapped inbound UDP is dropped, not accepted by the router's
            # own host stack. Sending port-unreachable replies would confirm
            # competing conntrack tuples and can force source-port rewriting.
            ns(name, "iptables", "-P", "INPUT", "DROP")
            ns(name, "iptables", "-A", "FORWARD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
            ns(name, "iptables", "-A", "FORWARD", "-s", subnet, "-j", "ACCEPT")
            ns(name, "iptables", "-t", "nat", "-A", "POSTROUTING", "-s", subnet, "-j", "SNAT", "--to-source", public)
        capture = open(directory / "transit.log", "w")
        packet_capture = subprocess.Popen(["ip", "netns", "exec", internet, "tcpdump", "-n", "-l", "-i", "any", "icmp or udp port 38149"], stdout=capture, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(packet_capture)
        environment = os.environ.copy()
        for kind in ("CONFIG", "DATA", "CACHE"):
            path = directory / kind.lower(); path.mkdir(); os.chown(path, user.pw_uid, user.pw_gid)
            environment[f"AMBRA_{kind}_DIR"] = str(path)
        environment["RUST_LOG"] = "ambra_net=info"
        environment.pop("AMBRA_SERVER_ADDRESS", None)
        config = {"id": "pwnat-lab", "name": "pwnat NAT lab", "bind": "0.0.0.0:45147", "securePort": 38149,
                  "discovery": False, "p2p": True, "pwnat": True, "publicEndpoint": "11.201.0.1:38149", "pairedClients": []}
        config_path = directory / "config/server.json"
        config_path.write_text(json.dumps(config)); os.chown(config_path, user.pw_uid, user.pw_gid); config_path.chmod(0o600)
        server_log = open(directory / "server.log", "w")
        server = subprocess.Popen(user_command(server_ns, HELPER, SERVER, "serve"), env=environment, stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(server)
        cli = lambda *args: run(user_command(server_ns, SERVER, *args), env=environment).stdout
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if server.poll() is not None: raise RuntimeError((directory / "server.log").read_text())
            try:
                status = json.loads(cli("network", "status"))
                if status["pwnatStatus"]["running"]: break
            except (subprocess.CalledProcessError, json.JSONDecodeError): pass
            time.sleep(0.1)
        else: raise RuntimeError("pwnat listener did not start")
        key = cli("network", "identity").strip()
        probe = EXAMPLES / "pwnat_probe"
        # Linux conntrack classifies the fabricated client error as INVALID and
        # does not SNAT it. First prove that unsupported NAT fails safely.
        strict = subprocess.run(user_command(client_ns, HELPER, probe, "connect", "11.201.0.1:38149", key), env=environment, capture_output=True, text=True, timeout=12)
        (directory / "strict-client-nat.log").write_text(strict.stdout + strict.stderr)
        assert strict.returncode != 0 and "timed out" in strict.stderr, strict.stderr
        print("PASS strict client conntrack NAT is unsupported and times out", flush=True)
        # Model a NAT that translates outbound ICMP errors. This explicit lab
        # rule is NOT installed on the host and is NOT evidence that real CPEs
        # or Linux conntrack provide this behavior by default.
        ns(router_b, "nft", "add", "table", "ip", "pwnatlab")
        ns(router_b, "nft", "add", "chain", "ip", "pwnatlab", "postrouting", "{ type filter hook postrouting priority mangle; }")
        ns(router_b, "nft", "add", "rule", "ip", "pwnatlab", "postrouting", "ip", "saddr", "10.202.1.2", "icmp", "type", "time-exceeded", "ip", "saddr", "set", "11.202.0.1")
        ns(router_a, "iptables", "-I", "FORWARD", "1", "-p", "icmp", "--icmp-type", "time-exceeded", "-j", "DROP")
        blocked = subprocess.run(user_command(client_ns, HELPER, probe, "connect", "11.201.0.1:38149", key), env=environment, capture_output=True, text=True, timeout=12)
        (directory / "blocked.log").write_text(blocked.stdout + blocked.stderr)
        assert blocked.returncode != 0 and "timed out" in blocked.stderr, blocked.stderr
        print("PASS blocked ICMP times out; server remains healthy", flush=True)
        assert json.loads(cli("network", "status"))["pwnatStatus"]["running"]
        rules = ns(router_a, "iptables", "-L", "FORWARD", "-v", "-n", "-x")
        drop_rows = [line.split() for line in rules.splitlines() if "DROP" in line and "icmp" in line]
        assert any(int(row[0]) > 0 for row in drop_rows), "The blocking rule must see actual ICMP packets"
        ns(router_a, "iptables", "-D", "FORWARD", "-p", "icmp", "--icmp-type", "time-exceeded", "-j", "DROP")
        payload = {"version": 1, "publicKey": key, "name": "pwnat NAT lab", "localAddresses": [], "publicEndpoint": "11.201.0.1:38149"}
        link = "ambra://pair/" + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        audio = directory / "tone.wav"
        with wave.open(str(audio), "wb") as output:
            output.setnchannels(2); output.setsampwidth(2); output.setframerate(44100)
            output.writeframes(b"".join(struct.pack("<hh", *([int(5000 * math.sin(2 * math.pi * 440 * i / 44100))] * 2)) for i in range(44100 * 8)))
        audio.chmod(0o644)
        file_id = hashlib.sha256(audio.read_bytes()).hexdigest() + ".wav"
        errors = open(directory / "client.log", "w")
        client = subprocess.Popen(user_command(client_ns, HELPER, EXAMPLES / "pairing_probe", link, file_id,
                                               "--pwnat-only", "--audio-file", audio, "--control"),
                                  env=environment, stdin=subprocess.PIPE, stdout=open(directory / "probe-output.log", "w"), stderr=errors,
                                  text=True, start_new_session=True)
        processes.append(client)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            lines = (directory / "probe-output.log").read_text().splitlines()
            if lines and lines[0].startswith("CODE "): break
            if client.poll() is not None: raise RuntimeError((directory / "client.log").read_text())
            time.sleep(0.1)
        else: raise RuntimeError("Client did not produce a pairing code")
        cli("pair", "approve", lines[0].split()[1])
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            lines = (directory / "probe-output.log").read_text().splitlines()
            if "READY" in lines: break
            if client.poll() is not None: raise RuntimeError((directory / "client.log").read_text())
            time.sleep(0.1)
        else: raise RuntimeError("Pairing/streaming did not complete")
        client.communicate("rebind\nping\nstream\nstatus\nquit\n", timeout=25)
        transcript = (directory / "probe-output.log").read_text().splitlines()
        assert client.returncode == 0, (directory / "client.log").read_text()
        assert "PING ok" in transcript and sum(line.startswith("STREAM ok") for line in transcript) == 2, transcript
        assert any('"method":"Pwnat"' in line for line in transcript), transcript
        print("\n".join(transcript), flush=True)
        cli("stop"); server.wait(timeout=8)
        os.killpg(packet_capture.pid, signal.SIGINT); packet_capture.wait(timeout=5); capture.close()
        traffic = (directory / "transit.log").read_text()
        logs = (directory / "server.log").read_text()
        assert "time exceeded" in traffic.lower() and "validated ICMP quotation" in logs, "Missing ICMP path proof"
        assert "11.201.0.1.38149" in traffic and "11.202.0.1.38149" in traffic, "Missing public UDP tuple"
        assert "pwnat accepted authenticated direct QUIC/Noise" in logs
        print("PASS compatible simulated NATs (explicit ICMP translation): ICMP quotation, QUIC/Noise, pairing, exact WAV/range, reconnect; no LAN/DHT/Tailscale data", flush=True)
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); process.wait()
        for name in reversed(created):
            subprocess.run(["ip", "netns", "delete", name], check=False, capture_output=True)


if __name__ == "__main__":
    main()
