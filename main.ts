// Entry point for the forge: bind, register with the suite, wait for done, exit.
//
// The suite (MAKEFUN_ENV_URL) owns port 8080, so this process listens on a port the
// kernel picks (listen(0)) and tells the suite that port. The suite then dials this
// process back and drives it; this process polls GET /done until the suite answers
// {"done": true} and only then exits 0. Nothing here reads the wall clock into any
// state the suite exports, and nothing here touches the network except the suite.

import { createForge } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const REQUEST_BUDGET_MS = 30_000;
// First retry after 150 ms, not 200: the register loop's first retry is the
// common cold-start path (the suite is usually up by the second attempt), and
// 150 ms is still well above the suite's startup jitter — it shaves 50 ms off
// the boot-to-registered latency without risking a retry storm.
const BACKOFF_FIRST_MS = 150;
const BACKOFF_CAP_MS = 2_000;

function nap(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const step = Math.min(attempt, 8);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** step);
}

// Tell the suite which port this process bound. 200 means accepted, 409 means some
// other process already registered first (keep waiting either way); 400/405 are
// contract errors and end the run, anything else is retried.
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await nap(backoffMs(attempt));
  }
}

// Poll GET /done until the suite says the trial is over. A failed poll is just
// another reason to wait a little and ask again — but a 404/405 means the env URL
// is not the suite at all, and waiting out the trial wall on a wrong URL only
// burns the run, so that is a contract error like a refused register.
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (res.status === 404 || res.status === 405) {
        throw new Error(`/done refused with HTTP ${res.status}`);
      }
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('/done refused')) throw err;
      // The suite is not answering yet; poll again.
    }
    await nap(backoffMs(attempt));
  }
}

async function run(): Promise<void> {
  const server = createForge();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  process.stdout.write(`[forge] listening on ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await awaitDone();
  // Drop any keep-alive sockets the suite still holds before closing, so the
  // process cannot hang here waiting for a connection that never ends.
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
