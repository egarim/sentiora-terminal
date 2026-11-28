// Issue #63: node-pty defers WindowsTerminal.kill() behind terminal readiness, so a session closed
// before it is ready has its kill *queued forever* — and that callback is the only caller of
// ConoutConnection.dispose(), the only path to worker.terminate(). The conout worker then stays
// ref'd, its MessagePort keeps the event loop alive, and the host cannot exit after shutdown.
//
// The assertion is the active-resource list, not process exit. Exit timing depends on how much other
// cleanup happens to run first — Session.close() waits out its grace period, which can let the exit
// path tidy up — so an exit-based test passes on the broken code by luck. A MessagePort that is
// still active after close() is the defect itself: measured, `unref()` on that worker removes it
// from the list without terminating anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import { Session } from '../src/session.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/interactive.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const opts = { skip: process.platform !== 'win32' ? 'ConPTY is Windows only' : false, timeout: 30000 };

const messagePorts = () => process.getActiveResourcesInfo().filter(name => name === 'MessagePort').length;

test('DK-01 a session closed before readiness leaves no active conout worker port', opts, async () => {
  const baseline = messagePorts();

  const child = pty.spawn(process.execPath, [FIXTURE], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: REPO, env: process.env,
  });
  const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true });
  const session = new Session(child, terminal);

  // If the terminal were already ready this test would prove nothing: the kill would run at once.
  assert.equal(child._isReady, false, 'the terminal must not be ready, or the deferred path is not exercised');

  // The conout worker's connect to the pty pipe is expected to fail once the child is gone; node-pty
  // surfaces that as an unhandled 'error' on the worker, which the test runner reports as an
  // uncaughtException. Captured here because it is the expected consequence of closing before
  // readiness, not a failure of the behaviour under test.
  const worker = child._agent?._conoutSocketWorker?._worker;
  const workerErrors = [];
  worker?.on('error', error => workerErrors.push(error));
  // node-pty connects this socket to the conout worker's pipe without an 'error' handler, so when
  // the child dies first the connect fails with ENOENT and surfaces as an uncaughtException -- in
  // whichever moment it lands, often after the test ends. That is node-pty's gap, not this
  // behaviour's, and it is captured here so the runner does not attribute it to the assertion.
  const outSocketErrors = [];
  child._agent?._outSocket?.on('error', error => outSocketErrors.push(error));

  // The child dies before the conout pipe connects, which is what makes readiness unreachable and
  // the queued kill permanent.
  try { process.kill(child.pid); } catch { /* already gone */ }
  await session.close();

  const after = messagePorts();
  try { await worker?.terminate(); } catch { /* already gone */ }

  assert.equal(after, baseline,
    `a conout worker still holds an active MessagePort after close() (${baseline} before, ${after} after): `
    + 'the host cannot exit the event loop while it does');
});
