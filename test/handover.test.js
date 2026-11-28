// Cooperative handover of input ownership (issue #4, slice 1). The current owner gives the input
// rights away; the token it held stops working immediately, and the old token is not merely
// "less preferred" -- every gated path must refuse it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/interactive.mjs', import.meta.url));

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
  let nextId = 0;
  async function request(method, params, timeoutMs = 30000) {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = responses.find(response => response.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no response for ${method}; stderr:\n${stderr}`);
      await Promise.race([new Promise(resolve => idle.push(resolve)), new Promise(resolve => setTimeout(resolve, 20))]);
    }
  }
  return {
    request,
    async call(method, params, timeoutMs) {
      const response = await request(method, params, timeoutMs);
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

test('OW-01 handover returns a new owner token and a different one', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const session = await runtime.create();

  const handed = await runtime.call('terminal.handover', { sessionId: session.sessionId, owner: session.owner });
  assert.equal(typeof handed.owner, 'string');
  assert.notEqual(handed.owner, session.owner, 'a handover must issue a different token');

  // The old token is refused everywhere it used to work, so the new owner is not one of two.
  const stale = await runtime.request('terminal.observe', { sessionId: session.sessionId });
  assert.ok(stale.result, 'observing stays ungated, as before');

  const typed = await runtime.request('terminal.type', {
    sessionId: session.sessionId, owner: session.owner, revision: stale.result.revision, text: 'x',
  });
  assert.match(typed.error.message, /ownership required/i);

  const closed = await runtime.request('terminal.close', { sessionId: session.sessionId, owner: session.owner });
  assert.match(closed.error.message, /Ownership required/);
});

test('OW-02 the new owner can type, resize and close', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const session = await runtime.create();
  const handed = await runtime.call('terminal.handover', { sessionId: session.sessionId, owner: session.owner });

  const observed = await runtime.call('terminal.observe', { sessionId: session.sessionId });
  const typed = await runtime.request('terminal.type', {
    sessionId: session.sessionId, owner: handed.owner, revision: observed.revision, text: 'echo HANDOVER-OK\r',
  });
  assert.ok(typed.result !== undefined, `the new owner must be able to type: ${JSON.stringify(typed.error)}`);

  const resized = await runtime.request('terminal.resize', {
    sessionId: session.sessionId, owner: handed.owner, cols: 70, rows: 20,
  });
  assert.ok(resized.result !== undefined, `the new owner must be able to resize: ${JSON.stringify(resized.error)}`);

  assert.equal(await runtime.call('terminal.close', { sessionId: session.sessionId, owner: handed.owner }), true);
});

test('OW-03 only the current owner can hand a session over', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const session = await runtime.create();

  const impostor = await runtime.request('terminal.handover', { sessionId: session.sessionId, owner: 'not-the-owner' });
  assert.match(impostor.error.message, /Ownership required/);

  const missing = await runtime.request('terminal.handover', { sessionId: session.sessionId });
  assert.match(missing.error.message, /Ownership required/);

  // Refused handovers must not have rotated anything: the original owner still works.
  const observed = await runtime.call('terminal.observe', { sessionId: session.sessionId });
  const typed = await runtime.request('terminal.type', {
    sessionId: session.sessionId, owner: session.owner, revision: observed.revision, text: 'echo STILL-MINE\r',
  });
  assert.ok(typed.result !== undefined);
  assert.equal(await runtime.call('terminal.close', { sessionId: session.sessionId, owner: session.owner }), true);
});
