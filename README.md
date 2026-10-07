# Meet Recorder

Self-hosted Google Meet recorder. One Docker container holds a real Chrome
profile, exposes it through VNC for a one-time Google sign-in, and runs
recordings against that persistent profile. After the first login you never
have to copy cookies again.

## Stack

- Node 20 + TypeScript, plain `http.Server` for the dashboard
- Playwright against the system Chrome (`launchPersistentContext`)
- `x11grab` + PulseAudio `MeetSink.monitor` muxed by `ffmpeg`
- `x11vnc` + `websockify` + `novnc` for the one-time sign-in
- Docker Compose single service, no DB, no queue

## Architecture (single container)

```
Xvfb :99  ──▶  google-chrome-stable  ──▶  PulseAudio MeetSink
   │                  │
   │                  └──▶  Playwright (persistent profile)
   │
   ├──▶  x11vnc  ──▶  websockify (noVNC)   (loopback only)
   │
   └──▶  ffmpeg x11grab + pulse  ──▶  /recordings/<YYYY>/<MM>/<DD>/<jobId>/part-NNN.mp4
```

The persistent Chrome profile lives in a Docker named volume (`meet-profile`).
IndexedDB, localStorage, the `Login Data` database, and cookies all persist
across container restarts and image rebuilds.

## First-time setup

```bash
# 1. Build and start the container.
docker compose build
docker compose up -d worker

# 2. Wait for it to be healthy.
docker compose ps
# STATUS: Up (healthy)

# 3. From your laptop, open an SSH tunnel so the dashboard + noVNC
#    reach your browser through localhost.
ssh -L 3333:127.0.0.1:3333 -L 6080:127.0.0.1:6080 user@server

# 4. Open the dashboard in your laptop browser:
#    http://localhost:3333

# 5. Open noVNC (the actual X display):
#    http://localhost:6080/vnc.html

# 6. Inside the noVNC window you see the X display :99.
#    To drive a one-time sign-in you can either:
#    a) Trigger a recording (the worker launches Chrome on :99)
#    b) Run Chrome manually inside the container:
#       docker exec -it meet-recorder-worker-1 \
#         bash -c 'DISPLAY=:99 google-chrome-stable --user-data-dir=/var/lib/meet-profile --no-sandbox'

# 7. Sign in to Google, complete 2FA. The profile is now populated.

# 8. Back on the dashboard, click "Check Profile". State flips to READY.
```

That's it. Future recordings happen against the same persistent profile. No
cookies are loaded from disk in normal flow.

## SSH tunnel (full command)

```bash
ssh -L 6080:127.0.0.1:6080 -L 3333:127.0.0.1:3333 user@server
```

`6080` carries noVNC, `3333` carries the dashboard. Both ports are bound to
loopback on the server, so neither is reachable from the internet.

## Recordings

```
/recordings/
  2026/
    10/
      07/
        1700000000000/                # jobId = epoch ms
            part-000.mp4
            part-001.mp4
            ...
```

ffmpeg segments every `SEGMENT_SECONDS` (default 600s = 10 minutes). Each
segment is independently playable. The dashboard stitches them conceptually
as one recording/session but lists individual parts for download.

The dashboard also exposes the legacy flat layout (`/recordings/*.mp4`) for
recordings made by previous versions.

## Failure reasons

The job record carries a structured `failureReason`:

| Code | Meaning |
|---|---|
| `MEETING_ENDED` | Normal exit (host ended, "You left the meeting", only participant left) |
| `GOOGLE_AUTH_REQUIRED` | Browser was redirected to accounts.google.com / sign-in page |
| `REMOVED_FROM_MEETING` | "You were removed" / "Someone removed you" |
| `CANNOT_JOIN` | "You can't join this meeting" / "Meeting not available" |
| `WEBRTC_DISCONNECTED` | Reconnecting indicator timed out |
| `BROWSER_CRASHED` | Browser process disconnected or page crashed |
| `FFMPEG_FAILED` | ffmpeg exited non-zero, was signalled, or wrote no usable segments |
| `PAGE_ERROR` | Uncaught pageerror that survived a single reload attempt |
| `ABORTED` | User pressed Stop |
| `UNKNOWN_FAILURE` | No matched signal — check logs |

## Backing up the profile

The persistent profile is the only state that matters. Back it up with:

```bash
docker run --rm \
  -v meet-profile:/profile \
  -v $PWD:/backup \
  alpine tar czf /backup/meet-profile.tgz -C / profile
```

Restore:

```bash
docker run --rm \
  -v meet-profile:/profile \
  -v $PWD:/backup \
  alpine sh -c 'rm -rf /profile/* && tar xzf /backup/meet-profile.tgz -C /profile'
```

You can move the profile between hosts by transferring it from one Docker
volume to another.

## Resetting the profile

If the profile becomes corrupted (Chrome lock file collision, sign-in loop,
2FA stuck):

```bash
docker compose down
docker volume rm meet-profile
docker compose up -d worker
```

Then sign in again via noVNC.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Dashboard shows `LOGIN_REQUIRED` after sign-in | Probed URL `myaccount.google.com` returned the sign-in form | Open noVNC, sign in to myaccount.google.com directly, then click Check Profile |
| `PROFILE_ERROR` | Chrome can't launch against the profile (lock contention) | `docker compose restart worker`, then re-check |
| Recording ends with `FFMPEG_FAILED` after a few seconds | ffmpeg was killed by the host or the X display vanished | Inspect `docker compose logs worker`; verify `DISPLAY=:99` still resolves |
| Recording ends with `GOOGLE_AUTH_REQUIRED` | Cookies in the profile are stale, or the host's IP changed | Refresh sign-in via noVNC |
| `WEBRTC_DISCONNECTED` | Network blip; Meet couldn't reconnect | Re-run the job; the recorder does not auto-rejoin |
| `BROWSER_CRASHED` mid-recording | Chrome process died (OOM, GPU crash) | Check `docker compose logs worker`; consider raising the host's RAM |

Logs are JSON, one line per event. They live in `docker compose logs worker`
(stdout) and in `/var/log/meet-recorder/` (bind-mounted to `./logs/`).

## Security

- VNC/noVNC bound to localhost. Not exposed to the internet.
- Dashboard auth: set `DASHBOARD_AUTH=user:password` to require HTTP Basic.
  Leave empty only if you're sure the dashboard is unreachable publicly.
- Recording downloads stream from `/api/recordings/<jobId>/<file>` with
  `safeResolve` (path-traversal blocked, symlinks rejected).
- No cookies are exported, logged, or stored outside the persistent
  Chrome profile.
- The worker process runs as root inside the container (Chromium + Xvfb
  need it). Keep the container isolated.

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `DASHBOARD_PORT` | `3333` | HTTP port for the dashboard |
| `OUTPUT_DIR` | `/recordings` | Where recordings land |
| `PROFILE_DIR` | `/var/lib/meet-profile` | Persistent Chrome profile |
| `JOBS_DIR` | `/var/lib/meet-recorder` | jobs.json lives here |
| `SEGMENT_SECONDS` | `600` | ffmpeg segment length |
| `CHROME_PATH` | `/usr/bin/google-chrome-stable` | Chrome binary |
| `DASHBOARD_AUTH` | empty | `user:password` for HTTP Basic |
| `ALLOW_COOKIE_INJECTION` | `0` | Legacy escape hatch. `1` re-enables `POST /api/cookies` |
| `DISPLAY` | `:99` | X display |
| `COOKIES_PATH` | `/app/cookies.json` | Legacy cookies file (unused when injection is off) |

## What changed from the previous version

- Chrome now uses a persistent profile via `launchPersistentContext`,
  not an ephemeral `newContext` with injected cookies.
- Cookies are no longer required. The `cookies.json` file is kept on disk
  for reference but is no longer read on the normal flow.
- Stealth plugin removed. No anti-detection tricks.
- Hard-coded User-Agent removed. Chrome speaks for itself.
- A VNC stack is added so the user can sign in to Google once through
  the real Chrome UI.
- Recordings are segmented (default 10 min each), stored under
  `/recordings/YYYY/MM/DD/<jobId>/part-NNN.mp4`.
- A structured JSON logger replaces ad-hoc console logs.
- A state machine with explicit failure classification replaces the
  scattered status updates.
- Dashboard is rewritten with a status header, system-health card,
  start form, active-recording card with live screenshot, recording
  history with search/filter/play/delete, and a VNC setup panel.
- Job metadata persists in `jobs.json`; the previous implementation
  kept it only in memory.
- Docker config: named volume for the profile, healthcheck, restart
  policy, loopback-only ports.