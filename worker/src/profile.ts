// Profile readiness probe. Boots a *separate* persistent-context instance,
// navigates to myaccount.google.com, and decides:
//   NOT_INITIALIZED — profile directory missing or empty
//   LOGIN_REQUIRED  — Chrome boots but Google shows the sign-in page
//   READY           — Google account is signed in
//   PROFILE_ERROR   — Chrome failed to launch against this profile
//
// We must NOT collide with the BrowserManager singleton — Chromium locks a
// profile to one process. So this module waits for the manager to be idle
// and tells it to skip launching while probing. Simpler: use a separate
// transient context that we close before any other page work happens.

import { BrowserContext, Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { profileLooksInitialized } from './browserManager';
import { info, warn, error } from './log';
import { profileReadyCandidates, profileSignedInIndicators } from './selectors';

export type ProfileState = 'NOT_INITIALIZED' | 'LOGIN_REQUIRED' | 'READY' | 'PROFILE_ERROR';

export interface ProfileStatus {
  state: ProfileState;
  message: string;
  lastChecked: number;
  chromeVersion?: string;
}

const CACHE_TTL_MS = 30_000;

let cache: ProfileStatus | null = null;
let inflight: Promise<ProfileStatus> | null = null;

export async function getProfileStatus(opts: {
  profileDir: string;
  executablePath: string;
  force?: boolean;
}): Promise<ProfileStatus> {
  if (!opts.force && cache && Date.now() - cache.lastChecked < CACHE_TTL_MS) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const result = await probe(opts.profileDir, opts.executablePath);
    cache = result;
    return result;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function probe(profileDir: string, executablePath: string): Promise<ProfileStatus> {
  const lastChecked = Date.now();

  if (!profileLooksInitialized(profileDir)) {
    return {
      state: 'NOT_INITIALIZED',
      message: 'Profile directory has not been used by Chrome yet.',
      lastChecked,
    };
  }

  let ctx: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    // We import here to avoid a cycle with browserManager.
    const { chromium } = await import('playwright');
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
    });

    page = ctx.pages()[0] ?? await ctx.newPage();
    const navPromise = page.goto('https://myaccount.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await navPromise.catch(() => undefined); // tolerate Google throttling

    // Give the SPA a moment.
    await page.waitForTimeout(2000);

    const url = page.url();
    info('ready_checker_url', { url });

    if (/accounts\.google\.com\/ServiceLogin|accounts\.google\.com\/signin|accounts\.google\.com\/v3\/signin/i.test(url)) {
      return {
        state: 'LOGIN_REQUIRED',
        message: `Google sign-in page detected (${url}). Open noVNC and sign in.`,
        lastChecked,
      };
    }

    // Look for the avatar/profile indicator.
    let ready = false;
    for (const sel of profileReadyCandidates) {
      try {
        const el = await page.$(sel);
        if (el) { ready = true; break; }
      } catch {}
    }
    if (!ready) {
      for (const sel of profileSignedInIndicators) {
        try {
          const el = await page.$(sel);
          if (el) { ready = true; break; }
        } catch {}
      }
    }

    if (ready) {
      return {
        state: 'READY',
        message: 'Google account is signed in.',
        lastChecked,
      };
    }

    return {
      state: 'LOGIN_REQUIRED',
      message: `Could not confirm signed-in state at ${url}. Open noVNC and sign in.`,
      lastChecked,
    };
  } catch (e: any) {
    error('profile_probe_failed', { error: e.message });
    return {
      state: 'PROFILE_ERROR',
      message: `Profile probe failed: ${e.message?.slice(0, 200) ?? 'unknown error'}`,
      lastChecked,
    };
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
    if (ctx) {
      try { await ctx.close(); } catch (e: any) {
        warn('profile_probe_close_failed', { error: e.message });
      }
    }
  }
}

export function resetProfileCache(): void {
  cache = null;
}