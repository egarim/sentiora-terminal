// Request cancellation (issue #2): `$/cancelRequest`, the LSP shape. A client can abandon a request
// that is waiting and get a definite answer instead of waiting out the timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/interactive.mjs', import.meta.url));
const CANCELLED = -32800;

const opts = { timeout: 60000 };

function startRuntime() {
  const child = spawn(process.execPath, [SERVER], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = '';
  const responses = [];
  const idle = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      responses.push(JSON.parse(line));
      for (const wake of idle.splice(0)) wake();
    }
  });

  let nextId = 1000;
  const write = message => child.stdin.write(`${JSON.stringify(message)}\n`);

  async function waitFor(id, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = responses.find(response => response.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no answer for id ${id}; stderr:\n${stderr}`);
      await Promise.race([new Promise(resolve => idle.push(resolve)), new Promise(resolve => setTimeout(resolve, 20))]);
    }
  }

  return {
    write,
    waitFor,
    async request(method, params) {
      const id = ++nextId;
      write({ jsonrpc: '2.0', id, method, params });
      return waitFor(id);
    },
    async call(method, params) {
      const response = await this.request(method, params);
      assert.ok(response.result !== undefined, `${method} failed: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    async create() {
      return this.call('terminal.create', { command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
    },
    async stop() {
      child.stdin.end();
      await new Promise(resolve => { const t = setTimeout(resolve, 15000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    },
  };
}


/** Polls observe until the needle appears, so a wait is started from a settled screen. */
async function waitForScreen(runtime, sessionId, needle, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let observation = await runtime.call('terminal.observe', { sessionId });
  while (!observation.screen.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`'${needle}' did not appear; screen:\n${observation.screen}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    observation = await runtime.call('terminal.observe', { sessionId });
  }
  return observation;
}
test('CAN-01 a waiting request can be abandoned with $/cancelRequest', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const session = await runtime.create();
  const observed = await runtime.call('terminal.observe', { sessionId: session.sessionId });

  // A wait that would block for 30 s: the fixture only writes when told to.
  // A mailbox long poll, not terminal.wait: a wait resolves the moment ANY output arrives, so it
  // races its own cancellation; a mailbox poll blocks until a message that never comes.
  const id = 5001;
  runtime.write({
    jsonrpc: '2.0', id, method: 'terminal.mailbox',
    params: { sessionId: session.sessionId, capability: session.mailbox, afterSequence: 0, timeoutMs: 30000 },
  });
  await new Promise(resolve => setTimeout(resolve, 150));

  const cancelledAt = Date.now();
  runtime.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
  const answer = await runtime.waitFor(id, 10000);
  const elapsed = Date.now() - cancelledAt;

  assert.ok(answer.error, 'a cancelled request must be answered with an error, not a result');
  assert.equal(answer.error.code, CANCELLED, `expected -32800, got ${JSON.stringify(answer.error)}`);
  assert.match(answer.error.message, /cancel/i);
  // The whole point: an answer now, not in 30 s.
  assert.ok(elapsed < 5000, `cancellation took ${elapsed}ms; the wait was 30000ms`);
});

test('CAN-02 cancelling an unknown id is a no-op and the host keeps serving', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());

  runtime.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 999999 } });
  // No answer is produced for a notification, and the next request still works.
  const listed = await runtime.call('terminal.list', {});
  assert.ok(Array.isArray(listed));

  // A notification with no id is never answered at all: the next response must belong to our id.
  const observed = await runtime.request('initialize', {});
  assert.equal(observed.result.protocolVersion, 1);
});

test('CAN-03 a request that is not cancelled still answers normally', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const session = await runtime.create();

  // Cancel a different id, then let this wait run its short timeout: the result must be a normal
  // one, proving the cancellation map did not leak across requests.
  const otherId = 6001;
  runtime.write({
    jsonrpc: '2.0', id: otherId, method: 'terminal.mailbox',
    params: { sessionId: session.sessionId, capability: session.mailbox, afterSequence: 0, timeoutMs: 300 },
  });
  runtime.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 424242 } });
  const answer = await runtime.waitFor(otherId, 10000);
  assert.ok(answer.result, `expected a normal observation, got ${JSON.stringify(answer.error)}`);
  assert.deepEqual(answer.result.messages, [], 'a poll with no messages answers with an empty frame');
});
