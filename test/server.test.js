// Registry and delivery semantics of the JSON-RPC server (issue #14).
//
// A create response carries the owner token, and without it no method can close
// the session -- so a session registered before its response is confirmed
// delivered is a slot burned for the life of the process. These tests provoke
// exactly that: refused delivery, a failed spawn, a cleanup failure during close,
// a broken stdout, and capacity exhaustion.
//
// Every session here is real. src/server.js runs in a subprocess (see
// test/fixtures/server-harness.mjs) with only its response sink scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRegistry, rpcLine, untilGone, reap } from './helpers/registry.mjs';
import { FIXTURE } from './helpers/native.mjs';

const opts = { timeout: 180000 };
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const spawnFixture = extra => ({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 20, ...extra });

// Starts a harness and guarantees it is torn down, so a failing assertion cannot
// leave a subprocess holding PTY sessions.
async function registry(t) {
  const api = startRegistry();
  t.after(async () => { await api.stop(); });
  return api;
}

test('ST14-01 an undeliverable create response rolls the session back', opts, async t => {
  const api = await registry(t);
  const { result, sent, sessions } = await api.create(spawnFixture(), { deliver: false });

  // The response was built -- that is how the caller would have learned the owner
  // token -- but the transport refused it, so nobody holds that token.
  assert.equal(sent.length, 1);
  assert.ok(result.sessionId, 'the create result must carry a session id');
  assert.ok(result.owner, 'the create result must carry an owner token');
  assert.ok(Number.isInteger(result.pid) && result.pid > 0, `expected a real child pid, got ${result.pid}`);
  assert.equal(sessions, 0, 'a session whose owner token was never delivered must not stay registered');
  await untilGone(result.pid);

  // Gone, not merely hidden: every method must reject the id, and holding the
  // owner token from the undelivered response must not change that.
  for (const [method, params] of [
    ['terminal.observe', {}],
    ['terminal.type', { owner: result.owner, revision: 0, text: 'x' }],
    ['terminal.key', { owner: result.owner, revision: 0, key: 'Enter' }],
    ['terminal.wait', { afterRevision: 0, timeoutMs: 10 }],
    ['terminal.resize', { owner: result.owner, cols: 50, rows: 20 }],
    ['terminal.close', { owner: result.owner }],
  ]) {
    const probe = await api.request(2, method, { sessionId: result.sessionId, ...params });
    assert.match(probe.sent[0]?.error?.message ?? '', /Unknown session/, `${method} still reached the rolled-back session`);
  }
  assert.equal((await api.state()).sessions, 0);
});

test('ST14-02 a delivered create response commits exactly one session', opts, async t => {
  const api = await registry(t);
  const { result } = await api.create(spawnFixture());

  assert.ok(result.owner);
  assert.equal((await api.state()).sessions, 1);
  assert.deepEqual((await api.state()).ids, [result.sessionId]);

  const closed = await api.close(result.sessionId, result.owner);
  assert.equal(closed.result, true);
  assert.equal(closed.sessions, 0, 'closing must return the slot in the same response');
  await untilGone(result.pid);
});

test('ST14-03 a create that fails validation or spawn registers nothing', opts, async t => {
  const api = await registry(t);

  // Validation failures happen before any child exists, on every platform.
  const rejected = [
    [{ command: '' }, /Invalid command/],
    [{ command: process.execPath, args: 'not-an-array' }, /Invalid command/],
    [{ command: process.execPath, args: [FIXTURE], cols: 1, rows: 10 }, /Invalid dimensions/],
    [{ command: process.execPath, args: [FIXTURE], conptyDll: 'yes' }, /Invalid conptyDll/],
  ];
  for (const [params, expected] of rejected) {
    const { result, error, sessions } = await api.create(spawnFixture(params));
    assert.equal(result, undefined, `create should have been rejected: ${JSON.stringify(params)}`);
    assert.match(error?.message ?? '', expected, `wrong error for ${JSON.stringify(params)}`);
    assert.equal(sessions, 0, 'a rejected create must not consume a slot');
  }
  assert.equal((await api.state()).sessions, 0);

  // A synchronous pty.spawn failure is provoked with a cwd on a drive that does
  // not exist. That is Windows-specific: on POSIX the path is merely relative and
  // forkpty defers cwd/exec failures to the forked child, so spawn() returns a pid
  // and the session is created normally rather than throwing.
  if (process.platform === 'win32') {
    const { result, error, sessions } = await api.create(spawnFixture({ cwd: 'Z:/definitely/not/here' }));
    assert.equal(result, undefined);
    assert.ok(error, 'a failed spawn must be reported as a JSON-RPC error');
    assert.equal(sessions, 0, 'a failed spawn must not consume a slot');
    assert.equal((await api.state()).sessions, 0);
  }
});

test('ST14-04 a cleanup failure during terminal.close still frees the slot', opts, async t => {
  const api = await registry(t);
  const { result } = await api.create(spawnFixture());
  assert.equal((await api.state()).sessions, 1);

  // Provoke the two failures close() can hit: a rejected pending write chain
  // (which close awaits) and an emulator that refuses to dispose. Neither may
  // abort deregistration, because the registry entry is the capacity leak.
  const sabotaged = await api.sabotage(result.sessionId, { poisonPending: true, breakDispose: true });
  assert.equal(sabotaged.error, undefined, `sabotage failed: ${sabotaged.error}`);

  const closed = await api.close(result.sessionId, result.owner);
  assert.equal(closed.error, undefined, `close reported an error: ${JSON.stringify(closed.error)}`);
  assert.equal(closed.result, true, 'close must succeed even when cleanup fails');
  assert.equal(closed.sessions, 0, 'a failed cleanup must not strand the registry entry');
  await untilGone(result.pid);
});

test('ST14-05 session capacity recovers after the limit is reached', opts, async t => {
  const api = await registry(t);
  const { limit } = await api.state();
  const created = [];
  for (let i = 0; i < limit; i += 1) {
    const entry = await api.create(spawnFixture({ cols: 40, rows: 10 }));
    assert.equal(entry.error, undefined, `create ${i} failed: ${JSON.stringify(entry.error)}`);
    created.push(entry.result);
  }
  assert.equal((await api.state()).sessions, limit);

  const refused = await api.create(spawnFixture({ cols: 40, rows: 10 }));
  assert.match(refused.error?.message ?? '', /Session limit/);
  assert.equal(refused.sessions, limit, 'a refused create must not register anything');

  // terminal.list deliberately omits the owner token, so closing has to use the
  // tokens the create responses returned -- exactly what a real caller holds.
  const listed = await api.request(3, 'terminal.list', {});
  const listing = listed.sent[0].result;
  assert.equal(listing.length, limit);
  assert.equal(listing[0].owner, undefined, 'terminal.list must not leak owner tokens');

  for (const entry of created) {
    const closed = await api.close(entry.sessionId, entry.owner);
    assert.equal(closed.result, true, `close failed: ${JSON.stringify(closed.error)}`);
  }
  assert.equal((await api.state()).sessions, 0, 'closing every session must return every slot');

  const recovered = await api.create(spawnFixture({ cols: 40, rows: 10 }));
  assert.equal(recovered.error, undefined, `capacity did not recover: ${JSON.stringify(recovered.error)}`);
  assert.equal((await api.state()).sessions, 1);
  assert.equal((await api.close(recovered.result.sessionId, recovered.result.owner)).result, true);
  assert.equal((await api.state()).sessions, 0);

  for (const pid of [...created.map(c => c.pid), recovered.result.pid]) await untilGone(pid);
});

test('ST14-06 duplicate create requests make independent closable sessions', opts, async t => {
  const api = await registry(t);
  // A client that retries a create it believes was lost reuses the same id. That
  // must not be treated as idempotent: two children exist, so two sessions must
  // be registered and both must be closable.
  const line = rpcLine(7, 'terminal.create', spawnFixture());
  const first = await api.rpc(line);
  const second = await api.rpc(line);

  assert.equal(first.sent[0].id, 7);
  assert.equal(second.sent[0].id, 7);
  const a = first.sent[0].result;
  const b = second.sent[0].result;
  assert.notEqual(a.sessionId, b.sessionId, 'a duplicate request must not alias the first session');
  assert.notEqual(a.owner, b.owner);
  assert.notEqual(a.pid, b.pid);
  assert.equal((await api.state()).sessions, 2);

  for (const entry of [a, b]) {
    const closed = await api.close(entry.sessionId, entry.owner);
    assert.equal(closed.result, true, `close failed: ${JSON.stringify(closed.error)}`);
    await untilGone(entry.pid);
  }
  assert.equal((await api.state()).sessions, 0);
});

test('ST14-07 dispatch registers nothing until the transport commits it', opts, async t => {
  const api = await registry(t);
  const created = await api.call('terminal.create', spawnFixture({ cols: 40, rows: 12 }));
  assert.ok(!created.error, `dispatch failed: ${created.error}`);
  assert.equal(created.tokens.length, 1, 'create must hand back exactly one deferred commit');
  try {
    assert.equal(created.sessions, 0, 'dispatch must not register the session itself');

    const probe = await api.call('terminal.observe', { sessionId: created.result.sessionId });
    assert.match(probe.error ?? '', /Unknown session/, 'an uncommitted session must be invisible to other methods');

    await api.commit(created.tokens[0]);
    assert.equal((await api.state()).sessions, 1);
    const observed = await api.call('terminal.observe', { sessionId: created.result.sessionId });
    assert.ok(!observed.error, `observe after commit failed: ${observed.error}`);
    assert.equal(observed.result.sessionId, created.result.sessionId);
  } finally {
    reap(created.result.pid);
  }
});

test('ST14-08 a rolled-back deferred create kills its child', opts, async t => {
  const api = await registry(t);
  const created = await api.call('terminal.create', spawnFixture({ cols: 40, rows: 12 }));
  const pid = created.result.pid;
  assert.ok(pid > 0);
  assert.equal(created.sessions, 0);

  await api.rollback(created.tokens[0]);
  assert.equal((await api.state()).sessions, 0);
  await untilGone(pid);
});

test('ST14-09 the server survives a broken stdout and still reaps its children', opts, async () => {
  // The real stdio transport this time: no harness, no scripted sink. Breaking
  // the response pipe while the server runs is what turns an undeliverable
  // response into an unhandled 'error' event on process.stdout if nothing listens.
  const server = spawn(process.execPath, [SERVER], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk; });

  const responses = [];
  const idle = [];
  let buffered = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', chunk => {
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

  const wait = async id => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const found = responses.find(r => r.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no response for id ${id}; stderr:\n${stderr}`);
      await Promise.race([new Promise(r => idle.push(r)), new Promise(r => setTimeout(r, 100))]);
    }
  };

  server.stdin.write(`${rpcLine(1, 'terminal.create', spawnFixture())}\n`);
  const created = await wait(1);
  assert.ok(created.result?.pid, `create failed: ${JSON.stringify(created.error)}`);
  const childPid = created.result.pid;

  server.stdout.destroy();
  server.stdin.write(`${rpcLine(2, 'terminal.create', spawnFixture())}\n`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(server.exitCode, null, `server died on a broken stdout:\n${stderr}`);

  server.stdin.end();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 45000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  assert.notEqual(server.exitCode, null, `server never exited after stdin closed:\n${stderr}`);
  assert.ok(!/Unhandled|ERR_STREAM|throw er/.test(stderr), `server stderr shows an unhandled failure:\n${stderr}`);
  await untilGone(childPid);
});
