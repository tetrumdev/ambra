#!/usr/bin/env python3
"""Experimental QUIC candidate test. Requires test-only aioquic dependency.

Uses STUN on the actual QUIC socket, out-of-band peer candidates, a privately
exchanged server certificate, and HMAC client authentication. It does not use
HyperDHT, ICMP, a proxy, or a data relay. Successful TLS is not Ambra integration.
"""
import argparse
import asyncio
import datetime
import json
import os
from pathlib import Path
import socket
import time

from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.asyncio.server import QuicServer
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.connection import QuicConnection
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from path_probe import discover, parse_raw, public_endpoint, raw, read_signaling, write_json


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=["server", "client"])
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, default=48501)
    parser.add_argument("--certificate", type=Path)
    parser.add_argument("--seconds", type=int, default=120)
    parser.add_argument("--start-at", type=float, default=0, help="Unix time to start QUIC after signaling")
    parser.add_argument("--allow-unmapped", action="store_true", help="Client may test an explicit peer despite failed STUN")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 1200 or args.config.stat().st_mode & 0o077:
        parser.error("Bound duration to 1..1200 seconds and use private config")
    key = bytes.fromhex(json.loads(args.config.read_text())["key"])
    if len(key) != 32:
        parser.error("key must contain 32 random bytes")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    log = (args.output / "events.jsonl").open("w")

    def event(stage, **fields):
        log.write(json.dumps({"unix": time.time(), "stage": stage, **fields}) + "\n")
        log.flush()

    inherited = os.environ.get("AMBRA_PATH_UDP_FD") if args.port == 443 else None
    sock = socket.socket(fileno=os.dup(int(inherited))) if inherited else socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if inherited:
        if sock.type != socket.SOCK_DGRAM or sock.getsockname() != (args.bind, args.port):
            raise ValueError("Invalid inherited UDP socket")
    else:
        sock.bind((args.bind, args.port))
    observation = discover(sock, ("stun.nextcloud.com", 443))
    if not observation["mapping"] and (args.role != "client" or not args.allow_unmapped):
        raise RuntimeError("No mapped QUIC candidate")
    write_json(args.output / "ready.json", observation["mapping"])
    event("ready", local=sock.getsockname(), observation=observation)
    configuration = QuicConfiguration(is_client=args.role == "client", alpn_protocols=["ambra-path-test"])
    tasks = set()

    async def handle(reader, writer):
        try:
            request = await asyncio.wait_for(reader.readexactly(64), 5)
            parsed = parse_raw(request, key)
            if not parsed or parsed[0] != b"Q":
                return
            writer.write(raw(b"R", parsed[1], key))
            await writer.drain()
            event("authenticated_stream")
            # Twenty seconds at audio-sized 2.048 Mbit/s, with exact bytes.
            for _ in range(1000):
                writer.write(bytes([42]) * 5120)
                await writer.drain()
                await asyncio.sleep(.02)
            writer.write_eof()
        except Exception as error:
            event("stream_error", error=repr(error))
        finally:
            writer.close()

    def stream_handler(reader, writer):
        if len(tasks) >= 4:
            writer.close()
            return
        task = asyncio.create_task(handle(reader, writer))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    loop = asyncio.get_running_loop()
    if args.role == "server":
        private = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ambra-path")])
        now = datetime.datetime.now(datetime.timezone.utc)
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                       .public_key(private.public_key()).serial_number(x509.random_serial_number())
                       .not_valid_before(now - datetime.timedelta(minutes=1))
                       .not_valid_after(now + datetime.timedelta(days=1))
                       .add_extension(x509.SubjectAlternativeName([x509.DNSName("ambra-path")]), critical=False)
                       .sign(private, hashes.SHA256()))
        configuration.certificate = certificate
        configuration.private_key = private
        (args.output / "certificate.pem").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        punch = sock.dup()
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: QuicServer(configuration=configuration, stream_handler=stream_handler), sock=sock)
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            peer_file = args.output / "peers.json"
            signaling = read_signaling(peer_file)
            if signaling:
                peer = public_endpoint(signaling)
                punch.sendto(b"ambra-quic-punch", peer)
            await asyncio.sleep(.5)
        punch.close()
        protocol.close()
    else:
        if not args.certificate:
            parser.error("client requires exchanged --certificate")
        configuration.load_verify_locations(cafile=str(args.certificate))
        configuration.server_name = "ambra-path"
        deadline = time.monotonic() + args.seconds
        while not (signaling := read_signaling(args.output / "peers.json")):
            if time.monotonic() >= deadline:
                raise TimeoutError("Missing peer signaling")
            await asyncio.sleep(.1)
        peer = public_endpoint(signaling)
        await asyncio.sleep(max(0, args.start_at - time.time()))
        connection = QuicConnection(configuration=configuration)
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: QuicConnectionProtocol(connection), sock=sock)
        started = time.monotonic()
        protocol.connect(peer)
        try:
            await asyncio.wait_for(protocol.wait_connected(), 8)
            event("connected", elapsed_ms=(time.monotonic() - started) * 1000, peer=peer,
                  observed_path=[{"endpoint": p.addr, "validated": p.is_validated} for p in connection._network_paths])
            reader, writer = await protocol.create_stream()
            transaction = os.urandom(12)
            writer.write(raw(b"Q", transaction, key))
            await writer.drain()
            reply = await asyncio.wait_for(reader.readexactly(64), 5)
            if parse_raw(reply, key) != (b"R", transaction):
                raise RuntimeError("Peer authentication failed")
            count = 0
            start = previous = time.monotonic()
            maximum_gap = 0
            while True:
                data = await asyncio.wait_for(reader.read(65536), 5)
                if not data:
                    break
                if data != bytes([42]) * len(data):
                    raise RuntimeError("Data integrity failed")
                count += len(data)
                now = time.monotonic()
                maximum_gap = max(maximum_gap, now - previous)
                previous = now
            if count != 5120000:
                raise RuntimeError(f"Truncated audio-sized stream: {count}")
            event("complete", bytes=count, seconds=time.monotonic() - start,
                  throughput_mib_s=count / 1048576 / (time.monotonic() - start), max_gap_ms=maximum_gap * 1000)
        except Exception as error:
            event("failed", elapsed_ms=(time.monotonic() - started) * 1000, error=repr(error))
            raise
        finally:
            protocol.close()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    transport.close()
    log.close()


if __name__ == "__main__":
    asyncio.run(main())
