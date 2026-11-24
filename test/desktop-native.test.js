// Real-runtime tests for the desktop session bridge.
//
// Everything here drives src/server.js over stdio through the same bridge the UI
// uses, against real child processes on a real PTY (ConPTY on Windows, forkpty on
// Linux, posix_openpt on macOS). The mocked bridge suite in
// test/desktop-bridge.test.js pins down the bridge's logic; this file proves that
// logic holds against the runtime rather than against a stand-in. Neither replaces
// the existing native suites.
//
// Covers, from issue #7's test plan: U01 (launch a real shell and run a command),
// U02 in part (Unicode, ANSI and alternate screen through the snapshot pipeline),
// U03 (independent per-pane resize), U04 (reconnect to a live session, ordered
// output) and U11 (burst output, no lost bytes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealBackend, allStrings, drainUntilQuiet } from './helpers/desktop.mjs';
import { FIXTURE, rawHex } from './helpers/native.mjs';
import { detectShells, defaultShell } from '../apps/desktop/bridge/shell-catalog.js';

const opts = { timeout: 120000 };

// Types a command and waits for the fixture's marker, which is the only reliable
// way to know the child answered: readiness is an observable condition, never a
// sleep.
async function ask(backend, sessionId, command, marker, { timeoutMs = 30000 } = {}) {
  await backend.bridge.type(sessionId, `${command}\r`);
  return backend.bridge.waitUntil(sessionId, observation => observation.screen.includes(marker), {
    timeoutMs, label: `${command} -> ${marker}`,
  });
}

// A shell echoes the command line back, so "the marker is on screen" is not proof
// the command ran -- the typed text alone would satisfy it. Requiring a line whose
// trimmed content *is* the marker distinguishes output from echo for cmd, bash and
// PowerShell alike, because the echoed line always carries the prompt or the
// command word in front of it.
const outputLineEquals = (screen, marker) => screen.split('\n').some(line => line.trim() === marker);

async function createFixture(backend, extraArgs = [], { cols = 90, rows = 25 } = {}) {
  const session = await backend.bridge.create({
    command: process.execPath, args: [FIXTURE, ...extraArgs], cols, rows, label: 'fixture',
  });
  await backend.bridge.waitUntil(session.sessionId, observation => observation.screen.includes('FIXTURE READY'), {
    timeoutMs: 30000, label: 'the fixture boot marker',
  });
  // Descriptors are snapshots, not live handles: re-read it so callers see the
  // state the session actually reached rather than the one it was created with.
  return backend.bridge.sessions.find(entry => entry.sessionId === session.sessionId);
}

// U01: the real deliverable -- a genuine login shell, discovered by the catalog
// the onboarding screen uses, running a genuine command.
test('U01 launches a real shell from the catalog and executes a command', opts, async () => {
  const shells = detectShells();
  const shell = defaultShell(shells);
  assert.ok(shell, `no shell was detected on ${process.platform}; detected: ${shells.map(s => s.id).join(', ')}`);

  const backend = await createRealBackend();
  try {
    const session = await backend.bridge.create({
      command: shell.command, args: shell.args, cols: 100, rows: 30, label: shell.label, shell,
    });
    assert.ok(Number.isInteger(session.revision));
    assert.equal(session.shellId, shell.id);

    // The shell has to be observed running before anything is sent to it.
    await backend.bridge.waitUntil(session.sessionId, observation => observation.state === 'operational', {
      timeoutMs: 45000, label: 'the shell to render output',
    });

    const marker = `SENTIORA-U01-${process.pid}`;
    const probe = shell.probe.command.replace('SENTIORA-PROBE-OK', marker);
    await backend.bridge.type(session.sessionId, probe);
    const observed = await backend.bridge.waitUntil(
      session.sessionId, observation => outputLineEquals(observation.screen, marker),
      { timeoutMs: 45000, label: `${shell.label} to print ${marker} as output rather than merely echo it` },
    );
    assert.ok(
      outputLineEquals(observed.screen, marker),
      `${shell.label} never printed the probe as output; screen:\n${observed.screen}`,
    );
    assert.equal(observed.running, true);
    assert.ok(observed.pid > 0, 'the real child pid must be exposed so identity can be verified independently');

    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

test('U01 the bridge drives the deterministic fixture end to end', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend);
    assert.equal(session.state, 'operational');

    const echoed = await ask(backend, session.sessionId, 'echo BRIDGE-OK', 'ECHO:BRIDGE-OK');
    assert.match(echoed.screen, /ECHO:BRIDGE-OK/);

    const pidLine = await ask(backend, session.sessionId, 'pid', 'PID:');
    const reported = Number(/PID:(\d+)/.exec(pidLine.screen)[1]);
    assert.ok(reported > 0);

    const exited = await (async () => {
      await backend.bridge.type(session.sessionId, 'exit 9\r');
      return backend.bridge.waitUntil(session.sessionId, observation => observation.state === 'exited', {
        timeoutMs: 30000, label: 'the child to exit',
      });
    })();
    assert.equal(exited.exit.exitCode, 9);
    assert.equal(exited.pid, reported, 'the pid must survive exit so a caller can verify identity');
    assert.equal(exited.running, false);

    assert.equal(await backend.bridge.close(session.sessionId), true);
    assert.equal(backend.bridge.sessions.length, 0);
  } finally {
    await backend.shutdown();
  }
});

// U02, in part. The runtime hands the bridge a *rendered viewport*, not bytes, so
// what has to survive is the visible result: Unicode glyphs, the layout an ANSI
// sequence produced, and the alternate screen's contents. Colour cannot survive a
// translateToString() snapshot and is recorded as a limitation, not tested as if
// it did.
test('U02 Unicode, ANSI layout and the alternate screen survive the snapshot pipeline', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend);

    const unicode = await ask(backend, session.sessionId, 'unicode', 'UNICODE-DONE');
    for (const expected of ['cañón', 'Ñandú', 'ÄÖÜß', 'Съешь ещё этих булок', '汉字终端测试']) {
      assert.ok(unicode.screen.includes(expected), `unicode lost through the bridge: ${expected}\n${unicode.screen}`);
    }

    const ansi = await ask(backend, session.sessionId, 'ansi', 'ANSI-DONE');
    // The escape sequences must have been *applied*: the letters appear, the
    // sequences themselves do not.
    assert.match(ansi.screen, /RGBN/);
    assert.ok(!ansi.screen.includes('\x1b['), 'raw escape bytes must not leak into the snapshot');

    const alt = await ask(backend, session.sessionId, 'alt', 'ALT-SCREEN');
    assert.match(alt.screen, /┌─+┐/);
    assert.match(alt.screen, /│ ALT-SCREEN\s*│/);
    // The primary screen's content is not visible while the alternate buffer is
    // active, which is exactly what buffer.active reports.
    assert.ok(!alt.screen.includes('UNICODE-DONE'), 'the alternate screen must replace the primary one');

    const back = await ask(backend, session.sessionId, 'unalt', 'ALT-SCREEN-EXITED');
    assert.match(back.screen, /UNICODE-DONE/, 'leaving the alternate screen must restore the primary one');

    const moved = await ask(backend, session.sessionId, 'cursor 5 9', 'CURSOR-1');
    assert.ok(moved.cursor.y >= 0 && moved.cursor.x >= 0);

    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

// U03: two panes, resized independently, each child confirming its own geometry.
test('U03 panes resize independently and each child sees its own size', opts, async () => {
  const backend = await createRealBackend();
  try {
    const left = await createFixture(backend, [], { cols: 80, rows: 24 });
    const right = await createFixture(backend, [], { cols: 80, rows: 24 });
    assert.notEqual(left.sessionId, right.sessionId);

    const resizedLeft = await backend.bridge.resize(left.sessionId, 120, 40);
    assert.equal(resizedLeft.clamped, false);
    assert.equal(resizedLeft.cols, 120);
    assert.equal(resizedLeft.rows, 40);

    // The other pane must be untouched: independent resize is the whole point.
    const rightAfter = await backend.bridge.observe(right.sessionId);
    assert.equal(rightAfter.cols, 80, 'resizing one pane must not resize another');
    assert.equal(rightAfter.rows, 24);

    // terminal.resize returns before the child knows (~170ms measured), so the
    // child's own report is waited for rather than asserted immediately.
    const leftSize = await ask(backend, left.sessionId, 'size', 'SIZE:120x40', { timeoutMs: 30000 });
    assert.match(leftSize.screen, /SIZE:120x40/);

    const resizedRight = await backend.bridge.resize(right.sessionId, 40, 10);
    assert.equal(resizedRight.cols, 40);
    assert.equal(resizedRight.rows, 10);
    const rightSize = await ask(backend, right.sessionId, 'size', 'SIZE:40x10', { timeoutMs: 30000 });
    assert.match(rightSize.screen, /SIZE:40x10/);

    const leftStill = await backend.bridge.observe(left.sessionId);
    assert.equal(leftStill.cols, 120, 'the first pane must keep its size');
    assert.equal(leftStill.rows, 40);

    // Out-of-range values are clamped, never turned into 'Invalid dimensions'.
    const wild = await backend.bridge.resize(left.sessionId, 5000, 900);
    assert.equal(wild.clamped, true);
    assert.deepEqual(wild.applied, { cols: 300, rows: 150 });
    const tiny = await backend.bridge.resize(left.sessionId, 0, 1);
    assert.deepEqual(tiny.applied, { cols: 2, rows: 2 });

    await backend.bridge.close(left.sessionId);
    await backend.bridge.close(right.sessionId);
  } finally {
    await backend.shutdown();
  }
});

// U04: a second consumer attaches to a session that is already live and already
// has history. It must get a complete snapshot, and both consumers must see
// frames in the same order.
test('U04 a late consumer reconnects to a live session with complete ordered output', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend, [], { cols: 90, rows: 25 });
    const first = backend.bridge.attach(session.sessionId);

    for (let i = 0; i < 5; i += 1) {
      await ask(backend, session.sessionId, `echo BEFORE-${i}`, `ECHO:BEFORE-${i}`);
    }

    // The late consumer starts from a snapshot, never from a partial screen.
    const late = backend.bridge.attach(session.sessionId);
    assert.equal(late.snapshot.resync, true);
    assert.equal(late.snapshot.lines.length, 25, 'the snapshot must cover the whole viewport');
    assert.equal(late.snapshot.cols, 90);
    assert.match(late.snapshot.lines.join('\n'), /BEFORE-4/, 'the snapshot must show the current screen');
    assert.ok(
      late.snapshot.revision > first.snapshot.revision,
      'the late snapshot must reflect everything that happened since the first attach',
    );
    assert.equal(late.snapshot.describe.sessionId, session.sessionId);
    assert.equal(late.snapshot.backendLost, null);

    for (let i = 0; i < 4; i += 1) {
      await ask(backend, session.sessionId, `echo AFTER-${i}`, `ECHO:AFTER-${i}`);
    }

    // Both consumers drain to quiescence. Stopping each at a fixed frame count
    // instead would compare two different points in the stream and prove nothing
    // about convergence.
    const [firstFrames, lateFrames] = await Promise.all([
      drainUntilQuiet(first, { quietMs: 1200, hardMs: 25000 }),
      drainUntilQuiet(late, { quietMs: 1200, hardMs: 25000 }),
    ]);

    for (const [name, frames] of [['first', firstFrames], ['late', lateFrames]]) {
      assert.ok(frames.length > 0, `the ${name} consumer received no frames`);
      const revisions = frames.map(frame => frame.revision);
      for (let i = 1; i < revisions.length; i += 1) {
        assert.ok(revisions[i] > revisions[i - 1], `${name} consumer saw out-of-order revisions: ${revisions.join(', ')}`);
      }
      assert.equal(new Set(revisions).size, revisions.length, `${name} consumer received a revision twice`);
      assert.ok(frames.every(frame => Array.isArray(frame.lines) && frame.lines.length === 25));
    }

    // Both consumers must converge on the same screen, and that screen must be the
    // runtime's own: they are mirrors of one session, not two renderings of it.
    const settled = await backend.bridge.observe(session.sessionId);
    assert.deepEqual(firstFrames.at(-1).lines, lateFrames.at(-1).lines, 'the two consumers diverged');
    assert.deepEqual(firstFrames.at(-1).lines, settled.screen.split('\n'), 'the consumers diverged from the runtime');
    assert.match(settled.screen, /AFTER-3/);

    first.detach();
    late.detach();
    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

// U11. Two properties are asserted, and they are different properties:
//   * a burst that fits the viewport loses nothing at all;
//   * a burst far larger than the viewport cannot be reconstructed from rendered
//     snapshots -- the runtime never exposes the bytes -- so what is asserted is
//     that the bridge stays a faithful mirror of the runtime's own screen, that
//     frames stay ordered and de-duplicated, and that a slow consumer is bounded
//     rather than growing without limit.
test('U11 a burst that fits the viewport loses no output', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend, [], { cols: 60, rows: 30 });
    const subscription = backend.bridge.attach(session.sessionId);

    const lines = 20;
    const payload = Array.from({ length: lines }, (_, i) => `BURSTLINE-${String(i).padStart(3, '0')}`).join('\r\n');
    // One single write, deliberately: ConPTY may split or coalesce it, and the
    // bridge must not care.
    await backend.bridge.type(session.sessionId, `bytes ${Buffer.from(`${payload}\r\n`, 'utf8').toString('hex')}\r`);

    const settled = await backend.bridge.waitUntil(
      session.sessionId, observation => observation.screen.includes(`BURSTLINE-${String(lines - 1).padStart(3, '0')}`),
      { timeoutMs: 30000, label: 'the last burst line to be rendered' },
    );
    for (let i = 0; i < lines; i += 1) {
      const marker = `BURSTLINE-${String(i).padStart(3, '0')}`;
      assert.ok(settled.screen.includes(marker), `burst line ${marker} was lost; screen:\n${settled.screen}`);
    }
    subscription.detach();
    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

test('U11 recovered scrollback never invents, duplicates or reorders content', opts, async () => {
  // What a real console actually does, measured: ConPTY delivers output in batches
  // roughly a second apart, so between two observations the screen can jump by
  // several rows at once. Pure-shift recovery then has too little overlap to be
  // evidence and correctly declines to guess -- recovery on a real console is
  // therefore partial and sometimes nil. What must always hold is that nothing is
  // invented, nothing is recovered twice and nothing arrives out of order, so
  // those are asserted and the recovery rate is reported rather than required.
  const backend = await createRealBackend();
  try {
    const rows = 8;
    const total = 20;
    const session = await createFixture(backend, [], { cols: 60, rows });
    const subscription = backend.bridge.attach(session.sessionId);
    for (let i = 0; i < total; i += 1) {
      const marker = `LINE-${String(i).padStart(2, '0')}`;
      await ask(backend, session.sessionId, `echo ${marker}`, `ECHO:${marker}`, { timeoutMs: 45000 });
    }
    const frames = await drainUntilQuiet(subscription, { quietMs: 1000, hardMs: 25000, kind: 'frame' });
    subscription.detach();

    const recovered = frames.flatMap(frame => frame.scrolledOff ?? []);
    const indexes = recovered
      .map(line => Number(/ECHO:LINE-(\d+)/.exec(line)?.[1] ?? -1))
      .filter(index => index >= 0);

    // Nothing invented: the fixture only ever prints its boot line, ECHO:LINE-nn
    // for nn < total, or blanks. Anything else would have been fabricated by the
    // recovery heuristic.
    for (const line of recovered) {
      if (line.trim() === '' || line.startsWith('FIXTURE READY')) continue;
      assert.match(line, /^ECHO:LINE-\d{2}$/, `recovered a line the child never printed: ${JSON.stringify(line)}`);
    }
    for (const index of indexes) {
      assert.ok(index < total, `recovered an out-of-range line index ${index}`);
    }

    const distinct = new Set(indexes);
    assert.equal(distinct.size, indexes.length, `a line was recovered twice: ${indexes.join(', ')}`);
    for (let i = 1; i < indexes.length; i += 1) {
      assert.ok(indexes[i] > indexes[i - 1], `recovered scrollback left emission order: ${indexes.join(', ')}`);
    }
    console.log(`    U11 scrollback on a real console: ${total} lines through a ${rows}-row viewport, ${frames.length} frames, ${distinct.size} lines recovered (partial recovery is expected: ConPTY batches output, so the screen jumps several rows between observations)`);
    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

test('U11 a burst far larger than the viewport stays ordered, bounded and faithful', opts, async () => {
  const backend = await createRealBackend({ maxQueuedFrames: 2 });
  try {
    const rows = 20;
    const session = await createFixture(backend, [], { cols: 80, rows });
    const subscription = backend.bridge.attach(session.sessionId);

    // Sent as several writes rather than one so the output genuinely arrives over
    // time: a single write could be applied by the emulator in one pass, which
    // would not exercise coalescing at all.
    const batches = 8;
    const perBatch = 50;
    const total = batches * perBatch;
    for (let batch = 0; batch < batches; batch += 1) {
      const payload = Array.from(
        { length: perBatch },
        (_, i) => `FLOOD-${String(batch * perBatch + i).padStart(4, '0')}`,
      ).join('\r\n');
      await backend.bridge.type(session.sessionId, `bytes ${Buffer.from(`${payload}\r\n`, 'utf8').toString('hex')}\r`);
    }

    const last = `FLOOD-${String(total - 1).padStart(4, '0')}`;
    const settled = await backend.bridge.waitUntil(
      session.sessionId,
      observation => observation.screen.includes(last),
      { timeoutMs: 45000, label: 'the flood to finish rendering' },
    );

    // Drain until the stream goes quiet, so the last frame is the converged state.
    const frames = await drainUntilQuiet(subscription, { quietMs: 1000, hardMs: 20000 });
    assert.ok(frames.length > 0, 'the consumer must have received frames');
    assert.ok(frames.length < total, `a consumer this slow must not receive a frame per line: ${frames.length}`);
    // Bounded: with a queue of 2 and hundreds of revision bumps, the excess has to
    // have been coalesced rather than queued. This is the backpressure guarantee.
    assert.ok(subscription.coalesced > 0, 'frames must have been coalesced for a slow consumer');
    assert.ok(
      frames.some(frame => frame.resync === true),
      'a coalesced frame must tell the consumer to repaint fully',
    );

    const revisions = frames.map(frame => frame.revision);
    for (let i = 1; i < revisions.length; i += 1) {
      assert.ok(revisions[i] > revisions[i - 1], `frames arrived out of order: ${revisions.join(', ')}`);
    }
    assert.equal(new Set(revisions).size, revisions.length, 'no revision may be delivered twice');

    // Every frame is a whole viewport, which is what makes coalescing safe.
    for (const frame of frames) assert.equal(frame.lines.length, rows);

    // Faithful: once the stream has settled, what the consumer holds is
    // byte-identical to the runtime's own rendering of the same session.
    const fresh = await backend.bridge.observe(session.sessionId);
    assert.deepEqual(frames.at(-1).lines, fresh.screen.split('\n'), 'the settled frame must mirror the runtime exactly');
    assert.match(fresh.screen, new RegExp(last));
    assert.equal(settled.revision, fresh.revision, 'the session must have stopped changing');

    // Recorded limitation, measured rather than assumed. Recovery is a heuristic
    // over a lossy channel: lines that scroll through the viewport between two
    // observations cannot be recovered at all, and a real console echoing a long
    // command across many wrapped rows can make two different shifts match the
    // same transition, so the same line is occasionally recovered twice. What is
    // asserted here is the invariant that matters -- the bridge never invents
    // content -- and the rest is reported so the real numbers stay visible.
    const emitted = Array.from({ length: total }, (_, i) => `FLOOD-${String(i).padStart(4, '0')}`);
    const emittedSet = new Set(emitted);
    const recovered = frames.flatMap(frame => frame.scrolledOff ?? []);
    const recoveredMarkers = recovered.flatMap(line => emitted.filter(marker => line.includes(marker)));
    for (const marker of recoveredMarkers) {
      assert.ok(emittedSet.has(marker), `the bridge invented scrollback content: ${marker}`);
    }
    const distinct = new Set(recoveredMarkers);
    const stillVisible = emitted.filter(marker => fresh.screen.includes(marker));
    console.log(`    U11 flood: ${total} lines emitted, ${frames.length} frames delivered, ${subscription.coalesced} coalesced, ${distinct.size} distinct lines recovered, ${recoveredMarkers.length - distinct.size} duplicate recoveries, ${stillVisible.length} still on screen`);

    subscription.detach();
    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

test('the owner token stays inside the bridge against the real runtime', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend);
    const subscription = backend.bridge.attach(session.sessionId);
    await ask(backend, session.sessionId, 'echo OWNER-CHECK', 'ECHO:OWNER-CHECK');

    // terminal.create really did hand the bridge an owner token; prove that by
    // using it successfully, then prove it never appears in anything UI-facing.
    await backend.bridge.resize(session.sessionId, 70, 20);
    const observed = await backend.bridge.observe(session.sessionId);
    const frames = [];
    const deadline = Date.now() + 2000;
    while (frames.length < 2 && Date.now() < deadline) {
      const frame = await Promise.race([
        subscription.next(),
        new Promise(resolveRace => setTimeout(() => resolveRace(null), 300)),
      ]);
      if (frame === null) break;
      frames.push(frame);
    }
    subscription.detach();

    const uiFacing = {
      session, observed, frames,
      listed: backend.bridge.sessions,
      hosts: backend.bridge.hosts,
      runtime: backend.bridge.runtimeInfo,
    };
    // The runtime's owner is a UUID; assert that no UUID-shaped string that the
    // bridge was never supposed to expose shows up. The session id is a UUID too,
    // so compare against the exact set of strings rather than a pattern.
    const strings = new Set(allStrings(uiFacing));
    assert.ok(strings.has(session.sessionId), 'the bridge session id is expected to be present');
    // Any owner token would be a distinct UUID; the runtime's create response is
    // the only place one exists, and the bridge must not have copied it out.
    for (const value of strings) {
      if (value === session.sessionId) continue;
      assert.ok(
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
        `a UUID other than the bridge session id reached a UI-facing payload: ${value}`,
      );
    }
    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

// Ctrl+C in raw mode arrives as byte 0x03 and the child survives; sent before the
// child configured its console it terminates the process instead. The bridge gates
// it on an observed readiness condition, which is what this proves end to end.
test('a readiness-gated Ctrl+C reaches a raw-mode child without killing it', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend, ['--raw-echo']);
    const interrupt = await backend.bridge.interrupt(session.sessionId, { readyPattern: /FIXTURE READY/ });
    assert.equal(interrupt.delivered, true, interrupt.reason ?? 'Ctrl+C should be allowed once readiness is observed');

    // The raw-echo fixture reports received bytes as hex, and has a SIGINT handler,
    // so 0x03 must show up as data and the session must still be running.
    const observed = await backend.bridge.waitUntil(
      session.sessionId, observation => rawHex(observation).endsWith('03'),
      { timeoutMs: 30000, label: 'the child to receive byte 0x03' },
    );
    assert.match(rawHex(observed), /03$/);
    assert.equal(observed.running, true, 'Ctrl+C in raw mode must not kill the child');
    assert.equal(observed.state, 'operational');

    // And a readiness condition that is not on screen must refuse the interrupt.
    const refused = await backend.bridge.interrupt(session.sessionId, { readyPattern: /THIS-IS-NOT-ON-SCREEN/ });
    assert.equal(refused.delivered, false);
    assert.match(refused.reason, /readiness condition/);
    assert.equal((await backend.bridge.observe(session.sessionId)).running, true);

    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

test('stale observations are retried against the real runtime, not surfaced', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend);
    // Hammering a session that is streaming output is how 'Stale observation'
    // shows up in practice; the bridge must absorb it.
    for (let i = 0; i < 25; i += 1) {
      const result = await backend.bridge.type(session.sessionId, `echo RAPID-${i}\r`);
      assert.ok(Number.isInteger(result.revision));
    }
    const final = await backend.bridge.waitUntil(
      session.sessionId, observation => observation.screen.includes('RAPID-24'),
      { timeoutMs: 30000, label: 'the last rapid echo',
    });
    assert.match(final.screen, /RAPID-24/);
    assert.equal(final.writeErrors, 0, 'no input should have been lost');
    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});

test('lost input is reported rather than presented as delivered', opts, async () => {
  const backend = await createRealBackend();
  try {
    const session = await createFixture(backend);
    // Writing to a session whose child has exited is the reachable way to make the
    // pty write path fail; the bridge must not claim the keystroke landed.
    await backend.bridge.type(session.sessionId, 'exit 0\r');
    await backend.bridge.waitUntil(session.sessionId, observation => observation.state === 'exited', {
      timeoutMs: 30000, label: 'the child to exit',
    });
    await assert.rejects(
      () => backend.bridge.type(session.sessionId, 'echo too-late\r'),
      error => error.kind === 'session-not-running',
      'writing to an exited session must fail loudly',
    );
    await backend.bridge.close(session.sessionId);
  } finally {
    await backend.shutdown();
  }
});
