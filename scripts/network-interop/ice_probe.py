#!/usr/bin/env python3
"""Bounded full ICE connectivity check using test-only aioice, without TURN.

Exchange private ready.json files as peers.json over SSH before switching modes.
Credentials are ephemeral, never printed. Only public remote candidates are
checked. Binding is explicit, so Tailscale cannot provide a successful data path.
"""
import argparse
import asyncio
import ipaddress
import json
import logging
import os
from pathlib import Path
import time

import aioice
import aioice.ice
from path_probe import read_signaling, write_json


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=["controlling", "controlled"])
    parser.add_argument("--bind", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--seconds", default=180, type=int)
    parser.add_argument("--start-at", type=float, default=0, help="Unix time to start checks after signaling")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 1200:
        parser.error("seconds must be 1..1200")
    address = ipaddress.IPv4Address(args.bind)
    if address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10"):
        parser.error("Select a physical IPv4 bind")
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    log = (args.output / "events.jsonl").open("w")

    def event(stage, **fields):
        log.write(json.dumps({"unix": time.time(), "stage": stage, **fields}) + "\n")
        log.flush()

    # Test-only enumeration override: prevents gathering overlay interfaces.
    aioice.ice.get_host_addresses = lambda **kwargs: [args.bind]
    connection = aioice.Connection(ice_controlling=args.role == "controlling",
                                  stun_server=("stun.nextcloud.com", 443), use_ipv6=False)
    await connection.gather_candidates()
    candidates = [candidate.to_sdp() for candidate in connection.local_candidates]
    write_json(args.output / "ready.json", {"username": connection.local_username,
               "password": connection.local_password, "candidates": candidates})
    event("ready", candidates=candidates, aioice_version=aioice.__version__)
    deadline = time.monotonic() + args.seconds
    try:
        while not (peer := read_signaling(args.output / "peers.json")):
            if time.monotonic() >= deadline:
                raise TimeoutError("No peer signaling")
            await asyncio.sleep(.1)
        connection.remote_username = peer["username"]
        connection.remote_password = peer["password"]
        for text in peer["candidates"]:
            candidate = aioice.Candidate.from_sdp(text)
            if candidate.transport.lower() == "udp" and ipaddress.ip_address(candidate.host).is_global:
                await connection.add_remote_candidate(candidate)
        await connection.add_remote_candidate(None)
        await asyncio.sleep(max(0, args.start_at - time.time()))
        start = time.monotonic()
        await asyncio.wait_for(connection.connect(), 20)
        pairs = [{"local": p.local_candidate.to_sdp(), "remote": p.remote_candidate.to_sdp()}
                 for p in connection._nominated.values()]
        event("connected", elapsed_ms=(time.monotonic() - start) * 1000, pairs=pairs)
        rtts = []
        for index in range(20):
            message = b"ambra-ice-probe:" + index.to_bytes(4, "big")
            sent = time.monotonic()
            if args.role == "controlling":
                await connection.send(message)
                reply = await asyncio.wait_for(connection.recv(), 2)
                if reply != message:
                    raise RuntimeError("ICE data mismatch")
                rtts.append((time.monotonic() - sent) * 1000)
            else:
                received = await asyncio.wait_for(connection.recv(), 2)
                if received != message:
                    raise RuntimeError("ICE data mismatch")
                await connection.send(received)
            await asyncio.sleep(.05)
        event("complete", exchanges=20, rtt_ms=rtts, encrypted=False)
    except Exception as error:
        event("failed", error=repr(error))
        raise
    finally:
        await connection.close()
        log.close()


if __name__ == "__main__":
    asyncio.run(main())
