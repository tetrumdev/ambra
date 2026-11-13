#!/usr/bin/env python3
"""Optional one-shot TCP/443 launcher. Never install this script setuid.

Usage: sudo python3 tcp-punch-bind.py NATIVE_IPV4 /absolute/command [args...]
Prebind a finite pool, drop all root credentials, then exec the application.
There is no privileged daemon, router operation, firewall change or password storage.
Restart this launcher when the finite pool is exhausted. Ordinary ephemeral TCP
punching does not require this launcher. Only use trusted, reviewed source.
"""
import ipaddress
import os
import socket
import sys


def main():
    if len(sys.argv) < 3 or not os.path.isabs(sys.argv[2]):
        raise SystemExit(__doc__)
    address = ipaddress.IPv4Address(sys.argv[1])
    if address.is_unspecified or address.is_loopback or address.is_multicast:
        raise SystemExit("An explicit native unicast IPv4 address is required")
    uid = int(os.environ.get("SUDO_UID", "0"))
    gid = int(os.environ.get("SUDO_GID", "-1"))
    if os.geteuid() != 0 or uid <= 0 or gid < 0:
        raise SystemExit("Run through sudo from the intended non-root account")
    sockets = []
    for _ in range(128):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        sock.bind((str(address), 443))
        sock.set_inheritable(True)
        sockets.append(sock)
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    if os.getuid() != uid or os.geteuid() != uid or os.getgid() != gid:
        raise SystemExit("Failed to drop privileges")
    os.environ["AMBRA_TCP_PUNCH_PORT"] = "443"
    os.environ["AMBRA_TCP_PUNCH_FDS"] = ",".join(str(sock.fileno()) for sock in sockets)
    os.execv(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    main()
