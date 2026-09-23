# Dockerized Google Meet Recording Bot — Full Build Plan

## 1. Goal

A self-hosted system where you:
1. Open a web dashboard
2. Paste a Google Meet URL (+ optional bot name / schedule time)
3. Click "Record"
4. A headless bot joins the meeting, records video+audio for the duration
5. The dashboard shows status, and gives you a downloadable MP4 + basic metadata when done

Everything ships via `docker compose up`. No host-level dependency installs.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        docker-compose stack                      │
│                                                                    │
│  ┌──────────────┐    ┌───────────────┐    ┌───────────────────┐  │
│  │  dashboard   │───▶│   api/orchestr │──▶│   postgres (db)    │  │
│  │  (React/Vite)│    │  ator (FastAPI)│    │  jobs, meetings    │  │
│  └──────────────┘    └───────┬───────┘    └───────────────────┘  │
│                               │                                    │
│                               │ spawns / talks to                 │
│                               ▼                                    │
│                     ┌───────────────────┐    ┌──────────────────┐│
│                     │   redis (queue)   │───▶│  bot-worker(s)   ││
│                     └───────────────────┘    │ (N replicas,     ││
│                                               │  each = 1 Chrome ││
│                                               │  + Xvfb + Pulse  ││
│                                               │  + ffmpeg)       ││
│                                               └────────┬─────────┘│
│                                                         │          │
│                                                         ▼          │
│                                               shared volume:       │
│                                               /recordings          │
└─────────────────────────────────────────────────────────────────┘
```

**Why this shape:**
- The dashboard never joins meetings itself — it just files a "job."
- The orchestrator enqueues jobs to Redis; a pool of bot-worker containers pull jobs so you can run several recordings concurrently (one Chrome instance = one meeting, so concurrency = worker replica count).
- Recordings land on a shared Docker volume; the API serves them back to the dashboard for playback/download.

---

## 3. Services (docker-compose)

### 3.1 `dashboard` (frontend)
- React + Vite, served via Nginx in production build
- Talks only to `api` over REST/WebSocket (for live job status)

### 3.2 `api` (orchestrator)
- **Node.js + TypeScript**, using **Fastify** (lighter and faster than Express/NestJS for this scope; swap for NestJS if you want its DI/module structure instead)
- **Prisma** as the ORM against Postgres
- **BullMQ** (Redis-backed) for the job queue — pairs naturally with Redis and gives you retries/backoff/concurrency limits out of the box
- Responsibilities:
  - Accept `POST /jobs` `{meet_url, bot_name, join_at?}`
  - Validate the Meet URL format
  - Write a row to Postgres, push job ID to Redis queue
  - `GET /jobs`, `GET /jobs/{id}` for status polling
  - WebSocket channel for live status (`joining`, `waiting_room`, `recording`, `processing`, `done`, `failed`)
  - Serve `/recordings/{id}.mp4` (or issue pre-signed link if you add S3/minio later)

### 3.3 `worker` (the actual bot) — the core piece
One container image, scaled via `docker compose up --scale worker=3`.

**Base image contents:**
- `node:20-slim` base
- `google-chrome-stable` (not just chromium — Meet behaves better with real Chrome build/branding)
- `xvfb` — virtual X display (Chrome runs "headed" against a fake screen, far less bot-detectable than `--headless=new`)
- `pulseaudio` — virtual audio sink/source so Chrome has a "microphone" to (not) use and a "speaker" we can capture
- `ffmpeg` — screen+audio capture and encoding
- `playwright` (npm package, `playwright install chromium` **or** pointed at system Chrome via `executablePath`) — page automation
- `fonts-liberation`, `libnss3`, `libgbm1`, etc. — standard headless-Chrome runtime libs
- A small bash entrypoint script to launch Xvfb → PulseAudio → the Node worker process in order, then tear down cleanly
- `fluent-ffmpeg` (npm wrapper) or just `child_process.spawn('ffmpeg', [...])` directly — spawn is simpler and avoids an extra dependency

**Worker job flow (`worker/src/joinAndRecord.ts`):**
1. BullMQ worker picks a job off the queue (`meetUrl`, `jobId`, `durationLimit`)
2. Start `Xvfb :99 -screen 0 1920x1080x24`
3. Start PulseAudio with a null sink (`pactl load-module module-null-sink sink_name=MeetSink`), set as default sink
4. Launch Chrome via Playwright (`chromium.launch({ headless: false, executablePath: '/usr/bin/google-chrome-stable', args: [...] })`), with `DISPLAY=:99` in env, pointed at `MeetSink.monitor` as its audio input/output device
5. Navigate to the Meet URL
6. Automation steps:
   - Dismiss "Got it" / permission dialogs
   - Type bot display name into the name field (if prompted, pre-join screen)
   - Toggle camera/mic **off** in the pre-join UI (bot doesn't need to send av)
   - Click "Ask to join"
   - Poll DOM for either (a) admitted into the call (grid/participant view visible) or (b) still in waiting room — set a timeout (e.g., 5 min) and fail the job if never admitted
7. Once admitted: spawn `ffmpeg` capture:
   ```
   ffmpeg -f x11grab -video_size 1920x1080 -framerate 30 -i :99 \
          -f pulse -i MeetSink.monitor \
          -c:v libx264 -preset veryfast -c:a aac \
          -movflags +faststart /recordings/{jobId}.mp4
   ```
8. Monitor the meeting for end conditions:
   - "You left the meeting" / "Meeting ended" screen detected via DOM polling
   - Participant count drops to 1 (just the bot) for N minutes → auto-leave
   - Hard max-duration timeout (safety net, e.g. 3 hours)
9. On end: send `SIGINT` to the ffmpeg child process for a clean finish, close Chrome, update job status → `processing` → `done` via BullMQ/Postgres, write file size/duration metadata
10. Clean up Xvfb/Pulse, BullMQ hands the worker the next job automatically

### 3.4 `redis`
Simple job queue (or Postgres `LISTEN/NOTIFY` if you want to cut a dependency — Redis is cleaner for this).

### 3.5 `postgres`
Tables: `meetings(id, url, bot_name, status, requested_at, started_at, ended_at, file_path, error)`, plus optional `users` if you add auth later.

### 3.6 `nginx` (optional, reverse proxy)
Fronts dashboard + api under one origin/port, handles TLS if exposed beyond localhost.

---

## 4. docker-compose.yml (skeleton)

```yaml
version: "3.9"

services:
  dashboard:
    build: ./dashboard
    ports:
      - "3000:80"
    depends_on:
      - api

  api:
    build: ./api
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://bot:bot@postgres:5432/meetbot
      - REDIS_URL=redis://redis:6379
    volumes:
      - recordings:/recordings
    depends_on:
      - postgres
      - redis

  worker:
    build: ./worker
    environment:
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://bot:bot@postgres:5432/meetbot
    volumes:
      - recordings:/recordings
    shm_size: "2gb"      # Chrome needs this, default 64mb will crash it
    cap_add:
      - SYS_ADMIN        # Chrome sandbox under Xvfb in a container
    deploy:
      replicas: 3         # concurrent meeting capacity
    depends_on:
      - redis
      - postgres

  redis:
    image: redis:7-alpine

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=bot
      - POSTGRES_PASSWORD=bot
      - POSTGRES_DB=meetbot
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  recordings:
  pgdata:
```

---

## 5. Worker Dockerfile (skeleton)

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates \
    xvfb pulseaudio ffmpeg \
    fonts-liberation libnss3 libgbm1 libasound2 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgtk-3-0 \
 && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
 && echo "deb https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

ENTRYPOINT ["./entrypoint.sh"]
```

`entrypoint.sh` brings up Xvfb + PulseAudio, then runs `node dist/worker.js`, which starts the BullMQ worker loop and drives Playwright as described in §3.3. Playwright is told to use the system Chrome (`executablePath: '/usr/bin/google-chrome-stable'`) instead of downloading its own bundled Chromium, so the image stays smaller and matches the exact browser build Meet expects.

---

## 6. Handling Google's Anti-Bot Measures

This is the part that actually determines whether the thing works reliably, so treat it as first-class:

- **Run real Chrome, not headless-mode.** Xvfb + `google-chrome-stable` with no `--headless` flag looks like a normal desktop browser to Meet's client-side checks.
- **Use `playwright-extra` with the `puppeteer-extra-plugin-stealth` port for Playwright** (or manual patches) to mask `navigator.webdriver`, fix plugin/mimetype fingerprints, and normalize WebGL vendor strings.
- **Realistic user agent + viewport**, matching the Xvfb resolution.
- **Use a dedicated Google account** (or anonymous/guest join if the meeting allows it) with a real-looking profile — brand-new throwaway accounts joining repeatedly get flagged faster than an aged account.
- **Auto-admit path**: if you control the Workspace, set org policies so meetings created by your domain auto-admit known accounts, or use a host account with "quick access off but pre-approved" — removes the waiting-room race entirely.
- **Rate/pace joins** — don't spin up 10 bots into 10 different meetings in the same second from the same IP; stagger them.
- Expect DOM selectors to break when Google ships a Meet UI change — isolate all selectors in one `selectors.ts` config file so fixes are a one-file diff.

---

## 7. Dashboard Features (MVP scope)

- **New Recording** form: Meet URL, bot display name, optional scheduled start time
- **Jobs table**: status badges (queued/joining/recording/processing/done/failed), duration, start time
- **Live status** via WebSocket (so "recording — 00:14:32" ticks up in real time)
- **Download/playback** of finished recordings (HTML5 `<video>` pointing at `/recordings/{id}.mp4`)
- **Retry/cancel** buttons for stuck or failed jobs

---

## 8. Scaling & Concurrency Notes

- Each `worker` replica = exactly one Chrome/one meeting at a time. Concurrency ceiling = number of replicas.
- CPU is the bottleneck (x264 encoding + Chrome rendering). Budget roughly 1–2 vCPU per concurrent recording; test and tune `-preset` in ffmpeg (`veryfast`/`ultrafast` trade quality for headroom).
- `shm_size: 2gb` on the worker service is not optional — Chrome will crash under the container default of 64MB.
- If you outgrow single-host Docker Compose, the same worker image runs unchanged on Kubernetes as a `Job`/`Deployment`, swap Redis for a real queue if needed (same interface).

---

## 9. Storage & Retention

- MVP: local named volume (`recordings`), served straight off disk by the API.
- Add a `RETENTION_DAYS` env var + a small cron/worker task that deletes files and marks DB rows expired — recordings add up fast.
- If you outgrow local disk: swap the volume mount for a MinIO (S3-compatible, dockerized) sidecar with almost no code change — upload from ffmpeg's output path, store the object key in Postgres instead of a local path.

---

## 10. Security / Legal Notes (not exhaustive — check your jurisdiction)

- Recording meeting participants without consent is illegal in many places (two-party consent states/countries). Build in a step where the bot's presence is visible in the participant list with a clearly labeled name (e.g., "Recording Bot — ask host to remove if unwanted"), and ideally have the meeting host announce/consent verbally or via chat.
- Automating a Google account against Meet's client is against Google's Terms of Service — this is inherent to the "headless bot joins meeting" approach (there's no way around it short of using the official Workspace recording API, which doesn't give you a bot to customize). Flagging this so it's a deliberate choice, not a surprise later.
- Keep the dashboard behind auth (even basic auth via Nginx) if exposed beyond `localhost`.

---

## 11. Suggested Repo Layout

```
meet-recorder/
├── docker-compose.yml
├── dashboard/
│   ├── Dockerfile
│   └── src/...
├── api/
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── server.ts        # Fastify app, routes
│   │   ├── schema.prisma
│   │   └── queue.ts         # BullMQ producer
│   └── tsconfig.json
├── worker/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   ├── package.json
│   ├── src/
│   │   ├── worker.ts        # BullMQ consumer, entrypoint
│   │   ├── joinAndRecord.ts
│   │   └── selectors.ts
│   └── tsconfig.json
└── .env.example
```

---

## 12. Build Order (practical milestones)

1. Get `worker` joining a test Meet call manually (script run locally, watch via VNC into the Xvfb display) — validate selectors and admit flow before automating anything else.
2. Add ffmpeg capture to that same script, confirm a clean MP4 comes out with audio synced.
3. Wrap the join+record script in the Redis-polling loop; wire up Postgres status updates.
4. Build the minimal API (`POST /jobs`, `GET /jobs`) and confirm end-to-end via `curl`.
5. Build the dashboard on top of the working API.
6. Add scaling (`--scale worker=N`), retention cleanup, and hardening (stealth, retries, timeouts) last.

Steps 1–2 are the highest-risk, do those first before investing in the dashboard/API scaffolding.
