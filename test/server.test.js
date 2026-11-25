// Registry and delivery semantics of the JSON-RPC server (issue #14).
//
// A create response carries the owner token, and without it no method can close
// the session -- so a session registered before its response is confirmed
// delivered is a slot burned for the life of the process. These tests provoke
// exactly that: refused delivery, delivery that fails asynchronously, a failed
// spawn, a cleanup failure during close, a write chain that never settles, a
// broken stdout, teardown racing an in-flight create, and capacity exhaustion.
//
// Every session here is real. src/server.js runs in a subprocess (see
// test/fixtures/server-harness.mjs) with only its response sink scripted.
//
// Which of these actually catch a defect, and which do not.
//
// Catch the original #14 defect -- a session registered before its owner token
// was delivered, and a close() that re-threw and so never deregistered:
// ST14-01, ST14-04, ST14-07, ST14-08, ST14-09, plus the Session-level cases in
// test/session.test.js. That defect was also reproduced directly against
// origin/main's create/close logic; see the commit message for the output.
//
// Catch defects in the deferred-commit redesign itself. Verified by running this
// file against revision 8b8163d, which had the redesign but not these fixes:
// ST14-10 failed (1 session registered, expected 0), ST14-12 failed (24 creates
// accepted against a limit of 16) and ST14-13 timed out at 60s (close() hung).
//
// ST14-11 and ST14-14 are guards, not caught regressions, and are labelled as
// such: awaiting delivery confirmation opens a window where a create is spawned
// but not yet in the registry, so a concurrent shutdown can miss it. Revision
// 8b8163d did not await the sink, so it has no window to hit and passes both.
// ST14-11 covers a respond that answers late, which commit() refuses; ST14-14
// covers one that never answers at all, where only shutdown()'s reap of the
// in-flight set can release the child.
//
// ST14-15 catches a defect of the redesign too: absorbing cleanup failures made
// them invisible, so a surviving child was reported as a clean close.
//
// Contract locks -- these also pass against unfixed code, and are kept because
// they pin behaviour a caller depends on rather than because they discriminate:
// ST14-02, ST14-03, ST14-05, ST14-06, and ST14-16 (which pins the delivery grace
// resolving TRUE, so a slow reader keeps its session).
//
// None of these can be run literally against origin/main: the harness imports
// handleRequest/dispatch/respond/shutdown, which that revision does not export.
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

// The real stdio transport as a separate process: no harness, no scripted sink.
// Used where the transport itself is the thing under test.
function startRuntime() {
  const child = spawn(process.execPath, [SERVER], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  const responses = [];
  const idle = [];
  let buffered = '';
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

  return {
    child,
    responses,
    get stderr() { return stderr; },
    write(line) { child.stdin.write(`${line}\n`); },
    async wait(id, timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = responses.find(r => r.id === id);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no response for id ${id}; stderr:\n${stderr}`);
        await Promise.race([new Promise(r => idle.push(r)), new Promise(r => setTimeout(r, 100))]);
      }
    },
    async exited(timeout = 45000) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, timeout);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
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
  // Breaking the response pipe while the server runs is what turns an
  // undeliverable response into an unhandled 'error' event on process.stdout if
  // nothing listens, killing the host and every session with it.
  const server = startRuntime();
  server.write(rpcLine(1, 'terminal.create', spawnFixture()));
  const created = await server.wait(1);
  assert.ok(created.result?.pid, `create failed: ${JSON.stringify(created.error)}`);
  const childPid = created.result.pid;

  server.child.stdout.destroy();
  server.write(rpcLine(2, 'terminal.create', spawnFixture()));
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(server.child.exitCode, null, `server died on a broken stdout:\n${server.stderr}`);

  server.child.stdin.end();
  await server.exited();
  assert.notEqual(server.child.exitCode, null, `server never exited after stdin closed:\n${server.stderr}`);
  assert.ok(!/Unhandled|ERR_STREAM|throw er/.test(server.stderr), `server stderr shows an unhandled failure:\n${server.stderr}`);
  await untilGone(childPid);
});

test('ST14-10 a write that fails asynchronously still rolls the create back', opts, async t => {
  // The sharpest form of the defect: write() accepts the bytes and returns true,
  // and the EPIPE only surfaces through the callback afterwards. A synchronous
  // delivery check has already committed by then, so the session is registered
  // with an owner token that went nowhere. This drives the production respond()
  // against exactly that stream.
  const api = await registry(t);
  const { sent, sessions } = await api.brokenPipeRpc(rpcLine(1, 'terminal.create', spawnFixture()));

  assert.equal(sent.length, 1, 'the response must have been attempted');
  const result = sent[0].result;
  assert.ok(result?.owner, `expected a create result, got ${JSON.stringify(sent[0])}`);
  assert.equal(sessions, 0, 'a write that failed asynchronously must not leave the session registered');
  assert.equal((await api.state()).sessions, 0);
  await untilGone(result.pid);
});

test('ST14-11 shutdown during an in-flight create reaps the child', opts, async t => {
  // A create that has spawned and observed but not yet committed is in neither the
  // registry nor any snapshot of it, so a shutdown that only drains the registry
  // misses the child entirely -- and on Windows a live ConPTY worker then keeps the
  // host process from ever exiting.
  const api = await registry(t);
  const line = rpcLine(1, 'terminal.create', spawnFixture());
  await api.startSlowRpc('inflight', line, 2500);
  // Let the create spawn and reach the point where it awaits the delivery verdict.
  await new Promise(resolve => setTimeout(resolve, 750));

  await api.closeAll();
  const { sent, sessions } = await api.awaitSlowRpc('inflight');

  assert.equal(sessions, 0, 'the in-flight create must not be registered after shutdown');
  assert.equal((await api.state()).sessions, 0);
  const pid = sent[0]?.result?.pid;
  assert.ok(pid > 0, `expected the create to have spawned a child, got ${JSON.stringify(sent[0])}`);
  await untilGone(pid);
});

test('ST14-12 pipelined creates cannot exceed the session limit', opts, async t => {
  // readline emits every complete line of one chunk synchronously, so a client
  // that pipelines creates runs all of their handlers to the first await before
  // any of them registers. A capacity check that reads only sessions.size lets
  // every one through: measured at 24 sessions registered against a limit of 16
  // when registration was deferred without also reserving capacity.
  //
  // The limit is read from the runtime rather than imported from src/server.js:
  // importing that module into the test process attaches a global stdout 'error'
  // handler and loads the native binding here, neither of which this test needs.
  const probe = await registry(t);
  const { limit } = await probe.state();
  const burst = limit + 8;
  const server = startRuntime();
  try {
    let payload = '';
    for (let i = 0; i < burst; i += 1) {
      payload += `${rpcLine(i, 'terminal.create', spawnFixture({ cols: 40, rows: 10 }))}\n`;
    }
    server.child.stdin.write(payload); // one write, one chunk, `burst` concurrent handlers

    const deadline = Date.now() + 90000;
    while (server.responses.length < burst && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(server.responses.length, burst, `only ${server.responses.length} of ${burst} creates were answered`);

    const accepted = server.responses.filter(r => r.result);
    const refused = server.responses.filter(r => r.error);
    assert.ok(accepted.length <= limit, `${accepted.length} creates accepted against a limit of ${limit}`);
    assert.equal(refused.length, burst - accepted.length);
    assert.ok(refused.every(r => /Session limit/.test(r.error.message)), 'the refusals must be capacity refusals');

    server.write(rpcLine(9999, 'terminal.list', {}));
    const listed = await server.wait(9999);
    assert.ok(listed.result.length <= limit, `terminal.list reports ${listed.result.length} sessions against a limit of ${limit}`);
    assert.equal(listed.result.length, accepted.length, 'every accepted create must be registered exactly once');
  } finally {
    server.child.stdin.end();
    await server.exited();
  }
});

test('ST14-13 close settles when an emulator write never completes', opts, async t => {
  // close() awaits the pending write chain. An emulator that accepts a write and
  // never invokes its callback therefore hangs close(), which hangs abandon(),
  // which hangs the caller's terminal.close and strands the slot -- the same
  // outcome as the rejection case, reached without anything throwing.
  const api = await registry(t);
  const { result } = await api.create(spawnFixture());
  assert.equal((await api.state()).sessions, 1);

  const hung = await api.hangWrites(result.sessionId);
  assert.equal(hung.error, undefined, `hangWrites failed: ${hung.error}`);

  const started = Date.now();
  const closed = await api.close(result.sessionId, result.owner);
  const elapsed = Date.now() - started;

  assert.equal(closed.result, true, 'close must still succeed');
  assert.equal(closed.sessions, 0, 'a non-terminating write chain must not strand the slot');
  // CLOSE_GRACE_MS is 2s. The bound is deliberately tight enough that raising the
  // grace to something that would stall a caller -- 10s, say -- fails here.
  assert.ok(elapsed < 8000, `close took ${elapsed}ms; it must be bounded rather than hang`);
  await untilGone(result.pid);
});

test('ST14-14 shutdown reaps a create whose delivery verdict never arrives', opts, async t => {
  // The other half of the teardown race. ST14-11 covers a create whose respond
  // eventually answers after shutdown began, which commit() refuses; this covers
  // one whose respond NEVER answers, so nothing will ever call commit() and only
  // shutdown()'s reap of the in-flight set can release the child. On Windows the
  // surviving ConPTY worker would also keep the host process from ever exiting.
  const api = await registry(t);
  await api.startStuckRpc('stuck', rpcLine(1, 'terminal.create', spawnFixture()));

  let state;
  const deadline = Date.now() + 30000;
  for (;;) {
    state = await api.state();
    if (state.inflight.length) break;
    if (Date.now() > deadline) throw new Error('the create never reached the in-flight state');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.sessions, 0, 'an unconfirmed create must not be in the registry');
  const pid = state.inflight[0].pid;
  assert.ok(pid > 0, `expected a spawned child, got ${JSON.stringify(state.inflight[0])}`);

  await api.closeAll();
  const after = await api.state();
  assert.deepEqual(after.inflight, [], 'shutdown must clear the in-flight set');
  assert.equal(after.sessions, 0);
  await untilGone(pid);
});

test('ST14-15 a failed teardown is reported on stderr rather than swallowed', opts, async t => {
  // close() absorbs cleanup failures so they cannot strand a slot, which makes
  // "the slot is free" and "the child is dead" different claims. Both failure
  // shapes -- a write chain that rejects and an emulator that refuses to dispose
  // -- must leave a trace, or a surviving process passes silently as a clean close.
  const api = await registry(t);

  const rejecting = await api.create(spawnFixture({ cols: 40, rows: 12 }));
  const disposing = await api.create(spawnFixture({ cols: 40, rows: 12 }));
  await api.sabotage(rejecting.result.sessionId, { poisonPending: true });
  const mark = api.stderr.length;
  await api.sabotage(disposing.result.sessionId, { breakDispose: true });

  for (const entry of [rejecting.result, disposing.result]) {
    const closed = await api.close(entry.sessionId, entry.owner);
    assert.equal(closed.result, true, 'close must still succeed');
    await untilGone(entry.pid);
  }
  assert.equal((await api.state()).sessions, 0);

  const logged = api.stderr.slice(mark);
  const reported = logged.split('\n').filter(line => line.includes('cleanup failed for session'));
  assert.equal(reported.length, 2, `expected one stderr line per failed teardown, got:\n${logged}`);
  assert.ok(reported.some(line => line.includes(rejecting.result.sessionId)), 'the rejecting write chain was not reported');
  assert.ok(reported.some(line => line.includes(disposing.result.sessionId)), 'the failing dispose was not reported');
  for (const line of reported) {
    assert.ok(!line.slice(line.indexOf(': ') + 2).includes('\n'), 'one failure must stay one line');
  }
});

test('ST14-16 a stalled write commits rather than killing a slow client session', opts, async t => {
  // The delivery grace is a liveness valve, not a verdict: it resolves TRUE. A
  // client that has merely stopped draining keeps its session, because killing a
  // healthy client's session to guard against a hypothetical late EPIPE is the
  // worse failure. The cost -- a commit no longer backed by confirmation -- is the
  // documented trade, and this pins the behaviour so it cannot change silently.
  const api = await registry(t);
  const started = Date.now();
  const { sent, sessions } = await api.stalledRpc(rpcLine(1, 'terminal.create', spawnFixture()));
  const elapsed = Date.now() - started;

  assert.equal(sent.length, 1);
  assert.equal(sessions, 1, 'a stalled write must not roll back a live session');
  assert.ok(elapsed >= 1500, `respond gave up after ${elapsed}ms; the grace bound should be ~2s`);
  assert.ok(elapsed < 10000, `respond took ${elapsed}ms; the grace bound must stay short`);

  const result = sent[0].result;
  const closed = await api.close(result.sessionId, result.owner);
  assert.equal(closed.result, true);
  await untilGone(result.pid);
});
