// Per-job record store. Single-process worker, file-based, atomic writes.
// Schema is intentionally simple — upgrades later can switch to SQLite
// without changing call sites.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FailureReason } from './diagnostics';

export type JobState =
  | 'IDLE'
  | 'STARTING'
  | 'BROWSER_STARTING'
  | 'AUTH_CHECK'
  | 'JOINING'
  | 'WAITING_FOR_ADMISSION'
  | 'RECORDING'
  | 'STOPPING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED';

export interface JobSegment {
  index: number;
  path: string;
  bytes: number;
}

export interface JobRecord {
  jobId: string;
  meetUrl: string;
  meetCode: string;
  botName: string;
  maxDurationSec?: number;
  startedAt: number;
  endedAt?: number;
  durationSec?: number;
  state: JobState;
  failureReason?: FailureReason;
  failureDetail?: string;
  outDir: string;
  segments: JobSegment[];
  totalBytes: number;
  skipRecording?: boolean;
}

interface StoreFile {
  version: 1;
  jobs: JobRecord[];
}

export class JobStore {
  private readonly file: string;
  private cache: StoreFile | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.file = file;
  }

  static async init(file: string): Promise<JobStore> {
    const s = new JobStore(file);
    await s.load();
    return s;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.jobs)) {
        this.cache = { version: 1, jobs: parsed.jobs };
        return;
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        // Corrupt store — back it up and start fresh.
        try {
          await fs.promises.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {}
      }
    }
    this.cache = { version: 1, jobs: [] };
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    const data = JSON.stringify(this.cache, null, 2);
    const tmp = `${this.file}.tmp`;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(tmp, data, 'utf-8');
    await fs.promises.rename(tmp, this.file);
  }

  private enqueueWrite(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch(() => undefined);
    return this.writeQueue;
  }

  list(): JobRecord[] {
    if (!this.cache) return [];
    return [...this.cache.jobs].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(jobId: string): JobRecord | undefined {
    return this.cache?.jobs.find((j) => j.jobId === jobId);
  }

  async create(rec: JobRecord): Promise<void> {
    if (!this.cache) this.cache = { version: 1, jobs: [] };
    this.cache.jobs.push(rec);
    await this.enqueueWrite();
  }

  async update(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord | undefined> {
    if (!this.cache) return;
    const idx = this.cache.jobs.findIndex((j) => j.jobId === jobId);
    if (idx < 0) return;
    this.cache.jobs[idx] = { ...this.cache.jobs[idx], ...patch };
    await this.enqueueWrite();
    return this.cache.jobs[idx];
  }

  async delete(jobId: string): Promise<boolean> {
    if (!this.cache) return false;
    const before = this.cache.jobs.length;
    this.cache.jobs = this.cache.jobs.filter((j) => j.jobId !== jobId);
    if (this.cache.jobs.length === before) return false;
    await this.enqueueWrite();
    return true;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

export function extractMeetCode(meetUrl: string): string {
  const m = meetUrl.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m ? m[1] : '';
}

export function deriveJobOutDir(outputRoot: string, jobId: string, startedAtMs: number): string {
  const d = new Date(startedAtMs);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return path.join(outputRoot, yyyy, mm, dd, jobId);
}