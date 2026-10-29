#!/usr/bin/env python3
"""Experimental physical TCP fixture harness for macOS and a Linux SSH peer.

SSH manages processes only. The fixture data uses a separate public TCP socket.
The harness controls WARP/Tailscale, exchanges candidates atomically, retains
private evidence, and leaves WARP disconnected with Tailscale enabled. Password
files must come from a private credential prompt, never from this repository.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--local-bind", required=True)
    parser.add_argument("--remote-bind", required=True)
    parser.add_argument("--client", required=True, type=Path)
    parser.add_argument("--remote-fixture", required=True)
    parser.add_argument("--remote-sudo-file", required=True, type=Path)
    parser.add_argument("--local-sudo-file", type=Path, help="Enable physical packet captures")
    parser.add_argument("--mode", choices=["native", "warp", "management"], default="native")
    parser.add_argument("--payload", choices=["tls", "noise"], default="tls")
    parser.add_argument("--passive", action="store_true")
    parser.add_argument("--mac-port", type=int, default=48504)
    parser.add_argument("--remote-port", type=int, default=443)
    parser.add_argument("--seconds", type=int, default=30)
    args = parser.parse_args()
    if not 1024 <= args.mac_port <= 65535 or not 1 <= args.seconds <= 120:
        parser.error("Use an unprivileged Mac port and 1..120 seconds")
    if args.remote_port != 443 and not 1024 <= args.remote_port <= 65535:
        parser.error("Remote port must be 443 or unprivileged")
    for value in [args.local_bind, args.remote_bind]:
        address = ipaddress.IPv4Address(value)
        if address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10"):
            parser.error("Select physical IPv4 bind addresses")
    for path in [args.remote_sudo_file, args.local_sudo_file]:
        if path and path.stat().st_mode & 0o077:
            parser.error("Password files must be private")
    if args.host.startswith("-") or not args.client.is_file():
        parser.error("Invalid SSH host or missing fixture client")
    os.umask(0o077)
    directory = Path(tempfile.mkdtemp(prefix="ambra-tcp-"))
    scripts = Path(__file__).resolve().parent
    remote_directory = None
    remote_pids = []
    local_processes = []
    local_capture = None
    remote_capture = None
    manifest = {"mode": args.mode, "payload": args.payload, "passive": args.passive,
                "mac_port": args.mac_port, "remote_port": args.remote_port, "seconds_requested": args.seconds,
                "initial_warp": subprocess.check_output(["warp-cli", "status"], text=True)}

    def command(argv, **kwargs):
        return subprocess.run(argv, check=True, timeout=25, **kwargs)

    def ssh(text, data=None):
        return subprocess.check_output(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", args.host, text], input=data, text=True, timeout=25)

    def remote_sudo(text):
        password = args.remote_sudo_file.read_bytes().rstrip(b"\r\n") + b"\n"
        result = subprocess.run(["ssh", "-o", "BatchMode=yes", args.host,
                                 "sudo -S -p '' sh -c " + shlex.quote(text)],
                                input=password, capture_output=True, timeout=25)
        if result.returncode:
            raise RuntimeError(result.stderr.decode())
        return result.stdout.decode().strip()

    def management():
        command(["warp-cli", "disconnect"], stdout=subprocess.DEVNULL)
        command(["tailscale", "up"], stdout=subprocess.DEVNULL)
        # SSH is attempted only after the client reports a running backend.
        state = json.loads(subprocess.check_output(["tailscale", "status", "--json"], text=True))
        if state.get("BackendState") != "Running":
            raise RuntimeError("Tailscale management is not running")

    def warp():
        command(["tailscale", "down"], stdout=subprocess.DEVNULL)
        command(["warp-cli", "connect"], stdout=subprocess.DEVNULL)
        for _ in range(25):
            if "Connected" in subprocess.check_output(["warp-cli", "status"], text=True):
                return
            time.sleep(1)
        raise TimeoutError("WARP did not connect")

    def start_remote(argv, name, privileged=False):
        shell = "nohup " + shlex.join(argv) + " < /dev/null > " + shlex.quote(remote_directory + "/" + name + ".log") + " 2>&1 & echo $!"
        pid = int(remote_sudo(shell) if privileged else ssh(shell).strip())
        remote_pids.append(pid)
        return pid

    def start_local(argv, name, privileged=False):
        output = (directory / (name + ".log")).open("w")
        process = subprocess.Popen((["sudo", "-S", "-p", ""] if privileged else []) + argv,
                                   stdin=args.local_sudo_file.open("rb") if privileged else subprocess.DEVNULL,
                                   stdout=output, stderr=output, start_new_session=True)
        local_processes.append(process)
        return process

    def wait_local(path, deadline):
        while time.time() < deadline:
            if path.exists():
                return json.loads(path.read_text())
            time.sleep(.1)
        raise TimeoutError("Local candidate preparation failed")

    try:
        management()
        remote_directory = ssh("umask 077; mktemp -d /tmp/ambra-tcp-XXXXXXXX").strip()
        remote_user = ssh("id -un").strip()
        manifest["remote_directory"] = remote_directory
        key = directory / "key.json"
        key.write_text(json.dumps({"key": os.urandom(32).hex()}))
        command(["scp", "-q", str(key), *[str(scripts / name) for name in ["path_probe.py", "tcp_punch.py", "tcp443-launch.py"]], args.host + ":" + remote_directory + "/"])
        ssh("umask 077; openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -noenc -keyout " + shlex.quote(remote_directory + "/tls-key.pem") + " -out " + shlex.quote(remote_directory + "/tls-cert.pem") + " -days 1 -subj /CN=ambra-path -addext subjectAltName=DNS:ambra-path > " + shlex.quote(remote_directory + "/certificate.log") + " 2>&1")
        command(["scp", "-q", args.host + ":" + remote_directory + "/tls-cert.pem", str(directory / "tls-cert.pem")])
        start_remote([args.remote_fixture, "--loopback"], "fixture")
        deadline = time.time() + 15
        while True:
            text = ssh("cat " + shlex.quote(remote_directory + "/fixture.log"))
            if "ADDRESS " in text:
                break
            if time.time() > deadline:
                raise TimeoutError("Remote fixture did not listen")
            time.sleep(.2)
        fixture_key = next(line.split()[1] for line in text.splitlines() if line.startswith("KEY "))
        fixture_address = next(line.split()[1] for line in text.splitlines() if line.startswith("ADDRESS "))
        start = time.time() + (100 if args.mode == "warp" else 35)
        server = (["/usr/bin/python3", remote_directory + "/tcp443-launch.py", args.remote_bind] if args.remote_port == 443 else []) + [
                  "/usr/bin/python3", remote_directory + "/tcp_punch.py", "--config", remote_directory + "/key.json",
                  "--output", remote_directory + "/probe", "--bind", args.remote_bind, "--port", str(args.remote_port),
                  "--seconds", "240", "--start-at", str(start), "--forward", fixture_address]
        server += ["--tls", "server", "--certificate", remote_directory + "/tls-cert.pem", "--private-key", remote_directory + "/tls-key.pem"] if args.payload == "tls" else ["--stream-role", "server"]
        if args.passive:
            server.append("--passive")
        start_remote(server, "server", args.remote_port == 443)
        if args.mode == "warp":
            warp()
        client = [os.sys.executable, str(scripts / "tcp_punch.py"), "--config", str(key), "--output", str(directory / "probe"),
                  "--bind", "0.0.0.0" if args.mode == "warp" else args.local_bind, "--port", str(args.mac_port),
                  "--seconds", "240", "--start-at", str(start), "--listen", "127.0.0.1:48510"]
        client += ["--tls", "client", "--certificate", str(directory / "tls-cert.pem")] if args.payload == "tls" else ["--stream-role", "client"]
        start_local(client, "client")
        candidate = wait_local(directory / "probe/ready.json", time.time() + 15)
        if args.mode == "warp":
            # Keep the candidate socket alive; exchange signaling through SSH.
            # WARP can change mappings on reconnect, so failures need this caveat.
            management()
            manifest["warp_candidate_reconnect_caveat"] = True
        peer = json.loads(ssh("cat " + shlex.quote(remote_directory + "/probe/ready.json")))
        (directory / "probe/peers.json").write_text(json.dumps(peer))
        target = remote_directory + "/probe/peers.json"
        ssh("cat > " + shlex.quote(target + ".tmp") + " && mv " + shlex.quote(target + ".tmp") + " " + shlex.quote(target), json.dumps(candidate))
        manifest.update(local_candidate=candidate, remote_candidate=peer, server_key=fixture_key,
                        remote_route=ssh("ip route get " + shlex.quote(candidate[0])))
        if args.local_sudo_file:
            expression = "tcp port " + str(args.remote_port) + " and host " + candidate[0]
            remote_capture = start_remote(["timeout", "240", "tcpdump", "-i", "any", "-nn", "-U", "-s", "192", "-c", "12000", "-Z", remote_user, "-w", remote_directory + "/physical.pcap", expression], "capture", True)
            local_capture = start_local(["/usr/sbin/tcpdump", "-i", "en0", "-nn", "-U", "-s", "192", "-c", "12000", "-w", str(directory / "physical.pcap"), "tcp port " + str(args.remote_port) + " and host " + peer[0]], "capture", True)
        sampler = "import subprocess,time\nfor _ in range(240):\n print('UNIX',time.time(),flush=True);subprocess.run(['ss','-tin','( sport = :" + str(args.remote_port) + " )']);time.sleep(1)"
        start_remote(["/usr/bin/python3", "-u", "-c", sampler], "tcp-info")
        if args.mode == "warp":
            warp()
        elif args.mode == "native":
            command(["tailscale", "down"], stdout=subprocess.DEVNULL)
        manifest.update(start_unix=time.time(), checks_start_unix=start,
                        warp_status=subprocess.check_output(["warp-cli", "status"], text=True),
                        tailscale_status=subprocess.run(["tailscale", "status"], capture_output=True, text=True).stdout,
                        route=subprocess.check_output(["route", "-n", "get", peer[0]], text=True))
        if args.mode == "warp":
            manifest["warp_stats"] = subprocess.check_output(["warp-cli", "tunnel", "stats"], text=True)
        if time.time() >= start - 2:
            raise TimeoutError("Preparation exceeded the scheduled start")
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
        while time.time() < start + 22:
            if "bridge_ready" in (directory / "probe/events.jsonl").read_text():
                break
            time.sleep(.1)
        else:
            raise TimeoutError("Peer stream did not authenticate")
        benchmark = start_local([str(args.client.resolve()), fixture_key, str(args.seconds), "--lan", "127.0.0.1:48510"], "benchmark")
        manifest["benchmark_exit"] = benchmark.wait(timeout=args.seconds + 55)
        manifest["end_unix"] = time.time()
        manifest["end_warp_status"] = subprocess.check_output(["warp-cli", "status"], text=True)
        manifest["end_tailscale_status"] = subprocess.run(["tailscale", "status"], capture_output=True, text=True).stdout
    except Exception as error:
        manifest["error"] = repr(error)
        manifest["end_unix"] = time.time()
        raise
    finally:
        management()
        for process in local_processes:
            if process.poll() is None and process is not local_capture:
                process.terminate()
        if local_capture and local_capture.poll() is None:
            # sudo can retain a monitor process. Signal the isolated session,
            # including the actual root capture child, rather than just sudo.
            command(["sudo", "-S", "-p", "", "/usr/bin/python3", "-c",
                     "import os,signal,sys; os.killpg(int(sys.argv[1]),signal.SIGINT)", str(local_capture.pid)],
                    stdin=args.local_sudo_file.open("rb"), stdout=subprocess.DEVNULL)
        if remote_directory:
            if remote_capture:
                remote_sudo("kill -INT " + str(remote_capture) + " 2>/dev/null || true")
            ssh("kill " + " ".join(map(str, [pid for pid in remote_pids if pid != remote_capture])) + " 2>/dev/null || true")
            command(["scp", "-qr", args.host + ":" + remote_directory + "/", str(directory / "remote")])
        manifest["final_state"] = "Tailscale enabled; WARP disconnected"
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(json.dumps({"evidence_directory": str(directory), "manifest": manifest}))


if __name__ == "__main__":
    main()
