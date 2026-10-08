// BrowserManager — single source of truth for the persistent Chrome profile.
// Uses launchPersistentContext against /var/lib/meet-profile so Google auth
// state (IndexedDB, localStorage, the Login Data database) survives across
// jobs, container restarts, and image rebuilds.
//
// Concurrency: ONE Chrome instance per process. Multiple recording jobs are
// not supported (preserves the legacy "one job at a time" contract).

import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { info, warn, error } from './log';

export interface BrowserManagerOpts {
  profileDir: string;
  executablePath?: string;
  headless?: boolean;          // default false — Meet requires a real display
  viewport?: { width: number; height: number };
  locale?: string;
}

export type DisconnectReason = 'crashed' | 'closed' | 'launch_failed';

type DisconnectCb = (reason: DisconnectReason, detail?: string) => void;

export class BrowserManager {
  private static _instance: BrowserManager | null = null;

  static getInstance(): BrowserManager {
    if (!this._instance) {
      const profileDir = process.env.PROFILE_DIR || '/var/lib/meet-profile';
      this._instance = new BrowserManager({
        profileDir,
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
        headless: false,
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
      });
    }
    return this._instance;
  }

  static async reset(): Promise<void> {
    if (this._instance) {
      try {
        await this._instance.shutdown();
      } catch {}
      this._instance = null;
    }
  }

  readonly profileDir: string;
  private readonly executablePath: string;
  private readonly headless: boolean;
  private readonly viewport: { width: number; height: number };
  private readonly locale: string;

  private context: BrowserContext | null = null;
  private starting: Promise<BrowserContext> | null = null;
  private lastRestartAt = 0;
  private readonly restartCooldownMs = 30_000;
  private disconnectCbs: DisconnectCb[] = [];

  constructor(opts: BrowserManagerOpts) {
    this.profileDir = opts.profileDir;
    this.executablePath = opts.executablePath ?? '/usr/bin/google-chrome-stable';
    this.headless = opts.headless ?? false;
    this.viewport = opts.viewport ?? { width: 1280, height: 720 };
    this.locale = opts.locale ?? 'en-US';
  }

  on(event: 'disconnected', cb: DisconnectCb): void {
    if (event === 'disconnected') this.disconnectCbs.push(cb);
  }

  isRunning(): boolean {
    return this.context !== null;
  }

  contextIfRunning(): BrowserContext | null {
    return this.context;
  }

  async ensureReady(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.starting) return this.starting;

    const now = Date.now();
    if (now - this.lastRestartAt < this.restartCooldownMs && this.lastRestartAt > 0) {
      // Cooldown — refuse to thrash.
      const wait = this.restartCooldownMs - (now - this.lastRestartAt);
      warn('browser_restart_cooldown', { waitMs: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
    this.lastRestartAt = Date.now();

    this.starting = this.launch();
    try {
      this.context = await this.starting;
      return this.context;
    } finally {
      this.starting = null;
    }
  }

  private async launch(): Promise<BrowserContext> {
    await fs.promises.mkdir(this.profileDir, { recursive: true });

    const args = [
      '--disable-blink-features=AutomationControlled',
      '--use-fake-ui-for-media-stream',
      // NOTE: no --disable-dev-shm-usage. compose.yml sets shm_size: 2gb.
      // No --headless. Real Chrome against Xvfb :99.
      // No --user-agent override. Chrome speaks for itself.
    ];

    info('browser_launch', {
      profileDir: this.profileDir,
      executablePath: this.executablePath,
      args: args.join(' '),
      viewport: this.viewport,
      locale: this.locale,
    });

    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        executablePath: this.executablePath,
        args,
        viewport: this.viewport,
        locale: this.locale,
        acceptDownloads: false,
      });
    } catch (e: any) {
      error('browser_launch_failed', { error: e.message });
      throw e;
    }

    // Hook disconnect — for us "disconnected" means the process is gone.
    const browser = ctx.browser();
    if (browser) {
      browser.on('disconnected', () => {
        const wasOurs = this.context === ctx;
        this.context = null;
        if (wasOurs) {
          warn('browser_disconnected', {});
          for (const cb of this.disconnectCbs) {
            try { cb('crashed', 'playwright disconnected event'); } catch {}
          }
        }
      });
    }

    // Popup killer. Meet/Chrome auto-open tabs (chat popout, PiP
    // screenshare, restore-from-profile) all briefly land on about:blank or
    // chrome://. x11grab captures the whole X display, so those tabs would
    // pollute recordings. Close any page whose URL settles to a blank-ish
    // origin. The recording page navigates to meet.google.com within
    // ~1s of creation, so its URL won't match by the time we check.
    const isBlankish = (u: string): boolean =>
      u === '' || u === 'about:blank' || u.startsWith('chrome://');

    const closeIfBlank = async (p: Page): Promise<void> => {
      try {
        if (p.isClosed()) return;
        const url = p.url();
        if (isBlankish(url)) {
          warn('popup_closed', { url });
          await p.close().catch(() => undefined);
        }
      } catch {}
    };

    ctx.on('page', (p) => {
      const createdAt = Date.now();
      // Best-effort opener trace — page.opener() returns the Page that
      // created this one via window.open / target=_blank, or null if it
      // came from session-restore / SW clients.openWindow / browser-chrome.
      void (async () => {
        let openerUrl: string | null = null;
        try {
          const op = await p.opener();
          openerUrl = op ? (op.url() || null) : null;
        } catch {}
        info('page_created', {
          count: ctx.pages().length,
          opener: openerUrl,
        });
      })();
      // Stream every navigation this new page goes through so a kill after
      // the first blank check still leaves breadcrumbs to correlate.
      p.on('framenavigated', (f) => {
        if (f !== p.mainFrame()) return;
        if (p.isClosed()) return;
        info('popup_navigated', {
          elapsedMs: Date.now() - createdAt,
          url: f.url(),
        });
      });
      // URL is about:blank at creation; wait one tick so goto() can land
      // a real URL for the recording page before we decide to kill.
      setTimeout(() => { void closeIfBlank(p); }, 800);
    });

    // Session-restore cleanup. The persistent profile reopens any tabs that
    // were open when Chrome last shut down. Restore happens over ~1–2s
    // AFTER launch returns, so a synchronous sweep closes nothing useful.
    // Delay, then close every page that didn't navigate somewhere real.
    setTimeout(async () => {
      try {
        const pages = ctx.pages();
        let keptOne = false;
        for (const p of pages) {
          if (p.isClosed()) continue;
          const u = p.url();
          // Keep a single real-URL page so Chrome has a foreground tab.
          // Close the rest, whatever their URL. Anchor: the first real URL
          // we see (or fall back to the first page if all are blank).
          if (!keptOne) {
            keptOne = true;
            continue;
          }
          warn('popup_closed', { url: u, source: 'startup_cleanup' });
          await p.close().catch(() => undefined);
        }
      } catch (e: any) {
        warn('startup_cleanup_failed', { error: e.message });
      }
    }, 2000);

    info('browser_launched', { profileDir: this.profileDir });
    return ctx;
  }

  async newPage(): Promise<Page> {
    const ctx = await this.ensureReady();
    return ctx.newPage();
  }

  async closePage(p: Page): Promise<void> {
    try {
      if (!p.isClosed()) await p.close();
    } catch (e: any) {
      warn('page_close_failed', { error: e.message });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.context) return;
    const ctx = this.context;
    this.context = null;
    try {
      await ctx.close();
    } catch (e: any) {
      warn('browser_close_failed', { error: e.message });
    }
  }

  // Used by `profile.ts` to do a transient probe of profile state.
  // Boots a separate persistent context, returns it; caller is responsible
  // for closing it before any other BrowserManager operation. We don't run
  // two launchPersistentContext against the same profile simultaneously —
  // Chromium enforces a lock.
  async launchProbeContext(): Promise<BrowserContext> {
    await fs.promises.mkdir(this.profileDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      executablePath: this.executablePath,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: this.viewport,
      locale: this.locale,
    });
    return ctx;
  }
}

export function profileLooksInitialized(profileDir: string): boolean {
  // Chromium profile fingerprint: "Local State" at the root and
  // a "Default/Cookies" sqlite file. We treat the presence of those
  // as "Chrome has been here at least once".
  try {
    const localState = path.join(profileDir, 'Local State');
    const defaultCookies = path.join(profileDir, 'Default', 'Cookies');
    return fs.existsSync(localState) && fs.existsSync(defaultCookies);
  } catch {
    return false;
  }
}
