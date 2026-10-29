#!/usr/bin/env python3
"""One-shot diagnostic launcher: bind UDP/443, drop sudo identity, then exec.

Run explicitly through sudo. No installation, setuid bit, capabilities, route,
firewall change, or privileged child is required. The child receives only the
bound UDP socket. Use with path_probe.py or quic_probe.py and a private config.
"""
import os
import socket
import sys

if len(sys.argv) < 3 or not os.path.isabs(sys.argv[2]):
    raise SystemExit("Usage: sudo python3 udp443-launch.py BIND /absolute/command [args...]")
uid = int(os.environ["SUDO_UID"])
gid = int(os.environ["SUDO_GID"])
if uid <= 0 or gid < 0 or os.geteuid() != 0:
    raise SystemExit("Requires sudo from a non-root user")
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((sys.argv[1], 443))
sock.set_inheritable(True)
os.setgroups([])
os.setgid(gid)
os.setuid(uid)
if os.getuid() != uid or os.geteuid() != uid:
    raise SystemExit("Failed to drop privileged identity")
os.environ["AMBRA_PATH_UDP_FD"] = str(sock.fileno())
os.execv(sys.argv[2], sys.argv[2:])
