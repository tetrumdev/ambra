#!/bin/sh
# Install only the prebuilt one-shot launcher. Never grants privileges to Ambra.
set -eu
destination=/usr/local/libexec/ambra-icmp-launch
if [ "$(id -u)" -ne 0 ]; then
    echo 'Run this installer with sudo after building icmp-launch as your normal user.' >&2
    exit 1
fi
if [ "${1:-}" = --uninstall ] && [ "$#" -eq 1 ]; then
    rm -f "$destination"
    exit 0
fi
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo 'Usage: install-helper.sh /absolute/path/to/prebuilt/icmp-launch | --uninstall' >&2
    exit 2
fi
case "$1" in /*) ;; *) echo 'Pass an absolute build path.' >&2; exit 2 ;; esac
case "$(uname -s)" in
    Darwin)
        install -d -o root -g wheel -m 0755 /usr/local/libexec
        install -o root -g wheel -m 0755 "$1" "$destination"
        # No setuid bit, daemon, or sudoers entry. Socket creation requires an
        # explicit, one-shot sudo launch; the child always runs unprivileged.
        ;;
    Linux)
        : "${SUDO_USER:?Run from the intended non-root account through sudo}"
        group=$(id -gn "$SUDO_USER")
        install -d -o root -g root -m 0755 /usr/local/libexec
        install -o root -g "$group" -m 0750 "$1" "$destination"
        setcap cap_net_raw=ep "$destination"
        ;;
    *) echo 'Unsupported helper platform.' >&2; exit 2 ;;
esac
