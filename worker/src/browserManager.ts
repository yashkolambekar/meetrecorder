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
      '--no-sandbox',
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
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
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