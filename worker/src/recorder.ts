// ffmpeg child wrapper. Owns the recording process for one job.
// Segment duration is configurable via SEGMENT_SECONDS env (default 600s = 10 min).

import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { info, warn, error } from './log';

const MIN_USABLE_BYTES = 32 * 1024; // 32 KiB — below this a segment is considered corrupt

export interface RecorderOpts {
  jobId: string;
  outDir: string;
  display?: string;       // X display for x11grab (default ":99")
  sink?: string;          // PulseAudio monitor source (default "MeetSink.monitor")
  segmentSeconds?: number;
  videoSize?: string;     // default "1280x720"
  framerate?: number;     // default 10
  preset?: string;        // default "ultrafast"
}

export interface SegmentInfo {
  index: number;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface RecorderResult {
  ok: boolean;
  reason: 'OK' | 'FFMPEG_FAILED';
  detail: string;
  segments: SegmentInfo[];
  totalBytes: number;
  ffmpegExit: { code: number | null; signal: string | null };
}

type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void;

export class Recorder {
  private readonly jobId: string;
  private readonly outDir: string;
  private readonly display: string;
  private readonly sink: string;
  private readonly segmentSeconds: number;
  private readonly videoSize: string;
  private readonly framerate: number;
  private readonly preset: string;
  private proc: ChildProcess | null = null;
  private exitHandlers: ExitHandler[] = [];
  private lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private stderrTail: string[] = [];
  private readonly stderrTailMax = 50;

  constructor(opts: RecorderOpts) {
    this.jobId = opts.jobId;
    this.outDir = opts.outDir;
    this.display = opts.display ?? process.env.DISPLAY ?? ':99';
    this.sink = opts.sink ?? 'MeetSink.monitor';
    this.segmentSeconds = Number(opts.segmentSeconds ?? process.env.SEGMENT_SECONDS ?? 600);
    this.videoSize = opts.videoSize ?? '1280x720';
    this.framerate = opts.framerate ?? 10;
    this.preset = opts.preset ?? 'ultrafast';
  }

  async start(): Promise<void> {
    await fs.promises.mkdir(this.outDir, { recursive: true });

    const args: string[] = [
      '-y',
      '-f', 'x11grab',
      '-video_size', this.videoSize,
      '-framerate', String(this.framerate),
      '-i', this.display,
      '-f', 'pulse',
      '-ac', '2',
      '-ar', '48000',
      '-i', this.sink,
      '-af', 'aresample=async=1:first_pts=0',
      '-map', '0:v',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', this.preset,
      '-pix_fmt', 'yuv420p',
      '-g', '20',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-f', 'segment',
      '-segment_time', String(this.segmentSeconds),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '0',
      '-movflags', '+faststart',
      path.join(this.outDir, 'part-%03d.mp4'),
    ];

    info('recorder_start', {
      jobId: this.jobId,
      outDir: this.outDir,
      segmentSeconds: this.segmentSeconds,
      args: args.join(' '),
    });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf-8');
      this.stderrTail.push(s);
      if (this.stderrTail.length > this.stderrTailMax) {
        this.stderrTail.splice(0, this.stderrTail.length - this.stderrTailMax);
      }
      // ffmpeg writes progress to stderr; mirror a tail to the log
      const tail = s.split('\n').slice(-1)[0];
      if (tail && (tail.includes('error') || tail.includes('Error') || tail.includes('Conversion failed'))) {
        warn('ffmpeg_stderr', { jobId: this.jobId, line: tail.slice(0, 200) });
      }
    });

    this.exitPromise = new Promise((resolve) => {
      proc.on('exit', (code, signal) => {
        this.lastExit = { code, signal };
        info('ffmpeg_exit', { jobId: this.jobId, code, signal });
        for (const h of this.exitHandlers) h(code, signal);
        resolve({ code, signal });
      });
    });
  }

  on(event: 'exit', cb: ExitHandler): void {
    if (event !== 'exit') return;
    this.exitHandlers.push(cb);
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }

  async stop(graceMs = 10_000): Promise<RecorderResult> {
    if (!this.proc) {
      return {
        ok: false,
        reason: 'FFMPEG_FAILED',
        detail: 'ffmpeg was never started',
        segments: [],
        totalBytes: 0,
        ffmpegExit: { code: null, signal: null },
      };
    }

    const proc = this.proc;
    try {
      proc.kill('SIGINT');
    } catch (e: any) {
      warn('ffmpeg_sigint_failed', { jobId: this.jobId, error: e.message });
    }

    const exited = await Promise.race([
      this.exitPromise ?? Promise.resolve({ code: 0, signal: null }),
      new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        setTimeout(() => resolve({ code: null, signal: 'SIGKILL_TIMEOUT' }), graceMs),
      ),
    ]);

    if (!exited.signal && exited.code === null) {
      try {
        proc.kill('SIGKILL');
      } catch {}
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }

    const finalExit = this.lastExit ?? exited;
    const segments = await this.scanSegments();
    const totalBytes = segments.reduce((s, x) => s + x.bytes, 0);

    const unusable = segments.filter((s) => s.bytes < MIN_USABLE_BYTES);
    if (unusable.length > 0 && unusable.length === segments.length) {
      // Every segment is empty
      return {
        ok: false,
        reason: 'FFMPEG_FAILED',
        detail: `all ${segments.length} segments below ${MIN_USABLE_BYTES} bytes`,
        segments,
        totalBytes,
        ffmpegExit: { code: finalExit.code, signal: finalExit.signal },
      };
    }

    if (finalExit.code !== 0 && finalExit.code !== null) {
      return {
        ok: false,
        reason: 'FFMPEG_FAILED',
        detail: `ffmpeg non-zero exit code=${finalExit.code} signal=${finalExit.signal ?? 'none'}`,
        segments,
        totalBytes,
        ffmpegExit: { code: finalExit.code, signal: finalExit.signal },
      };
    }

    if (segments.length === 0) {
      return {
        ok: false,
        reason: 'FFMPEG_FAILED',
        detail: 'no segments written',
        segments,
        totalBytes,
        ffmpegExit: { code: finalExit.code, signal: finalExit.signal },
      };
    }

    return {
      ok: true,
      reason: 'OK',
      detail: `recorded ${segments.length} segment(s), ${totalBytes} bytes`,
      segments,
      totalBytes,
      ffmpegExit: { code: finalExit.code, signal: finalExit.signal },
    };
  }

  async scanSegments(): Promise<SegmentInfo[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.outDir);
    } catch {
      return [];
    }
    const segments: SegmentInfo[] = [];
    for (const name of names) {
      const m = name.match(/^part-(\d+)\.mp4$/);
      if (!m) continue;
      const full = path.join(this.outDir, name);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(full);
      } catch {
        continue;
      }
      segments.push({
        index: Number(m[1]),
        path: full,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
    segments.sort((a, b) => a.index - b.index);
    return segments;
  }

  async status(): Promise<{ pid?: number; bytes: number; segments: SegmentInfo[] }> {
    const segments = await this.scanSegments();
    return {
      pid: this.pid(),
      bytes: segments.reduce((s, x) => s + x.bytes, 0),
      segments,
    };
  }

  // Forceful kill — used by abort paths.
  async kill(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.kill('SIGKILL');
    } catch {}
  }

  // Last stderr lines for post-mortem.
  lastStderr(): string {
    return this.stderrTail.join('');
  }
}