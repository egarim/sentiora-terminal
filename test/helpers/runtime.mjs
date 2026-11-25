// Client for the real src/server.js over its production stdio transport.
//
// Unlike test/fixtures/server-harness.mjs, nothing here is scripted or stubbed:
// the server runs exactly as an agent runs it, so transport loss, abrupt
// teardown and host crashes can be provoked for real rather than simulated.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export { alive, untilGone, reap, rpcLine } from './registry.mjs';
import { alive, rpcLine } from './registry.mjs';

const SERVER = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));

export function startRuntime({ env } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  // A write to a server that already died is an EPIPE on this stream; without a
  // listener it becomes an uncaught exception in the test runner during teardown.
  child.stdin.on('error', () => {});

  // exitCode is null for a signalled process, which is exactly what killHard()
  // produces, so "did it exit" cannot be inferred from exitCode alone.
  let exitInfo = null;
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });

  // Every raw stdout line is kept, parseable or not: a fault that corrupts the
  // framing has to be observable, not silently dropped by the client.
  const rawLines = [];
  const corrupted = [];
  const responses = [];
  const idle = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      rawLines.push(line);
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { corrupted.push(line); continue; }
      responses.push(parsed);
      for (const wake of idle.splice(0)) wake();
    }
  });

  let nextId = 1;

  const api = {
    child,
    rawLines,
    corrupted,
    responses,
    get stderr() { return stderr; },
    get exitCode() { return child.exitCode; },
    get exitInfo() { return exitInfo; },
    get hasExited() { return exitInfo !== null; },

    // Arbitrary bytes on the request channel. Malformed-input tests need to send
    // things that are not one well-formed JSON object per line.
    sendRaw(text) { child.stdin.write(text); },
    sendLine(line) { child.stdin.write(`${line}\n`); },

    async waitForResponse(id, timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = responses.find(r => r.id === id);
        if (found) return found;
        // Fail fast and say why: a server that died mid-request must not be
        // reported as a 30s timeout, which hides a crash as a hang.
        if (exitInfo) {
          throw new Error(`server exited (code=${exitInfo.code} signal=${exitInfo.signal}) while awaiting id ${id}; `
            + `${responses.length} responses received, ${corrupted.length} corrupt; stderr tail:\n${stderr.slice(-2000)}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`no response for id ${id} within ${timeout}ms; got ${responses.length} responses, `
            + `${corrupted.length} corrupt; stderr tail:\n${stderr.slice(-2000)}`);
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

    // Waits for `count` responses rather than a specific id, which is what a
    // malformed-input test needs: the ids it gets back are not all usable.
    async waitForResponseCount(count, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (responses.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`only ${responses.length} of ${count} responses arrived; stderr:\n${stderr}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return responses.length;
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
        if (Date.now() > deadline) {
          throw new Error(`screen never contained ${marker}; last:\n${result.screen}`);
        }
        await api.call('terminal.wait', { sessionId, afterRevision: result.revision, timeoutMs: 250 });
      }
    },

    endStdin() { child.stdin.end(); },
    destroyStdin() { child.stdin.destroy(); },
    destroyStdout() { child.stdout.destroy(); },
    killHard() { child.kill('SIGKILL'); },

    // Resolves with {code, signal}, or null if the server is still running after
    // the timeout. `code` is null for a signalled exit, so callers must test the
    // return value itself, not `code`.
    async exited(timeout = 45000) {
      if (exitInfo) return exitInfo;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, timeout);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      return exitInfo;
    },

    async stop() {
      api.endStdin();
      const info = await api.exited();
      if (!info) api.killHard();
      return info;
    },
  };
  return api;
}

// Every pid in `pids` must be gone. Used to prove a fault did not leak processes.
export async function allGone(pids, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const live = pids.filter(pid => Number.isInteger(pid) && pid > 0 && alive(pid));
    if (!live.length) return [];
    if (Date.now() > deadline) return live;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
