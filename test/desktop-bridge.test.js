// Unit tests for the desktop session bridge, driven against a scriptable stand-in
// for src/server.js (test/fixtures/fake-runtime.mjs).
//
// These are deliberately *not* native tests: they run on every CI platform in
// well under a second and pin down the bridge's own logic -- the revision guard,
// owner-token containment, ordered frames, backpressure, scrollback recovery, host
// recycling at the descriptor ceiling and the backend-lost path. The real runtime
// is exercised by test/desktop-native.test.js, which these do not replace.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeBackend, collectFrames, drainUntilQuiet, until, assertNoOwner,
} from './helpers/desktop.mjs';
import { classify, SentioraError } from '../apps/desktop/bridge/errors.js';
import { clampDimensions, COLS, ROWS, STALE_RETRY_LIMIT } from '../apps/desktop/bridge/protocol.js';

const opts = { timeout: 60000 };

test('every runtime error message maps to a stable kind', opts, () => {
  // All runtime failures share JSON-RPC code -32000, so the message string is the
  // only discriminator. This table is the contract the bridge is built on; if the
  // runtime ever grows real error codes, only errors.js changes.
  const cases = [
    ['Stale observation', 'stale-observation', true],
    ['Input ownership required', 'ownership-required', false],
    ['Ownership required', 'close-ownership-required', false],
    ['Session not running', 'session-not-running', false],
    ['Unknown session', 'unknown-session', false],
    ['Unknown key', 'unknown-key', false],
    ['Invalid dimensions', 'invalid-dimensions', false],
    ['Invalid command', 'invalid-command', false],
    ['Invalid conptyDll', 'invalid-conpty-dll', false],
    ['Resize denied', 'resize-denied', false],
    ['Session limit', 'session-limit', true],
    ['Invalid wait', 'invalid-wait', false],
    ['Invalid input', 'invalid-input', false],
    ['Invalid request', 'invalid-request', false],
    ['Unknown method', 'unknown-method', false],
    ['Invalid pty handle', 'invalid-pty-handle', false],
    ['something nobody predicted', 'unknown', false],
  ];
  for (const [message, kind, retryable] of cases) {
    const error = classify(message);
    assert.equal(error.kind, kind, `message ${JSON.stringify(message)} classified as ${error.kind}`);
    assert.equal(error.retryable, retryable, `${kind} retryable flag`);
    assert.ok(error instanceof SentioraError);
    assert.equal(error.code, -32000);
  }
});

test('dimensions are clamped into the range the runtime accepts', opts, () => {
  // The runtime rejects cols outside 2-300 and rows outside 2-150. A UI slider
  // must never be able to produce 'Invalid dimensions'.
  assert.deepEqual(clampDimensions(500, 500), { cols: COLS.max, rows: ROWS.max });
  assert.deepEqual(clampDimensions(0, 0), { cols: COLS.min, rows: ROWS.min });
  assert.deepEqual(clampDimensions(-40, 12.7), { cols: COLS.min, rows: 12 });
  assert.deepEqual(clampDimensions(NaN, undefined), { cols: COLS.default, rows: ROWS.default });
  assert.deepEqual(clampDimensions(80, 24), { cols: 80, rows: 24 });
});

test('an owner token never reaches a UI-facing payload', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 8 });
    const subscription = backend.bridge.attach(session.sessionId);
    const typed = await backend.bridge.type(session.sessionId, 'echo hello\r');
    const keyed = await backend.bridge.key(session.sessionId, 'Enter');
    const observed = await backend.bridge.observe(session.sessionId);
    const resized = await backend.bridge.resize(session.sessionId, 40, 10);
    // Collected with a bound rather than a required count: this test is about what
    // a payload contains, not about how many frames a settled burst produced.
    const frames = await collectFrames(subscription, { count: 2, timeoutMs: 4000 });
    assert.ok(frames.length >= 1, 'at least one frame must have been delivered');
    const listed = backend.bridge.sessions;
    subscription.detach();

    const owners = backend.ownerTokensIssued();
    assert.ok(owners.length >= 1, 'the fixture must have announced at least one owner token on stderr');

    // The credential is the only thing preventing input injection into a session,
    // so containment is asserted against every payload the bridge can emit rather
    // than against a hand-picked list of fields.
    const payloads = {
      create: session, snapshot: subscription.snapshot, typed, keyed, observed, resized, frames, listed,
      events: backend.events.map(event => event.payload),
      hosts: backend.bridge.hosts, info: backend.bridge.runtimeInfo, limits: backend.bridge.limits,
    };
    for (const owner of owners) {
      for (const [name, payload] of Object.entries(payloads)) assertNoOwner(assert, payload, owner);
    }
    assert.ok(!('owner' in session), 'describe() must not carry an owner field at all');
    assert.ok(!('owner' in observed), 'observe() must not carry an owner field at all');
  } finally {
    await backend.shutdown();
  }
});

test('a write that hits a stale observation is retried and still lands', opts, async () => {
  // The first three writes are refused however they were armed, which is what
  // output landing between observe and write does in the real runtime.
  const backend = await createFakeBackend({ runtimeArgs: ['--stale-first', '3'] });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const result = await backend.bridge.type(session.sessionId, 'echo RETRY-OK\r');
    assert.ok(Number.isInteger(result.revision), 'the retry loop must still return the new revision');
    const observed = await backend.bridge.observe(session.sessionId);
    assert.match(observed.screen, /RETRY-OK/, 'the input must land after the stale retries');
  } finally {
    await backend.shutdown();
  }
});

test('stale retries are bounded so a busy session cannot spin forever', opts, async () => {
  const backend = await createFakeBackend({ runtimeArgs: ['--stale-first', String(STALE_RETRY_LIMIT + 5)] });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    await assert.rejects(
      () => backend.bridge.type(session.sessionId, 'echo never\r'),
      error => error.kind === 'stale-observation',
    );
  } finally {
    await backend.shutdown();
  }
});

test('a write advances the revision that the next wait must be armed with', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const before = backend.bridge.sessions.find(s => s.sessionId === session.sessionId).revision;
    const typed = await backend.bridge.type(session.sessionId, 'echo ARM\r');
    // The write bumps the revision itself. Publishing the returned value is what
    // stops the next wait from being armed with the pre-write revision and
    // returning before the child has answered.
    assert.ok(typed.revision > before, `write must advance the revision (${before} -> ${typed.revision})`);
    assert.equal(
      backend.bridge.sessions.find(s => s.sessionId === session.sessionId).revision,
      typed.revision,
      'the bridge must re-arm with the revision the write returned',
    );
    const observed = await backend.bridge.waitUntil(
      session.sessionId, o => o.screen.includes('ARM'),
      { timeoutMs: 10000, label: 'the echo of ARM' },
    );
    assert.match(observed.screen, /ARM/);
  } finally {
    await backend.shutdown();
  }
});

test('resize clamps out-of-range requests and reports what was applied', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const wild = await backend.bridge.resize(session.sessionId, 5000, 900);
    assert.equal(wild.clamped, true, 'an out-of-range resize must be reported as clamped');
    assert.deepEqual(wild.applied, { cols: COLS.max, rows: ROWS.max });
    assert.deepEqual(wild.requested, { cols: 5000, rows: 900 });
    assert.equal(wild.cols, COLS.max);
    assert.equal(wild.rows, ROWS.max);

    const exact = await backend.bridge.resize(session.sessionId, 60, 15);
    assert.equal(exact.clamped, false, 'an in-range resize must not be marked clamped');
    assert.deepEqual(exact.applied, { cols: 60, rows: 15 });
  } finally {
    await backend.shutdown();
  }
});

test('frames arrive in strictly increasing revision order', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 60, rows: 20 });
    const subscription = backend.bridge.attach(session.sessionId);

    // Drained *while* output is still being produced. Demanding a fixed frame
    // count from a burst that has already settled is not a well-formed request:
    // backpressure may have coalesced the whole burst into one frame, and once the
    // child is quiet the pump emits nothing more, so the count could never be
    // reached however long the test waited. That was a real defect in this test.
    const frames = [];
    const collecting = collectFrames(subscription, { count: 3, timeoutMs: 20000, into: frames });
    let lastWritten = -1;
    for (let i = 0; i < 30 && frames.length < 3; i += 1) {
      await backend.bridge.type(session.sessionId, `echo ORDER-${i}\r`);
      lastWritten = i;
    }
    await collecting;
    subscription.detach();

    assert.ok(frames.length >= 3, `expected at least 3 frames from ${lastWritten + 1} writes, got ${frames.length}`);
    const revisions = frames.map(frame => frame.revision);
    for (let i = 1; i < revisions.length; i += 1) {
      assert.ok(revisions[i] > revisions[i - 1], `revisions must increase: ${revisions.join(', ')}`);
    }
    assert.equal(new Set(revisions).size, revisions.length, 'a revision must not be delivered twice');

    // Ordering is the pump's guarantee. Completeness of the final screen is the
    // runtime's, so it is checked against a marker the child itself printed rather
    // than assumed from whichever frame happened to arrive third.
    const final = await backend.bridge.waitUntil(
      session.sessionId, observation => observation.screen.includes(`ORDER-${lastWritten}`),
      { timeoutMs: 15000, label: `the last echoed line ORDER-${lastWritten}` },
    );
    assert.match(final.screen, new RegExp(`ORDER-${lastWritten}`));
  } finally {
    await backend.shutdown();
  }
});

const SILENT = Symbol('no-frame');

test('an idle session produces no duplicate frames', opts, async () => {
  // terminal.wait resolves on timeout with an unmoved revision. Publishing that
  // would mean 4 frames per second per idle session forever, so the pump has to
  // drop it. This is a regression test for exactly that.
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const subscription = backend.bridge.attach(session.sessionId);
    await backend.bridge.type(session.sessionId, 'echo SETTLE\r');
    await backend.bridge.waitUntil(session.sessionId, o => o.screen.includes('SETTLE'), {
      timeoutMs: 10000, label: 'the echo to land',
    });
    // Drain whatever the pump already published. Note that bridge.observe() is
    // deliberately not used here: it ingests, and ingesting publishes a frame,
    // which would defeat the very thing being measured.
    const revisionOf = () => backend.bridge.sessions.find(s => s.sessionId === session.sessionId).revision;
    for (;;) {
      const frame = await Promise.race([
        subscription.next(),
        new Promise(resolveRace => setTimeout(() => resolveRace(SILENT), 100)),
      ]);
      if (frame === SILENT || frame === null) break;
    }
    const revision = revisionOf();
    // Now require silence for longer than three poll intervals (250ms each).
    const quietFrame = await Promise.race([
      subscription.next(),
      new Promise(resolveRace => setTimeout(() => resolveRace(SILENT), 900)),
    ]);
    assert.equal(quietFrame, SILENT, 'an idle session must not keep emitting frames');
    assert.equal(revisionOf(), revision, 'the revision must not move on its own');
    subscription.detach();
  } finally {
    await backend.shutdown();
  }
});

test('concurrent observations cannot rewind the revision or replay scrollback', opts, async () => {
  // The pump's terminal.wait and an explicit observe() are separate RPCs
  // correlated by id, not by send order, so a response issued first can land
  // second. Applying that older screen would move the revision backwards and run
  // the pure-shift match against a stale base, recovering the same lines twice.
  // This is a regression test for exactly that, which the native U11 flood caught.
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 5 });
    const subscription = backend.bridge.attach(session.sessionId);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => backend.bridge.type(session.sessionId, `echo CONC-${i}\r`)),
      ...Array.from({ length: 10 }, () => backend.bridge.observe(session.sessionId)),
    ]);
    const frames = await drainUntilQuiet(subscription, { quietMs: 600, hardMs: 10000, kind: 'frame' });
    subscription.detach();

    assert.ok(frames.length > 0);
    const revisions = frames.map(frame => frame.revision);
    for (let i = 1; i < revisions.length; i += 1) {
      assert.ok(revisions[i] > revisions[i - 1], `revision repeated or went backwards: ${revisions.join(', ')}`);
    }

    const counts = new Map();
    for (const line of frames.flatMap(frame => frame.scrolledOff ?? [])) {
      const marker = /CONC-\d+/.exec(line)?.[0];
      if (!marker) continue;
      counts.set(marker, (counts.get(marker) ?? 0) + 1);
    }
    const duplicated = [...counts].filter(([, count]) => count > 1);
    assert.deepEqual(duplicated, [], `scrollback lines recovered more than once: ${JSON.stringify(duplicated)}`);
  } finally {
    await backend.shutdown();
  }
});

const PARK_TIMEOUT = Symbol('park-timeout');

test('a parked next() waiter is not skipped by the frame it was waiting for', opts, async () => {
  // Regression test for a real frame-loss defect. next() used to mint a fresh
  // promise on every call and overwrite the subscriber's wake callback, so a
  // consumer that raced next() against a deadline and lost would leave an
  // abandoned waiter registered. The next delivery then shifted the frame into
  // that already-abandoned promise and it vanished without ever reaching anyone.
  // Any consumer with a timeout hits this, which is why it is asserted directly.
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const subscription = backend.bridge.attach(session.sessionId);

    // Nothing has been produced yet, so the queue is empty and next() must park.
    const parked = subscription.next();
    const raced = await Promise.race([
      parked,
      new Promise(resolve => setTimeout(() => resolve(PARK_TIMEOUT), 150)),
    ]);
    assert.equal(raced, PARK_TIMEOUT, 'the waiter should still be parked with nothing queued');

    // The fix: a second call returns the *same* parked promise instead of
    // superseding it, so the frame still has a live owner.
    assert.equal(subscription.next(), parked, 'next() must park a single shared waiter per subscriber');

    await backend.bridge.type(session.sessionId, 'echo PARKED\r');
    const frame = await Promise.race([
      parked,
      new Promise(resolve => setTimeout(() => resolve(PARK_TIMEOUT), 15000)),
    ]);
    assert.notEqual(frame, PARK_TIMEOUT, 'the parked waiter was never woken: its frame was lost');
    assert.equal(frame.kind, 'frame');
    assert.equal(frame.sessionId, session.sessionId);

    // The stream must still be usable afterwards, and detaching must resolve
    // rather than leave a consumer hanging.
    const rest = await collectFrames(subscription, { count: 5, timeoutMs: 5000 });
    assert.ok(
      [...rest, frame].some(entry => entry.lines.join('\n').includes('PARKED')),
      'the echoed line must reach the consumer',
    );
    subscription.detach();
    assert.equal(await subscription.next(), null, 'a detached subscription must report closure');
  } finally {
    await backend.shutdown();
  }
});

test('a slow consumer gets coalesced snapshots flagged for resync', opts, async () => {
  // maxQueuedFrames 1 is the tightest setting: anything a consumer fails to drain
  // is replaced by the newest whole screen, and the frame says resync so the UI
  // repaints fully instead of applying a diff it no longer has the base for.
  const backend = await createFakeBackend({ maxQueuedFrames: 1 });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 60, rows: 20 });
    const subscription = backend.bridge.attach(session.sessionId);
    for (let i = 0; i < 12; i += 1) await backend.bridge.type(session.sessionId, `echo BURSTY-${i}\r`);
    await until(() => subscription.coalesced > 0, { timeoutMs: 10000, label: 'the pump to coalesce frames' });

    // Wait for the child's own last output rather than for the stream to go
    // quiet, then take whatever the bounded queue is holding. With a queue of one
    // that is the newest whole screen by construction.
    await backend.bridge.waitUntil(
      session.sessionId, observation => observation.screen.includes('BURSTY-11'),
      { timeoutMs: 15000, label: 'the last echoed line' },
    );
    const frames = await collectFrames(subscription, { count: 4, timeoutMs: 3000 });
    subscription.detach();

    assert.ok(frames.length > 0, 'the consumer must have received at least one frame');
    assert.ok(frames.some(frame => frame.resync === true), 'a coalesced frame must be flagged resync');
    assert.ok(subscription.coalesced > 0, 'the subscription must count what it coalesced');
    // Coalescing keeps the newest whole screen and drops the intermediates, so the
    // last frame delivered must still agree exactly with what the runtime renders.
    const fresh = await backend.bridge.observe(session.sessionId);
    assert.deepEqual(frames.at(-1).lines, fresh.screen.split('\n'), 'coalescing must stay lossless for the viewport');
    assert.match(fresh.screen, /BURSTY-11/);
  } finally {
    await backend.shutdown();
  }
});

test('attaching to a live session replays a full snapshot with scrollback', opts, async () => {
  // Test U04 at the bridge level: a client that attaches late must not start from
  // a partial screen.
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 5 });
    for (let i = 0; i < 6; i += 1) {
      await backend.bridge.type(session.sessionId, `echo LATE-${i}\r`);
      await backend.bridge.waitUntil(session.sessionId, o => o.screen.includes(`LATE-${i}`), {
        timeoutMs: 10000, label: `LATE-${i}`,
      });
    }
    const late = backend.bridge.attach(session.sessionId);
    assert.equal(late.snapshot.resync, true, 'an initial snapshot must always ask for a full repaint');
    assert.equal(late.snapshot.lines.length, 5, 'the snapshot must cover the whole viewport');
    assert.equal(late.snapshot.sessionId, session.sessionId);
    assert.match(late.snapshot.lines.join('\n'), /LATE-5/);
    assert.ok(late.snapshot.scrollback.length > 0, 'lines that left the viewport must be recovered');
    assert.ok(Array.isArray(late.snapshot.scrollback));
    late.detach();

    // Detaching must stop delivery, and a second attach must work again.
    const again = backend.bridge.attach(session.sessionId);
    assert.equal(again.snapshot.lines.length, 5);
    again.detach();
  } finally {
    await backend.shutdown();
  }
});

test('scrollback recovers the lines that scrolled off the top', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 5 });
    const total = 12;
    for (let i = 0; i < total; i += 1) {
      await backend.bridge.type(session.sessionId, `echo SB-${i}\r`);
      await backend.bridge.waitUntil(session.sessionId, o => o.screen.includes(`SB-${i}`), {
        timeoutMs: 10000, label: `SB-${i}`,
      });
    }
    const subscription = backend.bridge.attach(session.sessionId);
    const recovered = [...subscription.snapshot.scrollback, ...subscription.snapshot.lines].join('\n');
    subscription.detach();
    for (let i = 0; i < total; i += 1) {
      assert.ok(recovered.includes(`SB-${i}`), `line SB-${i} was lost; recovered text:\n${recovered}`);
    }
    // Order is what makes scrollback usable rather than merely present.
    const positions = Array.from({ length: total }, (_, i) => recovered.indexOf(`SB-${i}`));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'recovered lines must stay in order');
  } finally {
    await backend.shutdown();
  }
});

test('the scroll ring is bounded', opts, async () => {
  const backend = await createFakeBackend({ scrollbackLimit: 10 });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 4 });
    for (let i = 0; i < 30; i += 1) {
      await backend.bridge.type(session.sessionId, `echo CAP-${i}\r`);
      await backend.bridge.waitUntil(session.sessionId, o => o.screen.includes(`CAP-${i}`), {
        timeoutMs: 10000, label: `CAP-${i}`,
      });
    }
    const subscription = backend.bridge.attach(session.sessionId);
    assert.ok(subscription.snapshot.scrollback.length <= 10, `ring grew to ${subscription.snapshot.scrollback.length}`);
    assert.equal(subscription.snapshot.scrollback.at(-1).includes('CAP-'), true, 'the newest lines are the ones kept');
    subscription.detach();
  } finally {
    await backend.shutdown();
  }
});

test('a host is recycled at the descriptor ceiling instead of failing', opts, async () => {
  // The fixture starts refusing creates after 3, standing in for the real host's
  // 'Invalid pty handle' near ~495 cycles. Recycling at 3 must move the 4th
  // session to a fresh host so the failure is never observable.
  const backend = await createFakeBackend({ runtimeArgs: ['--fail-after', '3'], recycleAfter: 3 });
  try {
    const sessions = [];
    for (let i = 0; i < 6; i += 1) {
      sessions.push(await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 }));
    }
    assert.equal(sessions.length, 6, 'every create must succeed across the recycle boundary');
    assert.ok(backend.pool.hosts.length >= 2, `expected a second host, got ${JSON.stringify(backend.pool.hosts)}`);
    // The fixture restarts its id counter per process, so both hosts hand out
    // 'fake-1'. The bridge must not let that collide.
    assert.equal(new Set(sessions.map(s => s.sessionId)).size, 6, 'bridge session ids must stay unique across hosts');
    assert.notEqual(sessions[0].hostId, sessions[3].hostId, 'the 4th session must have landed on a fresh host');

    // Closing the first host's sessions must retire it rather than leave a
    // worn-out process holding descriptors.
    const firstHost = sessions[0].sessionId;
    await backend.bridge.close(firstHost);
    await backend.bridge.close(sessions[1].sessionId);
    await backend.bridge.close(sessions[2].sessionId);
    await until(() => backend.eventsOf('host-recycled').length > 0, {
      timeoutMs: 15000, label: 'the worn-out host to be retired',
    });
  } finally {
    await backend.shutdown();
  }
});

test('without recycling the host ceiling surfaces as a typed error', opts, async () => {
  const backend = await createFakeBackend({ runtimeArgs: ['--fail-after', '2'], recycleAfter: Infinity });
  try {
    await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    await assert.rejects(
      () => backend.bridge.create({ command: 'fake', cols: 30, rows: 6 }),
      error => error.kind === 'invalid-pty-handle',
      'an exhausted host must be reported as invalid-pty-handle, not silently retried',
    );
  } finally {
    await backend.shutdown();
  }
});

test('the 16-session cap spreads across hosts and then reports session-limit', opts, async () => {
  // sessionLimit is lowered on both sides (fixture and pool) so the spreading and
  // the refusal can be exercised without creating 48 real sessions.
  const backend = await createFakeBackend({ runtimeArgs: ['--session-limit', '2'], maxHosts: 3, sessionLimit: 2 });
  try {
    for (let i = 0; i < 6; i += 1) await backend.bridge.create({ command: 'fake', cols: 20, rows: 5 });
    assert.equal(backend.pool.hosts.length, 3, 'sessions must be spread over every allowed host');
    assert.equal(backend.bridge.sessions.length, 6);
    await assert.rejects(
      () => backend.bridge.create({ command: 'fake', cols: 20, rows: 5 }),
      error => error.kind === 'session-limit',
    );
  } finally {
    await backend.shutdown();
  }
});

test('a runtime that dies mid-session is reported as backend lost, not retried', opts, async () => {
  const backend = await createFakeBackend({ runtimeArgs: ['--die-after-requests', '4'] });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    await until(() => backend.eventsOf('host-lost').length > 0, {
      timeoutMs: 15000, label: 'the host to die',
    });
    await until(() => backend.eventsOf('session-lost').length > 0, {
      timeoutMs: 15000, label: 'the session to be marked lost',
    });

    // Every sessionId on that host is now meaningless. Blindly retrying would
    // attach the UI to a different process, so the bridge refuses instead.
    await assert.rejects(
      () => backend.bridge.observe(session.sessionId),
      error => error.kind === 'backend-lost',
    );
    await assert.rejects(
      () => backend.bridge.type(session.sessionId, 'echo x\r'),
      error => error.kind === 'backend-lost',
    );
    const described = backend.bridge.sessions.find(s => s.sessionId === session.sessionId);
    assert.ok(described.backendLost, 'the UI must be able to see that the backend was lost');

    // Closing a lost session must succeed locally and must not throw: the pane
    // still has to go away even though there is no runtime left to tell.
    assert.equal(await backend.bridge.close(session.sessionId), true);
    assert.equal(backend.bridge.sessions.length, 0, 'a lost session must still leave the registry');
  } finally {
    await backend.shutdown();
  }
});

test('non-JSON on the runtime stdout is fatal rather than skipped', opts, async () => {
  // A silent skip would hide framing corruption, which is the one property the
  // whole transport depends on (WIN-15 proves the real runtime holds it).
  const backend = await createFakeBackend({ runtimeArgs: ['--corrupt-after-requests', '3'] });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    await until(() => backend.eventsOf('host-lost').length > 0, {
      timeoutMs: 15000, label: 'the corrupted host to be torn down',
    });
    const lost = backend.eventsOf('host-lost')[0];
    assert.match(lost.reason, /not JSON/, `expected a framing complaint, got ${lost.reason}`);
    await assert.rejects(
      () => backend.bridge.observe(session.sessionId),
      error => error.kind === 'backend-lost',
    );
  } finally {
    await backend.shutdown();
  }
});

test('lost input is surfaced rather than presented as a landed keystroke', opts, async () => {
  const backend = await createFakeBackend({ runtimeArgs: ['--lose-input'] });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    await backend.bridge.type(session.sessionId, 'echo dropped\r');
    await until(() => backend.eventsOf('write-error').length > 0, {
      timeoutMs: 10000, label: 'a write-error event',
    });
    const observed = await backend.bridge.observe(session.sessionId);
    assert.ok(observed.writeErrors > 0, 'writeErrors must reach the UI so it can warn the user');
  } finally {
    await backend.shutdown();
  }
});

test('Ctrl+C is refused until readiness has been observed', opts, async () => {
  // create() returns before the child has configured its console mode, and a
  // Ctrl+C that arrives in cooked mode without a handler kills the process with
  // 0xC000013A instead of interrupting it.
  const backend = await createFakeBackend({ runtimeArgs: ['--no-autoboot'] });
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    assert.equal(session.state, 'spawned', 'the fixture must leave the session spawned');

    const refused = await backend.bridge.interrupt(session.sessionId);
    assert.equal(refused.delivered, false);
    assert.match(refused.reason, /spawned/);

    await backend.bridge.type(session.sessionId, 'echo READY-NOW\r');
    await backend.bridge.waitUntil(
      session.sessionId, o => o.state === 'operational' && o.screen.includes('READY-NOW'),
      { timeoutMs: 10000, label: 'an observed prompt' },
    );

    const allowed = await backend.bridge.interrupt(session.sessionId, { readyPattern: /READY-NOW/ });
    assert.equal(allowed.delivered, true, allowed.reason ?? 'interrupt should be allowed once readiness is observed');

    const wrongPattern = await backend.bridge.interrupt(session.sessionId, { readyPattern: /NOT-PRESENT/ });
    assert.equal(wrongPattern.delivered, false);
    assert.match(wrongPattern.reason, /readiness condition/);
  } finally {
    await backend.shutdown();
  }
});

test('readiness is polled against an observable condition, never slept through', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    // Already true: must resolve on the first observation rather than after a delay.
    const started = Date.now();
    const ready = await backend.bridge.waitUntil(session.sessionId, o => o.screen.includes('FAKE READY'), {
      timeoutMs: 10000, label: 'the boot marker',
    });
    assert.match(ready.screen, /FAKE READY/);
    assert.ok(Date.now() - started < 5000, 'a satisfied condition must not be delayed');

    // Never true: must fail with a typed timeout instead of hanging.
    await assert.rejects(
      () => backend.bridge.waitUntil(session.sessionId, o => o.screen.includes('NEVER-APPEARS'), {
        timeoutMs: 500, label: 'an impossible condition',
      }),
      error => error.kind === 'readiness-timeout',
    );
  } finally {
    await backend.shutdown();
  }
});

test('input is validated before it reaches the runtime', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    await assert.rejects(() => backend.bridge.type(session.sessionId, ''), error => error.kind === 'invalid-input');
    await assert.rejects(() => backend.bridge.type(session.sessionId, 42), error => error.kind === 'invalid-input');
    // The runtime's key map is fixed; anything else has to go as raw control bytes.
    await assert.rejects(() => backend.bridge.key(session.sessionId, 'CtrlD'), error => error.kind === 'unknown-key');
    // Control bytes through type() are the documented way to send them.
    const sent = await backend.bridge.type(session.sessionId, '\x04');
    assert.ok(Number.isInteger(sent.revision));
    await assert.rejects(
      () => backend.bridge.observe('no-such-session'),
      error => error.kind === 'unknown-session',
    );
  } finally {
    await backend.shutdown();
  }
});

test('a long paste is chunked to the runtime input limit', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 60, rows: 10 });
    // terminal.type rejects more than 65536 characters, so the bridge has to split.
    const paste = 'x'.repeat(70000);
    const result = await backend.bridge.type(session.sessionId, paste);
    assert.ok(Number.isInteger(result.revision));
  } finally {
    await backend.shutdown();
  }
});

test('closing a session removes it and releases its host slot', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    assert.equal(backend.pool.liveSessionCount, 1);
    assert.equal(await backend.bridge.close(session.sessionId), true);
    assert.equal(backend.bridge.sessions.length, 0);
    assert.equal(backend.pool.liveSessionCount, 0);
    assert.equal(await backend.bridge.close(session.sessionId), false, 'closing twice must be a no-op, not a throw');
    assert.deepEqual(backend.eventsOf('session-closed'), [{ sessionId: session.sessionId }]);
  } finally {
    await backend.shutdown();
  }
});

test('writes to an exited session are refused', opts, async () => {
  const backend = await createFakeBackend();
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 30, rows: 6 });
    await backend.bridge.type(session.sessionId, 'exit\r');
    await until(() => backend.bridge.sessions.find(s => s.sessionId === session.sessionId)?.state === 'exited', {
      timeoutMs: 10000, label: 'the session to report exited',
    });
    await assert.rejects(
      () => backend.bridge.type(session.sessionId, 'echo x\r'),
      error => error.kind === 'session-not-running',
    );
  } finally {
    await backend.shutdown();
  }
});

test('a parented session carries its parent link into the listing', opts, async () => {
  const backend = await createFakeBackend({});
  try {
    const parent = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const child = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10, parentSessionId: parent.sessionId });

    assert.equal(child.parent, parent.sessionId, 'the child names its parent by bridge id, not a runtime id');

    const listed = await backend.bridge.list();
    const byId = new Map(listed.map(entry => [entry.sessionId, entry]));
    assert.equal(byId.get(parent.sessionId).parent, null, 'a root has no parent');
    assert.equal(byId.get(child.sessionId).parent, parent.sessionId);

    // The UI-facing listing must never carry a capability. (assertNoOwner is not used here: the
    // bridge does not expose runtimeSessionId, so there is no non-empty token to search for --
    // passing an empty needle would always "leak".)
    assert.doesNotMatch(JSON.stringify(listed), /"owner"|"mailbox"/);
  } finally {
    await backend.shutdown();
  }
});

test('an unknown parentSessionId is refused before anything is spawned', opts, async () => {
  const backend = await createFakeBackend({});
  try {
    await assert.rejects(
      backend.bridge.create({ command: 'fake', cols: 40, rows: 10, parentSessionId: 'no-such-session' }),
      error => error.kind === 'unknown-session',
    );
    assert.deepEqual(await backend.bridge.list(), [], 'a refused create must leave no session behind');
  } finally {
    await backend.shutdown();
  }
});

test('the bridge posts and drains messages on behalf of the UI', opts, async () => {
  const backend = await createFakeBackend({});
  try {
    const session = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });

    const posted = await backend.bridge.post(session.sessionId, { kind: 'task', text: 'run it' });
    assert.equal(posted.sequence, 1);

    const frame = await backend.bridge.mailbox(session.sessionId, { afterSequence: 0, timeoutMs: 200 });
    assert.deepEqual(frame.messages.map(message => message.payload.text), ['run it']);
    assert.equal(frame.nextSequence, 1);

    // Nothing UI-facing carries an owner or mailbox token.
    assertNoOwner(assert, posted, 'owner-');
    assert.doesNotMatch(JSON.stringify({ posted, frame }), /"owner"|"capability"/);
  } finally {
    await backend.shutdown();
  }
});

test('posting from a session uses the pair edge, so the runtime can attribute direction', opts, async () => {
  const backend = await createFakeBackend({});
  try {
    const parent = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const child = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10, parentSessionId: parent.sessionId });

    // As the parent: the child's inbox must say who sent it.
    await backend.bridge.post(child.sessionId, { text: 'task' }, { from: parent.sessionId });
    const inbox = await backend.bridge.mailbox(child.sessionId, { afterSequence: 0, timeoutMs: 100 });
    assert.deepEqual(inbox.messages.map(message => message.payload.text), ['task']);
    // Delivery proves the bridge used the pair's edge capability. Attribution itself is asserted
    // against the real runtime in PE-15: the fake does not model senders.
    assert.equal(inbox.messages.length, 1, 'the post used the edge capability and was delivered');

    // An edge that does not exist must be refused, not silently posted as the host.
    const stranger = await backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    await assert.rejects(
      backend.bridge.post(child.sessionId, { text: 'sibling' }, { from: stranger.sessionId }),
      error => error.kind === 'no-edge',
    );
    const after = await backend.bridge.mailbox(child.sessionId, { afterSequence: 0, timeoutMs: 100 });
    assert.equal(after.messages.length, 1, 'the refused post must not have been delivered');
  } finally {
    await backend.shutdown();
  }
});
