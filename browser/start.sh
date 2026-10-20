#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME"
Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp >/dev/null 2>&1 &
xvfb_pid=$!
# Wait for display readiness, not a blind delay before browser startup.
i=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 50 ]; then exit 1; fi
  sleep 0.1
done
x11vnc -display :99 -localhost -nopw -forever -shared -rfbport 5900 -quiet >/dev/null 2>&1 &
vnc_pid=$!
node /app/build/web/main.js &
app_pid=$!
trap 'kill "$app_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true' INT TERM EXIT
wait "$app_pid"
