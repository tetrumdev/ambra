#!/usr/bin/env python3
"""Bounded simultaneous TCP open after real TCP STUN; no proxy or relay.

Exchange ready.json into the other peer's peers.json before removing management
connectivity. The config format matches path_probe.py. A successful TCP handshake
is recorded separately from an authenticated exchange. No encryption is claimed.
"""
import argparse
import errno
import json
import ipaddress
import os
from pathlib import Path
import select
import socket
import ssl
import time

from path_probe import parse_raw, parse_stun, public_endpoint, raw, read_signaling, stun, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, default=48500)
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--start-at", type=float, default=0, help="Unix time to begin dials")
    parser.add_argument("--tls", choices=["client", "server"])
    parser.add_argument("--stream-role", choices=["client", "server"], help="Authenticated stream without outer TLS; fixture must supply its own encryption")
    parser.add_argument("--passive", action="store_true", help="Listen without simultaneous outbound dials")
    parser.add_argument("--certificate", type=Path)
    parser.add_argument("--private-key", type=Path)
    parser.add_argument("--forward", help="TLS server forwards only to an explicit loopback fixture")
    parser.add_argument("--listen", help="TLS client accepts one local loopback fixture connection")
    args = parser.parse_args()
    if args.tls and args.stream_role:
        parser.error("Choose TLS or an authenticated plain stream")
    role = args.tls or args.stream_role
    if args.forward and role != "server" or args.listen and role != "client":
        parser.error("Fixture forwarding requires server role; listening requires client role")
    if args.tls and (not args.certificate or args.tls == "server" and not args.private_key):
        parser.error("TLS requires certificate and server private key")
    inherited = [int(fd) for fd in os.environ.get("AMBRA_PATH_TCP_FDS", "").split(",") if fd]
    if not 1 <= args.seconds <= 1200 or not (1024 <= args.port <= 65535 or args.port == 443 and inherited):
        parser.error("seconds must be 1..1200; privileged port 443 requires inherited sockets")
    if args.config.stat().st_mode & 0o077:
        parser.error("config must be private")
    key = bytes.fromhex(json.loads(args.config.read_text())["key"])
    if len(key) != 32:
        parser.error("key must contain 32 random bytes")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    log = (args.output / "events.jsonl").open("w")

    def event(stage, **fields):
        log.write(json.dumps({"unix": time.time(), "stage": stage, **fields}) + "\n")
        log.flush()

    def bound():
        if args.port == 443:
            if not inherited:
                raise RuntimeError("Inherited TCP socket pool exhausted")
            sock = socket.socket(fileno=inherited.pop(0))
            if sock.type != socket.SOCK_STREAM or sock.getsockname() != (args.bind, args.port):
                raise ValueError("Invalid inherited TCP socket")
            return sock
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        sock.bind((args.bind, args.port))
        return sock

    control = bound()
    control.settimeout(4)
    control.connect(("stun.nextcloud.com", 443))
    transaction = os.urandom(12)
    control.sendall(stun(1, transaction))
    packet = b""
    while len(packet) < 20 or len(packet) < 20 + int.from_bytes(packet[2:4], "big"):
        chunk = control.recv(2048)
        if not chunk:
            raise RuntimeError("TCP STUN closed before complete response")
        packet += chunk
        if len(packet) > 2048:
            raise RuntimeError("Oversized TCP STUN response")
    parsed = parse_stun(packet)
    if not parsed or parsed[:2] != (0x101, transaction) or not parsed[2]:
        raise RuntimeError("Invalid TCP STUN response")
    write_json(args.output / "ready.json", parsed[2])
    event("ready", local=control.getsockname(), mapping=parsed[2], stun_peer=control.getpeername())
    listener = bound()
    listener.listen(4)
    listener.setblocking(False)
    active = {}
    peer = None
    next_dial = 0
    start = time.monotonic()
    attempts = 0
    authenticated = 0

    def loopback(value):
        host, port = value.rsplit(":", 1)
        if not ipaddress.IPv4Address(host).is_loopback or not 0 < int(port) < 65536:
            raise ValueError("Fixture bridge requires an explicit loopback IPv4 address")
        return host, int(port)

    def bridge(secure):
        if args.forward:
            local = socket.create_connection(loopback(args.forward), timeout=8)
        else:
            listener = socket.socket()
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(loopback(args.listen))
            listener.listen(1)
            listener.settimeout(20)
            event("bridge_ready", address=listener.getsockname())
            local, _ = listener.accept()
            listener.close()
        secure.settimeout(8)
        local.settimeout(8)
        started = time.monotonic()
        counts = {"network_to_loopback": 0, "loopback_to_network": 0}
        try:
            while time.monotonic() - started < 120:
                readable, _, _ = select.select([secure, local], [], [], .1)
                if getattr(secure, "pending", lambda: 0)() and secure not in readable:
                    readable.append(secure)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    target = local if source is secure else secure
                    target.sendall(data)
                    name = "network_to_loopback" if source is secure else "loopback_to_network"
                    counts[name] += len(data)
            raise TimeoutError("Fixture bridge exceeded 120 seconds")
        finally:
            local.close()
            event("bridge_complete", seconds=time.monotonic() - started, **counts)

    def stream_exchange(sock):
        nonlocal authenticated
        context = None
        if args.tls:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER) if role == "server" else ssl.create_default_context(cafile=str(args.certificate))
            if role == "server":
                context.load_cert_chain(str(args.certificate), str(args.private_key))
            context.minimum_version = ssl.TLSVersion.TLSv1_2
        sock.settimeout(8)

        def exact(stream, size):
            result = b""
            while len(result) < size:
                chunk = stream.recv(size - len(result))
                if not chunk:
                    raise RuntimeError("Truncated authenticated exchange")
                result += chunk
            return result

        try:
            started = time.monotonic()
            stream = context.wrap_socket(sock, server_side=role == "server", server_hostname="ambra-path" if role == "client" else None) if context else sock
            with stream as secure:
                event("tls_connected" if context else "stream_connected", local=secure.getsockname(), peer=secure.getpeername(), version=secure.version() if context else None, elapsed_ms=(time.monotonic() - started) * 1000)
                if role == "client":
                    transaction = os.urandom(12)
                    auth_started = time.monotonic()
                    secure.sendall(raw(b"Q", transaction, key))
                    if parse_raw(exact(secure, 64), key) != (b"R", transaction):
                        raise RuntimeError("Peer authentication failed")
                    event("authentication", rtt_ms=(time.monotonic() - auth_started) * 1000)
                    if args.listen:
                        bridge(secure)
                        authenticated += 1
                        event("authenticated", tls=bool(context), fixture_bridge=True)
                        return
                    count = 0
                    maximum_gap = 0
                    previous = start = time.monotonic()
                    while count < 5120000:
                        data = secure.recv(min(65536, 5120000 - count))
                        if not data or data != bytes([42]) * len(data):
                            raise RuntimeError("Truncated or corrupt stream")
                        count += len(data)
                        now = time.monotonic()
                        maximum_gap = max(maximum_gap, now - previous)
                        previous = now
                    event("audio_stream", bytes=count, seconds=time.monotonic() - start, max_gap_ms=maximum_gap * 1000)
                else:
                    parsed = parse_raw(exact(secure, 64), key)
                    if not parsed or parsed[0] != b"Q":
                        raise RuntimeError("Client authentication failed")
                    secure.sendall(raw(b"R", parsed[1], key))
                    if args.forward:
                        bridge(secure)
                        authenticated += 1
                        event("authenticated", tls=bool(context), fixture_bridge=True)
                        return
                    for _ in range(1000):
                        secure.sendall(bytes([42]) * 5120)
                        time.sleep(.02)
                authenticated += 1
                event("authenticated", tls=bool(context))
        except Exception as error:
            event("tls_failed" if context else "stream_failed", error=repr(error))
            sock.close()

    while time.monotonic() - start < args.seconds:
        signaling = read_signaling(args.output / "peers.json") if peer is None else None
        if signaling:
            peer = public_endpoint(signaling)
            event("peer", endpoint=peer)
        now = time.monotonic()
        if peer and now >= next_dial and time.time() >= args.start_at and not authenticated and not args.passive:
            if args.port == 443 and not inherited:
                event("socket_pool_exhausted")
                break
            sock = bound()
            sock.setblocking(False)
            error = sock.connect_ex(peer)
            attempts += 1
            event("dial", attempt=attempts, errno=error)
            if error in (0, errno.EINPROGRESS, errno.EWOULDBLOCK):
                active[sock] = {"connecting": True, "at": now, "buffer": b""}
            else:
                sock.close()
            next_dial = now + 5
        readers = [listener] + [s for s, v in active.items() if not v["connecting"]]
        writers = [s for s, v in active.items() if v["connecting"]]
        readable, writable, _ = select.select(readers, writers, [], .1)
        if listener in readable:
            sock, source = listener.accept()
            sock.settimeout(1)
            if peer is None or source[0] != peer[0] or len(active) >= 8:
                sock.close()
            else:
                if role:
                    event("accepted", local=sock.getsockname(), peer=source)
                    stream_exchange(sock)
                    readable.remove(listener)
                    continue
                sock.sendall(raw(b"Q", os.urandom(12), key))
                active[sock] = {"connecting": False, "at": now, "buffer": b""}
                event("accepted", local=sock.getsockname(), peer=source)
            readable.remove(listener)
        for sock in writable:
            error = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            event("connect_result", errno=error)
            if error:
                del active[sock]
                sock.close()
                continue
            sock.settimeout(1)
            if role:
                del active[sock]
                event("connected", local=sock.getsockname(), peer=sock.getpeername())
                stream_exchange(sock)
                continue
            sock.sendall(raw(b"Q", os.urandom(12), key))
            active[sock]["connecting"] = False
            event("connected", local=sock.getsockname(), peer=sock.getpeername())
        for sock in readable:
            chunk = sock.recv(128)
            if not chunk:
                del active[sock]
                sock.close()
                continue
            entry = active[sock]
            entry["buffer"] += chunk
            while len(entry["buffer"]) >= 64:
                parsed = parse_raw(entry["buffer"][:64], key)
                entry["buffer"] = entry["buffer"][64:]
                if parsed and parsed[0] == b"Q":
                    sock.sendall(raw(b"R", parsed[1], key))
                    authenticated += 1
                    event("authenticated", local=sock.getsockname(), peer=sock.getpeername())
        for sock, value in list(active.items()):
            if now - value["at"] > 8:
                del active[sock]
                sock.close()
    event("complete", attempts=attempts, authenticated=authenticated)
    for sock in active:
        sock.close()
    listener.close()
    control.close()
    for fd in inherited:
        os.close(fd)
    log.close()


if __name__ == "__main__":
    main()
