// The cross-session mailbox (issue #34): a sequenced, bounded, host-relayed channel that is
// deliberately not the PTY. These drive the real runtime over its real stdio transport.
//
// The security property is the one that matters most: holding a mailbox capability authorises
// messages only. MB-04 pins that a capability cannot be used as an owner token.
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
  return {
    child,
    get stderr() { return stderr; },
    async request(method, params, timeoutMs = 30000) {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = responses.find(response => response.id === id);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no response for ${method} within ${timeoutMs}ms; stderr:\n${stderr}`);
        await Promise.race([new Promise(resolve => idle.push(resolve)), new Promise(resolve => setTimeout(resolve, 20))]);
      }
    },
    async call(method, params, timeoutMs) {
      const response = await this.request(method, params, timeoutMs);
      assert.ok(response.result !== undefined, `${method} failed: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    async create() {
      return this.call('terminal.create', { command: process.execPath, args: [FIXTURE], cols: 40, rows: 10 });
    },
    async stop() {
      child.stdin.end();
      await new Promise(resolve => { const t = setTimeout(resolve, 15000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    },
  };
}

test('MB-01 a message reaches its target in sequence', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const created = await runtime.create();
  assert.equal(typeof created.mailbox, 'string', 'create must return a mailbox capability');
  assert.notEqual(created.mailbox, created.owner, 'the mailbox capability must not be the owner token');

  const first = await runtime.call('terminal.post', { sessionId: created.sessionId, capability: created.mailbox, payload: { kind: 'task', text: 'one' } });
  const second = await runtime.call('terminal.post', { sessionId: created.sessionId, capability: created.mailbox, payload: { kind: 'task', text: 'two' } });
  assert.deepEqual([first.sequence, second.sequence], [1, 2]);

  const drained = await runtime.call('terminal.mailbox', { sessionId: created.sessionId, capability: created.mailbox, afterSequence: 0 });
  assert.deepEqual(drained.messages.map(m => m.payload.text), ['one', 'two']);
  assert.equal(drained.nextSequence, 2);
  assert.equal(drained.dropped, 0);
});

test('MB-02 the cursor returns only later messages', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const created = await runtime.create();
  for (const text of ['a', 'b', 'c']) {
    await runtime.call('terminal.post', { sessionId: created.sessionId, capability: created.mailbox, payload: text });
  }
  const after = await runtime.call('terminal.mailbox', { sessionId: created.sessionId, capability: created.mailbox, afterSequence: 2 });
  assert.deepEqual(after.messages.map(m => m.payload), ['c']);
  assert.equal(after.nextSequence, 3);
});

test('MB-03 a wrong, missing or foreign capability is refused', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const a = await runtime.create();
  const b = await runtime.create();

  const wrong = await runtime.request('terminal.post', { sessionId: a.sessionId, capability: 'not-the-capability', payload: 'x' });
  assert.match(wrong.error.message, /Mailbox capability required/);

  const missing = await runtime.request('terminal.post', { sessionId: a.sessionId, payload: 'x' });
  assert.match(missing.error.message, /Mailbox capability required/);

  // A capability for B must not open A's mailbox, and must not be usable on B's behalf on A.
  const crossed = await runtime.request('terminal.post', { sessionId: a.sessionId, capability: b.mailbox, payload: 'x' });
  assert.match(crossed.error.message, /Mailbox capability required/);

  const unknown = await runtime.request('terminal.post', { sessionId: 'session-that-never-existed', capability: a.mailbox, payload: 'x' });
  assert.match(unknown.error.message, /Unknown session/);
});

test('MB-04 a mailbox capability is not an input right', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const created = await runtime.create();

  // The strongest form of the rule: even the capability that can post into a session cannot
  // type into it, because every write path still checks the owner token.
  const typed = await runtime.request('terminal.type', { sessionId: created.sessionId, owner: created.mailbox, revision: 1, text: 'echo pwned\r' });
  assert.ok(typed.error, 'a mailbox capability must not authorise terminal.type');
  assert.match(typed.error.message, /ownership required/i);

  const closed = await runtime.request('terminal.close', { sessionId: created.sessionId, owner: created.mailbox });
  assert.ok(closed.error, 'a mailbox capability must not authorise terminal.close');
});

test('MB-05 oversize and non-encodable payloads are refused', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const created = await runtime.create();
  const base = { sessionId: created.sessionId, capability: created.mailbox };

  const huge = await runtime.request('terminal.post', { ...base, payload: 'x'.repeat(70 * 1024) });
  assert.match(huge.error.message, /Message too large/);

  // undefined and functions have no JSON encoding; accepting them would silently post nothing.
  const empty = await runtime.request('terminal.post', { ...base, payload: undefined });
  assert.match(empty.error.message, /Invalid message/);
});

test('MB-06 queue overflow drops the oldest and reports the gap', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const created = await runtime.create();
  const post = text => runtime.call('terminal.post', { sessionId: created.sessionId, capability: created.mailbox, payload: text });

  // The per-second rate limit is part of the contract, so the volume that overflows the
  // 256-deep queue has to be spread over seconds rather than fired in one burst.
  let last;
  for (let batch = 0; batch < 3; batch += 1) {
    for (let i = 0; i < 90; i += 1) last = await post(`m${batch * 90 + i}`);
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  assert.equal(last.dropped, 14, `270 posts into a 256-deep queue must drop 14, got ${last.dropped}`);

  const drained = await runtime.call('terminal.mailbox', { sessionId: created.sessionId, capability: created.mailbox, afterSequence: 0 });
  assert.equal(drained.messages.length, 256, 'the queue holds exactly its depth');
  assert.equal(drained.nextSequence, 270);
  assert.equal(drained.messages[0].sequence, 15, 'the 14 oldest messages are the ones dropped');
  assert.equal(drained.dropped, 14);
});

test('MB-07 a waiting mailbox wakes when a message is posted', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const created = await runtime.create();

  const waiting = runtime.request('terminal.mailbox', { sessionId: created.sessionId, capability: created.mailbox, afterSequence: 0, timeoutMs: 10000 });
  await new Promise(resolve => setTimeout(resolve, 200));
  const postedAt = Date.now();
  await runtime.call('terminal.post', { sessionId: created.sessionId, capability: created.mailbox, payload: 'wake' });
  const answered = await waiting;
  const elapsed = Date.now() - postedAt;

  assert.equal(answered.result.messages.length, 1);
  assert.equal(answered.result.messages[0].payload, 'wake');
  assert.ok(elapsed < 5000, `the long poll took ${elapsed}ms to wake after the post`);
});
