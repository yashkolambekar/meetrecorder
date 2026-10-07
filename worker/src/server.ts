// HTTP server for the recorder dashboard + REST API.
//
// Routes (legacy + new):
//   GET  /                              — dashboard HTML
//   GET  /static/*                       — dashboard CSS/JS
//   GET  /screenshot                     — legacy; returns latest JPEG of active page
//   GET  /status                         — legacy; current job status
//   POST /api/jobs                       — start a job
//   POST /api/jobs/:id/abort             — abort a job
//   GET  /api/jobs                       — list jobs
//   GET  /api/jobs/:id                   — one job
//   DELETE /api/jobs/:id                 — delete job + segments
//   GET  /api/jobs/:id/screenshot        — page screenshot
//   GET  /api/profile/status             — profile readiness
//   POST /api/profile/check              — force profile re-check
//   GET  /api/system                     — CPU/RAM/disk/process metrics
//   GET  /api/recordings/:jobId/:file    — stream a segment (safe-join)
//   POST /api/cookies                    — legacy; 410 unless ALLOW_COOKIE_INJECTION=1

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Page } from 'playwright';
import { BrowserManager } from './browserManager';
import { joinAndRecord, JoinOpts, JoinResult } from './joinAndRecord';
import { JobStore, JobRecord, JobState, extractMeetCode, deriveJobOutDir } from './jobStore';
import { getProfileStatus, ProfileStatus } from './profile';
import { info, warn, error, debug } from './log';

export interface WorkerStatus {
  state: JobState;
  busy: boolean;
  jobId?: string;
  meetUrl?: string;
  meetCode?: string;
  botName?: string;
  startedAt?: number;
  elapsedSec?: number;
  outDir?: string;
  failureReason?: string;
  failureDetail?: string;
  bytes?: number;
  lastUpdate?: number;
}

interface RunningJobHandle {
  jobId: string;
  promise: Promise<JoinResult>;
  abortFlag: { aborted: boolean };
}

const MAX_BODY = 2 * 1024 * 1024;
const SYSTEM_CACHE_MS = 5_000;
const SCREENSHOT_CACHE_MS = 1500;

let status: WorkerStatus = { state: 'IDLE', busy: false, lastUpdate: Date.now() };
let statusUpdateQueued = false;

let jobStore: JobStore | null = null;
let jobsDir = process.env.JOBS_DIR || '/var/lib/meet-recorder';
let outputDir = process.env.OUTPUT_DIR || '/recordings';
let profileDir = process.env.PROFILE_DIR || '/var/lib/meet-profile';
let chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
let dashboardAuth = process.env.DASHBOARD_AUTH || '';
let allowCookieInjection = process.env.ALLOW_COOKIE_INJECTION === '1';

let running: RunningJobHandle | null = null;
let screenshotCache: { ts: number; buf: Buffer | null } = { ts: 0, buf: null };
let screenshotInFlight: Promise<Buffer | null> | null = null;
let systemCache: { ts: number; body: any } = { ts: 0, body: null };
let profileCache: { ts: number; body: ProfileStatus } | null = null;

export function setStatus(s: Partial<WorkerStatus>): void {
  status = { ...status, ...s, lastUpdate: Date.now() };
  if (!statusUpdateQueued) {
    statusUpdateQueued = true;
    setImmediate(() => {
      statusUpdateQueued = false;
      // (No-op for now; future hook for WS push.)
    });
  }
}

export function getStatus(): WorkerStatus {
  return { ...status };
}

function authHeaderFor(req: http.IncomingMessage): boolean {
  if (!dashboardAuth) return true;
  const expected = 'Basic ' + Buffer.from(dashboardAuth).toString('base64');
  return req.headers['authorization'] === expected;
}

function sendAuthChallenge(res: http.ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="meet-recorder"',
    'Content-Type': 'text/plain',
  });
  res.end('auth required');
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
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

function json(res: http.ServerResponse, code: number, body: any): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function text(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function safeResolve(root: string, name: string): string | null {
  if (!name) return null;
  if (name.includes('..') || name.includes('\0')) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name.length > 200) return null;
  const full = path.resolve(root, name);
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(full);
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + path.sep) && real !== realRoot) return null;
  return full;
}

async function captureScreenshot(page: Page | null): Promise<Buffer | null> {
  if (!page) return null;
  if (screenshotInFlight) return screenshotInFlight;
  screenshotInFlight = (async () => {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      screenshotCache = { ts: Date.now(), buf };
      return buf;
    } catch (e: any) {
      warn('screenshot_failed', { error: e.message });
      return screenshotCache.buf;
    } finally {
      screenshotInFlight = null;
    }
  })();
  return screenshotInFlight;
}

async function systemMetrics() {
  const now = Date.now();
  if (systemCache.ts && now - systemCache.ts < SYSTEM_CACHE_MS) return systemCache.body;
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const processMem = process.memoryUsage();
  const loadAvg = os.loadavg();

  let diskTotal = 0, diskFree = 0;
  try {
    const s = fs.statfsSync(outputDir);
    diskTotal = s.blocks * s.bsize;
    diskFree = s.bavail * s.bsize;
  } catch {}

  let recordingsBytes = 0;
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync(`du -sb ${outputDir} 2>/dev/null || echo 0`).toString().trim().split('\n')[0];
    recordingsBytes = parseInt(out, 10) || 0;
  } catch {}

  let profileBytes = 0;
  try {
    const st = fs.statSync(profileDir);
    if (st.isDirectory()) {
      const { execSync } = await import('node:child_process');
      const out = execSync(`du -sb ${profileDir} 2>/dev/null || echo 0`).toString().trim().split('\n')[0];
      profileBytes = parseInt(out, 10) || 0;
    }
  } catch {}

  const mgr = BrowserManager.getInstance();
  const ctx = mgr.contextIfRunning();
  const chromeRunning = ctx !== null;

  const body = {
    cpu: {
      count: cpuCount,
      loadAvg: loadAvg.map((x) => Math.round(x * 100) / 100),
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: totalMem - freeMem,
      processRssBytes: processMem.rss,
      processHeapBytes: processMem.heapUsed,
    },
    disk: {
      recordingsBytes,
      recordingsTotalBytes: diskTotal,
      recordingsFreeBytes: diskFree,
      profileBytes,
    },
    chrome: {
      running: chromeRunning,
      profilePath: profileDir,
    },
    ffmpeg: {
      running: running !== null,
    },
    uptimeSec: Math.round(process.uptime()),
    ts: now,
  };
  systemCache = { ts: now, body };
  return body;
}

async function startJob(opts: JoinOpts): Promise<{ jobId: string }> {
  if (running) {
    const err: any = new Error('a job is already running');
    err.statusCode = 409;
    throw err;
  }
  await fsp.mkdir(opts.outputDir, { recursive: true });
  const abortFlag = { aborted: false };

  const job = joinAndRecord({
    ...opts,
    onState: (state, extra) => {
      setStatus({
        state,
        jobId: opts.jobId,
        meetUrl: opts.meetUrl,
        botName: opts.botName,
        ...extra,
      } as Partial<WorkerStatus>);
    },
    onAbortRequest: () => {
      abortFlag.aborted = true;
      return true;
    },
  });

  running = { jobId: opts.jobId, promise: job, abortFlag };
  try {
    const result = await job;
    info('job_finished', { jobId: opts.jobId, result });
    setStatus({
      state: result.state,
      jobId: opts.jobId,
      failureReason: result.failureReason,
      failureDetail: result.failureDetail,
      bytes: result.bytes,
      elapsedSec: result.durationSec,
      busy: false,
    });
  } catch (e: any) {
    error('job_failed', { jobId: opts.jobId, error: e.message });
    setStatus({
      state: 'FAILED',
      jobId: opts.jobId,
      failureReason: 'UNKNOWN_FAILURE',
      failureDetail: e.message?.slice(0, 200),
      busy: false,
    });
  } finally {
    running = null;
  }
  return { jobId: opts.jobId };
}

async function abortJob(jobId: string): Promise<boolean> {
  if (!running || running.jobId !== jobId) return false;
  running.abortFlag.aborted = true;
  // Try to close the page; joinAndRecord will tear down on its own.
  try {
    const ctx = BrowserManager.getInstance().contextIfRunning();
    if (ctx) {
      const pages = ctx.pages();
      for (const p of pages) {
        try { await p.close({ runBeforeUnload: false }); } catch {}
      }
    }
  } catch {}
  return true;
}

export async function startServer(port: number, publicDir: string): Promise<http.Server> {
  jobStore = await JobStore.init(path.join(jobsDir, 'jobs.json'));
  // Mark any jobs left in RECORDING/STOPPING/etc. as FAILED with reason INTERRUPTED.
  await recoverInterruptedJobs();

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const method = req.method || 'GET';

    try {
      // Static dashboard
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        const html = await fsp.readFile(path.join(publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (method === 'GET' && url.startsWith('/static/')) {
        const sub = url.slice('/static/'.length);
        const safe = safeResolve(publicDir, sub);
        if (!safe || !fs.existsSync(safe)) return text(res, 404, 'not found');
        const ext = path.extname(safe).toLowerCase();
        const mime: Record<string, string> = {
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
        };
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(safe).pipe(res);
        return;
      }

      // Auth gate — applies to all API routes
      if (url.startsWith('/api/') && !authHeaderFor(req)) {
        sendAuthChallenge(res);
        return;
      }

      // Legacy screenshot
      if (method === 'GET' && (url === '/screenshot' || url.startsWith('/screenshot?'))) {
        const page = currentPage();
        const buf = await captureScreenshot(page);
        if (!buf) return text(res, 503, 'no screenshot available');
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
        });
        res.end(buf);
        return;
      }

      // Legacy status
      if (method === 'GET' && (url === '/status' || url.startsWith('/status?'))) {
        return json(res, 200, { ...status, busy: running !== null });
      }

      // POST /api/jobs
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
        const meetCode = extractMeetCode(meetUrl);

        setStatus({
          state: 'STARTING',
          jobId,
          meetUrl,
          meetCode,
          botName,
          busy: true,
          startedAt: Date.now(),
          elapsedSec: 0,
        } as Partial<WorkerStatus>);

        startJob({ meetUrl, jobId, botName, outputDir, skipRecording, maxDurationSec, jobStore: jobStore! })
          .catch(() => { /* status already set */ });

        return json(res, 202, { jobId });
      }

      // POST /api/jobs/:id/abort
      const abortMatch = url.match(/^\/api\/jobs\/([^/]+)\/abort$/);
      if (method === 'POST' && abortMatch) {
        const ok = await abortJob(decodeURIComponent(abortMatch[1]));
        if (!ok) return json(res, 409, { error: 'no such running job' });
        return json(res, 200, { aborted: true });
      }

      // GET /api/jobs
      if (method === 'GET' && url === '/api/jobs') {
        return json(res, 200, { jobs: jobStore!.list() });
      }

      // GET /api/jobs/:id
      const jobMatch = url.match(/^\/api\/jobs\/([^/]+)$/);
      if (method === 'GET' && jobMatch) {
        const rec = jobStore!.get(decodeURIComponent(jobMatch[1]));
        if (!rec) return json(res, 404, { error: 'not found' });
        return json(res, 200, rec);
      }

      // GET /api/jobs/:id/screenshot
      const jobShotMatch = url.match(/^\/api\/jobs\/([^/]+)\/screenshot$/);
      if (method === 'GET' && jobShotMatch) {
        const rec = jobStore!.get(decodeURIComponent(jobShotMatch[1]));
        if (!rec) return json(res, 404, { error: 'not found' });
        const page = currentPage();
        if (!page) return text(res, 503, 'no active page');
        const buf = await captureScreenshot(page);
        if (!buf) return text(res, 503, 'capture failed');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(buf);
        return;
      }

      // DELETE /api/jobs/:id
      if (method === 'DELETE' && jobMatch) {
        const rec = jobStore!.get(decodeURIComponent(jobMatch[1]));
        if (!rec) return json(res, 404, { error: 'not found' });
        // Don't allow delete of running job
        if (running && running.jobId === rec.jobId) {
          return json(res, 409, { error: 'cannot delete running job' });
        }
        // Remove segments from disk
        try {
          await fsp.rm(rec.outDir, { recursive: true, force: true });
        } catch (e: any) {
          warn('delete_segments_failed', { jobId: rec.jobId, error: e.message });
        }
        await jobStore!.delete(rec.jobId);
        return json(res, 200, { deleted: true });
      }

      // POST /api/browser/open — launches the persistent Chrome on :99 for setup.
      if (method === 'POST' && url === '/api/browser/open') {
        const mgr = BrowserManager.getInstance();
        await mgr.ensureReady();
        const page = await mgr.newPage();
        try {
          await page.goto('https://myaccount.google.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
        } catch {
          // Tolerate Google throttling — page is still on :99.
        }
        return json(res, 200, { ok: true });
      }

      // POST /api/browser/close — shuts down the persistent context. Refused if a job is running.
      if (method === 'POST' && url === '/api/browser/close') {
        if (running) {
          return json(res, 409, { error: 'cannot close browser while a job is running' });
        }
        await BrowserManager.reset();
        return json(res, 200, { ok: true });
      }

      // GET /api/profile/status
      if (method === 'GET' && url === '/api/profile/status') {
        if (profileCache && Date.now() - profileCache.ts < 30_000) {
          return json(res, 200, profileCache.body);
        }
        const p = await getProfileStatus({ profileDir, executablePath: chromePath });
        profileCache = { ts: Date.now(), body: p };
        return json(res, 200, p);
      }

      // POST /api/profile/check
      if (method === 'POST' && url === '/api/profile/check') {
        profileCache = null;
        const p = await getProfileStatus({ profileDir, executablePath: chromePath, force: true });
        profileCache = { ts: Date.now(), body: p };
        return json(res, 200, p);
      }

      // GET /api/system
      if (method === 'GET' && url === '/api/system') {
        return json(res, 200, await systemMetrics());
      }

      // GET /api/recordings/:jobId/:file
      const recMatch = url.match(/^\/api\/recordings\/([^/]+)\/([^/]+)$/);
      if (method === 'GET' && recMatch) {
        const jobId = decodeURIComponent(recMatch[1]);
        const file = decodeURIComponent(recMatch[2]);
        const rec = jobStore!.get(jobId);
        if (!rec) return json(res, 404, { error: 'job not found' });
        const full = safeResolve(rec.outDir, file);
        if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'segment not found' });
        const stat = fs.statSync(full);
        const ext = path.extname(full).toLowerCase();
        const mime = ext === '.mp4' ? 'video/mp4' : (ext === '.json' ? 'application/json' : 'application/octet-stream');
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        if (method === 'HEAD' as any) { res.end(); return; }
        fs.createReadStream(full).pipe(res);
        return;
      }

      // POST /api/cookies (legacy)
      if (method === 'POST' && url === '/api/cookies') {
        if (!allowCookieInjection) {
          return json(res, 410, {
            error: 'cookie injection is disabled. Set ALLOW_COOKIE_INJECTION=1 to enable.',
          });
        }
        const body = await readBody(req);
        let payload: any = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'invalid JSON' }); }
        const content = String(payload.content || '');
        if (!content.trim()) return json(res, 400, { error: 'content is empty' });
        const cookiesPath = process.env.COOKIES_PATH || '/app/cookies.json';
        await fsp.writeFile(cookiesPath, content);
        return json(res, 200, { path: cookiesPath, bytes: Buffer.byteLength(content) });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err: any) {
      const code = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      error('http_error', { url, method, error: err.message });
      json(res, code, { error: String(err?.message ?? err) });
    }
  });

  server.listen(port, () => {
    info('server_listen', { port, pid: process.pid });
  });

  return server;
}

function currentPage(): Page | null {
  const ctx = BrowserManager.getInstance().contextIfRunning();
  if (!ctx) return null;
  const pages = ctx.pages();
  for (const p of pages) {
    if (!p.isClosed()) return p;
  }
  return null;
}

async function recoverInterruptedJobs(): Promise<void> {
  if (!jobStore) return;
  for (const j of jobStore.list()) {
    if (j.state === 'COMPLETED' || j.state === 'FAILED' || j.state === 'ABORTED') continue;
    info('recover_orphaned_job', { jobId: j.jobId, prevState: j.state });
    await jobStore.update(j.jobId, {
      state: 'FAILED',
      failureReason: 'BROWSER_CRASHED',
      failureDetail: `worker restarted while job was in ${j.state}`,
      endedAt: Date.now(),
    });
  }
  await jobStore.flush();
}