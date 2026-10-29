#!/usr/bin/env python3
"""Bounded, byte-exact native transport benchmark; SSH is administration only.

Use --loopback for the encrypted LAN stack on localhost, or --host for physical
HyperDHT/UDX. Public endpoints and non-overlay routes must verify on both peers.
No production identity, provider credentials, or server profile is used.
"""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--host", help="SSH management destination; never the data endpoint")
    mode.add_argument("--loopback", action="store_true")
    parser.add_argument("--server", required=True, help="Absolute fixture executable path on its machine")
    parser.add_argument("--reference-node", help="Test-only Node executable for throughput-reference.cjs on the SSH host")
    parser.add_argument("--clients", type=Path, required=True, help="Directory containing connection_bench and streaming_bench")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--parallel", type=int, choices=range(1, 9), default=1)
    parser.add_argument("--rounds", type=int, choices=range(1, 31), default=5)
    parser.add_argument("--seconds", type=int, choices=range(1, 121), default=90)
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    directory = args.output.resolve()
    server = None
    local = None
    report = {"schema": 1, "started_unix_ms": int(time.time() * 1000), "ok": False,
              "mode": "loopback_lan_noise_http2" if args.loopback else "physical_hyperdht_udx",
              "physical_path_verified": False, "reference_native_server": bool(args.reference_node), "commands": [],
              "workload": {"rounds": args.rounds, "parallel": args.parallel, "seconds": args.seconds},
              "client_sha256": {name: hashlib.sha256((args.clients / name).read_bytes()).hexdigest()
                                for name in ("connection_bench", "streaming_bench")}}
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.host or ""]

    def remote(code, timeout=30):
        return subprocess.check_output(ssh + ["python3 -"], input=code, text=True, timeout=timeout)

    try:
        environment = dict(os.environ, RUST_LOG=os.environ.get("RUST_LOG", "ambra_net=debug,peeroxide_dht::hyperdht=info"))
        if args.loopback:
            report["server_sha256"] = hashlib.sha256(Path(args.server).read_bytes()).hexdigest()
            log = (directory / "server.log").open("w")
            local = subprocess.Popen([args.server, "--loopback"], env=environment, stdout=log,
                                     stderr=log, stdin=subprocess.DEVNULL)
            deadline = time.monotonic() + 10
            while True:
                text = (directory / "server.log").read_text()
                if "ADDRESS " in text: break
                if local.poll() is not None or time.monotonic() >= deadline: raise RuntimeError("Loopback server did not start")
                time.sleep(.1)
            key = re.search(r"^KEY ([0-9a-f]{64})$", text, re.M)[1]
            address = re.search(r"^ADDRESS (.+)$", text, re.M)[1]
            options = ["--lan", address]
        else:
            code = '''import hashlib,json,os,pathlib,subprocess,tempfile,time
binary=BINARY
node=NODE
directory=pathlib.Path(tempfile.mkdtemp(prefix='ambra-benchmark-'))
log=open(directory/'server.log','w')
p=subprocess.Popen([node,binary] if node else [binary],env=dict(os.environ,RUST_LOG=LOG_FILTER),stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
try:
 for _ in range(90):
  text=(directory/'server.log').read_text()
  if 'ANNOUNCED' in text or node and any(line.startswith('KEY ') for line in text.splitlines()):
   key=next(line.split()[1] for line in text.splitlines() if line.startswith('KEY '))
   print(json.dumps({'key':key,'pid':p.pid,'directory':str(directory),'binary':node or binary,'sha256':hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest()}));break
  if p.poll() is not None:raise RuntimeError('Fixture exited: '+str(directory))
  time.sleep(1)
 else:raise RuntimeError('Fixture did not announce: '+str(directory))
except BaseException:
 p.terminate();p.wait(timeout=10);raise
'''.replace("BINARY", repr(args.server)).replace("NODE", repr(args.reference_node)).replace("LOG_FILTER", repr(environment["RUST_LOG"]))
            server = json.loads(remote(code, timeout=100))
            key = server["key"]
            options = []
            report["server_directory"] = server["directory"]
            report["server_sha256"] = server["sha256"]
        commands = [("connection_bench", [key, str(args.rounds), str(args.parallel), *options], args.rounds * 46 + 15),
                    ("streaming_bench", [key, str(args.seconds), *options], args.seconds + 95)]
        for name, words, timeout in commands:
            start = time.monotonic()
            with (directory / (name + ".jsonl")).open("w") as out, (directory / (name + ".log")).open("w") as err:
                result = subprocess.run([str(args.clients.resolve() / name), *words], env=environment,
                                        stdout=out, stderr=err, timeout=timeout)
            rows = [json.loads(line) for line in (directory / (name + ".jsonl")).read_text().splitlines()]
            report["commands"].append({"name": name, "exit_code": result.returncode,
                                       "elapsed_seconds": time.monotonic() - start, "results": rows})
        if not args.loopback:
            # The selected method alone cannot prove the OS avoided a VPN.
            text = "\n".join((directory / (name + ".log")).read_text() for name, _, _ in commands)
            text = re.sub(r"\x1b\[[0-9;]*m", "", text)
            addresses = re.findall(r"authenticated direct.*?endpoint=(?:Some\()?([0-9.]+):", text)
            if not addresses or not all(ipaddress.ip_address(ip).is_global for ip in addresses):
                raise RuntimeError("Missing public authenticated client endpoint")
            spec = importlib.util.spec_from_file_location("udp_peer", ROOT / "scripts/pwnat/udp-peer.py")
            routes = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(routes)
            report["client_interfaces"] = sorted({routes.route(ip) for ip in addresses})
            code = '''import ipaddress,json,pathlib,re,subprocess
text=re.sub(r'\\x1b\\[[0-9;]*m','',pathlib.Path(LOG).read_text())
addresses=re.findall(r'accepted authenticated direct.*?endpoint=([0-9.]+):',text)
for line in text.splitlines():
 try:
  value=json.loads(line)
  if value.get('event')=='direct' and value.get('remoteHost'):addresses.append(value['remoteHost'])
 except ValueError:pass
if not addresses:raise RuntimeError('Missing server endpoint evidence')
interfaces=set()
for ip in addresses:
 if not ipaddress.ip_address(ip).is_global:raise RuntimeError('Nonpublic server endpoint')
 name=json.loads(subprocess.check_output(['ip','-j','route','get',ip],text=True,timeout=5))[0]['dev']
 if name.startswith(('utun','tun','tap','tailscale','wg','ipsec','ppp','lo')):raise RuntimeError('Overlay data route')
 interfaces.add(name)
print(json.dumps(sorted(interfaces)))
'''.replace("LOG", repr(server["directory"] + "/server.log"))
            report["server_interfaces"] = json.loads(remote(code))
            report["physical_path_verified"] = True
        connection, streaming = report["commands"]
        report["ok"] = (all(command["exit_code"] == 0 for command in report["commands"])
                        and len(connection["results"]) == args.rounds * args.parallel
                        and all(row["ok"] for row in connection["results"])
                        and len(streaming["results"]) == 1
                        and streaming["results"][0]["result"] == "Ok(Ok(()))"
                        and streaming["results"][0]["poll_error"] is None)
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        if local is not None:
            if local.poll() is None: local.send_signal(signal.SIGINT)
            try: local.wait(timeout=10)
            except subprocess.TimeoutExpired: local.kill(); local.wait(timeout=5)
        if server is not None:
            try:
                code = '''import os,pathlib,signal
pid=PID
try:
 command=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\\0')[0].decode()
 if command != BINARY:raise RuntimeError('Refusing to signal a reused PID')
 os.kill(pid,signal.SIGINT)
except FileNotFoundError:pass
print(pathlib.Path(LOG).read_text())
'''.replace("PID", repr(server["pid"])).replace("BINARY", repr(server["binary"])).replace("LOG", repr(server["directory"] + "/server.log"))
                (directory / "server.log").write_text(remote(code))
            except Exception as error:
                report["cleanup_error"] = str(error)
                report["ok"] = False
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"ok": report["ok"], "mode": report["mode"], "report": str(directory / "report.json"),
                          "error": report.get("error"), "cleanup_error": report.get("cleanup_error")}))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
