// Controller entrypoint. Starts the dashboard HTTP server and waits for jobs
// to be POSTed at /api/jobs. Does NOT auto-start a job from env vars.
//
// Env vars read here:
//   DASHBOARD_PORT  — port for the dashboard (default 3000)
// Env vars NOT used anymore (jobs now come from the dashboard):
//   MEET_URL, BOT_NAME, MAX_DURATION, SKIP_RECORDING, JOB_ID
//   Those are still respected by joinAndRecord if you want to run it standalone.

import { startServer, setStatus } from './server';
import * as path from 'node:path';

async function main() {
  const port = Number(process.env.DASHBOARD_PORT || '3000');
  const publicDir = path.resolve(__dirname, '../public');

  startServer(port, publicDir);
  setStatus({ state: 'idle' });

  console.log('[worker] controller up — open the dashboard to start a recording');

  // Keep the process alive forever. The HTTP server is the long-running thing.
  // SIGTERM / SIGINT should let the docker stop happen cleanly.
  process.on('SIGTERM', () => { console.log('[worker] SIGTERM'); process.exit(0); });
  process.on('SIGINT',  () => { console.log('[worker] SIGINT');  process.exit(0); });
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
