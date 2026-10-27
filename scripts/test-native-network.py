#!/usr/bin/env python3
"""Run the real server and CLI in isolated storage; no user library or credentials are opened."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
server = root / "server/target/debug/ambra-server"
probe = root / "crates/ambra-net/target/debug/examples/pairing_probe"
with tempfile.TemporaryDirectory(prefix="ambra-network-integration-") as directory:
    environment = os.environ.copy()
    environment.pop("AMBRA_SERVER_ADDRESS", None)
    for kind in ("CONFIG", "DATA", "CACHE"):
        path = Path(directory) / kind.lower()
        path.mkdir()
        environment[f"AMBRA_{kind}_DIR"] = str(path)
    config_path = Path(directory) / "config/server.json"
    config_path.write_text(json.dumps({"id": "integration", "name": "Network integration", "bind": "0.0.0.0:0", "discovery": False, "p2p": False, "securePort": 0, "pairedClients": []}))
    log = open(Path(directory) / "server.log", "w+")
    process = subprocess.Popen([str(server), "serve"], env=environment, stdout=log, stderr=log)
    cli = lambda *args: subprocess.check_output([str(server), *args], env=environment, text=True)
    try:
        runtime = Path(directory) / "data/server-runtime.json"
        deadline = time.monotonic() + 15
        while not runtime.exists():
            if process.poll() is not None or time.monotonic() > deadline:
                log.seek(0)
                raise RuntimeError(log.read())
            time.sleep(0.05)
        port = int(json.loads(runtime.read_text())["address"].rsplit(":", 1)[1])
        base = f"http://127.0.0.1:{port}"
        for _ in range(100):
            status = json.loads(cli("network", "status"))
            if status["secureListening"]:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("Secure listener did not start")
        with urllib.request.urlopen(base + "/api/local/pairing/qr") as response:
            pairing = json.load(response)
        assert cli("network", "identity").strip() == pairing["publicKey"]
        assert "ambra://pair/" in cli("pair", "qr")
        synthetic = bytes(range(256)) * 781 + bytes(range(64))
        assert len(synthetic) == 200_000
        file_id = hashlib.sha256(synthetic).hexdigest() + ".flac"
        client = subprocess.Popen([str(probe), pairing["payload"], file_id], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        line = client.stdout.readline().strip()
        assert line.startswith("CODE "), (line, client.stderr.read())
        assert "Paired Native integration probe" in cli("pair", "approve", line.split()[1])
        output, errors = client.communicate(timeout=25)
        assert client.returncode == 0, errors
        print(output.strip())
        assert "native-integration" in cli("pair", "list")
        cli("pair", "revoke", "native-integration")
        assert json.loads(cli("network", "status"))["pairedDevices"] == 0
        cli("network", "p2p", "on")
        assert json.loads(cli("network", "status"))["p2p"] is True
        cli("network", "p2p", "off")
        assert json.loads(cli("network", "status"))["p2p"] is False
        print("PASS CLI identity, QR, approve/list/revoke, live P2P enable/disable")
        print("Pwnat capability:", json.dumps(status["pwnat"]))
        cli("stop")
        process.wait(timeout=8)
        assert process.returncode == 0
        print("PASS clean server shutdown")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=8)
        log.close()
