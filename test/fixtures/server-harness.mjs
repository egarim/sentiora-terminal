// Drives src/server.js's request handler with a scriptable transport.
//
// The production module is imported and exercised exactly as the stdio transport
// exercises it; only the response sink is replaced, so a test can decide whether
// a response was "delivered" and inspect precisely what the server tried to send.
// That is the seam issue #14 needs: the defect is in what happens when delivery
// fails, which cannot be provoked reliably by breaking a real pipe.
//
// This runs in a subprocess on purpose. A real ConPTY session leaks one socket
// handle inside its host process -- node-pty never destroys
// WindowsPtyAgent._inSocket -- so creating sessions inside the test runner would
// keep it alive after the last test finished. Here the harness owns the sessions
// and exits explicitly.
import { createInterface } from 'node:readline';
import { handleRequest, dispatch, shutdown, sessions, SESSION_LIMIT } from '../../src/server.js';

// Awaited so a reply is flushed before the next one is queued; stdout is a pipe
// here and an unflushed write would be lost on exit.
const reply = payload => new Promise(resolve => process.stdout.write(`${JSON.stringify(payload)}\n`, resolve));

const deferredByToken = new Map();
let tokenSeq = 0;

const ops = {
  // One raw JSON-RPC line through the real handler. `deliver: false` makes the
  // transport refuse the response, which is the acknowledgement the create path
  // commits or rolls back on.
  async rpc({ line, deliver }) {
    const sent = [];
    await handleRequest(line, payload => { sent.push(payload); return deliver !== false; });
    return { sent };
  },

  // Calls dispatch() directly and hands back tokens for the deferred creates it
  // produced, so a test can check registry visibility before and after commit.
  async call({ method, params }) {
    const deferred = [];
    let result; let error = null;
    try { result = await dispatch(method, params ?? {}, deferred); } catch (e) { error = String(e?.message ?? e); }
    const tokens = deferred.map(d => { const token = `deferred-${++tokenSeq}`; deferredByToken.set(token, d); return token; });
    return { result, error, tokens };
  },

  async commit({ token }) {
    const d = deferredByToken.get(token);
    if (!d) return { error: `unknown token ${token}` };
    deferredByToken.delete(token);
    d.commit();
    return {};
  },

  async rollback({ token }) {
    const d = deferredByToken.get(token);
    if (!d) return { error: `unknown token ${token}` };
    deferredByToken.delete(token);
    await d.rollback();
    return {};
  },

  async state() {
    return { ids: [...sessions.keys()], limit: SESSION_LIMIT };
  },

  // Provokes the cleanup failures a closing session can hit: a poisoned write
  // chain (which close() awaits) and an emulator that refuses to dispose.
  async sabotage({ sessionId, poisonPending, breakDispose }) {
    const s = sessions.get(sessionId);
    if (!s) return { error: `unknown session ${sessionId}` };
    if (poisonPending) {
      const poisoned = Promise.reject(new Error('poisoned write chain'));
      poisoned.catch(() => {}); // handled here so Node does not report it before close() awaits it
      s.pending = poisoned;
    }
    if (breakDispose) s.terminal.dispose = () => { throw new Error('dispose failed'); };
    return { state: s.state };
  },

  async closeAll() { await shutdown(); return {}; },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async line => {
  let req;
  try { req = JSON.parse(line); } catch { await reply({ id: null, error: 'harness request was not JSON' }); return; }
  const { op, id, ...args } = req;
  if (op === 'exit') { await shutdown(); process.exit(0); }
  const handler = ops[op];
  if (!handler) { await reply({ id, error: `unknown harness op ${op}` }); return; }
  try {
    const out = await handler(args);
    await reply({ id, ok: true, ...out, sessions: sessions.size });
  } catch (e) {
    await reply({ id, error: String(e?.message ?? e), sessions: sessions.size });
  }
});

// The test ended without saying exit; do not leave children behind.
rl.on('close', async () => { await shutdown(); process.exit(0); });
process.on('uncaughtException', error => { void reply({ id: null, error: `harness crashed: ${error?.stack ?? error}` }); });
