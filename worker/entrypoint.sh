#!/bin/bash
set -e

# Virtual X display at 1280x720x24. Chrome runs "headed" against this so Meet
# can't tell it's headless. ffmpeg's x11grab captures from this same display.
Xvfb :99 -screen 0 1280x720x24 -ac &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

# PulseAudio: null sink that Chrome's audio output is routed to. ffmpeg
# monitors it for the recording's audio track.
pulseaudio -D --exit-idle-time=-1 --verbose=0
sleep 0.5
pactl load-module module-null-sink sink_name=MeetSink >/dev/null
pactl set-default-sink MeetSink

# VNC stack. Loopback only — SSH tunnel from your laptop brings it to you.
# x11vnc -localhost: refuses non-loopback TCP clients.
# websockify: bridges HTTP/WS clients on :6080 to the VNC port :5900.
x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever -quiet -bg
websockify --web=/usr/share/novnc 6080 localhost:5900 >/var/log/websockify.log 2>&1 &
WEBSOCKIFY_PID=$!

# Make sure the persistent profile and jobs directory exist, owned by root
# (the worker process also runs as root in this image).
mkdir -p /var/lib/meet-profile /var/lib/meet-recorder /var/log/meet-recorder

# Clean stale Chrome singleton lock files left behind by a prior crashed or
# SIGKILLed container. Chrome refuses to launch with exitCode=21 when these
# exist and reference a dead PID. Only safe when no Chrome is currently
# running here — pgrep guards against the case where the lock is genuinely
# held by a sibling process.
if ! pgrep -f "google-chrome-stable" >/dev/null 2>&1; then
  rm -f /var/lib/meet-profile/SingletonLock \
        /var/lib/meet-profile/SingletonCookie \
        /var/lib/meet-profile/SingletonSocket
  echo "[entrypoint] cleared stale Chrome singleton lock files"
fi

# Run the controller. SIGTERM → graceful (5s grace for browser/ffmpeg to die).
trap 'kill -TERM "$NODE_PID" 2>/dev/null || true; kill "$WEBSOCKIFY_PID" 2>/dev/null || true; kill "$XVFB_PID" 2>/dev/null || true; sleep 0.5; exit 0' TERM INT

node dist/worker.js "$@" &
NODE_PID=$!

wait $NODE_PID