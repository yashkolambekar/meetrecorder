#!/bin/bash
set -e

# Start Xvfb on :99
Xvfb :99 -screen 0 1280x720x24 -ac &
XVFB_PID=$!
export DISPLAY=:99

# Wait briefly for X to come up
sleep 1

# Start a window manager — required for Chrome's --start-fullscreen / --kiosk /
# --app flags to actually fullscreen and strip browser chrome. Without a WM,
# Xvfb shows Chrome's URL bar / tabs even in fullscreen mode.
fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!

# Hide the mouse cursor so it doesn't appear in recordings.
unclutter -idle 0 -root >/dev/null 2>&1 &
UNCLUTTER_PID=$!

# Start PulseAudio and create a virtual null sink we can capture from
pulseaudio -D --exit-idle-time=-1 --verbose=0
sleep 0.5
pactl load-module module-null-sink sink_name=MeetSink >/dev/null
pactl set-default-sink MeetSink

# Forward SIGTERM/SIGINT to the node process, then kill background helpers
trap 'kill -TERM "$NODE_PID" 2>/dev/null; kill $FLUXBOX_PID $UNCLUTTER_PID $XVFB_PID 2>/dev/null; exit 0' TERM INT

node dist/worker.js "$@" &
NODE_PID=$!

wait $NODE_PID