// Pipeline for one recording job. Consumes:
//   - BrowserManager (persistent Chrome profile)
//   - Recorder     (ffmpeg child + segmentation)
//   - JobStore     (per-job metadata)
//   - diagnostics  (failure classification)
//
// Replaces the old cookie-injection flow. Cookies are NOT loaded unless
// ALLOW_COOKIE_INJECTION=1 is set (back-compat escape hatch).

import { BrowserContext, Page, Response } from 'playwright';
import * as fs from 'node:fs';
import { BrowserManager } from './browserManager';
import { Recorder } from './recorder';
import { JobStore, JobRecord, JobState, extractMeetCode, deriveJobOutDir } from './jobStore';
import { classifyEndSignal, groupForSelector, FailureReason, ClassifyOutput } from './diagnostics';
import {
  acceptCookiesCandidates,
  askToJoinCandidates,
  cameraToggleCandidates,
  micToggleCandidates,
  nameInputCandidates,
  inCallCandidates,
  moreOptionsButtonCandidates,
  adjustViewMenuItemCandidates,
  spotlightOptionCandidates,
  dialogCloseButtonCandidates,
  failureSelectorGroups,
} from './selectors';
import { info, warn, error, debug } from './log';

export interface JoinOpts {
  meetUrl: string;
  jobId: string;
  botName: string;
  outputDir: string;
  skipRecording?: boolean;
  maxDurationSec?: number;
  jobStore: JobStore;
  onState?: (state: JobState, extra?: Record<string, unknown>) => void;
  onAbortRequest?: () => boolean;
}

export interface JoinResult {
  state: JobState;
  failureReason?: FailureReason;
  failureDetail?: string;
  bytes: number;
  durationSec: number;
}

interface PollState {
  aborted: boolean;
  browserDisconnected: boolean;
  pageError: { message: string } | null;
  matchedGroup?: 'auth' | 'removed' | 'reconnecting' | 'cannotJoin' | 'ended';
  matchedSelector?: string;
  lastUrl: string;
  lastTitle: string;
  startedAtMs: number;
  reason: FailureReason | null;
  reasonDetail: string | null;
  maxDurationTimer?: NodeJS.Timeout;
}

async function tryClickAny(page: Page, candidates: string[], label: string, jobId: string): Promise<boolean> {
  for (const sel of candidates) {
    try {
      await page.click(sel, { timeout: 4000 });
      info('clicked', { jobId, label, sel });
      return true;
    } catch {}
  }
  return false;
}

export async function joinAndRecord(opts: JoinOpts): Promise<JoinResult> {
  const { meetUrl, jobId, botName, outputDir, skipRecording, maxDurationSec, jobStore } = opts;
  const startedAtMs = Date.now();
  const meetCode = extractMeetCode(meetUrl);
  const outDir = deriveJobOutDir(outputDir, jobId, startedAtMs);

  const baseRec: JobRecord = {
    jobId,
    meetUrl,
    meetCode,
    botName,
    maxDurationSec,
    startedAt: startedAtMs,
    state: 'STARTING',
    outDir,
    segments: [],
    totalBytes: 0,
    skipRecording: !!skipRecording,
  };
  await jobStore.create(baseRec);
  setState(opts, 'STARTING', { jobId, meetUrl, meetCode, outDir });

  let page: Page | null = null;
  let recorder: Recorder | null = null;
  let result: JoinResult | null = null;

  const pollState: PollState = {
    aborted: false,
    browserDisconnected: false,
    pageError: null,
    lastUrl: '',
    lastTitle: '',
    startedAtMs,
    reason: null,
    reasonDetail: null,
  };

  try {
    const mgr = BrowserManager.getInstance();
    setState(opts, 'BROWSER_STARTING', { jobId });
    const context = await mgr.ensureReady();
    setState(opts, 'AUTH_CHECK', { jobId });

    if (process.env.ALLOW_COOKIE_INJECTION === '1') {
      const cookiesPath = process.env.COOKIES_PATH || '/app/cookies.json';
      if (fs.existsSync(cookiesPath)) {
        warn('cookie_injection_enabled', { jobId, cookiesPath });
        await injectCookiesFromFile(context, cookiesPath);
      } else {
        warn('cookie_injection_no_file', { jobId, cookiesPath });
      }
    }

    page = await mgr.newPage();
    wirePageDiagnostics(page, pollState, jobId);

    mgr.on('disconnected', (reason) => {
      pollState.browserDisconnected = true;
      pollState.reason = 'BROWSER_CRASHED';
      pollState.reasonDetail = `browser disconnected (${reason})`;
      info('job_browser_disconnected', { jobId });
    });

    setState(opts, 'JOINING', { jobId });

    info('page_goto', { jobId, meetUrl });
    await page.goto(meetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    await tryClickAny(page, acceptCookiesCandidates, 'cookies', jobId);

    let nameSet = false;
    for (const sel of nameInputCandidates) {
      try {
        await page.fill(sel, botName, { timeout: 4000 });
        info('name_filled', { jobId, sel });
        nameSet = true;
        break;
      } catch {}
    }
    if (!nameSet) warn('name_input_not_found', { jobId });

    await tryClickAny(page, cameraToggleCandidates, 'camera', jobId);
    await tryClickAny(page, micToggleCandidates, 'mic', jobId);

    const asked = await tryClickAny(page, askToJoinCandidates, 'ask', jobId);
    if (!asked) {
      throw new Error('Could not find ask-to-join button');
    }

    setState(opts, 'WAITING_FOR_ADMISSION', { jobId });
    info('waiting_for_admit', { jobId, timeoutMs: 5 * 60_000 });

    let admitted = false;
    for (const sel of inCallCandidates) {
      try {
        await page.waitForSelector(sel, { timeout: 5 * 60_000 });
        info('admitted', { jobId, sel });
        admitted = true;
        break;
      } catch {}
    }
    if (!admitted) {
      throw new Error('Never admitted into the call');
    }

    await setSpotlightLayout(page, jobId);
    setState(opts, 'RECORDING', { jobId, admittedAt: Date.now() });

    if (skipRecording) {
      info('skip_recording', { jobId });
      await page.waitForTimeout(3000);
      result = {
        state: 'COMPLETED',
        bytes: 0,
        durationSec: Math.floor((Date.now() - startedAtMs) / 1000),
      };
      return finalize();
    }

    recorder = new Recorder({ jobId, outDir });
    await recorder.start();
    await jobStore.update(jobId, { state: 'RECORDING', outDir });

    recorder.on('exit', (code, signal) => {
      if (code !== 0 || signal) {
        pollState.reason = 'FFMPEG_FAILED';
        pollState.reasonDetail = `ffmpeg exited code=${code} signal=${signal ?? 'none'}`;
        warn('ffmpeg_failed_during_recording', { jobId, code, signal });
      }
    });

    if (maxDurationSec && maxDurationSec > 0) {
      pollState.maxDurationTimer = setTimeout(() => {
        pollState.reason = 'MEETING_ENDED';
        pollState.reasonDetail = `max duration ${maxDurationSec}s reached`;
        info('max_duration_reached', { jobId, maxDurationSec });
      }, maxDurationSec * 1000);
    }

    await waitForMeetingEnd(page, jobId, pollState, recorder);

    setState(opts, 'STOPPING', { jobId });
    const recResult = await recorder.stop();
    setState(opts, 'FINALIZING', { jobId });

    let reason: FailureReason | null = pollState.reason;
    let detail = pollState.reasonDetail ?? '';

    if (!recResult.ok) {
      reason = 'FFMPEG_FAILED';
      detail = recResult.detail;
    }
    if (pollState.aborted) {
      reason = 'ABORTED';
      detail = 'user aborted';
    }
    if (!reason) reason = 'MEETING_ENDED';

    const _classification: ClassifyOutput = { reason, detail };

    result = {
      state: reason === 'ABORTED' ? 'ABORTED' : (reason === 'MEETING_ENDED' ? 'COMPLETED' : 'FAILED'),
      failureReason: reason === 'MEETING_ENDED' ? undefined : reason,
      failureDetail: detail,
      bytes: recResult.totalBytes,
      durationSec: Math.floor((Date.now() - startedAtMs) / 1000),
    };

    info('job_end', {
      jobId,
      state: result.state,
      reason: result.failureReason ?? 'OK',
      detail,
      bytes: result.bytes,
      durationSec: result.durationSec,
    });
    void _classification;
    return finalize();
  } catch (e: any) {
    error('job_threw', { jobId, error: e.message });
    setState(opts, 'FAILED', { jobId, error: e.message });
    let bytes = 0;
    if (recorder) {
      try {
        const s = await recorder.status();
        bytes = s.bytes;
        await recorder.stop(2000);
      } catch {}
    }
    if (!result) {
      result = {
        state: 'FAILED',
        failureReason: classifyException(e),
        failureDetail: e.message?.slice(0, 200),
        bytes,
        durationSec: Math.floor((Date.now() - startedAtMs) / 1000),
      };
    }
    return finalize();
  } finally {
    if (pollState.maxDurationTimer) clearTimeout(pollState.maxDurationTimer);
    if (page) await BrowserManager.getInstance().closePage(page);
  }

  function finalize(): JoinResult {
    const r = result!;
    void jobStore.update(jobId, {
      state: r.state,
      failureReason: r.failureReason,
      failureDetail: r.failureDetail,
      endedAt: Date.now(),
      durationSec: r.durationSec,
      totalBytes: r.bytes,
    }).catch(() => undefined);
    return r;
  }
}

function classifyException(e: any): FailureReason {
  const m = String(e?.message ?? '').toLowerCase();
  if (m.includes('never admitted')) return 'CANNOT_JOIN';
  if (m.includes('ask-to-join')) return 'CANNOT_JOIN';
  if (m.includes('target page') || m.includes('page closed')) return 'BROWSER_CRASHED';
  if (m.includes('navigation')) return 'BROWSER_CRASHED';
  return 'UNKNOWN_FAILURE';
}

function wirePageDiagnostics(page: Page, state: PollState, jobId: string): void {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    const prev = state.lastUrl;
    state.lastUrl = url;
    info('framenavigated', { jobId, from: prev ?? '', to: url });
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    debug('console', { jobId, type: msg.type(), text: msg.text().slice(0, 300) });
  });

  page.on('pageerror', (err) => {
    state.pageError = { message: err.message };
    warn('pageerror', { jobId, error: err.message.slice(0, 300) });
  });

  page.on('response', (resp: Response) => {
    const url = resp.url();
    const status = resp.status();
    if (status < 400) return;
    if (!/(accounts\.google\.com|meet\.google\.com)/i.test(url)) return;
    warn('http_error', { jobId, status, url });
  });
}

async function waitForMeetingEnd(
  page: Page,
  jobId: string,
  state: PollState,
  recorder: Recorder | null,
): Promise<void> {
  let lastHeartbeat = 0;
  while (true) {
    if (state.aborted) return;
    if (state.browserDisconnected) return;
    if (state.reason) return;
    if (state.pageError) {
      await page.waitForTimeout(2000).catch(() => undefined);
      if (!page.isClosed()) {
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
          await page.waitForTimeout(1000);
          state.pageError = null;
          continue;
        } catch {}
      }
      return;
    }

    // Capture URL + title for failure classification.
    try {
      state.lastUrl = page.url();
      state.lastTitle = await page.title();
    } catch {}

    const pollResult = await probeFailureSelectors(page);
    if (pollResult) {
      state.matchedGroup = pollResult.group;
      state.matchedSelector = pollResult.selector;
      const cls = classifyEndSignal({
        url: state.lastUrl,
        title: state.lastTitle,
        matchedGroup: pollResult.group,
        matchedSelector: pollResult.selector,
        browserDisconnected: state.browserDisconnected,
        pageError: state.pageError ?? undefined,
      });
      state.reason = cls.reason;
      state.reasonDetail = cls.detail;
      info('meeting_signal', { jobId, group: pollResult.group, selector: pollResult.selector, reason: cls.reason });
      return;
    }

    const now = Date.now();
    if (now - lastHeartbeat > 30_000) {
      lastHeartbeat = now;
      const status = recorder ? await recorder.status() : null;
      const mem = process.memoryUsage();
      info('heartbeat', {
        jobId,
        elapsedSec: Math.floor((now - state.startedAtMs) / 1000),
        url: state.lastUrl,
        title: state.lastTitle,
        bytes: status?.bytes ?? 0,
        segments: status?.segments.length ?? 0,
        rssMB: Math.round(mem.rss / 1024 / 1024),
      });
    }

    await page.waitForTimeout(5000).catch(() => undefined);
  }
}

async function probeFailureSelectors(page: Page): Promise<{ group: 'auth' | 'removed' | 'reconnecting' | 'cannotJoin' | 'ended'; selector: string } | null> {
  for (const group of failureSelectorGroups) {
    for (const sel of group.candidates) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await el.textContent().catch(() => sel);
          const resolvedGroup = groupForSelector(text ?? '') ?? group.group;
          if (resolvedGroup === group.group) {
            return { group: group.group, selector: sel };
          }
        }
      } catch {}
    }
  }
  return null;
}

async function setSpotlightLayout(page: Page, jobId: string): Promise<void> {
  info('ui_setting_spotlight', { jobId });
  let opened = false;
  for (const sel of moreOptionsButtonCandidates) {
    try {
      await page.click(sel, { timeout: 3000 });
      info('clicked', { jobId, label: 'moreOptions', sel });
      opened = true;
      break;
    } catch {}
  }
  if (!opened) { warn('more_options_not_found', { jobId }); return; }
  await page.waitForTimeout(500);
  let layoutClicked = false;
  for (const sel of adjustViewMenuItemCandidates) {
    try {
      await page.click(sel, { timeout: 3000 });
      info('clicked', { jobId, label: 'adjustView', sel });
      layoutClicked = true;
      break;
    } catch {}
  }
  if (!layoutClicked) {
    warn('adjust_view_not_found', { jobId });
    await page.keyboard.press('Escape');
    return;
  }
  await page.waitForTimeout(500);
  for (const sel of spotlightOptionCandidates) {
    try {
      await page.click(sel, { timeout: 3000 });
      info('clicked', { jobId, label: 'spotlight', sel });
      break;
    } catch {}
  }
  await page.waitForTimeout(500);
  for (const sel of dialogCloseButtonCandidates) {
    try {
      await page.click(sel, { timeout: 2000 });
      info('clicked', { jobId, label: 'dialogClose', sel });
      break;
    } catch {}
  }
  await page.waitForTimeout(300);
}

function setState(opts: JoinOpts, state: JobState, extra: Record<string, unknown> = {}): void {
  opts.onState?.(state, extra);
}

async function injectCookiesFromFile(ctx: BrowserContext, cookiesPath: string): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync(cookiesPath, 'utf-8').trim();
  } catch { return; }
  if (!raw) return;

  let parsed: any[] = [];
  try {
    if (raw.startsWith('[') || raw.startsWith('{')) {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) parsed = j;
    } else if (raw.startsWith('#') || raw.includes('\t')) {
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const parts = t.split('\t');
        if (parts.length < 7) continue;
        const [domain, , pathV, secureStr, expirationStr, name, ...vp] = parts;
        parsed.push({
          name,
          value: vp.join('\t'),
          domain,
          path: pathV,
          expires: parseInt(expirationStr, 10) || -1,
          secure: secureStr === 'TRUE',
        });
      }
    }
  } catch {
    return;
  }

  const filtered = parsed
    .filter((c: any) => c?.domain?.includes('google.com'))
    .map((c: any) => {
      let domain: string = c.domain || c.host || '';
      if (!domain.startsWith('.')) domain = '.' + domain;
      return {
        name: String(c.name),
        value: String(c.value),
        domain,
        path: c.path || '/',
        expires:
          typeof c.expirationDate === 'number' ? c.expirationDate :
          typeof c.expires === 'number' ? c.expires : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: 'Lax' as const,
      };
    });

  if (filtered.length === 0) return;
  await ctx.addCookies(filtered);
  warn('cookies_injected', { count: filtered.length });
}