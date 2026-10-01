#!/bin/bash
# Starts the daemon: start.sh <node> <state dir> <port>
# The app and CLI launch this through a hidden wsl.exe on the Windows side
# (cmd "start /b", so no console window opens); that wsl.exe stays running as
# the daemon's parent and keeps the distro up. Anything printed before the
# daemon's own log is up (bad node path, module errors) lands in daemon-launch.log.
node="$1"; state="$2"; port="$3"
[ -x "$node" ] || node=$(bash -lic 'command -v node' 2>/dev/null | tail -1)
mkdir -p "$state/logs"
exec "$node" "$(dirname "$0")/r7shelld.js" --state "$state" --port "$port" >>"$state/logs/daemon-launch.log" 2>&1
