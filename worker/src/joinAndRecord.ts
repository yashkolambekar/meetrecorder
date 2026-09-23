import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Page } from 'playwright';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as selectors from './selectors';
import { setLatestScreenshot, setStatus } from './server';

chromium.use(stealth());

export interface JoinOpts {
  meetUrl: string;
  jobId: string;
  botName: string;
  outputDir: string;
  skipRecording?: boolean;
  maxDurationSec?: number;
  onBrowser?: (browser: import('playwright').Browser) => void;
  onPage?: (page: import('playwright').Page) => void;
}

const DEBUG = process.env.DEBUG !== '0'; // default on while we develop; set DEBUG=0 to silence

function loadGoogleCookies(): any[] {
  const cookiesPath = process.env.COOKIES_PATH || '/app/cookies.json';
  if (!fs.existsSync(cookiesPath)) return [];
  const raw = fs.readFileSync(cookiesPath, 'utf-8').trim();
  if (!raw) return [];

  let parsed: any[] = [];
  try {
    if (raw.startsWith('[')) {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) parsed = j;
    } else if (raw.startsWith('#') && raw.includes('\t')) {
      parsed = parseNetscapeCookies(raw);
    } else {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) parsed = j;
    }
  } catch (e) {
    console.warn('failed to parse cookies:', (e as Error).message);
    return [];
  }

  const out: any[] = [];
  for (const c of parsed) {
    let domain = c.domain || c.host || '';
    if (!domain.includes('google.com')) continue;
    if (!domain.startsWith('.')) domain = '.' + domain;
    const sameSiteRaw = String(c.sameSite || 'Lax').toLowerCase();
    const sameSite = sameSiteRaw.charAt(0).toUpperCase() + sameSiteRaw.slice(1);
    out.push({
      name: String(c.name),
      value: String(c.value),
      domain,
      path: c.path || '/',
      expires:
        typeof c.expirationDate === 'number' ? c.expirationDate :
        typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite,
    });
  }
  return out;
}

function parseNetscapeCookies(content: string): any[] {
  // Netscape cookie file: tab-separated fields per line.
  // Format: domain \t flag \t path \t secure \t expiration \t name \t value
  // Lines starting with # are comments; blank lines are ignored.
  const cookies: any[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , path, secureStr, expirationStr, name, ...valueParts] = parts;
    const value = valueParts.join('\t');
    cookies.push({
      name,
      value,
      domain,
      path,
      expires: parseInt(expirationStr, 10) || -1,
      secure: secureStr === 'TRUE',
    });
  }
  return cookies;
}

async function debugDump(page: Page, label: string, jobId: string, outputDir: string) {
  if (!DEBUG) return;
  const dir = path.join(outputDir, `debug-${jobId}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const url = page.url();
    const title = await page.title();
    console.log(`[${jobId}] debug[${label}] url=${url} title="${title}"`);
    fs.writeFileSync(path.join(dir, `${label}.html`), await page.content());
    await page.screenshot({ path: path.join(dir, `${label}.png`), fullPage: true });
  } catch (e) {
    console.warn(`[${jobId}] debug dump failed:`, (e as Error).message);
  }
}

async function tryClickAny(page: Page, candidates: string[], label: string): Promise<boolean> {
  for (const sel of candidates) {
    try {
      await page.click(sel, { timeout: 4000 });
      console.log(`[${label}] clicked: ${sel}`);
      return true;
    } catch {}
  }
  return false;
}

export async function joinAndRecord(opts: JoinOpts): Promise<void> {
  const { meetUrl, jobId, botName, outputDir, skipRecording } = opts;

  fs.mkdirSync(outputDir, { recursive: true });
  const outFile = path.join(outputDir, `${jobId}.mp4`);

  console.log(`[${jobId}] launching browser`);
  setStatus({ state: 'joining', outFile, startedAt: Date.now(), elapsedSec: 0 });
  const browser = await chromium.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--use-fake-ui-for-media-stream',
      // No --use-fake-device-for-media-stream: Meet accepts participants
      // without camera/mic and we save the CPU of running synthetic streams.
      '--auto-select-desktop-capture-source=Entire screen',
      '--kiosk',
      '--start-fullscreen',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  const cookies = loadGoogleCookies();
  if (cookies.length > 0) {
    await context.addCookies(cookies);
    console.log(`[${jobId}] applied ${cookies.length} Google cookies`);
  }

  console.log(`[${jobId}] navigating to ${meetUrl}`);
  await page.goto(meetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000); // let Meet's JS settle
  await debugDump(page, '01-loaded', jobId, outputDir);

  // Expose browser + page to the controller so it can abort and capture on demand.
  if (opts.onBrowser) opts.onBrowser(browser);
  if (opts.onPage) opts.onPage(page);

  // Lightweight elapsed timer — no screenshot work. The dashboard polls /status
  // every 1s and we just keep elapsedSec fresh.
  const startedAt = Date.now();
  const elapsedTimer = setInterval(() => {
    setStatus({ elapsedSec: Math.floor((Date.now() - startedAt) / 1000) });
  }, 1000);

  // Cookie banner (best effort)
  await tryClickAny(page, selectors.acceptCookiesCandidates, `[${jobId}] cookies`);

  // Fill name (best effort; the bot joins even without setting one)
  let nameSet = false;
  for (const sel of selectors.nameInputCandidates) {
    try {
      await page.fill(sel, botName, { timeout: 4000 });
      console.log(`[${jobId}] name filled via ${sel}`);
      nameSet = true;
      break;
    } catch {}
  }
  if (!nameSet) {
    console.warn(`[${jobId}] name input not found — continuing`);
    await debugDump(page, '02-no-name-input', jobId, outputDir);
  }

  // Toggle camera/mic off (best effort)
  await tryClickAny(page, selectors.cameraToggleCandidates, `[${jobId}] camera`);
  await tryClickAny(page, selectors.micToggleCandidates, `[${jobId}] mic`);

  // Click ask-to-join — try each candidate
  const asked = await tryClickAny(page, selectors.askToJoinCandidates, `[${jobId}] ask`);
  if (!asked) {
    await debugDump(page, '03-no-ask-button', jobId, outputDir);
    throw new Error('Could not find ask-to-join button');
  }

  await debugDump(page, '04-after-ask', jobId, outputDir);

  console.log(`[${jobId}] waiting for admit (timeout 5min)...`);
  let admitted = false;
  for (const sel of selectors.inCallCandidates) {
    try {
      await page.waitForSelector(sel, { timeout: 5 * 60_000 });
      console.log(`[${jobId}] admitted (matched ${sel})`);
      admitted = true;
      break;
    } catch {}
  }
  if (!admitted) {
    await debugDump(page, '05-never-admitted', jobId, outputDir);
    throw new Error('Never admitted into the call');
  }

  await debugDump(page, '06-admitted', jobId, outputDir);
  setStatus({ state: 'admitted', startedAt: Date.now(), elapsedSec: 0 });

  // Switch layout to Spotlight so any screen-share dominates the frame
  await setSpotlightLayout(page, jobId);
  await debugDump(page, '07-after-layout', jobId, outputDir);

  if (skipRecording) {
    console.log(`[${jobId}] SKIP_RECORDING=1 — leaving in 3s without capture`);
    await page.waitForTimeout(3000);
    clearInterval(elapsedTimer);
    await browser.close();
    return;
  }

  console.log(`[${jobId}] starting ffmpeg → ${outFile}`);
  setStatus({ state: 'recording' });
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'x11grab',
    '-video_size', '1280x720',
    '-framerate', '10',
    '-i', ':99',
    '-f', 'pulse',
    '-ac', '2',
    '-ar', '48000',
    '-i', 'MeetSink.monitor',
    '-af', 'aresample=async=1:first_pts=0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-g', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outFile,
  ]);
  ffmpeg.stderr.on('data', (d) => process.stderr.write(`[ffmpeg] ${d}`));

  const maxMs = (opts.maxDurationSec ?? 0) * 1000;
  let maxTimer: NodeJS.Timeout | undefined;

  try {
    if (maxMs > 0) {
      console.log(`[${jobId}] max duration ${opts.maxDurationSec}s — will stop ffmpeg after that`);
      maxTimer = setTimeout(() => {
        console.log(`[${jobId}] max duration reached`);
        // Replace meeting ended signal by terminating — simplest: blow up the
        // poll loop by throwing a sentinel via global.
        (global as any).__MAX_DURATION_HIT = true;
      }, maxMs);
    }
    await waitForMeetingEnd(page, jobId);
  } finally {
    if (maxTimer) clearTimeout(maxTimer);
    clearInterval(elapsedTimer);
    setStatus({ state: 'ending' });
    console.log(`[${jobId}] meeting ended — stopping ffmpeg`);
    ffmpeg.kill('SIGINT');
    await new Promise<void>((resolve) => {
      ffmpeg.on('exit', () => resolve());
      setTimeout(() => { ffmpeg.kill('SIGKILL'); resolve(); }, 10_000);
    });
    await browser.close();
  }

  console.log(`[${jobId}] saved ${outFile} (${fs.statSync(outFile).size} bytes)`);
}

async function waitForMeetingEnd(page: Page, jobId: string) {
  while (true) {
    if ((global as any).__MAX_DURATION_HIT) {
      console.log(`[${jobId}] max duration flag set — exiting poll`);
      return;
    }
    let ended = false;
    for (const sel of selectors.meetingEndedCandidates) {
      try {
        const el = await page.$(sel);
        if (el) {
          console.log(`[${jobId}] end indicator matched ${sel}`);
          ended = true;
          break;
        }
      } catch {}
    }
    if (ended) return;
    await page.waitForTimeout(5000);
  }
}

async function setSpotlightLayout(page: Page, jobId: string) {
  console.log(`[${jobId}] setting Spotlight layout`);
  // Current Meet UI: layout lives in "More options" (3-dot) → "Change layout" → Spotlight.
  let opened = false;
  for (const sel of selectors.moreOptionsButtonCandidates) {
    try {
      await page.click(sel, { timeout: 3000 });
      console.log(`[${jobId}] opened More options via ${sel}`);
      opened = true;
      break;
    } catch {}
  }
  if (!opened) {
    console.warn(`[${jobId}] More options button not found — skipping layout change`);
    return;
  }
  await page.waitForTimeout(500);
  let layoutClicked = false;
  for (const sel of selectors.adjustViewMenuItemCandidates) {
    try {
      await page.click(sel, { timeout: 3000 });
      console.log(`[${jobId}] clicked Adjust view via ${sel}`);
      layoutClicked = true;
      break;
    } catch {}
  }
  if (!layoutClicked) {
    console.warn(`[${jobId}] Adjust view menu item not found — skipping Spotlight`);
    // Close the open menu so we don't leave it hanging
    await page.keyboard.press('Escape');
    return;
  }
  await page.waitForTimeout(500);
  let picked = false;
  for (const sel of selectors.spotlightOptionCandidates) {
    try {
      await page.click(sel, { timeout: 3000 });
      console.log(`[${jobId}] picked Spotlight via ${sel}`);
      picked = true;
      break;
    } catch {}
  }
  if (!picked) {
    console.warn(`[${jobId}] Spotlight option not found in submenu`);
  }
  await page.waitForTimeout(500);
  // Close the dialog (the X button) so it doesn't cover the screen-share
  // for the entire recording.
  for (const sel of selectors.dialogCloseButtonCandidates) {
    try {
      await page.click(sel, { timeout: 2000 });
      console.log(`[${jobId}] closed Adjust view dialog via ${sel}`);
      break;
    } catch {}
  }
  await page.waitForTimeout(300);
}