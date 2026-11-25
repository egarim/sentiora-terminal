// Drives src/server.js's request handler with a scriptable transport.
//
// The production module is imported and exercised exactly as the stdio transport
// exercises it; only the response sink is replaced, so a test can decide whether a
// response was "delivered" -- and crucially *when* the delivery verdict arrives --
// and inspect precisely what the server tried to send. That is the seam issue #14
// needs: its failure paths cannot be provoked reliably by breaking a real pipe.
//
// This runs in a subprocess on purpose. A real ConPTY session leaks one socket
// handle inside its host process -- node-pty never destroys
// WindowsPtyAgent._inSocket -- so creating sessions inside the test runner would
// keep it alive after the last test finished. Here the harness owns the sessions
// and exits explicitly.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { handleRequest, dispatch, respond, shutdown, sessions, inflightInfo, SESSION_LIMIT } from '../../src/server.js';

// Captured before any test can swap process.stdout, so replies always reach the
// test process even while a broken-pipe probe is installed.
const realStdout = process.stdout;

// Awaited so a reply is flushed before the next one is queued; stdout is a pipe
// here and an unflushed write would be lost on exit.
const reply = payload => new Promise(resolve => realStdout.write(`${JSON.stringify(payload)}\n`, resolve));

const deferredByToken = new Map();
const pendingOps = new Map();
let tokenSeq = 0;

// A stand-in for a stdout whose pipe has broken: write() accepts the bytes (so a
// synchronous check would report success) and then fails through the callback,
// which is how EPIPE actually surfaces on a pipe. A real Writable rather than a
// plain object, because library code between the swap and the write expects the
// full stream surface.
function brokenStdout(sink) {
  const stream = new Writable({
    write(chunk, encoding, callback) {
      sink.push(chunk.toString());
      queueMicrotask(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    },
  });
  // The production 'error' listener is attached to the real stdout at import time
  // and does not follow the swap; swallow here so the probe cannot crash the
  // harness. The delivery verdict under test arrives through the write callback.
  stream.on('error', () => {});
  return stream;
}

function swapStdout(value) {
  Object.defineProperty(process, 'stdout', { value, configurable: true, writable: true });
}

const ops = {
  // One raw JSON-RPC line through the real handler. `deliver: false` makes the
  // transport refuse the response outright.
  async rpc({ line, deliver }) {
    const sent = [];
    await handleRequest(line, payload => { sent.push(payload); return deliver !== false; });
    return { sent };
  },

  // Runs the real handleRequest against a stdout that accepts the write and then
  // fails it asynchronously -- the EPIPE case. Uses the production respond(), not a
  // stub, so this exercises the actual delivery-confirmation path.
  async brokenPipeRpc({ line }) {
    const sink = [];
    const real = process.stdout;
    swapStdout(brokenStdout(sink));
    try {
      await handleRequest(line, respond);
    } finally {
      swapStdout(real);
    }
    return { sent: sink.map(raw => JSON.parse(raw)) };
  },

  // Starts a request whose response sink delays its verdict, and returns without
  // awaiting it. The create is then genuinely in flight -- spawned, observed, not
  // yet committed -- so a shutdown() landing in that window can be tested.
  async startSlowRpc({ key, line, delayMs }) {
    const promise = (async () => {
      const sent = [];
      await handleRequest(line, async payload => {
        sent.push(payload);
        await new Promise(resolve => setTimeout(resolve, delayMs ?? 1500));
        // Claims delivery *after* shutdown has begun, which is the race.
        return true;
      });
      return sent;
    })();
    pendingOps.set(key, promise);
    return {};
  },

  async awaitSlowRpc({ key }) {
    const promise = pendingOps.get(key);
    if (!promise) return { error: `unknown key ${key}` };
    pendingOps.delete(key);
    return { sent: await promise };
  },

  // Starts a request whose response sink NEVER settles, and returns without
  // awaiting it. The create is then parked in `inflight` indefinitely, which is the
  // only way to prove that shutdown() reaps it rather than relying on commit()
  // noticing that teardown has begun.
  async startStuckRpc({ key, line }) {
    pendingOps.set(key, handleRequest(line, () => new Promise(() => {})));
    return {};
  },

  // Runs the production respond() against a stdout that accepts the write and never
  // calls back -- a reader that has stopped draining rather than one that has gone
  // away. Exercises the delivery grace bound, which resolves true on purpose so a
  // slow client keeps its session.
  async stalledRpc({ line }) {
    const sink = [];
    const real = process.stdout;
    const stalled = new Writable({ write(chunk, encoding, callback) { sink.push(chunk.toString()); } });
    stalled.on('error', () => {});
    swapStdout(stalled);
    try {
      await handleRequest(line, respond);
    } finally {
      swapStdout(real);
    }
    return { sent: sink.map(raw => JSON.parse(raw)) };
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
    return { ids: [...sessions.keys()], limit: SESSION_LIMIT, inflight: inflightInfo() };
  },

  // Provokes the cleanup failures a closing session can hit: a write chain that
  // rejects, and an emulator that refuses to dispose. `pending` is trapped with an
  // accessor so the next PTY chunk cannot silently re-link it into a healthy chain,
  // which would turn the sabotage into a no-op and the test into a false pass.
  async sabotage({ sessionId, poisonPending, breakDispose }) {
    const s = sessions.get(sessionId);
    if (!s) return { error: `unknown session ${sessionId}` };
    if (poisonPending) {
      const poisoned = Promise.reject(new Error('poisoned write chain'));
      poisoned.catch(() => {}); // handled here so Node does not report it before close() awaits it
      Object.defineProperty(s, 'pending', { get: () => poisoned, set() {}, configurable: true });
    }
    if (breakDispose) s.terminal.dispose = () => { throw new Error('dispose failed'); };
    return { state: s.state };
  },

  // An emulator write that never invokes its callback: close() must still settle
  // rather than hang terminal.close and strand the slot forever.
  async hangWrites({ sessionId }) {
    const s = sessions.get(sessionId);
    if (!s) return { error: `unknown session ${sessionId}` };
    s.terminal.write = () => {};
    s.pending = new Promise(() => {});
    return {};
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
