// Client for test/fixtures/server-harness.mjs: runs src/server.js in a
// subprocess with a scriptable transport so the registry and delivery-failure
// paths can be driven deterministically.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HARNESS = fileURLToPath(new URL('../fixtures/server-harness.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const rpcLine = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

// process.kill(pid, 0) is the portable existence probe: it delivers no signal and
// throws ESRCH once the process is gone. EPERM means it exists but is not ours.
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function untilGone(pid, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`child ${pid} was still alive after ${timeout}ms`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export function reap(pid) {
  try { process.kill(pid); } catch { /* already gone */ }
}

export function startRegistry() {
  const child = spawn(process.execPath, [HARNESS], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  const replies = new Map();
  const harnessErrors = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined || message.id === null) { harnessErrors.push(message); continue; }
      const wake = replies.get(message.id);
      replies.delete(message.id);
      if (wake) wake(message);
    }
  });

  let nextId = 1;
  // A request that times out used to report only how long it waited, which cannot tell
  // apart the two causes that matter: an operation whose promise never settles (a JS-level
  // stall) and a harness whose event loop is blocked (a synchronous or native call that
  // never returns). They need different fixes, so the failure should say which one it was.
  // The line handler dispatches each op independently, so a cheap op after the timeout is a
  // fair liveness probe.
  async function diagnoseStall(op, id) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return `the harness process had exited (code ${child.exitCode}, signal ${child.signalCode})`;
    }
    const probeId = `probe-for-${id}`;
    const answered = await new Promise(resolve => {
      const timer = setTimeout(() => { replies.delete(probeId); resolve(null); }, 3000);
      replies.set(probeId, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ op: 'state', id: probeId })}\n`);
    });
    if (!answered) {
      return 'the harness stopped answering even a trivial op, so its event loop is blocked ' +
        '(a synchronous or native call is not returning) -- not the host being busy';
    }
    return `the harness still answers (${answered.error ? 'with an error' : 'with state'}), so ` +
      `'${op}' is stuck in its own promise while the loop keeps running`;
  }

  function send(op, args, { timeout = 60000 } = {}) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ op, id, ...args })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        replies.delete(id);
        void diagnoseStall(op, id).then(verdict => reject(
          new Error(`harness op ${op} (id ${id}) did not answer within ${timeout}ms; ${verdict}; stderr:\n${stderr}`)));
      }, timeout);
      replies.set(id, message => { clearTimeout(timer); resolve(message); });
    });
  }

  // Writing to a harness that already died is an EPIPE on this stream; without a
  // listener it becomes an uncaught exception in the test runner during teardown.
  child.stdin.on('error', () => {});

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    // 'exit' answers with process termination rather than a reply, so completion
    // is the child's exit event.
    if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify({ op: 'exit' })}\n`);
    }
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 30000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    // A harness that crashed replies with id:null. Surfacing it here means a crash
    // cannot pass as a clean teardown just because the tests happened to be done.
    if (harnessErrors.length) {
      throw new Error(`harness reported ${harnessErrors.length} failure(s):\n${harnessErrors.map(e => e.error).join('\n')}`);
    }
  }

  const api = {
    get stderr() { return stderr; },
    get harnessErrors() { return harnessErrors; },
    send,
    stop,
    // One JSON-RPC line through the production handler. deliver:false makes the
    // transport refuse the response.
    async rpc(line, { deliver = true } = {}) {
      const reply = await send('rpc', { line, deliver });
      if (reply.error) throw new Error(`harness rpc failed: ${reply.error}`);
      return reply;
    },
    async request(id, method, params, options) {
      return api.rpc(rpcLine(id, method, params), options);
    },
    async create(params, options) {
      const reply = await api.request(1, 'terminal.create', params, options);
      return { ...reply, result: reply.sent[0]?.result, error: reply.sent[0]?.error };
    },
    async close(sessionId, owner) {
      const reply = await api.request(2, 'terminal.close', { sessionId, owner });
      return { ...reply, result: reply.sent[0]?.result, error: reply.sent[0]?.error };
    },
    async state() { return send('state', {}); },
    async call(method, params) { return send('call', { method, params }); },
    async commit(token) { return send('commit', { token }); },
    async rollback(token) { return send('rollback', { token }); },
    async sabotage(sessionId, what) { return send('sabotage', { sessionId, ...what }); },
    async hangWrites(sessionId) { return send('hangWrites', { sessionId }); },
    async closeAll() { return send('closeAll', {}); },
    // Runs the production respond() against a stdout that accepts the write and
    // then fails it through the callback, the way EPIPE actually arrives.
    async brokenPipeRpc(line) {
      const reply = await send('brokenPipeRpc', { line });
      if (reply.error) throw new Error(`harness brokenPipeRpc failed: ${reply.error}`);
      return reply;
    },
    async startSlowRpc(key, line, delayMs) { return send('startSlowRpc', { key, line, delayMs }); },
    async awaitSlowRpc(key) { return send('awaitSlowRpc', { key }); },
    async startStuckRpc(key, line) { return send('startStuckRpc', { key, line }); },
    async stalledRpc(line) {
      const reply = await send('stalledRpc', { line });
      if (reply.error) throw new Error(`harness stalledRpc failed: ${reply.error}`);
      return reply;
    },
  };
  return api;
}
