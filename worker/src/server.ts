// HTTP server for the recorder dashboard. Serves:
//   GET  /                       — dashboard HTML
//   GET  /screenshot             — latest JPEG of the current meeting
//   GET  /status                 — JSON status of the current/last job
//   POST /api/jobs               — { meetUrl, botName, maxDurationSec, skipRecording } → start a job
//   POST /api/jobs/abort         — kill the running browser (returns 409 if no job)
//   POST /api/cookies            — { content: string } (raw cookies.json text) → write to /app/cookies.json
//   GET  /api/recordings         — JSON list of { name, sizeBytes, mtimeMs } in OUTPUT_DIR
//   GET  /api/recordings/:name   — stream an mp4 file
//
// Only one job can run at a time. /api/jobs returns 409 if one is in flight.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, Page } from 'playwright';
import { joinAndRecord, JoinOpts } from './joinAndRecord';

export interface WorkerStatus {
  state: 'idle' | 'joining' | 'admitted' | 'recording' | 'ending' | 'failed' | 'done';
  meetUrl?: string;
  jobId?: string;
  botName?: string;
  startedAt?: number;     // ms epoch when admitted (or job started)
  elapsedSec?: number;    // updated periodically
  outFile?: string;
  error?: string;
  lastUpdate?: number;    // ms epoch
  startedAtJobMs?: number;
  finishedAtJobMs?: number;
  exitReason?: 'completed' | 'aborted' | 'failed' | null;
}

let latestScreenshot: Buffer | null = null;
let status: WorkerStatus = { state: 'idle', lastUpdate: Date.now() };

export function setLatestScreenshot(buf: Buffer | null): void {
  latestScreenshot = buf;
}

export function setStatus(s: Partial<WorkerStatus>): void {
  status = { ...status, ...s, lastUpdate: Date.now() };
}

export function getStatus(): WorkerStatus {
  return status;
}

// --- Job tracking ---
let currentBrowser: Browser | null = null;
let currentPage: Page | null = null;
let currentJobPromise: Promise<void> | null = null;
let captureInFlight: Promise<Buffer | null> | null = null;

function defaultOutputDir(): string {
  return process.env.OUTPUT_DIR || '/recordings';
}

function defaultCookiesPath(): string {
  return process.env.COOKIES_PATH || '/app/cookies.json';
}

function safeJoin(root: string, name: string): string | null {
  // Prevent path traversal: name must be a plain filename with no separators.
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return path.join(root, name);
}

async function startJob(opts: JoinOpts): Promise<{ jobId: string }> {
  if (currentJobPromise) {
    const err: any = new Error('a job is already running');
    err.statusCode = 409;
    throw err;
  }
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const job = joinAndRecord({
    ...opts,
    onBrowser: (b) => { currentBrowser = b; },
    onPage:    (p) => { currentPage = p; },
  });
  currentJobPromise = job;
  try {
    await job;
    setStatus({ state: 'done', exitReason: 'completed', finishedAtJobMs: Date.now() });
  } catch (err) {
    setStatus({
      state: 'failed',
      error: String((err as Error).message ?? err),
      exitReason: 'failed',
      finishedAtJobMs: Date.now(),
    });
  } finally {
    currentBrowser = null;
    currentPage = null;
    currentJobPromise = null;
  }
  return { jobId: opts.jobId };
}

async function captureScreenshot(): Promise<Buffer | null> {
  // Serialize so rapid clicks don't pile up multiple captures.
  if (captureInFlight) return captureInFlight;
  if (!currentPage) return null;
  const page = currentPage;
  captureInFlight = (async () => {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      setLatestScreenshot(buf);
      return buf;
    } catch (e) {
      console.warn('[server] screenshot capture failed:', (e as Error).message);
      return null;
    } finally {
      captureInFlight = null;
    }
  })();
  return captureInFlight;
}

async function abortJob(): Promise<boolean> {
  if (!currentBrowser) return false;
  try {
    await currentBrowser.close();
    setStatus({ state: 'ending', exitReason: 'aborted' });
    return true;
  } catch {
    return false;
  }
}

// --- Request body parsing ---
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 2 * 1024 * 1024; // 2 MB cap — cookies.json is tiny, recordings are streamed separately
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function text(res: http.ServerResponse, code: number, body: string) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

export function startServer(port: number, publicDir: string): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    try {
      // --- Static dashboard ---
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        const html = fs.readFileSync(path.join(publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // --- Live screenshot (capture on demand) ---
      if (method === 'GET' && url.startsWith('/screenshot')) {
        const buf = await captureScreenshot();
        if (!buf) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('no screenshot available — no job running');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
        });
        res.end(buf);
        return;
      }

      // --- Live status ---
      if (method === 'GET' && (url === '/status' || url.startsWith('/status?'))) {
        const body = JSON.stringify({ ...status, busy: currentJobPromise !== null });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }

      // --- Start a job ---
      if (method === 'POST' && url === '/api/jobs') {
        const body = await readBody(req);
        let payload: any = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'invalid JSON' }); }

        const meetUrl = String(payload.meetUrl || '').trim();
        const botName = String(payload.botName || 'Recording Bot').trim() || 'Recording Bot';
        const maxDurationSec = Math.max(0, Math.floor(Number(payload.maxDurationSec ?? 0)));
        const skipRecording = payload.skipRecording === true || payload.skipRecording === '1';

        if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(meetUrl)) {
          return json(res, 400, { error: 'meetUrl must look like https://meet.google.com/abc-defg-hij' });
        }

        const jobId = `web-${Date.now()}`;
        const outputDir = defaultOutputDir();

        setStatus({
          state: 'joining',
          meetUrl,
          jobId,
          botName,
          outFile: path.join(outputDir, `${jobId}.mp4`),
          startedAtJobMs: Date.now(),
          startedAt: Date.now(),
          elapsedSec: 0,
          error: undefined,
          exitReason: null,
          finishedAtJobMs: undefined,
        });

        // Fire and forget — the dashboard polls /status for progress.
        startJob({ meetUrl, jobId, botName, outputDir, skipRecording, maxDurationSec })
          .catch(() => { /* errors are recorded into status */ });

        return json(res, 202, { jobId });
      }

      // --- Abort current job ---
      if (method === 'POST' && url === '/api/jobs/abort') {
        const ok = await abortJob();
        if (!ok) return json(res, 409, { error: 'no job running' });
        return json(res, 200, { aborted: true });
      }

      // --- Replace cookies.json ---
      if (method === 'POST' && url === '/api/cookies') {
        const body = await readBody(req);
        let payload: any = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'invalid JSON' }); }
        const content = String(payload.content || '');
        if (!content.trim()) return json(res, 400, { error: 'content is empty' });

        // Validate it looks like JSON or a Netscape cookie file before writing.
        const trimmed = content.trim();
        let looksValid = false;
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try { JSON.parse(trimmed); looksValid = true; } catch {}
        } else if (trimmed.startsWith('#') || trimmed.includes('\t')) {
          // Accept any tab-separated cookies file; we parse loosely on load.
          looksValid = true;
        }
        if (!looksValid) return json(res, 400, { error: 'cookies must be JSON array or Netscape cookie file' });

        const cookiesPath = defaultCookiesPath();
        fs.writeFileSync(cookiesPath, content);
        return json(res, 200, { path: cookiesPath, bytes: Buffer.byteLength(content) });
      }

      // --- List recordings ---
      if (method === 'GET' && url === '/api/recordings') {
        const dir = defaultOutputDir();
        let entries: { name: string; sizeBytes: number; mtimeMs: number }[] = [];
        try {
          for (const f of fs.readdirSync(dir)) {
            if (!f.toLowerCase().endsWith('.mp4')) continue;
            const full = path.join(dir, f);
            const st = fs.statSync(full);
            entries.push({ name: f, sizeBytes: st.size, mtimeMs: st.mtimeMs });
          }
          entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
        } catch (e) {
          return json(res, 500, { error: 'cannot list recordings: ' + (e as Error).message });
        }
        return json(res, 200, { dir, recordings: entries });
      }

      // --- Download a recording ---
      if (method === 'GET' && url.startsWith('/api/recordings/')) {
        const name = decodeURIComponent(url.slice('/api/recordings/'.length));
        const safe = safeJoin(defaultOutputDir(), name);
        if (!safe || !fs.existsSync(safe)) return text(res, 404, 'not found');
        const stat = fs.statSync(safe);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${path.basename(safe)}"`,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(safe).pipe(res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err: any) {
      const code = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      console.error('[server] error:', err);
      json(res, code, { error: String(err?.message ?? err) });
    }
  });

  server.listen(port, () => {
    console.log(`[server] dashboard listening on http://0.0.0.0:${port}`);
  });

  return server;
}
