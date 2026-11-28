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
  assert.match(afterClose.error.message, /Edge closed/);

  // The parent's own capability is unaffected.
  const own = await runtime.call('terminal.post', { sessionId: parent.sessionId, capability: parent.mailbox, payload: 'still here' });
  assert.equal(own.sequence, 1);
});

// process.kill(pid, 0) is the portable existence probe: no signal delivered, ESRCH once gone.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function untilGone(pid, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`child ${pid} was still alive ${timeout}ms after its parent closed`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('PE-07 closeChildren makes a child die with its parent', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId, closeChildren: true });
  assert.equal((await runtime.call('terminal.list', {})).length, 2);

  await runtime.call('terminal.close', { sessionId: parent.sessionId, owner: parent.owner });

  const listed = await runtime.call('terminal.list', {});
  assert.equal(listed.length, 0, 'the registry must hold neither parent nor child');
  await untilGone(child.pid);
});

test('PE-08 by default a child outlives its parent', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });

  await runtime.call('terminal.close', { sessionId: parent.sessionId, owner: parent.owner });

  // Detaching is the default on purpose: killing a process the caller did not name is the more
  // surprising behaviour, so the cascade has to be asked for (PE-07).
  const listed = await runtime.call('terminal.list', {});
  assert.equal(listed.length, 1, 'the child must survive its parent by default');
  assert.equal(listed[0].sessionId, child.sessionId);
  assert.ok(alive(child.pid), 'the child process must still be running');
  await runtime.call('terminal.close', { sessionId: child.sessionId, owner: child.owner });
});

test('PE-09 closeChildren is validated rather than guessed', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();

  const notBoolean = await runtime.request('terminal.create', {
    command: process.execPath, args: [FIXTURE], parent: parent.sessionId, closeChildren: 'yes',
  });
  assert.match(notBoolean.error.message, /Invalid closeChildren/);

  const withoutParent = await runtime.request('terminal.create', {
    command: process.execPath, args: [FIXTURE], closeChildren: true,
  });
  assert.match(withoutParent.error.message, /closeChildren requires a parent/);

  assert.equal((await runtime.call('terminal.list', {})).length, 1, 'neither refusal may leave a session behind');
});

test('PE-10 a message to a closed edge says so instead of blaming the token', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });
  const capability = child.childMailbox;

  await runtime.call('terminal.close', { sessionId: child.sessionId, owner: child.owner });

  // The parent is still open, so this is not "Unknown session", and the capability was real until
  // a moment ago, so it is not "Mailbox capability required" either. A caller can tell a
  // lifecycle event from a bug in its own bookkeeping.
  const closed = await runtime.request('terminal.post', { sessionId: parent.sessionId, capability, payload: 'late' });
  assert.match(closed.error.message, /Edge closed/);

  const never = await runtime.request('terminal.post', { sessionId: parent.sessionId, capability: 'never-was-a-capability', payload: 'x' });
  assert.match(never.error.message, /Mailbox capability required/);
});

test('PE-11 an edge reaches its own two ends and nothing else', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });
  const grandchild = await runtime.createWith({ parent: child.sessionId });

  // The parent holds the edge to its child; that capability must not reach the grandchild.
  const up = await runtime.request('terminal.post', { sessionId: grandchild.sessionId, capability: child.childMailbox, payload: 'x' });
  assert.match(up.error.message, /Mailbox capability required/);

  // The child holds the edge to the grandchild; that capability must not reach the parent.
  const down = await runtime.request('terminal.post', { sessionId: parent.sessionId, capability: grandchild.childMailbox, payload: 'x' });
  assert.match(down.error.message, /Mailbox capability required/);

  // Each edge still works at its own ends.
  await runtime.call('terminal.post', { sessionId: child.sessionId, capability: child.childMailbox, payload: 'to child' });
  const drained = await runtime.call('terminal.mailbox', { sessionId: child.sessionId, capability: child.childMailbox, afterSequence: 0 });
  assert.deepEqual(drained.messages.map(m => m.payload), ['to child']);
});

test('PE-12 the session list carries the parent link, and roots have none', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });

  assert.equal(child.parent, parent.sessionId, 'a parented create must name its parent');

  const listed = await runtime.call('terminal.list', {});
  const byId = new Map(listed.map(entry => [entry.sessionId, entry]));
  assert.equal(byId.get(parent.sessionId).parent, null, 'a root session has no parent');
  assert.equal(byId.get(child.sessionId).parent, parent.sessionId, 'the child names its parent');
  // A viewer must never be handed a capability, only the shape.
  for (const entry of listed) {
    assert.doesNotMatch(JSON.stringify(entry), /"owner"|"mailbox"|"childMailbox"/);
  }
});

test('PE-13 a detached child loses its parent link with the edge', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });

  await runtime.call('terminal.close', { sessionId: parent.sessionId, owner: parent.owner });

  const listed = await runtime.call('terminal.list', {});
  assert.equal(listed.length, 1, 'the child outlives the parent by default');
  assert.equal(listed[0].sessionId, child.sessionId);
  // The edge died with the parent, so the tree must not still claim a link that no longer exists
  // -- a viewer would draw a node pointing at a session that cannot be addressed.
  assert.equal(listed[0].parent, null, 'a detached child has no parent');
});

test('PE-14 closing a child leaves the parent listed as a root', opts, async t => {
  const runtime = startRuntime();
  t.after(() => runtime.stop());
  const parent = await runtime.createWith();
  const child = await runtime.createWith({ parent: parent.sessionId });

  await runtime.call('terminal.close', { sessionId: child.sessionId, owner: child.owner });

  const listed = await runtime.call('terminal.list', {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, parent.sessionId);
  assert.equal(listed[0].parent, null, 'the parent was a root before and is one after');
});
