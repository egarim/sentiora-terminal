// Parent/child edges (issue #35): `terminal.create { parent }` mints one capability for the
// edge, accepted at either end and nowhere else. That is the structural form of "no
// sibling-to-sibling, no broadcast" -- a sibling never holds the capability to begin with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/interactive.mjs', import.meta.url));
const PRINT_ENV = 'console.log("CAP=" + (process.env.SENTIORA_MAILBOX_CAPABILITY ?? "none") + "|PARENT=" + (process.env.SENTIORA_PARENT_SESSION ?? "none"))';

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
    async createWith(params = {}) {
      return this.call('terminal.create', { command: process.execPath, args: [FIXTURE], cols: 40, rows: 10, ...params });
    },
    async stop() {
      child.stdin.end();
      await new Promise(resolve => { const t = setTimeout(resolve, 15000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    },
  };
}

test('PE-01 a child is created with an edge capability in its env', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId, args: ['-e', PRINT_ENV] });

  assert.equal(typeof child.childMailbox, 'string', 'a parented create must return the edge capability');
  assert.notEqual(child.childMailbox, child.mailbox, 'the edge capability is not the child\'s own mailbox capability');

  // The child sees the capability and its parent's session id, and nothing else of the parent.
  // Compare with whitespace collapsed: a 40-column terminal wraps a 48-character capability
  // across lines, and asserting on the raw screen would be asserting on the wrap width.
  let screen = '';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    screen = (await runtime.call('terminal.observe', { sessionId: child.sessionId })).screen;
    if (/CAP=/.test(screen)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const flat = screen.replace(/\s+/g, '');
  assert.ok(flat.includes(`CAP=${child.childMailbox}`), `child env did not carry the edge capability:\n${screen}`);
  assert.ok(flat.includes(`PARENT=${parent.sessionId}`), `child env did not carry the parent session id:\n${screen}`);
});

test('PE-02 the parent can post to its child through the edge', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });

  await runtime.call('terminal.post', { sessionId: child.sessionId, capability: child.childMailbox, payload: { kind: 'task', text: 'run it' } });
  const drained = await runtime.call('terminal.mailbox', { sessionId: child.sessionId, capability: child.childMailbox, afterSequence: 0 });
  assert.deepEqual(drained.messages.map(m => m.payload.text), ['run it']);
});

test('PE-03 the child can answer its parent through the same edge', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });

  // The same capability, used at the other end. Both directions are one edge, which is what
  // makes a child unable to reach a sibling: it holds only edges it is one end of.
  await runtime.call('terminal.post', { sessionId: parent.sessionId, capability: child.childMailbox, payload: { kind: 'result', text: 'done' } });
  const drained = await runtime.call('terminal.mailbox', { sessionId: parent.sessionId, capability: child.childMailbox, afterSequence: 0 });
  assert.deepEqual(drained.messages.map(m => m.payload.text), ['done']);
});

test('PE-04 an edge capability cannot open a session that is not one of its ends', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });
  const stranger = await runtime.createWith();

  const refused = await runtime.request('terminal.post', { sessionId: stranger.sessionId, capability: child.childMailbox, payload: 'x' });
  assert.match(refused.error.message, /Mailbox capability required/);
});

test('PE-05 an unknown or malformed parent is refused before anything spawns', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());

  const unknown = await runtime.request('terminal.create', { command: process.execPath, args: [FIXTURE], parent: 'session-that-never-existed' });
  assert.match(unknown.error.message, /Unknown parent/);

  const malformed = await runtime.request('terminal.create', { command: process.execPath, args: [FIXTURE], parent: 42 });
  assert.match(malformed.error.message, /Unknown parent/);

  const listed = await runtime.call('terminal.list', {});
  assert.equal(listed.length, 0, 'a refused parented create must leave no session behind');
});

test('PE-06 closing either end drops the edge and its capability', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });
  const capability = child.childMailbox;

  await runtime.call('terminal.close', { sessionId: child.sessionId, owner: child.owner });

  // The edge is gone with the child, so the capability no longer answers for the parent.
  const afterClose = await runtime.request('terminal.post', { sessionId: parent.sessionId, capability, payload: 'late' });
  assert.match(afterClose.error.message, /Mailbox capability required/);

  // The parent's own capability is unaffected.
  const own = await runtime.call('terminal.post', { sessionId: parent.sessionId, capability: parent.mailbox, payload: 'still here' });
  assert.equal(own.sequence, 1);
});
