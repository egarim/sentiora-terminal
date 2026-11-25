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
  function send(op, args, { timeout = 60000 } = {}) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ op, id, ...args })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`harness op ${op} (id ${id}) did not answer within ${timeout}ms; stderr:\n${stderr}`));
      }, timeout);
      replies.set(id, message => { clearTimeout(timer); resolve(message); });
    });
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    // 'exit' answers with process termination rather than a reply, so completion
    // is the child's exit event.
    child.stdin.write(`${JSON.stringify({ op: 'exit' })}\n`);
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 30000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
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
    async closeAll() { return send('closeAll', {}); },
  };
  return api;
}
