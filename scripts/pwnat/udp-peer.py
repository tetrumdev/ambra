#!/usr/bin/env python3
"""Bounded direct UDP test. Bind explicitly to a physical IPv4 address.

Prints a STUN-observed endpoint, then accepts one JSON line on stdin containing
peer=PUBLIC_IP:PORT and token=64_HEX_DIGITS. Give both peers the same random
token through their private administration channel. No token is logged.
Only authenticated, same-size replies are sent; maximum 120 packets per role.
STUN observations do not predict a destination-dependent peer mapping.
"""
import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import select
import socket
import struct
import subprocess
import sys
import time


def route(address):
    if sys.platform == "darwin":
        text = subprocess.check_output(["route", "-n", "get", address], text=True, timeout=5)
        name = next(line.split(":",1)[1].strip() for line in text.splitlines() if "interface:" in line)
    else:
        routes = json.loads(subprocess.check_output(["ip", "-j", "route", "get", address], text=True, timeout=5))
        name = routes[0]["dev"]
    if name.startswith(("utun", "tun", "tap", "tailscale", "wg", "ipsec", "ppp", "lo")):
        raise ValueError("Refusing overlay or loopback route")
    return name


def mapping(sock):
    destination = socket.gethostbyname("stun.l.google.com"), 19302
    for _ in range(2):
        transaction = os.urandom(12)
        sock.sendto(struct.pack("!HHI",1,0,0x2112a442)+transaction,destination)
        deadline = time.monotonic()+2
        while time.monotonic()<deadline:
            sock.settimeout(max(.01,deadline-time.monotonic()))
            try: packet, source = sock.recvfrom(2048)
            except socket.timeout: break
            if source != destination or len(packet)<20 or packet[:2]!=b"\x01\x01" or packet[8:20]!=transaction: continue
            end = 20+struct.unpack("!H",packet[2:4])[0]
            if end>len(packet): continue
            offset = 20
            while offset+4<=end:
                kind,size = struct.unpack("!HH",packet[offset:offset+4]);offset+=4
                if kind==0x20 and size==8 and offset+size<=end and packet[offset+1]==1:
                    port = struct.unpack("!H",packet[offset+2:offset+4])[0]^0x2112
                    ip = socket.inet_ntoa(bytes(a^b for a,b in zip(packet[offset+4:offset+8],b"\x21\x12\xa4\x42")))
                    return ip,port
                offset+=(size+3)&~3
    raise TimeoutError("No transaction-checked STUN mapping; cannot coordinate this test")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    ip = ipaddress.IPv4Address(args.bind)
    if ip.is_loopback or ip.is_link_local or ip in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("Bind a physical unicast IPv4 address")
    sock = socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    with sock:
        sock.bind((args.bind,args.port))
        endpoint = mapping(sock)
        print(json.dumps({"stage":"ready","endpoint":f"{endpoint[0]}:{endpoint[1]}","interface":route(endpoint[0])}),flush=True)
        if not select.select([sys.stdin],[],[],30)[0]: raise TimeoutError("Missing peer coordination")
        line = sys.stdin.readline(1024)
        request = json.loads(line)
        if set(request)!={"peer","token"}: raise ValueError("Unknown coordination field")
        host,port = request["peer"].rsplit(":",1)
        if not ipaddress.IPv4Address(host).is_global or not 0<int(port)<65536:
            raise ValueError("Peer must be a public IPv4 endpoint")
        token = bytes.fromhex(request["token"])
        if len(token)!=32: raise ValueError("Token must contain 32 random bytes")
        interface = route(host)
        peer = host,int(port)
        sent = {}
        rtts = []
        seen = set()
        replies = 0
        received_endpoints = set()
        first_reply_ms = None
        sock.setblocking(False)
        start = time.monotonic()
        next_send = start
        sequence = 0
        while time.monotonic()-start<8:
            now = time.monotonic()
            if sequence<100 and now>=next_send:
                body = b"ambra-udp-v1"+b"Q"+struct.pack("!I",sequence)
                sock.sendto(body+hmac.digest(token,body,"sha256"),peer)
                sent[sequence] = now
                sequence+=1;next_send=now+.05
            if not select.select([sock],[],[],.02)[0]: continue
            packet,source = sock.recvfrom(2048)
            if len(packet)!=49 or source[0]!=host: continue
            body,mac = packet[:-32],packet[-32:]
            if body[:12]!=b"ambra-udp-v1" or not hmac.compare_digest(mac,hmac.digest(token,body,"sha256")): continue
            number = struct.unpack("!I",body[13:17])[0]
            received_endpoints.add(source)
            if body[12:13]==b"Q" and replies<120:
                reply = body[:12]+b"R"+body[13:]
                sock.sendto(reply+hmac.digest(token,reply,"sha256"),source);replies+=1
            elif body[12:13]==b"R" and number in sent and number not in seen:
                seen.add(number);rtts.append((time.monotonic()-sent[number])*1000)
                if first_reply_ms is None:first_reply_ms=(time.monotonic()-start)*1000
        print(json.dumps({"stage":"complete","physical":True,"interface":interface,"sent":sequence,"replies":len(seen),
                          "unanswered":sequence-len(seen),"rtt_ms":rtts,"peer_port_changed":any(p!=peer for p in received_endpoints),
                          "first_reply_ms":first_reply_ms,"unanswered_sequences":sorted(set(sent)-seen),
                          "successive_rtt_jitter_ms":sum(abs(b-a) for a,b in zip(rtts,rtts[1:]))/(len(rtts)-1) if len(rtts)>1 else None,
                          "limitation":"Unanswered probes cannot distinguish mapping incompatibility, filtering, and packet loss."}),flush=True)


if __name__ == "__main__":
    main()
