// Controller entrypoint. Boots the HTTP server, registers signal handlers,
// and recovers from crashes cleanly.

import { startServer, setStatus } from './server';
import * as path from 'node:path';
import { info, warn, error } from './log';
import { BrowserManager } from './browserManager';

async function main() {
  const port = Number(process.env.DASHBOARD_PORT || '3333');
  const publicDir = path.resolve(__dirname, '../public');

  // Mark any in-flight job from a previous run as failed (interrupted).
  startServer(port, publicDir);

  // Mark status as idle for the dashboard.
  setStatus({ state: 'IDLE' });

  info('boot_complete', { port, publicDir });

  // Graceful shutdown — give the browser + ffmpeg a few seconds, then SIGKILL.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('shutdown_begin', { signal });
    try {
      await BrowserManager.getInstance().shutdown();
    } catch (e: any) {
      warn('shutdown_browser_failed', { error: e.message });
    }
    setTimeout(() => {
      warn('shutdown_force_exit', { signal });
      process.exit(0);
    }, 5000).unref();
    // Allow the event loop to drain.
    setImmediate(() => process.exit(0));
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    error('uncaught_exception', { error: err.message, stack: err.stack?.slice(0, 600) });
  });
  process.on('unhandledRejection', (reason: any) => {
    const msg = reason?.message ?? String(reason);
    error('unhandled_rejection', { error: msg });
  });
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});