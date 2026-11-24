// How many create/close cycles can one host process survive before the leaked
// ConPTY input-socket descriptors exhaust? WIN-19 and the stress harness both
// measured exactly one leaked fd per session; this finds the ceiling.
//
// Usage: node test/bench/fd-exhaustion.mjs [maxSessions]
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import { Session } from '../../src/session.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/interactive.mjs', import.meta.url));
const MAX = Number(process.argv[2] ?? 1200);
const t0 = Date.now();

let sockets = 0;
const kinds = () => {
  const k = {};
  for (const h of process._getActiveHandles()) { const n = h.constructor?.name ?? '?'; k[n] = (k[n] ?? 0) + 1; }
  return k;
};

process.on('uncaughtException', error => {
  console.log(`UNCAUGHT at session ${i}: code=${error.code ?? ''} ${error.message}`);
  console.log(`RESULT ${JSON.stringify({ failedAtSession: i, code: error.code ?? null, message: error.message, elapsedMs: Date.now() - t0, handles: kinds() })}`);
  process.exit(1);
});

let i = 0;
for (; i < MAX; i += 1) {
  const terminal = new xterm.Terminal({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true });
  let child;
  try {
    child = pty.spawn(process.execPath, [FIXTURE], { name: 'xterm-256color', cols: 40, rows: 10, cwd: process.cwd(), env: process.env });
  } catch (error) {
    console.log(`SPAWN FAILED at session ${i}: code=${error.code ?? ''} ${error.message}`);
    terminal.dispose();
    break;
  }
  const session = new Session(child, terminal);
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      const snap = await session.observe();
      if (snap.screen.includes('FIXTURE READY')) break;
      if (Date.now() > deadline) { console.log(`READY TIMEOUT at session ${i}`); break; }
      await session.wait(snap.revision, 100);
    }
  } catch (error) {
    console.log(`SESSION ERROR at ${i}: ${error.message}`);
  }
  await session.close();

  if (i % 100 === 0 || i === MAX - 1) {
    const k = kinds();
    sockets = k.Socket ?? 0;
    console.log(`session ${i}: handles=${JSON.stringify(k)} rss=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}

console.log(`RESULT ${JSON.stringify({ completedSessions: i, failedAtSession: null, elapsedMs: Date.now() - t0, finalHandles: kinds(), rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)) })}`);
process.exit(0);
