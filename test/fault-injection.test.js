// Protocol and lifecycle fault injection (issue #17).
//
// Everything here drives the real src/server.js over its real stdio transport as
// a separate process -- see test/helpers/runtime.mjs. Nothing is stubbed, because
// the point is to find out what the runtime actually does when the transport
// breaks, a child dies, the host is killed outright, or a caller misbehaves.
//
// The invariant every test ends on is the same one issue #14 established: no
// sequence of faults may permanently consume session capacity, leak a child
// process, or let a caller act on a session it does not own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime, allGone, untilGone, reap, rpcLine } from './helpers/runtime.mjs';
import { FIXTURE } from './helpers/native.mjs';

const opts = { timeout: 180000 };
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const spawnFixture = extra => ({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 20, ...extra });

test('FI-01 malformed messages cannot corrupt the channel or the registry', opts, async () => {
  const server = startRuntime();
  try {
    const { result } = await server.call('initialize', {});
    assert.ok(result.protocolVersion);

    // One entry per line, each sent as its own line. Together they cover every
    // way a request can be wrong short of being a valid request for a session
    // that does not exist, which FI-09 covers.
    const hostile = [
      '',
      '   ',
      'not json at all',
      '{"jsonrpc":"2.0"',
      '{"jsonrpc":"2.0"}',
      '{"jsonrpc":"2.0","method":"terminal.list"}',
      '{"jsonrpc":"1.0","id":900,"method":"terminal.list"}',
      '{"id":901,"method":"terminal.list"}',
      '{"jsonrpc":"2.0","id":902}',
      '{"jsonrpc":"2.0","id":903,"method":42}',
      '{"jsonrpc":"2.0","id":904,"method":"terminal.nope"}',
      '{"jsonrpc":"2.0","id":905,"method":"terminal.observe","params":null}',
      '{"jsonrpc":"2.0","id":906,"method":"terminal.observe","params":"a string"}',
      '{"jsonrpc":"2.0","id":907,"method":"terminal.observe","params":[1,2]}',
      '{"jsonrpc":"2.0","id":908,"method":"terminal.observe"}',
      '[{"jsonrpc":"2.0","id":909,"method":"terminal.list"}]',
      'null',
      '42',
      '"just a string"',
      '{"jsonrpc":"2.0","id":910,"method":"terminal.create","params":{"command":"x","args":{}}}',
      '{"jsonrpc":"2.0","id":911,"method":"terminal.create","params":{"command":"","args":[]}}',
      '{"jsonrpc":"2.0","id":912,"method":"terminal.create","params":{"command":"x","cols":1,"rows":1}}',
      '{"jsonrpc":"2.0","id":913,"method":"terminal.close","params":{}}',
      '{"jsonrpc":"2.0","id":914,"method":"terminal.type","params":{"text":123}}',
      '\u0000\u0001\u0002',
      '{'.repeat(500),
      '{"jsonrpc":"2.0","id":915,"method":"terminal.key","params":{"sessionId":"x","key":"__proto__"}}',
    ];

    // Counted from a snapshot: the initialize above already produced a response.
    const before = server.responses.length;
    for (const line of hostile) server.sendLine(line);
    // A sentinel proves the server is still processing after the barrage, and
    // gives the earlier responses time to land.
    const sentinelId = 99999;
    server.sendLine(rpcLine(sentinelId, 'terminal.list', {}));
    const sentinel = await server.waitForResponse(sentinelId);
    assert.deepEqual(sentinel.result, [], 'malformed input must not have created a session');
    await settle(500);

    assert.deepEqual(server.corrupted, [], `server emitted non-JSON on stdout: ${JSON.stringify(server.corrupted)}`);
    assert.equal(server.exitCode, null, `server died during malformed input:\n${server.stderr}`);

    // Every line is answered exactly once, and every answer is well-formed. Note
    // that answers do not arrive in request order: the handlers run concurrently,
    // which is why this asserts on the set rather than the sequence.
    const batch = server.responses.slice(before);
    assert.equal(batch.length, hostile.length + 1,
      `expected one response per hostile line plus the sentinel, got ${batch.length}`);
    for (const response of batch) {
      assert.equal(response.jsonrpc, '2.0', `response is not JSON-RPC 2.0: ${JSON.stringify(response)}`);
      assert.ok(response.id === null || Number.isInteger(response.id),
        `response id must be an integer or null: ${JSON.stringify(response)}`);
      assert.ok(response.result !== undefined || response.error !== undefined,
        `response carries neither result nor error: ${JSON.stringify(response)}`);
    }

    // The create-shaped hostile lines must have been rejected on validation, not
    // spawned: nothing may be registered and no child may exist.
    const listed = await server.list();
    assert.deepEqual(listed, []);
  } finally {
    await server.stop();
  }
});

test('FI-02 an abrupt stdin teardown reaps every open session', opts, async () => {
  const server = startRuntime();
  const pids = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const created = await server.create(spawnFixture());
      await server.waitScreen(created.sessionId, 'FIXTURE READY');
      pids.push(created.pid);
    }
    assert.equal((await server.list()).length, 3);
  } finally {
    // destroy(), not end(): the client vanished rather than hanging up politely.
    server.destroyStdin();
    const info = await server.exited();
    assert.ok(info, `server never exited after stdin was destroyed:\n${server.stderr}`);
    assert.ok(!/Unhandled|ERR_STREAM|throw er/.test(server.stderr), `unhandled failure on teardown:\n${server.stderr}`);
    assert.deepEqual(await allGone(pids), [], 'a vanished client must not leave its shells running');
  }
});

test('FI-03 a lost response pipe does not strand open sessions', opts, async () => {
  const server = startRuntime();
  const pids = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      const created = await server.create(spawnFixture());
      await server.waitScreen(created.sessionId, 'FIXTURE READY');
      pids.push(created.pid);
    }
    server.destroyStdout();
    // Requests keep arriving on a transport that can no longer answer.
    server.sendLine(rpcLine(1, 'terminal.list', {}));
    server.sendLine(rpcLine(2, 'terminal.create', spawnFixture()));
    await settle(1500);
    assert.equal(server.exitCode, null, `server died when its stdout broke:\n${server.stderr}`);
  } finally {
    server.endStdin();
    const info = await server.exited();
    assert.ok(info, `server never exited:\n${server.stderr}`);
    assert.ok(!/Unhandled|ERR_STREAM|throw er/.test(server.stderr), `unhandled failure:\n${server.stderr}`);
    assert.deepEqual(await allGone(pids), [], 'sessions opened before the pipe broke must still be reaped');
  }
});

test('FI-04 an externally killed child is reported, closable, and frees its slot', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    await server.waitScreen(created.sessionId, 'FIXTURE READY');

    process.kill(created.pid); // SIGTERM/TerminateProcess: the child dies without the runtime's help

    const deadline = Date.now() + 20000;
    let observed;
    for (;;) {
      const { result } = await server.call('terminal.observe', { sessionId: created.sessionId });
      observed = result;
      if (!result.running) break;
      if (Date.now() > deadline) throw new Error(`runtime never noticed the child died; last: ${JSON.stringify(result)}`);
      await server.call('terminal.wait', { sessionId: created.sessionId, afterRevision: result.revision, timeoutMs: 250 });
    }
    assert.equal(observed.state, 'exited', `expected state exited, got ${observed.state}`);
    assert.equal(observed.running, false);
    assert.ok(observed.exit, 'the exit status must be reported, not swallowed');
    assert.equal(observed.pid, created.pid, 'the pid must survive exit so identity is still verifiable');

    // A dead session is still owned: the owner gate must not relax on exit.
    const foreign = await server.request('terminal.close', { sessionId: created.sessionId, owner: 'not-the-owner' });
    assert.match(foreign.response.error?.message ?? '', /Ownership required/);
    assert.equal((await server.list()).length, 1, 'a rejected close must not free the slot');

    const closed = await server.close(created.sessionId, created.owner);
    assert.equal(closed.result, true);
    assert.deepEqual(await server.list(), [], 'a dead session must still be closable and free its slot');

    // Capacity survived the crash.
    const next = await server.create(spawnFixture());
    await server.waitScreen(next.sessionId, 'FIXTURE READY');
    assert.equal((await server.close(next.sessionId, next.owner)).result, true);
    assert.deepEqual(await server.list(), []);
    await untilGone(next.pid);
  } finally {
    await server.stop();
  }
});

test('FI-05 killing the runtime outright does not orphan its shells', opts, async () => {
  const server = startRuntime();
  const pids = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const created = await server.create(spawnFixture());
      await server.waitScreen(created.sessionId, 'FIXTURE READY');
      pids.push(created.pid);
    }
    assert.equal((await server.list()).length, 3);

    server.killHard(); // no shutdown handler runs: this is a crash, not a stop
    // A signalled exit reports exitCode null, so the exit record itself -- not the
    // code -- is the evidence that the runtime is gone.
    const info = await server.exited();
    assert.ok(info, 'the runtime survived SIGKILL');

    const survivors = await allGone(pids);
    // Reported as well as asserted: whether the OS tears down a PTY's children when
    // the host dies without running any cleanup is a platform property, and this is
    // where a platform that does not would show up.
    console.log(`    FI-05 survivors after SIGKILL of the runtime: ${survivors.length} of ${pids.length} (${process.platform}, exit ${JSON.stringify(info)})`);
    assert.deepEqual(survivors, [], `killing the runtime orphaned shell pids ${survivors.join(', ')}`);
  } finally {
    // Reap whatever survived, so a failure here cannot leak ConPTY hosts into the
    // tests that follow. Leaked hosts from an earlier failing test are what starved
    // a later one during development of this suite.
    for (const pid of await allGone(pids, 0)) reap(pid);
    if (!server.hasExited) server.killHard();
    await server.exited(10000);
  }
});

test('FI-06 a restarted runtime starts clean and rejects stale ids', opts, async () => {
  const first = startRuntime();
  const stale = await first.create(spawnFixture());
  await first.waitScreen(stale.sessionId, 'FIXTURE READY');
  const stalePid = stale.pid;
  first.killHard();
  await first.exited();
  // FI-05 owns the "a crash leaves no orphans" assertion. Here a survivor would
  // only pollute the restart test, so reap it and move on.
  for (const pid of await allGone([stalePid])) reap(pid);

  const second = startRuntime();
  try {
    const { result } = await second.call('initialize', {});
    assert.equal(result.protocolVersion, 1);

    // Nothing survives a restart, and a stale id must not be honoured -- nor
    // must a stale owner token, which is the only credential the old caller had.
    for (const method of ['terminal.observe', 'terminal.type', 'terminal.resize', 'terminal.close', 'terminal.wait']) {
      const probe = await second.request(method, {
        sessionId: stale.sessionId, owner: stale.owner, revision: 0, cols: 60, rows: 20, text: 'x', afterRevision: 0,
      });
      assert.match(probe.response.error?.message ?? '', /Unknown session/, `${method} honoured a session id from a dead runtime`);
    }
    assert.deepEqual(await second.list(), []);

    const fresh = await second.create(spawnFixture());
    await second.waitScreen(fresh.sessionId, 'FIXTURE READY');
    assert.notEqual(fresh.sessionId, stale.sessionId);
    assert.equal((await second.close(fresh.sessionId, fresh.owner)).result, true);
    await untilGone(fresh.pid);
  } finally {
    await second.stop();
  }
});

test('FI-07 duplicate and racing requests leave the registry consistent', opts, async () => {
  const server = startRuntime();
  const pids = [];
  try {
    // A retry that reuses the same id must not be treated as idempotent: two
    // children exist, so two sessions must exist and both must be closable.
    const line = rpcLine(7, 'terminal.create', spawnFixture());
    server.sendLine(line);
    server.sendLine(line);
    await server.waitForResponse(7);
    await settle(500);
    const ids = server.responses.filter(r => r.id === 7).map(r => r.result);
    assert.equal(ids.length, 2, `a duplicated create must produce two responses, got ${ids.length}`);
    assert.ok(ids.every(Boolean), `both duplicated creates must succeed: ${JSON.stringify(ids)}`);
    assert.notEqual(ids[0].sessionId, ids[1].sessionId);
    assert.notEqual(ids[0].owner, ids[1].owner);
    assert.notEqual(ids[0].pid, ids[1].pid);
    pids.push(ids[0].pid, ids[1].pid);
    assert.equal((await server.list()).length, 2);

    // Two closes for one session, pipelined without waiting. Both are answered, and
    // both may report success: terminal.close is idempotent by construction, since
    // the second call finds the session already released. Telling a retrying client
    // "unknown session" for a close it already asked for would read as a failure, so
    // idempotence is the behaviour, not a defect. What must hold is that both are
    // answered, the slot is freed exactly once, and the child dies.
    const target = ids[0];
    server.sendLine(rpcLine(20, 'terminal.close', { sessionId: target.sessionId, owner: target.owner }));
    server.sendLine(rpcLine(21, 'terminal.close', { sessionId: target.sessionId, owner: target.owner }));
    const outcomes = [await server.waitForResponse(20), await server.waitForResponse(21)];
    for (const outcome of outcomes) {
      assert.ok(outcome.result === true || /Unknown session/.test(outcome.error?.message ?? ''),
        `a racing close must either succeed or report the session gone: ${JSON.stringify(outcome)}`);
    }
    assert.equal((await server.list()).length, 1, 'the racing closes must free exactly one slot');
    await untilGone(target.pid);

    // Closing the survivor normally still works, and the registry ends empty.
    const survivor = ids[1];
    assert.equal((await server.close(survivor.sessionId, survivor.owner)).result, true);
    assert.deepEqual(await server.list(), []);
    assert.deepEqual(await allGone(pids), [], 'racing closes must not leak a child');
  } finally {
    await server.stop();
  }
});

test('FI-08 ownership is enforced on every gated method and no token is interchangeable', opts, async () => {
  const server = startRuntime();
  const pids = [];
  try {
    const a = await server.create(spawnFixture());
    const b = await server.create(spawnFixture());
    pids.push(a.pid, b.pid);
    await server.waitScreen(a.sessionId, 'FIXTURE READY');
    await server.waitScreen(b.sessionId, 'FIXTURE READY');

    // Each gated method rejects a bad owner with its own message. What matters is
    // that all of them reject, and that they reject for ownership rather than for
    // some unrelated reason that would let a wrong token through later.
    const gated = [
      ['terminal.type', { revision: 0, text: 'x' }, /Input ownership required/],
      ['terminal.key', { revision: 0, key: 'Enter' }, /Input ownership required/],
      ['terminal.resize', { cols: 50, rows: 20 }, /Resize denied/],
      ['terminal.close', {}, /Ownership required/],
    ];
    // Includes B's genuine token, which is valid for B and must still be refused
    // on A: tokens are per-session credentials, not a shared secret.
    const wrongTokens = ['not-the-owner', '', b.owner, a.sessionId, a.owner.toUpperCase(), null, 0];
    for (const [method, params, expected] of gated) {
      for (const owner of wrongTokens) {
        const probe = await server.request(method, { sessionId: a.sessionId, owner, ...params });
        assert.ok(probe.response.error, `${method} accepted owner ${JSON.stringify(owner)}`);
        assert.match(probe.response.error.message, expected,
          `${method} with owner ${JSON.stringify(owner)} failed for the wrong reason: ${probe.response.error.message}`);
      }
    }

    // Ungated reads must keep working, or the session would be unusable.
    const observed = await server.call('terminal.observe', { sessionId: a.sessionId });
    assert.equal(observed.result.sessionId, a.sessionId);
    assert.equal(observed.result.owner, undefined, 'observe must not leak the owner token');
    const listed = await server.list();
    assert.equal(listed.length, 2);
    assert.ok(listed.every(entry => entry.owner === undefined), 'terminal.list must not leak owner tokens');

    // Failed ownership attempts consumed nothing.
    assert.equal((await server.list()).length, 2, 'rejected ownership attempts must not close or strand a session');

    // The rightful owner still has full control after all the abuse.
    const revision = (await server.call('terminal.observe', { sessionId: a.sessionId })).result.revision;
    const typed = await server.request('terminal.type', { sessionId: a.sessionId, owner: a.owner, revision, text: 'echo OWN-OK\r' });
    assert.ok(typed.response.result, `the real owner was refused: ${JSON.stringify(typed.response.error)}`);
    await server.waitScreen(a.sessionId, 'ECHO:OWN-OK');

    assert.equal((await server.close(a.sessionId, a.owner)).result, true);
    assert.equal((await server.close(b.sessionId, b.owner)).result, true);
    assert.deepEqual(await server.list(), []);
    assert.deepEqual(await allGone(pids), []);
  } finally {
    await server.stop();
  }
});

test('FI-09 capacity survives repeated fault storms', opts, async () => {
  const server = startRuntime();
  const everyPid = [];
  try {
    const { result } = await server.call('initialize', {});
    assert.equal(result.protocolVersion, 1);

    for (let round = 0; round < 3; round += 1) {
      const opened = [];
      // Fill to the limit; the next create must be refused with a message that
      // names the bound rather than failing obscurely.
      for (;;) {
        const response = await server.request('terminal.create', spawnFixture({ cols: 40, rows: 10 }));
        if (response.response.error) {
          assert.match(response.response.error.message, /Session limit/);
          break;
        }
        opened.push(response.response.result);
        everyPid.push(response.response.result.pid);
      }
      assert.ok(opened.length > 0, `round ${round}: no sessions could be created`);
      const full = await server.list();
      assert.equal(full.length, opened.length, `round ${round}: registry disagrees with what was accepted`);

      // Fault the protocol, not the operating system. Mass-killing children behind
      // the runtime's back and then continuing to create is a *separate* defect: it
      // crashes the host with STATUS_ACCESS_VIOLATION inside node-pty's ConPTY
      // layer, and it does so on unmodified main as well, so asserting on it here
      // would make this test flaky for a reason unrelated to capacity accounting.
      // It is measured by test/bench/conpty-external-kill.mjs instead.
      //
      // Every close below must be refused WITHOUT freeing the slot it targets.
      for (const [i, entry] of opened.entries()) {
        const probe = i % 3 === 0
          ? await server.request('terminal.close', { sessionId: entry.sessionId, owner: 'wrong-owner' })
          : i % 3 === 1
            ? await server.request('terminal.close', { sessionId: entry.sessionId })
            : await server.request('terminal.close', { sessionId: 'not-a-real-session', owner: entry.owner });
        assert.ok(probe.response.error, `round ${round}: an invalid close was accepted`);
      }
      assert.equal((await server.list()).length, opened.length,
        `round ${round}: a rejected close must not free a slot`);

      // At the limit every create is refused before its parameters are examined, so
      // nothing malformed can slip in and nothing can be consumed or freed.
      for (const params of [
        spawnFixture({ cols: 40, rows: 10 }),
        spawnFixture({ command: '', cols: 40, rows: 10 }),
        spawnFixture({ cols: 1, rows: 1 }),
      ]) {
        const refused = await server.request('terminal.create', params);
        assert.match(refused.response.error?.message ?? '', /Session limit/,
          `round ${round}: expected a capacity refusal, got ${JSON.stringify(refused.response)}`);
      }
      assert.equal((await server.list()).length, opened.length,
        `round ${round}: a refused create must not change the registry`);

      // Now close everything properly. Every slot must come back.
      for (const entry of opened) {
        const closed = await server.close(entry.sessionId, entry.owner);
        assert.equal(closed.result, true, `round ${round}: close failed: ${JSON.stringify(closed.error)}`);
      }
      assert.deepEqual(await server.list(), [], `round ${round}: slots were not returned after a fault storm`);
    }

    // And the runtime still works afterwards.
    const fresh = await server.create(spawnFixture());
    everyPid.push(fresh.pid);
    await server.waitScreen(fresh.sessionId, 'FIXTURE READY');
    assert.equal((await server.close(fresh.sessionId, fresh.owner)).result, true);
    assert.deepEqual(await server.list(), []);
  } finally {
    await server.stop();
    // Reap before asserting, so a failure here cannot leak ConPTY hosts into the
    // next test -- which is how a hang in this test was traced to leftovers from an
    // unrelated earlier one.
    for (const pid of await allGone(everyPid, 0)) reap(pid);
    const leaked = await allGone(everyPid);
    assert.deepEqual(leaked, [], `a fault storm leaked child processes: ${leaked.join(', ')}`);
  }
});
