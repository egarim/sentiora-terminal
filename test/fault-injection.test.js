// Protocol and lifecycle fault injection (issue #17).
//
// Everything here drives the real src/server.js over its real stdio transport as
// a separate process -- see test/helpers/runtime.mjs. Nothing is stubbed, because
// the point is what the runtime actually does when the transport breaks, a child
// dies, the host is killed outright, or a caller misbehaves.
//
// The invariant every test ends on is the one issue #14 established: no sequence
// of faults may permanently consume session capacity, leak a child process, or
// let a caller act on a session it does not own.
//
// Two limits on what this file proves, stated up front:
//
//   * Cleanup FAILURES (a kill that throws, an emulator that will not dispose) are
//     not provoked here -- that needs the scripted sink in
//     test/fixtures/server-harness.mjs, and ST14-04/ST14-15 cover it. What this
//     file asserts instead is the negative: none of these faults may CAUSE a
//     cleanup failure, so the runtime's stderr must stay free of the
//     "cleanup failed for session" diagnostic it emits when one happens.
//   * A create whose response cannot be delivered is unobservable from outside the
//     process, so it is covered by ST14-01/ST14-08/ST14-10 rather than here.
//     FI-03 proves the weaker but still necessary thing: a broken response pipe
//     does not kill the host or strand the sessions it already holds. FI-03 does
//     fail on bc4f611, which had no 'error' listener on stdout and died with
//     "Error: EPIPE: broken pipe, write"; it passes on this base (3fbbcb2), which
//     already carries the #14 fix, so it guards that fix rather than proving it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime, expectGone, untilGone, reap, rpcLine } from './helpers/runtime.mjs';
import { FIXTURE } from './helpers/native.mjs';

const opts = { timeout: 180000 };
const spawnFixture = extra => ({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 20, ...extra });

// The runtime logs this to stderr whenever close() had to absorb a failure. None
// of the faults below should cause one, so its absence is an assertion rather than
// a formality -- and its presence is the only external signal that teardown broke.
const CLEANUP_FAILURE = /sentiora: cleanup failed for session/;

test('FI-01 malformed messages cannot corrupt the channel or the registry', opts, async () => {
  const server = startRuntime();
  try {
    const { result } = await server.call('initialize', {});
    assert.ok(result.protocolVersion);
    const before = server.responses.length;

    // 27 ways to be wrong. `id` records what each must answer with: null when the
    // request carries no usable id, otherwise the id it sent. Asserting the id
    // multiset rather than the response total is what makes this a per-line
    // property -- a server that answered one line twice and silently dropped
    // another would still produce the right count.
    const hostile = [
      { line: '', id: null },
      { line: '   ', id: null },
      { line: 'not json at all', id: null },
      { line: '{"jsonrpc":"2.0"', id: null },
      { line: '{"jsonrpc":"2.0"}', id: null },
      { line: '{"jsonrpc":"2.0","method":"terminal.list"}', id: null },
      { line: '{"jsonrpc":"1.0","id":900,"method":"terminal.list"}', id: 900 },
      { line: '{"id":901,"method":"terminal.list"}', id: 901 },
      { line: '{"jsonrpc":"2.0","id":902}', id: 902 },
      { line: '{"jsonrpc":"2.0","id":903,"method":42}', id: 903 },
      { line: '{"jsonrpc":"2.0","id":904,"method":"terminal.nope"}', id: 904 },
      { line: '{"jsonrpc":"2.0","id":905,"method":"terminal.observe","params":null}', id: 905 },
      { line: '{"jsonrpc":"2.0","id":906,"method":"terminal.observe","params":"a string"}', id: 906 },
      { line: '{"jsonrpc":"2.0","id":907,"method":"terminal.observe","params":[1,2]}', id: 907 },
      { line: '{"jsonrpc":"2.0","id":908,"method":"terminal.observe"}', id: 908 },
      // A batch is an array, so it has no top-level id: the server answers with
      // null even though the wrapped request carries 909. Asserting 909 here would
      // have been asserting that the server reaches inside an unsupported batch.
      { line: '[{"jsonrpc":"2.0","id":909,"method":"terminal.list"}]', id: null },
      { line: 'null', id: null },
      { line: '42', id: null },
      { line: '"just a string"', id: null },
      { line: '{"jsonrpc":"2.0","id":910,"method":"terminal.create","params":{"command":"x","args":{}}}', id: 910 },
      { line: '{"jsonrpc":"2.0","id":911,"method":"terminal.create","params":{"command":"","args":[]}}', id: 911 },
      { line: '{"jsonrpc":"2.0","id":912,"method":"terminal.create","params":{"command":"x","cols":1,"rows":1}}', id: 912 },
      { line: '{"jsonrpc":"2.0","id":913,"method":"terminal.close","params":{}}', id: 913 },
      { line: '{"jsonrpc":"2.0","id":914,"method":"terminal.type","params":{"text":123}}', id: 914 },
      { line: '\u0000\u0001\u0002', id: null },
      { line: '{'.repeat(500), id: null },
      { line: '{"jsonrpc":"2.0","id":915,"method":"terminal.key","params":{"sessionId":"x","key":"__proto__"}}', id: 915 },
    ];

    for (const entry of hostile) server.sendLine(entry.line);
    const sentinelId = 99999;
    server.sendLine(rpcLine(sentinelId, 'terminal.list', {}));

    // Waited on a count, not slept on: the create-shaped answers can arrive after
    // the sentinel because dispatch defers on an await, so a fixed pause would be
    // the entire flakiness budget.
    await server.waitForResponseCount(before + hostile.length + 1);
    const batch = server.responses.slice(before);

    assert.deepEqual(server.corrupted, [], `server emitted non-JSON on stdout: ${JSON.stringify(server.corrupted)}`);
    assert.equal(server.hasExited, false, `server died during malformed input:\n${server.stderr}`);
    assert.equal(batch.length, hostile.length + 1,
      `expected one response per hostile line plus the sentinel, got ${batch.length}`);

    // One response per input, matched by id.
    const sortIds = ids => [...ids].map(String).sort();
    assert.deepEqual(
      sortIds(batch.map(r => (r.id === undefined ? null : r.id))),
      sortIds([...hostile.map(h => h.id), sentinelId]),
      `response ids do not match the requests one-for-one: ${JSON.stringify(batch.map(r => r.id))}`,
    );

    for (const response of batch) {
      assert.equal(response.jsonrpc, '2.0', `response is not JSON-RPC 2.0: ${JSON.stringify(response)}`);
      assert.ok(response.id === null || Number.isInteger(response.id),
        `response id must be an integer or null: ${JSON.stringify(response)}`);
      assert.ok(response.result !== undefined || response.error !== undefined,
        `response carries neither result nor error: ${JSON.stringify(response)}`);
    }

    // Every line with a usable id must have been REFUSED rather than answered with
    // a plausible result -- otherwise a malformed create could still spawn.
    for (const entry of hostile) {
      if (entry.id === null) continue;
      const response = batch.find(r => r.id === entry.id);
      assert.ok(response.error, `hostile line with id ${entry.id} was not refused: ${JSON.stringify(response)}`);
    }
    // The twelve id-less lines all answer with id null; count them rather than
    // matching them, since null cannot be correlated to a specific input.
    assert.equal(batch.filter(r => r.id === null).length, hostile.filter(h => h.id === null).length,
      'the id-less malformed lines were not each answered once');

    const sentinel = batch.find(r => r.id === sentinelId);
    assert.deepEqual(sentinel.result, [], 'malformed input must not have created a session');
    assert.deepEqual(await server.list(), []);
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `a malformed message caused a cleanup failure:\n${server.stderr}`);
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
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `teardown reported a cleanup failure:\n${server.stderr}`);
    // expectGone reaps survivors before returning them, so a failure here cannot
    // leak a live PTY into the tests that follow.
    assert.deepEqual(await expectGone(pids), [], 'a vanished client must not leave its shells running');
  }
});

test('FI-03 a lost response pipe does not kill the host or strand open sessions', opts, async () => {
  const server = startRuntime();
  const pids = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      const created = await server.create(spawnFixture());
      await server.waitScreen(created.sessionId, 'FIXTURE READY');
      pids.push(created.pid);
    }
    server.destroyStdout();
    // Requests keep arriving on a transport that can no longer answer. No create is
    // sent: its response could not be read, so neither its session id nor its pid
    // would be observable and nothing about it could be asserted -- an untracked
    // child would be an untracked leak. The undelivered-create invariant belongs to
    // ST14-01/ST14-10, which can see it.
    server.sendLine(rpcLine(1, 'terminal.list', {}));
    server.sendLine(rpcLine(2, 'terminal.observe', { sessionId: 'x' }));
    // Waited on an observable condition rather than slept on. exited() resolves
    // null while the server is still running, which is the assertion here.
    assert.equal(await server.exited(1500), null, `server died when its stdout broke:\n${server.stderr}`);
  } finally {
    server.endStdin();
    const info = await server.exited();
    assert.ok(info, `server never exited:\n${server.stderr}`);
    assert.ok(!/Unhandled|ERR_STREAM|throw er/.test(server.stderr), `unhandled failure:\n${server.stderr}`);
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `teardown reported a cleanup failure:\n${server.stderr}`);
    assert.deepEqual(await expectGone(pids), [], 'sessions opened before the pipe broke must still be reaped');
  }
});

test('FI-04 an externally killed child is reported, closable, and frees its slot', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    await server.waitScreen(created.sessionId, 'FIXTURE READY');

    process.kill(created.pid); // the child dies without the runtime's help

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

    // Capacity survived the crash -- proven by a second session reaching readiness
    // and closing, not merely by a create being accepted.
    const next = await server.create(spawnFixture());
    await server.waitScreen(next.sessionId, 'FIXTURE READY');
    assert.equal((await server.close(next.sessionId, next.owner)).result, true);
    assert.deepEqual(await server.list(), []);
    assert.deepEqual(await expectGone([created.pid, next.pid]), []);
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `a killed child caused a cleanup failure:\n${server.stderr}`);
  } finally {
    await server.stop();
  }
});

test('FI-05 killing the runtime outright leaves no orphaned shells', opts, async () => {
  // What this measures is node-pty plus the OS, not src/: SIGKILL runs no cleanup
  // handler, so nothing in this repository can influence the outcome. It is kept
  // because the answer is load-bearing for the desktop bridge, and because it does
  // change with the ConPTY provider or a node-pty upgrade. Measured on win32 arm64:
  // 0 of 3 survivors.
  const server = startRuntime();
  const pids = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const created = await server.create(spawnFixture());
      await server.waitScreen(created.sessionId, 'FIXTURE READY');
      pids.push(created.pid);
    }
    assert.equal((await server.list()).length, 3);

    server.killHard();
    const info = await server.exited();
    assert.ok(info, 'the runtime survived SIGKILL');

    // Reaped before asserting, so a failure cannot leak into the next test.
    const survivors = await expectGone(pids);
    console.log(`    FI-05 survivors after SIGKILL of the runtime: ${survivors.length} of ${pids.length} `
      + `(${process.platform}, exit ${JSON.stringify(info)})`);
    assert.deepEqual(survivors, [], `killing the runtime orphaned shell pids ${survivors.join(', ')}`);
  } finally {
    reap(await untilGone(pids, 0));
    if (!server.hasExited) { server.killHard(); await server.exited(10000); }
  }
});

test('FI-06 a restarted runtime rejects the previous one\'s credentials', opts, async () => {
  // Scope, stated honestly: a fresh process has a fresh registry and ids are
  // random, so "no session survives a restart" is true by construction and no
  // change to src/ could falsify it. What IS falsifiable -- and what an agent
  // actually depends on -- is that the new runtime refuses the stale session id and
  // the stale owner token on every session method rather than honouring them, that
  // the refusals register nothing, and that it is usable afterwards.
  const first = startRuntime();
  let stalePid = null;
  let stale = null;
  try {
    stale = await first.create(spawnFixture());
    await first.waitScreen(stale.sessionId, 'FIXTURE READY');
    stalePid = stale.pid;
  } finally {
    // Torn down here rather than after the second runtime is exercised: the first
    // server is created outside the nested try, and without this a throw during
    // its create or readiness wait would leave a live server holding a live PTY
    // child, keeping the test file's process alive and hanging the whole job
    // instead of failing in seconds.
    first.killHard();
    await first.exited();
    if (stalePid !== null) reap(await untilGone([stalePid], 20000));
  }

  const second = startRuntime();
  try {
    const { result } = await second.call('initialize', {});
    assert.equal(result.protocolVersion, 1);
    assert.deepEqual(await second.list(), [], 'a fresh runtime must start with an empty registry');

    for (const method of ['terminal.observe', 'terminal.type', 'terminal.resize', 'terminal.close', 'terminal.wait']) {
      const probe = await second.request(method, {
        sessionId: stale.sessionId, owner: stale.owner, revision: 0, cols: 60, rows: 20, text: 'x', afterRevision: 0,
      });
      assert.match(probe.response.error?.message ?? '', /Unknown session/,
        `${method} honoured a session id from a dead runtime`);
    }
    assert.deepEqual(await second.list(), [], 'a rejected stale request must not register anything');

    const fresh = await second.create(spawnFixture());
    await second.waitScreen(fresh.sessionId, 'FIXTURE READY');
    assert.notEqual(fresh.sessionId, stale.sessionId);
    assert.equal((await second.close(fresh.sessionId, fresh.owner)).result, true);
    assert.deepEqual(await expectGone([fresh.pid]), []);
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
    await server.waitForResponseCount(2);
    const created = server.responses.filter(r => r.id === 7).map(r => r.result);
    assert.equal(created.length, 2, `a duplicated create must produce two responses, got ${created.length}`);
    assert.ok(created.every(Boolean), `both duplicated creates must succeed: ${JSON.stringify(created)}`);
    assert.notEqual(created[0].sessionId, created[1].sessionId);
    assert.notEqual(created[0].owner, created[1].owner);
    assert.notEqual(created[0].pid, created[1].pid);
    pids.push(created[0].pid, created[1].pid);
    assert.equal((await server.list()).length, 2);

    // Two closes for one session, pipelined without waiting. Both are answered, and
    // both may report success: terminal.close is idempotent by construction, and
    // telling a retrying client "unknown session" for a close it already asked for
    // would read as a failure. The falsifiable parts are that both are answered,
    // that exactly one slot is freed, that the child dies, and that the doubled
    // teardown did not make close() absorb a failure it then had to report.
    const target = created[0];
    server.sendLine(rpcLine(20, 'terminal.close', { sessionId: target.sessionId, owner: target.owner }));
    server.sendLine(rpcLine(21, 'terminal.close', { sessionId: target.sessionId, owner: target.owner }));
    const outcomes = [await server.waitForResponse(20), await server.waitForResponse(21)];
    for (const outcome of outcomes) {
      assert.ok(outcome.result === true || /Unknown session/.test(outcome.error?.message ?? ''),
        `a racing close must either succeed or report the session gone: ${JSON.stringify(outcome)}`);
    }
    assert.equal((await server.list()).length, 1, 'the racing closes must free exactly one slot');
    assert.deepEqual(await expectGone([target.pid]), [], 'the racing close must still kill the child');
    assert.ok(!CLEANUP_FAILURE.test(server.stderr),
      `a doubled teardown made close() absorb a failure:\n${server.stderr}`);

    const survivor = created[1];
    assert.equal((await server.close(survivor.sessionId, survivor.owner)).result, true);
    assert.deepEqual(await server.list(), []);
    assert.deepEqual(await expectGone(pids), [], 'racing closes must not leak a child');
  } finally {
    reap(await untilGone(pids, 0));
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
    // that all of them reject, and for ownership rather than for some unrelated
    // reason that would let a wrong token through later.
    const gated = [
      ['terminal.type', { revision: 0, text: 'x' }, /Input ownership required/],
      ['terminal.key', { revision: 0, key: 'Enter' }, /Input ownership required/],
      ['terminal.resize', { cols: 50, rows: 20 }, /Resize denied/],
      ['terminal.close', {}, /Ownership required/],
    ];
    // Includes B's genuine token, valid for B and still refused on A: tokens are
    // per-session credentials, not a shared secret.
    const wrongTokens = ['not-the-owner', '', b.owner, a.sessionId, a.owner.toUpperCase(), null, 0];
    for (const [method, params, expected] of gated) {
      for (const owner of wrongTokens) {
        const probe = await server.request(method, { sessionId: a.sessionId, owner, ...params });
        assert.ok(probe.response.error, `${method} accepted owner ${JSON.stringify(owner)}`);
        assert.match(probe.response.error.message, expected,
          `${method} with owner ${JSON.stringify(owner)} failed for the wrong reason: ${probe.response.error.message}`);
      }
    }

    // Ownership is checked before the revision guard. Pinning that order matters:
    // reversing it would answer a wrong-owner caller with "Stale observation",
    // which leaks that the session exists and is live.
    const fresh = await server.call('terminal.observe', { sessionId: a.sessionId });
    const staleAndWrong = await server.request('terminal.type', {
      sessionId: a.sessionId, owner: 'wrong', revision: fresh.result.revision + 99, text: 'x',
    });
    assert.match(staleAndWrong.response.error?.message ?? '', /Input ownership required/,
      'ownership must be checked before the revision guard');

    // Ungated reads must keep working, or the session would be unusable.
    assert.equal(fresh.result.sessionId, a.sessionId);
    assert.equal(fresh.result.owner, undefined, 'observe must not leak the owner token');
    const listed = await server.list();
    assert.equal(listed.length, 2);
    assert.ok(listed.every(entry => entry.owner === undefined), 'terminal.list must not leak owner tokens');

    // The rightful owner still has full control after all the abuse -- proven by a
    // round trip through the child rather than a status code: the fixture only
    // echoes back what it actually received on stdin.
    const typed = await server.request('terminal.type', {
      sessionId: a.sessionId, owner: a.owner, revision: fresh.result.revision, text: 'echo OWN-OK\r',
    });
    assert.ok(typed.response.result, `the real owner was refused: ${JSON.stringify(typed.response.error)}`);
    await server.waitScreen(a.sessionId, 'ECHO:OWN-OK');

    assert.equal((await server.close(a.sessionId, a.owner)).result, true);
    assert.equal((await server.close(b.sessionId, b.owner)).result, true);
    assert.deepEqual(await server.list(), []);
    assert.deepEqual(await expectGone(pids), []);
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `ownership abuse caused a cleanup failure:\n${server.stderr}`);
  } finally {
    reap(await untilGone(pids, 0));
    await server.stop();
  }
});

test('FI-09 session capacity survives repeated fault storms', opts, async () => {
  const server = startRuntime();
  const everyPid = [];
  try {
    const { result } = await server.call('initialize', {});
    assert.equal(result.protocolVersion, 1);

    // The capacity invariant is comparative rather than absolute: round 0
    // establishes how many slots this runtime offers and every later round must get
    // the same number back. A slot burned by a fault shows up as a short round --
    // which is the failure mode issue #14 was about, and the one an assertion like
    // "at least one session opened" cannot see.
    let capacity = null;
    for (let round = 0; round < 3; round += 1) {
      const opened = [];
      for (;;) {
        const response = await server.request('terminal.create', spawnFixture({ cols: 40, rows: 10 }));
        if (response.response.error) {
          assert.match(response.response.error.message, /Session limit/,
            `round ${round}: create failed for a reason other than capacity: ${JSON.stringify(response.response.error)}`);
          break;
        }
        opened.push(response.response.result);
        everyPid.push(response.response.result.pid);
      }

      if (capacity === null) {
        capacity = opened.length;
        assert.ok(capacity > 1, `round 0 only opened ${capacity} session(s); the runtime cannot be stressed`);
      } else {
        assert.equal(opened.length, capacity,
          `round ${round} opened ${opened.length} sessions but round 0 opened ${capacity}: `
          + "capacity was permanently consumed by the previous round's faults");
      }
      assert.equal((await server.list()).length, capacity,
        `round ${round}: registry disagrees with the number of accepted creates`);

      // Fault the protocol, not the operating system. Mass-killing children behind
      // the runtime's back and then continuing to create is a separate defect: it
      // crashes the host with STATUS_ACCESS_VIOLATION inside node-pty's ConPTY
      // layer, at the same rate on unmodified main, so asserting on it here would
      // make this test flaky for a reason unrelated to capacity accounting. It is
      // measured by test/bench/conpty-external-kill.mjs and filed as issue #21.
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
      assert.equal((await server.list()).length, capacity,
        `round ${round}: a rejected close must not free a slot`);

      // Now close everything properly. Every slot must come back.
      for (const entry of opened) {
        const closed = await server.close(entry.sessionId, entry.owner);
        assert.equal(closed.result, true, `round ${round}: close failed: ${JSON.stringify(closed.error)}`);
      }
      assert.deepEqual(await server.list(), [], `round ${round}: slots were not returned after a fault storm`);
    }

    // A full-capacity round afterwards is the point of the whole test: three rounds
    // of abuse must leave the runtime offering exactly as many slots as it started
    // with, and a session opened at that point must still reach readiness.
    const reopened = [];
    for (;;) {
      const response = await server.request('terminal.create', spawnFixture({ cols: 40, rows: 10 }));
      if (response.response.error) break;
      reopened.push(response.response.result);
      everyPid.push(response.response.result.pid);
    }
    assert.equal(reopened.length, capacity,
      `after three fault storms the runtime offers ${reopened.length} slots instead of ${capacity}`);
    await server.waitScreen(reopened[0].sessionId, 'FIXTURE READY');
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `a fault storm caused a cleanup failure:\n${server.stderr}`);
  } finally {
    await server.stop();
    // Measure BEFORE reaping: reaping first would make the leak assertion
    // unfalsifiable, since it could then only fail if a process survived
    // TerminateProcess for the whole budget.
    const leaked = await untilGone(everyPid, 15000);
    reap(leaked);
    assert.deepEqual(leaked, [], `a fault storm leaked child processes: ${leaked.join(', ')}`);
  }
});
