// Client for the real src/server.js over its production stdio transport.
//
// Unlike test/fixtures/server-harness.mjs, nothing here is scripted or stubbed:
// the server runs exactly as an agent runs it, so transport loss, abrupt teardown
// and host crashes can be provoked for real rather than simulated.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Re-exported for callers, and bound locally: `export { x } from '...'` alone
// would re-export it without making it visible inside this module.
import { rpcLine } from './registry.mjs';
export { rpcLine };

const SERVER = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// process.kill(pid, 0) is the portable existence probe: it delivers no signal and
// throws ESRCH once the process is gone. EPERM means it exists but is not ours.
// On POSIX a momentarily unreaped child reads as alive (a zombie still has a pid),
// so untilGone can be slow rather than immediate there; the budget absorbs that.
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A pid this helper cannot probe is a bug in the caller, not evidence of a clean
// teardown. Filtering it out would let every leak assertion in the suite pass
// vacuously -- which matters because node-pty 1.2.0-beta reports pid 0 until its
// deferred pty connection completes, and src/session.js documents that.
function assertProvable(pids) {
  const invalid = pids.filter(pid => !Number.isInteger(pid) || pid <= 0);
  if (invalid.length) {
    throw new Error(`cannot check liveness of ${invalid.length} invalid pid(s) ${JSON.stringify(invalid)}; `
      + 'capture pids after readiness, or a leak assertion here would be vacuous');
  }
}

export async function untilGone(pids, timeout = 30000) {
  const list = Array.isArray(pids) ? pids : [pids];
  assertProvable(list);
  const deadline = Date.now() + timeout;
  for (;;) {
    const live = list.filter(alive);
    if (!live.length) return [];
    if (Date.now() > deadline) return live;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export function reap(pids) {
  for (const pid of Array.isArray(pids) ? pids : [pids]) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

// Waits for pids to disappear, reaps anything still alive, and returns what
// survived the wait. Callers assert on the returned list; reaping first would make
// the assertion unfalsifiable, and not reaping at all would leak processes into
// the tests that follow.
export async function expectGone(pids, timeout = 30000) {
  const survivors = await untilGone(pids, timeout);
  reap(survivors);
  return survivors;
}

export function startRuntime({ env } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  // A write to a server that already died is an EPIPE on this stream; without a
  // listener it becomes an uncaught exception in the test runner during teardown.
  child.stdin.on('error', () => {});

  // exitCode alone is not a liveness oracle: it is null for a signalled death, so
  // "still running" and "killed by a signal" are indistinguishable through it.
  // exitInfo/hasExited are the reliable ones. Measured on win32 arm64: killing the
  // host reports {code: null, signal: 'SIGKILL'} there too, so the POSIX reasoning
  // happens to hold on both, but nothing here depends on that.
  let exitInfo = null;
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });

  // Every raw stdout line is kept, parseable or not: a fault that corrupts the
  // framing has to be observable rather than silently dropped by the client.
  const rawLines = [];
  const corrupted = [];
  const responses = [];
  const idle = [];
  let buffered = '';
  let stdoutEnded = false;

  const take = line => {
    rawLines.push(line);
    if (!line.trim()) return;
    let parsed;
    try { parsed = JSON.parse(line); } catch { corrupted.push(line); return; }
    responses.push(parsed);
    for (const wake of idle.splice(0)) wake();
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      take(line);
    }
  });
  // An unterminated trailing line is corruption, not something to discard: on an
  // abnormal exit it is the difference between "truncated response" and a
  // misleading timeout.
  for (const event of ['end', 'close', 'error']) {
    child.stdout.once(event, () => {
      stdoutEnded = true;
      if (buffered.length) { take(buffered); buffered = ''; }
      for (const wake of idle.splice(0)) wake();
    });
  }

  let nextId = 1;

  const api = {
    child,
    rawLines,
    corrupted,
    responses,
    get stderr() { return stderr; },
    get exitInfo() { return exitInfo; },
    get hasExited() { return exitInfo !== null; },
    get stdoutEnded() { return stdoutEnded; },

    sendLine(line) { child.stdin.write(`${line}\n`); },

    async waitForResponse(id, timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        // Checked before the liveness tests: a response that already arrived must
        // not be discarded because the exit event fired first.
        const found = responses.find(r => r.id === id);
        if (found) return found;
        if (exitInfo) {
          throw new Error(`server exited (code=${exitInfo.code} signal=${exitInfo.signal}) while awaiting id ${id}; `
            + `${responses.length} responses, ${corrupted.length} corrupt; stderr tail:\n${stderr.slice(-2000)}`);
        }
        // The host can outlive its response pipe -- FI-03 does that on purpose --
        // so stdout ending is its own reason to stop waiting. But on Windows the
        // pipe closes before the 'exit' event arrives, so a crashed host would
        // otherwise be reported as "stdout ended, server still running" and the
        // crash would be misdiagnosed as a transport fault. Give the exit event a
        // moment to land and report whichever actually happened.
        if (stdoutEnded) {
          if (!exitInfo) await new Promise(resolve => setTimeout(resolve, 1000));
          if (exitInfo) {
            throw new Error(`server exited (code=${exitInfo.code} signal=${exitInfo.signal}) while awaiting id ${id}; `
              + `${responses.length} responses, ${corrupted.length} corrupt; stderr tail:\n${stderr.slice(-2000)}`);
          }
          throw new Error(`server stdout ended while awaiting id ${id}, server still running; `
            + `${responses.length} responses, ${corrupted.length} corrupt; stderr tail:\n${stderr.slice(-2000)}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`no response for id ${id} within ${timeout}ms; ${responses.length} responses, `
            + `${corrupted.length} corrupt; stderr tail:\n${stderr.slice(-2000)}`);
        }
        await Promise.race([
          new Promise(resolve => idle.push(resolve)),
          new Promise(resolve => setTimeout(resolve, 100)),
        ]);
      }
    },

    // Waits for a count rather than an id, which is what a malformed-input test
    // needs: most of those responses carry id null and cannot be correlated.
    async waitForResponseCount(count, timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (responses.length >= count) return responses.length;
        if (exitInfo || stdoutEnded) {
          throw new Error(`server ${exitInfo ? 'exited' : 'closed stdout'} after only ${responses.length} of `
            + `${count} responses; stderr tail:\n${stderr.slice(-2000)}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`only ${responses.length} of ${count} responses arrived; stderr tail:\n${stderr.slice(-2000)}`);
        }
        await Promise.race([
          new Promise(resolve => idle.push(resolve)),
          new Promise(resolve => setTimeout(resolve, 100)),
        ]);
      }
    },

    async request(method, params, { id, timeout } = {}) {
      const useId = id ?? nextId++;
      api.sendLine(rpcLine(useId, method, params));
      const response = await api.waitForResponse(useId, timeout);
      return { id: useId, response };
    },

    async call(method, params, options) {
      const { id, response } = await api.request(method, params, options);
      if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
      return { id, result: response.result };
    },

    async create(params) {
      const { result } = await api.call('terminal.create', params);
      return result;
    },

    async close(sessionId, owner) {
      const { response } = await api.request('terminal.close', { sessionId, owner });
      return response;
    },

    async list() {
      const { result } = await api.call('terminal.list', {});
      return result;
    },

    // Polls terminal.observe until the screen carries `marker`. Readiness is an
    // observable condition, never a sleep.
    async waitScreen(sessionId, marker, timeout = 20000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const { result } = await api.call('terminal.observe', { sessionId });
        if (result.screen.includes(marker)) return result;
        if (Date.now() > deadline) throw new Error(`screen never contained ${marker}; last:\n${result.screen}`);
        await api.call('terminal.wait', { sessionId, afterRevision: result.revision, timeoutMs: 250 });
      }
    },

    endStdin() { child.stdin.end(); },
    destroyStdin() { child.stdin.destroy(); },
    destroyStdout() { child.stdout.destroy(); },
    killHard() { child.kill('SIGKILL'); },

    // Resolves with {code, signal}, or null if the server is still running after
    // the timeout.
    async exited(timeout = 45000) {
      if (exitInfo) return exitInfo;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, timeout);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      return exitInfo;
    },

    // Always leaves the server dead: if the graceful path times out, kill it and
    // wait for that too, so the next test cannot inherit a dying process.
    async stop() {
      if (!exitInfo) api.endStdin();
      if (await api.exited()) return exitInfo;
      api.killHard();
      await api.exited(15000);
      return exitInfo;
    },
  };
  return api;
}
