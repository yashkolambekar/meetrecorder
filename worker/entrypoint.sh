#!/bin/bash
set -e

# Start Xvfb on :99
Xvfb :99 -screen 0 1280x720x24 -ac &
XVFB_PID=$!
export DISPLAY=:99

# Wait briefly for X to come up
sleep 1

# Start PulseAudio and create a virtual null sink we can capture from
pulseaudio -D --exit-idle-time=-1 --verbose=0
sleep 0.5
pactl load-module module-null-sink sink_name=MeetSink >/dev/null
pactl set-default-sink MeetSink

# Forward SIGTERM/SIGINT to the node process, then kill Xvfb
trap 'kill -TERM "$NODE_PID" 2>/dev/null; kill $XVFB_PID 2>/dev/null; exit 0' TERM INT

node dist/worker.js "$@" &
NODE_PID=$!

wait $NODE_PID