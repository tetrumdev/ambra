#!/usr/bin/env python3
"""Four bounded RFC 5780 probes to one server; public addresses are included.

Same-IP alternate-port tests do not establish a complete NAT classification.
"""
import argparse
import json
import os
import socket
import struct

from path_probe import parse_stun, stun

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--bind", required=True)
args = parser.parse_args()
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((args.bind, 0))
sock.settimeout(2)
host = socket.gethostbyname("stun.nextcloud.com")
results = []
for port, change in [(443, True), (443, False), (3478, False), (3478, True)]:
    transaction = os.urandom(12)
    packet = stun(1, transaction)
    if change:
        packet = packet[:2] + struct.pack("!H", 8) + packet[4:] + struct.pack("!HHI", 3, 4, 2)
    sock.sendto(packet, (host, port))
    row = {"destination": [host, port], "change_port": change, "local": sock.getsockname()}
    try:
        packet, source = sock.recvfrom(2048)
        parsed = parse_stun(packet)
        row.update(source=source, response_kind=parsed[0] if parsed else None,
                   mapping=parsed[2] if parsed else None,
                   transaction_matches=bool(parsed and parsed[1] == transaction))
    except socket.timeout:
        row["timeout"] = True
    results.append(row)
sock.close()
print(json.dumps(results, indent=2))
