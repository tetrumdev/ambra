#!/usr/bin/env python3
"""Bounded, headless physical pairing/audio/reconnect test using an isolated server.

SSH carries only administration and pairing approval. Audio uses the selected
native transport. Requires already-built, compatible server/probe executables.
The optional ICMP launcher must supply the descriptor for pwnat-only tests.
Artifacts are private; no existing server, profile, or network setting is changed.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import queue
import re
import shlex
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("--remote-root", default="/home/llewyn/ambra")
    parser.add_argument("--probe", type=Path)
    parser.add_argument("--transport", choices=("hyperdht", "pwnat"), default="hyperdht")
    parser.add_argument("--rounds", type=int, choices=range(0, 21), default=5)
    parser.add_argument("--audio-seconds", type=int, choices=range(1, 121), default=12)
    parser.add_argument("--desktop-binary",type=Path,help="Also play the fixture in an isolated real debug Desktop")
    parser.add_argument("--playback-seconds",type=int,choices=range(5,91),default=30)
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise SystemExit("Run unprivileged. The ICMP launcher drops privileges first.")
    root = Path(__file__).resolve().parents[2]
    probe = args.probe or root / "crates/ambra-net/target/debug/examples/pairing_probe"
    directory = Path(tempfile.mkdtemp(prefix="ambra-physical-"))
    print("ARTIFACTS", directory, flush=True)
    report = {"schema": 1, "transport": args.transport, "physical_test_attempted": False, "physical_path_verified": False,
              "started_unix_ms": int(time.time()*1000), "rounds": [], "ok": False}
    descriptor = None
    if args.transport == "pwnat":
        try:
            descriptor = int(os.environ["AMBRA_PWNAT_ICMP_FD"])
            os.fstat(descriptor)
        except (KeyError,ValueError,OSError):
            report["failure_stage"]="icmp_descriptor"
            report["error"]="Missing valid inherited ICMP descriptor; launch through the one-shot icmp-launch helper."
            (directory/"report.json").write_text(json.dumps(report,indent=2)+"\n")
            print(json.dumps(report),flush=True)
            return 1
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.host]

    def remote_python(code, timeout=25):
        return json.loads(subprocess.check_output(ssh + ["python3 -"], input=code, text=True, timeout=timeout))

    def cli(*words):
        assignments = [f"AMBRA_{kind}_DIR={server['directory']}/{kind.lower()}" for kind in ("CONFIG", "DATA", "CACHE")]
        command = ["env", *assignments, str(Path(args.remote_root)/"server/target/debug/ambra-server"), *words]
        return subprocess.check_output(ssh+[shlex.join(command)],text=True,timeout=20)

    server = None
    process = None
    desktop = None
    transcript = []
    started = time.monotonic()
    try:
        # Launch a separate process with private identity, storage, and loopback administration.
        # A pre-existing user server and its installed executable remain untouched.
        server = remote_python("""
import json,os,pathlib,subprocess,tempfile,time,urllib.request
root=pathlib.Path(ROOT)
directory=pathlib.Path(tempfile.mkdtemp(prefix='ambra-physical-server-'))
environment=os.environ.copy(); environment.pop('AMBRA_SERVER_ADDRESS',None)
for kind in ('CONFIG','DATA','CACHE'):
    path=directory/kind.lower();path.mkdir();environment['AMBRA_'+kind+'_DIR']=str(path)
environment['RUST_LOG']='ambra_net=info,peeroxide_dht::hyperdht=info'
config={'id':'physical-test','name':'Isolated physical test','bind':'0.0.0.0:0',
        'securePort':48489,'discovery':False,'p2p':True,'pwnat':PWNAT,'pairedClients':[]}
path=directory/'config/server.json';path.write_text(json.dumps(config));path.chmod(0o600)
command=[str(root/'server/target/debug/ambra-server'),'serve']
if PWNAT: command.insert(0,'/usr/local/libexec/ambra-icmp-launch')
# The test server also expires if this administration connection disappears.
command=['/usr/bin/timeout','--signal=INT','600',*command]
log=open(directory/'server.log','w')
process=subprocess.Popen(command,env=environment,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
(directory/'pid').write_text(str(process.pid))
runtime=directory/'data/server-runtime.json'
try:
    deadline=time.monotonic()+85
    while time.monotonic()<deadline:
        if process.poll() is not None: raise RuntimeError('Isolated server exited; inspect '+str(directory/'server.log'))
        if runtime.exists():
            port=json.loads(runtime.read_text())['address'].rsplit(':',1)[1]
            base='http://127.0.0.1:'+port
            try:
                status=json.loads(subprocess.check_output([str(root/'server/target/debug/ambra-server'),'network','status'],env=environment,text=True,timeout=10))
                ready=status.get('pwnatStatus',{}).get('publicEndpoint') if PWNAT else status.get('hyperdht',{}).get('announced')
                if ready:
                    with urllib.request.urlopen(base+'/api/local/pairing/qr',timeout=5) as response: pairing=json.load(response)
                    print(json.dumps({'directory':str(directory),'pid':process.pid,'pairing':pairing,'status':status}));break
            except (OSError,subprocess.SubprocessError): pass
        time.sleep(.5)
    else: raise RuntimeError('Isolated server readiness timed out; inspect '+str(directory/'server.log'))
except BaseException:
    process.terminate();process.wait(timeout=10);raise
""".replace("ROOT", repr(args.remote_root)).replace("PWNAT", repr(args.transport == "pwnat")), timeout=100)
        report["server_directory"] = server["directory"]
        key = server["pairing"]["publicKey"]
        payload = {"version": 1, "publicKey": key, "name": "Physical test", "localAddresses": [],
                   "publicEndpoint": server["status"].get("pwnatStatus", {}).get("publicEndpoint")}
        link = "ambra://pair/" + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        audio = directory / "tone.wav"
        # Valid stereo PCM WAV, deterministic exact-byte checks; no provider credentials.
        import math
        frames = b"".join(struct.pack("<hh", int(3000*math.sin(i*2*math.pi*440/44100)),
                                     int(3000*math.sin(i*2*math.pi*440/44100))) for i in range(44100))
        with wave.open(str(audio), "wb") as output:
            output.setparams((2, 2, 44100, 0, "NONE", "not compressed"))
            for _ in range(args.audio_seconds): output.writeframesraw(frames)
        expected = audio.read_bytes()
        file_id = hashlib.sha256(expected).hexdigest()+".wav"
        environment = os.environ.copy()
        environment["RUST_LOG"] = "ambra_net=debug,peeroxide_dht::hyperdht=info"
        command = [str(probe), link, file_id, "--audio-file", str(audio), "--control"]
        desktop_data = directory/"desktop"
        if args.desktop_binary:
            desktop_data.mkdir()
            command += ["--desktop-data",str(desktop_data),"--publish-fixture","--duration-seconds",str(args.audio_seconds)]
        if args.transport == "pwnat": command.append("--pwnat-only")
        errors = (directory / "client.log").open("w")
        process = subprocess.Popen(command, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=errors, env=environment,
                                   pass_fds=() if descriptor is None else (descriptor,))
        report["physical_test_attempted"]=True
        resources=[]
        def sample_resources():
            while process.poll() is None:
                try:
                    row=subprocess.check_output(["ps","-o","rss=,pcpu=","-p",str(process.pid)],text=True,timeout=3).split()
                    if len(row)==2:resources.append({"rss_kib":int(row[0]),"cpu_percent":float(row[1])})
                except (OSError,ValueError,subprocess.SubprocessError):pass
                time.sleep(1)
        threading.Thread(target=sample_resources,daemon=True).start()
        lines = queue.Queue()
        def read_lines():
            for line in process.stdout: lines.put(line.rstrip())
            lines.put(None)
        threading.Thread(target=read_lines, daemon=True).start()

        def wait_line(predicate, timeout):
            deadline = time.monotonic()+timeout
            while time.monotonic()<deadline:
                try: line = lines.get(timeout=max(.01, deadline-time.monotonic()))
                except queue.Empty: break
                if line is None: raise RuntimeError("Probe exited; inspect private client.log")
                transcript.append(line)
                if predicate(line): return line
            raise TimeoutError("Probe stage deadline expired; inspect private client.log")

        connect_start = time.monotonic()
        code = wait_line(lambda l:l.startswith("CODE "), 95)
        report["first_pair_request_ms"] = (time.monotonic()-connect_start)*1000
        cli("pair", "approve", code.split()[1])
        wait_line(lambda l:l == "READY", 120)
        expected_method = "HyperDHT" if args.transport == "hyperdht" else "Pwnat"
        selected = [json.loads(l.removeprefix("TRANSPORT ")) for l in transcript if l.startswith("TRANSPORT ")]
        assert selected and selected[0]["method"] == expected_method, "Refusing accidental LAN/overlay success"
        report["first_ready_ms"] = (time.monotonic()-connect_start)*1000
        for round_number in range(args.rounds):
            start = time.monotonic()
            process.stdin.write("rebind\nping\n"); process.stdin.flush()
            wait_line(lambda l:l.startswith("PING "), 95)
            reconnect_ms = (time.monotonic()-start)*1000
            assert transcript[-1] == "PING ok", "Authenticated reconnect failed"
            process.stdin.write("stream\nstatus\n"); process.stdin.flush()
            wait_line(lambda l:l.startswith("STATUS "), 120)
            assert json.loads(transcript[-1].removeprefix("STATUS "))["method"] == expected_method
            report["rounds"].append({"round":round_number,"ok":True,"reconnect_ms":reconnect_ms})
            print(json.dumps(report["rounds"][-1]),flush=True)
        process.stdin.write("quit\n"); process.stdin.flush(); process.wait(timeout=15)
        assert process.returncode == 0
        report["streams"] = [l for l in transcript if l.startswith("STREAM ")]
        report["metrics"] = [json.loads(l.removeprefix("METRIC ")) for l in transcript if l.startswith("METRIC ")]
        report["probe_resources"]={"peak_sampled_rss_kib":max((s["rss_kib"] for s in resources),default=None),
            "ps_cpu_percent_samples":[s["cpu_percent"] for s in resources],"samples":len(resources),"note":"OS-reported ps CPU percentages are platform dependent; RSS is sampled once per second"}
        assert len(report["streams"]) == args.rounds+1 and all(l.startswith("STREAM ok ") for l in report["streams"])
        # Method selection alone cannot prove the OS did not route through a VPN.
        # Check the route of each actual, authenticated public data endpoint.
        import importlib.util
        import ipaddress
        spec = importlib.util.spec_from_file_location("udp_peer",root/"scripts/pwnat/udp-peer.py")
        route_tools = importlib.util.module_from_spec(spec);spec.loader.exec_module(route_tools)
        addresses = re.findall(r"authenticated direct.*?endpoint=(?:Some\()?([0-9.]+):",(directory/"client.log").read_text())
        if not addresses: raise RuntimeError("Missing authenticated client endpoint evidence")
        if not all(ipaddress.ip_address(ip).is_global for ip in addresses):raise RuntimeError("Nonpublic client data endpoint")
        report["client_interfaces"] = sorted({route_tools.route(ip) for ip in addresses})
        report["server_interfaces"] = remote_python("""
import ipaddress,json,pathlib,re,subprocess
text=(pathlib.Path(DIRECTORY)/'server.log').read_text()
addresses=re.findall(r'accepted authenticated direct.*?endpoint=([0-9.]+):',text)
if not addresses: raise RuntimeError('Missing authenticated server endpoint evidence')
names=set()
for ip in addresses:
    if not ipaddress.ip_address(ip).is_global: raise RuntimeError('Nonpublic server data endpoint')
    name=json.loads(subprocess.check_output(['ip','-j','route','get',ip],text=True,timeout=5))[0]['dev']
    if name.startswith(('utun','tun','tap','tailscale','wg','ipsec','ppp','lo')): raise RuntimeError('Overlay data route')
    names.add(name)
print(json.dumps(sorted(names)))
""".replace("DIRECTORY",repr(server["directory"])))
        report["physical_path_verified"] = True
        if args.desktop_binary:
            desktop_env=environment.copy();desktop_env["AMBRA_DATA_DIR"]=str(desktop_data)
            desktop=subprocess.Popen([str(root/"desktop/src-tauri/scripts/run-signed.sh"),str(args.desktop_binary.resolve()),"--network-test-stdin"],
                env=desktop_env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(directory/"desktop.log").open("w"))
            desktop_lines=queue.Queue()
            def desktop_reader():
                for line in desktop.stdout:
                    try:
                        value=json.loads(line)
                        if value.get("networkTest"):desktop_lines.put(value)
                    except ValueError:pass
                desktop_lines.put(None)
            threading.Thread(target=desktop_reader,daemon=True).start()
            def desktop_command(action,**fields):
                desktop.stdin.write(json.dumps({"action":action,**fields})+"\n");desktop.stdin.flush()
                value=desktop_lines.get(timeout=95)
                if value is None or not value["ok"]:raise RuntimeError("Desktop command failed: "+str(value))
                return value["value"]
            desktop_command("tracks")
            desktop_command("useDefaultOutput")
            play_start=time.monotonic()
            desktop_command("playTrack",trackId="local:"+file_id.split('.')[0])
            samples=[]
            deadline=time.monotonic()+args.playback_seconds
            while time.monotonic()<deadline:
                status=desktop_command("status")
                samples.append({"elapsed_ms":(time.monotonic()-play_start)*1000,"status":status})
                if len(samples)==max(3,args.playback_seconds//4):desktop_command("reconnect")
                time.sleep(1)
            desktop_command("pause")
            desktop.stdin.write('{"action":"quit"}\n');desktop.stdin.flush();desktop.wait(timeout=15)
            report["desktop_samples"]=samples
            (directory/"desktop-samples.json").write_text(json.dumps(samples,indent=2)+"\n")
            native=[s["status"]["native"] for s in samples]
            playing=[s for s in native if s.get("isPlaying") and s.get("currentTime",0)>0]
            assert playing and max(s["currentTime"] for s in playing)>min(5,args.playback_seconds/3), "Native playback did not advance"
            assert not any(s.get("error") for s in native), "Native decoder/output reported an error"
            report["native_playback_progress_verified"]=True
            report["audible_output_measured"]=False
        report["ok"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        report["elapsed_seconds"] = time.monotonic()-started
        if process is not None and process.poll() is None:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill();process.wait(timeout=5)
        if desktop is not None and desktop.poll() is None:
            desktop.terminate()
            try:desktop.wait(timeout=10)
            except subprocess.TimeoutExpired:desktop.kill();desktop.wait(timeout=5)
        if server is not None:
            try:
                state = json.loads(cli("network","status"))
                report["server_pwnat_counters"] = {k:v for k,v in state.get("pwnatStatus",{}).items() if k in
                    ("icmpEchoSent","icmpErrors","icmpQuotationsAccepted","udpPunchesSent")}
            except (subprocess.SubprocessError,ValueError): pass
            # Only this invocation's isolated PID is signalled. User server is untouched.
            try:
                remote_python("""
import json,os,pathlib,signal
directory=pathlib.Path(DIRECTORY)
pid=int((directory/'pid').read_text())
try: os.kill(pid,signal.SIGTERM)
except ProcessLookupError: pass
print(json.dumps({'stopped':pid}))
""".replace("DIRECTORY",repr(server["directory"])))
                subprocess.run(ssh+["cat "+shlex.quote(server["directory"]+"/server.log")],stdout=(directory/"server.log").open("w"),timeout=20,check=True)
            except (OSError,subprocess.SubprocessError,ValueError) as error:
                report["cleanup_error"]=f"{type(error).__name__}: {error}"
                report["ok"]=False
        client_log=directory/"client.log"
        if client_log.exists():
            text=client_log.read_text()
            stages=re.findall(r'Native connection state state=(\w+)',text)
            if stages:report["last_client_state"]=stages[-1]
            failure=re.search(r'pwnat setup failed stage="(\w+)" icmp_requests=(\d+) elapsed_ms=(\d+)',text)
            if failure:report["pwnat_failure"]={"stage":failure[1],"icmp_requests":int(failure[2]),"elapsed_ms":int(failure[3])}
        (directory/"transcript.log").write_text("\n".join(transcript)+"\n")
        (directory/"report.json").write_text(json.dumps(report,indent=2)+"\n")
        print(json.dumps(report),flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
