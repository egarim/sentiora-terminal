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
import { startRuntime, expectGone, collectSurvivors, untilGone, untilNotRunning, reap, describeInit, rpcLine } from './helpers/runtime.mjs';
import { FIXTURE } from './helpers/native.mjs';

const opts = { timeout: 180000 };
const spawnFixture = extra => ({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 20, ...extra });

// FI-09 and FI-10 repeatedly fill the registry to its 16-session limit and drain
// it. On Windows that reliably enough kills the host with STATUS_ACCESS_VIOLATION
// (exit 3221225477) to make them unusable as CI gates. It is the crash documented
// in issue #21, and notably it needs NO external kill: plain fill-and-drain at the
// session limit is enough.
//
// Observed on windows-latest + node 22 (FI-09, FI-10), windows-latest + node 24
// (ST14-05) and windows-11-arm + node 24 (FI-10) -- both Windows runners and both
// Node majors, never on ubuntu or macos. The gate was first scoped to
// windows-latest + node 22 alone on the strength of two occurrences; that scoping
// was wrong and only moved the failure to the next cell, so it now covers all of
// Windows.
//
// They are gated rather than deleted or relaxed, because the capacity invariant
// they assert is the one issue #14 was about. CI sets SENTIORA_FAULT_FILL=0 on
// Windows and says why; run them locally, or set SENTIORA_FAULT_FILL=1, to
// exercise them. Un-gating them is the acceptance test for a fix to #21.
const FILL_GATE = process.env.SENTIORA_FAULT_FILL === '0'
  ? 'fill-to-limit churn crashes the host on Windows (STATUS_ACCESS_VIOLATION); see issue #21. Set SENTIORA_FAULT_FILL=1 to run it anyway.'
  : false;
const fillOpts = { ...opts, skip: FILL_GATE };

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
    // Teardown runs to completion BEFORE any assertion. If the shutdown path
    // regresses -- the very thing this test exists to report -- an early assert
    // would leave a live server holding three live PTY children, which keeps this
    // file's process alive and turns a fast failure into a job-level hang.
    server.destroyStdin();
    const info = await server.exited(20000);
    if (!info) server.killHard();
    await server.exited(10000);
    const { survivors, invalid } = await collectSurvivors(pids, 20000);

    assert.ok(info, `server never exited after stdin was destroyed:\n${server.stderr}`);
    assert.deepEqual(invalid, [], `unusable pids would make the leak check vacuous: ${JSON.stringify(invalid)}`);
    assert.deepEqual(survivors, [], 'a vanished client must not leave its shells running');
    assert.ok(!/Unhandled|ERR_STREAM|throw er/.test(server.stderr), `unhandled failure on teardown:\n${server.stderr}`);
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `teardown reported a cleanup failure:\n${server.stderr}`);
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
    // Same ordering rule as FI-02: guarantee the host and its children are gone
    // before asserting anything about them.
    server.endStdin();
    const info = await server.exited(20000);
    if (!info) server.killHard();
    await server.exited(10000);
    const { survivors, invalid } = await collectSurvivors(pids, 20000);

    assert.ok(info, `server never exited:\n${server.stderr}`);
    assert.deepEqual(invalid, [], `unusable pids would make the leak check vacuous: ${JSON.stringify(invalid)}`);
    assert.deepEqual(survivors, [], 'sessions opened before the pipe broke must still be reaped');
    assert.ok(!/Unhandled|ERR_STREAM|throw er/.test(server.stderr), `unhandled failure:\n${server.stderr}`);
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `teardown reported a cleanup failure:\n${server.stderr}`);
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

    // The runtime is SIGKILLed, so it cannot reap its own children and PID 1 of the
    // pid namespace inherits that job. Hence untilNotRunning rather than untilGone:
    // a child that exited and was never reaped is a pid-table entry, not a leaked
    // shell, and in a container whose PID 1 is not an init it would otherwise fail
    // this test forever while measuring nothing about this repository.
    //
    // Everything is described before anything is signalled, because reaping turns a
    // running process into a dying one and destroys the distinction being reported.
    const { running, zombies } = await untilNotRunning(pids);
    const pid1 = describeInit();
    console.log(`    FI-05 after SIGKILL of the runtime: ${running.length} running, `
      + `${zombies.length} exited-but-unreaped, of ${pids.length} `
      + `(${process.platform}, exit ${JSON.stringify(info)}, pid1 ${JSON.stringify(pid1)})`);
    if (zombies.length) console.log(`    FI-05 unreaped exit records: ${JSON.stringify(zombies)}`);
    // Signalled before asserting, so a failure cannot leak a live shell into the next
    // test. A zombie cannot be reaped from here -- we are not its parent, PID 1 is.
    reap(running.map(entry => entry.pid));
    assert.deepEqual(running.map(entry => entry.pid), [],
      `killing the runtime left ${running.length} shell(s) STILL RUNNING: ${JSON.stringify(running)}; `
      + `pid1 ${JSON.stringify(pid1)}`);
  } finally {
    if (!server.hasExited) { server.killHard(); await server.exited(10000); }
    await collectSurvivors(pids, 0);
  }
});

test('FI-06 a restarted runtime rejects the previous one\'s session ids', opts, async () => {
  // Scope, stated honestly. A fresh process has a fresh registry and ids are
  // random, so "no session survives a restart" is true by construction and no
  // change to src/ could falsify it; this is not really a restart test. What it
  // does pin is that a new runtime answers Unknown session for an id it never
  // issued, on the five session methods exercised below, and registers nothing
  // while refusing. dispatch handles six; terminal.key is covered by ST14-01.
  //
  // The stale owner token is sent along with each request but is never compared:
  // dispatch looks the session up before it checks ownership, so the id fails
  // first. That ordering is the correct one and worth keeping -- answering a
  // wrong-token caller with an ownership error would confirm that the session
  // exists. This test therefore does NOT prove anything about token validation
  // across a restart; FI-08 covers tokens against live sessions.
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
    if (stalePid !== null) {
      // Logged, not asserted: this is a `finally`, where throwing would mask the
      // failure the test actually came to report.
      //
      // untilNotRunning throws on a pid it cannot probe. That is correct inside a
      // test body -- a leak check that quietly skips an unprobeable pid asserts
      // nothing -- and wrong here, which is why collectSurvivors, the function this
      // replaced, filtered instead of throwing. Filter the same way rather than
      // reintroducing the hazard. The window is not hypothetical: node-pty
      // 1.2.0-beta reports pid 0 until its deferred pty connection completes, and
      // src/session.js documents that.
      const probeable = [stalePid].filter(pid => Number.isInteger(pid) && pid > 0);
      if (probeable.length) {
        // untilNotRunning also gives back the 20s collectSurvivors used to spend
        // waiting on a zombie that nothing in a container without an init can reap.
        const { running, zombies } = await untilNotRunning(probeable, 20000);
        if (running.length || zombies.length) {
          console.log(`    FI-06 after SIGKILL of the runtime: ${JSON.stringify({ running, zombies })}`);
        }
        reap(running.map(entry => entry.pid));
      } else {
        // Reported rather than treated as gone, for the same reason the helper
        // throws in the first place: silence here would look like a clean teardown.
        console.log(`    FI-06 cannot probe stale pid ${JSON.stringify(stalePid)}; not claiming it is gone`);
      }
    }
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
    // Stop the server first: a live host holds live children, so reaping before
    // stopping would race the runtime's own teardown.
    await server.stop();
    await collectSurvivors(pids, 20000);
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
    // Stop the server first: a live host holds live children, so reaping before
    // stopping would race the runtime's own teardown.
    await server.stop();
    await collectSurvivors(pids, 20000);
  }
});

test('FI-10 rejected creates do not consume session capacity', fillOpts, async () => {
  // terminal.list cannot see a session that sits in the in-flight set and was never
  // committed, so "the registry is empty after a rejected create" does not prove no
  // slot was burned. The only way to observe it is to fill the registry and require
  // the full count back. That is exactly issue #14's failure mode -- a malformed
  // create silently costing a slot in a long-lived runtime -- and it is the variant
  // FI-09 cannot see, because FI-09 never sends an invalid create.
  const server = startRuntime();
  const pids = [];
  const fill = async () => {
    const opened = [];
    for (;;) {
      const response = await server.request('terminal.create', spawnFixture({ cols: 40, rows: 10 }));
      if (response.response.error) {
        assert.match(response.response.error.message, /Session limit/,
          `create failed for a reason other than capacity: ${JSON.stringify(response.response.error)}`);
        return opened;
      }
      opened.push(response.response.result);
      pids.push(response.response.result.pid);
    }
  };
  const drain = async opened => {
    for (const entry of opened) {
      assert.equal((await server.close(entry.sessionId, entry.owner)).result, true);
    }
    assert.deepEqual(await server.list(), []);
  };

  try {
    // Establish this runtime's capacity before anything has been rejected.
    const baseline = await fill();
    const capacity = baseline.length;
    assert.ok(capacity > 1, `only ${capacity} slot(s) available; capacity cannot be measured`);
    await drain(baseline);

    const invalid = [
      { command: '', args: [] },
      { command: process.execPath, args: 'not-an-array' },
      { command: process.execPath, args: [1, 2] },
      { command: process.execPath, args: [FIXTURE], cols: 1, rows: 1 },
      { command: process.execPath, args: [FIXTURE], cols: 5000, rows: 10 },
      { command: process.execPath, args: [FIXTURE], conptyDll: 'yes' },
      { args: [FIXTURE] },
    ];
    for (const params of invalid) {
      const response = await server.request('terminal.create', params);
      assert.ok(response.response.error, `an invalid create was accepted: ${JSON.stringify(params)}`);
    }
    assert.deepEqual(await server.list(), [], 'a rejected create must not register a session');

    // The real assertion: capacity is undiminished. A create that reserved a slot
    // and then threw during validation would show up here and nowhere else. All
    // seven cases fail validation rather than spawn, so this covers the validation
    // path on every platform; the spawn-throw path is Windows-only (see ST14-03 for
    // why POSIX does not throw there) and a slot burned only on a spawn failure is
    // not covered by this test.
    const after = await fill();
    assert.equal(after.length, capacity,
      `${invalid.length} rejected creates consumed ${capacity - after.length} slot(s): `
      + 'a create that reserves capacity must release it when validation fails');
    await drain(after);
    assert.ok(!CLEANUP_FAILURE.test(server.stderr), `a rejected create caused a cleanup failure:\n${server.stderr}`);
  } finally {
    await server.stop();
    const { survivors, invalid: unusable } = await collectSurvivors(pids, 20000);
    assert.deepEqual(unusable, [], `unusable pids would make the leak check vacuous: ${JSON.stringify(unusable)}`);
    assert.deepEqual(survivors, [], `rejected creates leaked child processes: ${survivors.join(', ')}`);
  }
});

test('FI-09 session capacity survives repeated fault storms', fillOpts, async () => {
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

      // Fault the protocol, not the operating system. This test no longer kills any
      // child externally -- but that is a choice about what to ASSERT, not a claim
      // that external kills are what crash the host. Issue #21's
      // STATUS_ACCESS_VIOLATION reproduces from plain fill-to-limit-and-drain churn
      // with nothing killed behind the runtime's back, which is why this test and
      // FI-10 are gated by SENTIORA_FAULT_FILL on windows-latest/node 22. Do not
      // read the absence of external kills here as evidence that repeated
      // fill-and-drain is safe; the external-kill form is separately measured by
      // test/bench/conpty-external-kill.mjs.
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

    // Close the last round while the server is still alive and check the children
    // with a short budget. Doing it after server.stop() would measure the
    // runtime's own shutdown sweep rather than close(): stop() reaps both the
    // registry and the in-flight set, so a close that stopped killing children
    // would be papered over by the teardown that follows it.
    const reopenedPids = reopened.map(entry => entry.pid);
    for (const entry of reopened) {
      assert.equal((await server.close(entry.sessionId, entry.owner)).result, true);
    }
    assert.deepEqual(await server.list(), [], 'the final round did not return its slots');
    const notKilled = await untilGone(reopenedPids, 15000);
    assert.deepEqual(notKilled, [],
      `terminal.close returned true but these children were still alive 5s later: ${notKilled.join(', ')}`);
  } finally {
    await server.stop();
    // Backstop over every pid the test ever saw, after the host is stopped so the
    // measurement is not racing the runtime's own teardown.
    const { survivors, invalid } = await collectSurvivors(everyPid, 15000);
    assert.deepEqual(invalid, [], `unusable pids would make the leak check vacuous: ${JSON.stringify(invalid)}`);
    assert.deepEqual(survivors, [], `a fault storm leaked child processes: ${survivors.join(', ')}`);
  }
});
