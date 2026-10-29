#!/usr/bin/env python3
"""Experimental, bounded UDP path comparison; never an Ambra transport.

Run on both peers with the same private 32-byte hex key in --config. Each peer
writes ready.json, then reads peers.json from its output directory. Exchange only
ready.json over a management channel before disconnecting that channel. Requests
compare real STUN Binding checks with an opaque authenticated echo on the same
socket pair. No discovery or data relay is used. Output contains public addresses.
"""
import argparse
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import time

COOKIE = 0x2112A442


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def read_signaling(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        # A coordinator may still be writing. The experiment deadline remains.
        return None


def stun(kind, transaction, key=None, address=None):
    attributes = b""
    if address:
        attributes += struct.pack("!HHBBHI", 0x20, 8, 0, 1,
                                  address[1] ^ 0x2112,
                                  int(ipaddress.IPv4Address(address[0])) ^ COOKIE)
    elif key:
        attributes += struct.pack("!HH", 6, 16) + b"ambra-path-probe"
    if key:
        # RFC 8489: length includes MESSAGE-INTEGRITY; HMAC excludes its TLV.
        header = struct.pack("!HHI", kind, len(attributes) + 24, COOKIE) + transaction
        digest = hmac.digest(key, header + attributes, "sha1")
        return header + attributes + struct.pack("!HH", 8, 20) + digest
    return struct.pack("!HHI", kind, len(attributes), COOKIE) + transaction + attributes


def parse_stun(packet, key=None):
    if len(packet) < 20:
        return None
    kind, length, cookie = struct.unpack("!HHI", packet[:8])
    if cookie != COOKIE or length % 4 or length + 20 != len(packet):
        return None
    mapping = None
    authenticated = False
    offset = 20
    while offset + 4 <= len(packet):
        attribute, size = struct.unpack("!HH", packet[offset:offset + 4])
        value = packet[offset + 4:offset + 4 + size]
        if len(value) != size:
            return None
        if attribute == 0x20 and size == 8 and value[:2] == b"\0\1":
            port, ip = struct.unpack("!HI", value[2:])
            mapping = str(ipaddress.IPv4Address(ip ^ COOKIE)), port ^ 0x2112
        if attribute == 8 and size == 20 and key:
            header = packet[:2] + struct.pack("!H", offset + 24 - 20) + packet[4:20]
            authenticated = hmac.compare_digest(value, hmac.digest(key, header + packet[20:offset], "sha1"))
            break
        offset += 4 + ((size + 3) & ~3)
    if key and not authenticated:
        return None
    return kind, packet[8:20], mapping


def raw(kind, transaction, key):
    body = b"ABP1" + kind + transaction + bytes(15)
    return body + hmac.digest(key, body, "sha256")


def parse_raw(packet, key):
    if len(packet) != 64 or packet[:4] != b"ABP1":
        return None
    if not hmac.compare_digest(packet[32:], hmac.digest(key, packet[:32], "sha256")):
        return None
    return packet[4:5], packet[5:17]


def public_endpoint(value):
    host, port = value
    if not ipaddress.IPv4Address(host).is_global or not 0 < int(port) < 65536:
        raise ValueError("Peer must be a global IPv4 endpoint")
    return host, int(port)


def discover(sock, target):
    host, port = target
    destination = socket.gethostbyname(host), port
    transaction = os.urandom(12)
    start = time.monotonic()
    sock.sendto(stun(1, transaction), destination)
    deadline = start + 1.5
    while time.monotonic() < deadline:
        if not select.select([sock], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        packet, source = sock.recvfrom(2048)
        parsed = parse_stun(packet)
        if source == destination and parsed and parsed[:2] == (0x101, transaction):
            return {"target": destination, "mapping": parsed[2], "rtt_ms": (time.monotonic() - start) * 1000}
    return {"target": destination, "mapping": None, "error": "timeout"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--ports", default="0,443,19302,49737")
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--start-at", type=float, default=0, help="Unix time to begin peer checks")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 1200:
        parser.error("seconds must be 1..1200")
    if args.config.stat().st_mode & 0o077:
        parser.error("config must be private (mode 0600)")
    key = bytes.fromhex(json.loads(args.config.read_text())["key"])
    if len(key) != 32:
        parser.error("key must contain 32 random bytes")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    log = (args.output / "events.jsonl").open("w")
    stopped = False

    def stop(signum, frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def event(stage, **fields):
        log.write(json.dumps({"unix": time.time(), "stage": stage, **fields}) + "\n")
        log.flush()

    sockets = []
    ready = []
    for port in map(int, args.ports.split(",")):
        inherited = os.environ.get("AMBRA_PATH_UDP_FD") if port == 443 else None
        sock = socket.socket(fileno=os.dup(int(inherited))) if inherited else socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            if inherited:
                if sock.type != socket.SOCK_DGRAM or sock.getsockname() != (args.bind, port):
                    raise ValueError("Inherited UDP socket has incorrect type or bind")
            else:
                sock.bind((args.bind, port))
        except OSError as error:
            event("bind_failed", port=port, error=str(error))
            sock.close()
            continue
        observations = [discover(sock, target) for target in [
            ("stun.l.google.com", 19302), ("stun1.l.google.com", 19302),
            ("stun.nextcloud.com", 443), ("stun.cloudflare.com", 3478)]]
        ready.append({"requested_port": port, "local": sock.getsockname(), "observations": observations})
        sockets.append(sock)
    write_json(args.output / "ready.json", ready)
    event("ready", sockets=ready)
    pending = {}
    stats = [{"sent": {}, "requests_received": {}, "responses_received": {}, "rtt_ms": {}, "sources": []} for _ in sockets]
    start = time.monotonic()
    next_send = start
    responses = 0
    first = True
    peers_path = args.output / "peers.json"
    peers = []
    while not stopped and time.monotonic() - start < args.seconds:
        signaling = read_signaling(peers_path) if not peers else None
        if signaling:
            peers = [public_endpoint(p) for p in signaling]
            if len(peers) > 8:
                raise ValueError("At most eight explicit peer endpoints")
            event("peers", endpoints=peers)
        now = time.monotonic()
        if peers and now >= next_send and time.time() >= args.start_at:
            for index, sock in enumerate(sockets):
                peer = peers[index % len(peers)]
                for kind in ("stun", "raw"):
                    transaction = os.urandom(12)
                    packet = stun(1, transaction, key) if kind == "stun" else raw(b"Q", transaction, key)
                    sock.sendto(packet, peer)
                    pending[transaction] = (index, kind, now, peer)
                    stats[index]["sent"][kind] = stats[index]["sent"].get(kind, 0) + 1
            next_send = now + 1
            pending = {t: v for t, v in pending.items() if now - v[2] < 10}
        readable, _, _ = select.select(sockets, [], [], .05)
        for sock in readable:
            packet, source = sock.recvfrom(2048)
            if not ipaddress.IPv4Address(source[0]).is_global:
                continue
            index = sockets.index(sock)
            parsed = parse_stun(packet, key)
            if parsed and parsed[0] in (1, 0x101):
                kind, transaction, request = "stun", parsed[1], parsed[0] == 1
            else:
                parsed = parse_raw(packet, key)
                if not parsed or parsed[0] not in (b"Q", b"R"):
                    continue
                kind, transaction, request = "raw", parsed[1], parsed[0] == b"Q"
            entry = stats[index]
            if list(source) not in entry["sources"]:
                entry["sources"].append(list(source))
            if request:
                if responses >= 20000:
                    continue
                reply = stun(0x101, transaction, key, source) if kind == "stun" else raw(b"R", transaction, key)
                if len(reply) > len(packet):
                    raise AssertionError("Amplification forbidden")
                sock.sendto(reply, source)
                responses += 1
                entry["requests_received"][kind] = entry["requests_received"].get(kind, 0) + 1
                event("request", socket=index, kind=kind, source=source)
            elif transaction in pending:
                sent_index, sent_kind, sent_at, peer = pending[transaction]
                if sent_index != index or sent_kind != kind or source[0] != peer[0]:
                    continue
                del pending[transaction]
                rtt = (time.monotonic() - sent_at) * 1000
                entry["responses_received"][kind] = entry["responses_received"].get(kind, 0) + 1
                entry["rtt_ms"].setdefault(kind, []).append(rtt)
                event("response", socket=index, kind=kind, source=source, rtt_ms=rtt)
                if first:
                    event("first_peer_response", elapsed_ms=(time.monotonic() - start) * 1000)
                    first = False
    event("complete", duration_s=time.monotonic() - start, sockets=stats,
          limitation="Unanswered probes do not distinguish filtering, mapping mismatch, and loss. This is authenticated plaintext, not encrypted Ambra.")
    for sock in sockets:
        sock.close()
    log.close()


if __name__ == "__main__":
    main()
