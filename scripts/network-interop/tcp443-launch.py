#!/usr/bin/env python3
"""One-shot TCP/443 diagnostic launcher. Prebind ten sockets, then drop root.

The pool permits one STUN connection, one listener, and eight bounded dials.
No child retains root or the ability to create new privileged bindings.
"""
import os
import socket
import sys

if len(sys.argv) < 3 or not os.path.isabs(sys.argv[2]):
    raise SystemExit("Usage: sudo python3 tcp443-launch.py BIND /absolute/command [args...]")
uid = int(os.environ["SUDO_UID"])
gid = int(os.environ["SUDO_GID"])
if uid <= 0 or gid < 0 or os.geteuid() != 0:
    raise SystemExit("Requires sudo from a non-root user")
sockets = []
for _ in range(10):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    sock.bind((sys.argv[1], 443))
    sock.set_inheritable(True)
    sockets.append(sock)
os.setgroups([])
os.setgid(gid)
os.setuid(uid)
if os.getuid() != uid or os.geteuid() != uid:
    raise SystemExit("Failed to drop privileged identity")
os.environ["AMBRA_PATH_TCP_FDS"] = ",".join(str(sock.fileno()) for sock in sockets)
os.execv(sys.argv[2], sys.argv[2:])
