// Read-only live stream and recording, driven against the real runtime (issue #27).
//
// Everything here runs src/server.js in a subprocess over its production stdio
// transport and spawns real PTY sessions, so the bytes under test have been through
// ConPTY or a Unix pty rather than a stub. The unit-level ring and replay invariants
// are in test/recording.test.js; this file covers what only the real runtime can
// show: that a watcher converges with observe(), that colour survives a path
// observe() cannot carry, that a watcher cannot type, and that a recording of a real
// session replays to the screen the session actually ended on.
//
// The three acceptance criteria from the issue map to STR-01 (two watchers see the
// same final screen as observe), STR-07/STR-08 (a slow watcher neither slows the
// program nor grows memory without limit) and STR-06 (a recording played back ends
// in the same screen).
import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import { startRuntime } from './helpers/runtime.mjs';
import { replayRecording, SESSION_SCROLLBACK } from '../src/recording.js';
import { FIXTURE } from './helpers/native.mjs';

const { Terminal } = xterm;
const opts = { timeout: 180000 };
const spawnFixture = extra => ({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 20, ...extra });

// terminal.type requires the revision the caller last observed, and any output
// landing between the observation and the write makes that write stale -- so retry,
// exactly as a real agent and the desktop bridge both do (and as `armed()` in
// test/windows-server.test.js already did).
//
// Not retrying is a race rather than a simplification, and a platform-dependent one:
// this passed on Windows, where ConPTY batches output into fewer larger chunks and
// the window between observe and type is narrow, and failed on every Linux and macOS
// cell in CI with `Stale observation`, where a pty delivers the same output in more,
// smaller chunks. The tests that happened to pass there were latently racy too.
async function type(server, sessionId, owner, text) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { result: obs } = await server.call('terminal.observe', { sessionId });
    const { response } = await server.request('terminal.type', { sessionId, owner, revision: obs.revision, text });
    if (response.result !== undefined) return response.result;
    if (!/Stale observation/.test(response.error?.message ?? '')) {
      throw new Error(`terminal.type failed: ${JSON.stringify(response.error)}`);
    }
  }
  throw new Error('terminal.type kept hitting stale observations');
}

async function sendCommand(server, sessionId, owner, command) {
  return type(server, sessionId, owner, `${command}\r`);
}

// Polls the way a real consumer does: keep the cursor it was handed, ask again, stop
// when the marker has been seen or when a poll comes back empty.
async function drain(server, sessionId, { from = 0, marker, timeout = 30000 } = {}) {
  const events = [];
  let cursor = from;
  let resync = false;
  let snapshot = null;
  let polls = 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    const { result } = await server.call('terminal.stream', { sessionId, afterSequence: cursor, timeoutMs: 250 });
    polls += 1;
    resync = resync || result.resync;
    if (result.snapshot) snapshot = result.snapshot;
    events.push(...result.events);
    cursor = result.nextSequence;
    const text = outputText(events);
    if (marker) {
      if (text.includes(marker)) break;
    } else if (polls > 1 && result.events.length === 0) {
      // The first response is the attach handshake: a snapshot and, by design, no
      // events. Ending the drain there would return nothing at all and let every
      // assertion about `events` pass vacuously, so only a *subsequent* empty poll
      // means the stream has been drained.
      break;
    }
    if (Date.now() > deadline) throw new Error(`drain timed out after ${events.length} events; text so far:\n${text.slice(-500)}`);
  }
  return { events, cursor, resync, snapshot, polls };
}

const outputText = events => Buffer.concat(
  events.filter(e => e.kind === 'output').map(e => Buffer.from(e.data, 'base64')),
).toString('latin1');

// Replays recorded bytes through a real emulator built with the same options
// src/server.js uses, so the comparison against observe() is like for like.
async function replayBytes(buffer, cols, rows) {
  const terminal = new Terminal({ cols, rows, scrollback: SESSION_SCROLLBACK, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(buffer, resolve));
    const b = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '').join('\n');
  } finally {
    terminal.dispose();
  }
}

// Replays a watcher's view: the snapshot it attached with, plus the bytes it
// received afterwards. This is the path a real consumer takes, and exercising it
// through the shipped replayRecording means the test cannot pass on a replay
// implementation that only works for the cases this file happens to construct.
async function replayFromSnapshot(snapshot, events, cols, rows) {
  return replayRecording({
    events: [
      {
        seq: 0, kind: 'snapshot', screen: snapshot.screen,
        cols: snapshot.cols, rows: snapshot.rows, cursor: snapshot.cursor,
      },
      ...events,
    ],
    cols, rows, Terminal,
  });
}

test('STR-01 two watchers attaching at different times converge on the screen observe reports', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');

    // B attaches first, A attaches after two of the three commands. Both then receive
    // only what follows their own attach point, so they converge on the same final
    // screen by different routes -- B replaying more history, A less. If
    // `afterSequence` were ignored, or if an attach replayed the whole ring instead of
    // snapshotting, the divergent content assertions below would fail. The first
    // version of this test attached both watchers at 0 against an already-quiesced
    // session, so a server that ignored the cursor entirely would have passed it.
    const { result: attachB } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 200 });
    assert.ok(attachB.snapshot, 'attaching must yield a snapshot');
    assert.deepEqual(attachB.events, [], 'a snapshot response carries no events, so the two views cannot overlap');
    const cursorB = attachB.nextSequence;
    assert.ok(cursorB > 0, 'the fixture banner must already have been recorded');

    await sendCommand(server, sessionId, owner, 'echo one');
    await sendCommand(server, sessionId, owner, 'echo two');
    await server.waitScreen(sessionId, 'ECHO:two');

    const { result: attachA } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 200 });
    const cursorA = attachA.nextSequence;
    assert.ok(cursorA > cursorB, 'a later attach resumes from a later cursor');
    assert.match(attachA.snapshot.screen, /ECHO:two/, 'the later snapshot already contains the earlier output');

    await sendCommand(server, sessionId, owner, 'echo three');
    await server.waitScreen(sessionId, 'ECHO:three');

    const watcherB = await drain(server, sessionId, { from: cursorB, marker: 'ECHO:three' });
    const watcherA = await drain(server, sessionId, { from: cursorA, marker: 'ECHO:three' });
    const { result: observed } = await server.call('terminal.observe', { sessionId });

    // Different cursors must produce different event sets, or the cursor is decoration.
    const textA = outputText(watcherA.events);
    const textB = outputText(watcherB.events);
    assert.ok(textB.includes('ECHO:one'), 'B attached before the first command, so it sees it');
    assert.ok(!textA.includes('ECHO:one'), 'A attached after it, so it must not re-receive it');
    assert.ok(textA.includes('ECHO:three') && textB.includes('ECHO:three'), 'both see what followed their attach');
    for (const text of [textA, textB]) {
      assert.ok(!text.includes('FIXTURE READY'), 'neither re-receives output from before the ring or its attach');
    }
    assert.ok(watcherB.events.length > watcherA.events.length, 'B saw strictly more events than A');

    // And both routes land on the screen the runtime itself reports.
    const viaB = await replayFromSnapshot(attachB.snapshot, watcherB.events, observed.cols, observed.rows);
    const viaA = await replayFromSnapshot(attachA.snapshot, watcherA.events, observed.cols, observed.rows);
    assert.equal(viaB.screen, observed.screen, 'watcher B: early snapshot plus more bytes');
    assert.equal(viaA.screen, observed.screen, 'watcher A: later snapshot plus fewer bytes');

    // Sequences ascend without repeats, which is what makes "you missed some"
    // detectable at all.
    const seqs = watcherB.events.map(e => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence numbers must ascend');
    assert.equal(new Set(seqs).size, seqs.length, 'sequence numbers must not repeat');
  } finally {
    await server.stop();
  }
});

test('STR-02 the stream carries colour that observe cannot', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');
    // Attach BEFORE the coloured output. The stream is live-from-attach: a consumer
    // that attaches afterwards gets the current screen as a snapshot and no
    // historical bytes, because the snapshot already accounts for them and returning
    // both would make it apply that output twice. Recovering full history is
    // terminal.recording's job, not the stream's.
    const { result: attach } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 200 });
    await sendCommand(server, sessionId, owner, 'ansi');
    await server.waitScreen(sessionId, 'ANSI-DONE');

    const { events } = await drain(server, sessionId, { from: attach.nextSequence, marker: 'ANSI-DONE' });
    const raw = outputText(events);
    // The escape bytes are present in the stream: colour is preserved because the
    // original chunk is carried, not a rendering of it.
    assert.ok(raw.includes('\x1b[31m'), `the stream must carry the ANSI colour sequence, got:\n${JSON.stringify(raw.slice(-200))}`);

    // observe() still does not, and must not: an existing test pins that no escape
    // byte leaks into screen text. The two views differ on purpose.
    const { result: observed } = await server.call('terminal.observe', { sessionId });
    assert.ok(!observed.screen.includes('\x1b'), 'observe().screen must stay free of raw escapes');
    assert.match(observed.screen, /RGBN/);
  } finally {
    await server.stop();
  }
});

test('STR-03 a watcher gets no owner token and cannot type', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');
    await sendCommand(server, sessionId, owner, 'echo marker');
    await server.waitScreen(sessionId, 'ECHO:marker');

    const { result: streamed } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 200 });
    // The token is a capability, so the check is on the serialised payload rather
    // than on a list of expected fields: any path that leaked it would be caught.
    assert.ok(!JSON.stringify(streamed).includes(owner), 'the stream response must not contain the owner token');
    assert.equal(streamed.snapshot.owner, undefined, 'the embedded snapshot must not carry it either');

    const { result: listed } = await server.call('terminal.list', {});
    assert.ok(!JSON.stringify(listed).includes(owner), 'terminal.list must not contain the owner token');

    // Read-only in both directions: no token means no input, and no recording.
    const typed = await server.request('terminal.type', { sessionId, owner: 'not-the-owner', revision: streamed.revision, text: 'echo pwned\r' });
    assert.match(typed.response.error?.message ?? '', /ownership/i);
    const recorded = await server.request('terminal.recording', { sessionId });
    assert.match(recorded.response.error?.message ?? '', /Ownership required/);
    const recordedWrong = await server.request('terminal.recording', { sessionId, owner: 'not-the-owner' });
    assert.match(recordedWrong.response.error?.message ?? '', /Ownership required/);

    // The refused keystroke must not have reached the child.
    const { result: after } = await server.call('terminal.observe', { sessionId });
    assert.ok(!after.screen.includes('pwned'), 'a rejected write must not reach the child');
  } finally {
    await server.stop();
  }
});

test('STR-04 input is not recorded by default and the record says so', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');
    // A credential-shaped string, so the assertion is about the secret and not
    // merely about some text that might coincidentally be absent.
    await sendCommand(server, sessionId, owner, 'echo hunter2-secret');
    await server.waitScreen(sessionId, 'ECHO:hunter2-secret');

    const { result: recording } = await server.call('terminal.recording', { sessionId, owner });
    assert.equal(recording.inputRecorded, false, 'the record must state that input was not captured');
    assert.deepEqual(recording.events.filter(e => e.kind === 'input'), [], 'no keystrokes may be retained');
    // The child's own echo of the secret is output and is retained; that is the
    // child's doing, not input recording, and is why the issue scopes the guarantee
    // to what was typed.
    assert.ok(recording.events.some(e => e.kind === 'output'));
  } finally {
    await server.stop();
  }
});

test('STR-05 opt-in input recording keeps keystrokes out of the watcher stream', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture({ recordInput: true }));
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');
    // Attach before typing, for the same reason as STR-02: the stream is
    // live-from-attach. It also makes the test stronger -- the keystroke is typed
    // while a watcher cursor is already open, so the filter is exercised on the path
    // a real watcher is actually on rather than on a history read.
    const { result: attach } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 200 });
    // A credential-shaped string, so the assertion is about the secret and not merely
    // about some text that might coincidentally be absent.
    await sendCommand(server, sessionId, owner, 'echo top-secret-value');
    await server.waitScreen(sessionId, 'ECHO:top-secret-value');

    const { result: recording } = await server.call('terminal.recording', { sessionId, owner });
    assert.equal(recording.inputRecorded, true);
    const inputs = recording.events.filter(e => e.kind === 'input');
    assert.ok(inputs.length >= 1, 'keystrokes must be retained when asked for');
    const typed = Buffer.concat(inputs.map(e => Buffer.from(e.data, 'base64'))).toString('utf8');
    assert.ok(typed.includes('top-secret-value'), 'the recording must contain what was typed');

    // The watcher view is filtered at the source, so no cursor and no argument
    // reaches the keystrokes -- including ones recorded before it attached.
    const { events } = await drain(server, sessionId, { from: attach.nextSequence, marker: 'ECHO:top-secret-value' });
    assert.deepEqual(events.filter(e => e.kind === 'input'), [], 'a stream must never carry input events');
    const streamedText = outputText(events);
    // The child echoes the secret back, so the assertion is on the event kind and on
    // the typed framing, not on the bare word appearing nowhere.
    assert.ok(!streamedText.includes('echo top-secret-value\r'), 'the keystroke itself must not be in the stream');
  } finally {
    await server.stop();
  }
});

test('STR-06 a recording of a real session replays to the screen it ended on', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');
    for (const command of ['echo first', 'ansi', 'echo last']) {
      await sendCommand(server, sessionId, owner, command);
    }
    await server.waitScreen(sessionId, 'ECHO:last');

    const { result: recording } = await server.call('terminal.recording', { sessionId, owner });
    const { result: observed } = await server.call('terminal.observe', { sessionId });

    assert.equal(recording.truncated, false, 'this session is well inside the default cap');
    const bytes = Buffer.concat(recording.events
      .filter(e => e.kind === 'output')
      .map(e => Buffer.from(e.data, 'base64')));
    const replayed = await replayBytes(bytes, recording.initialCols, recording.initialRows);
    assert.equal(replayed, observed.screen, 'replaying the recording must end on the live screen');

    // And the way a real consumer does it: the WHOLE event list through the shipped
    // replayer, including the snapshot the ring is seeded with at construction and any
    // resize. Filtering to `output` alone, as above, would skip the seed snapshot and
    // so would not test what a consumer actually receives.
    const full = await replayRecording({
      events: recording.events,
      cols: recording.initialCols,
      rows: recording.initialRows,
      Terminal,
    });
    assert.equal(full.screen, observed.screen, 'replaying every recorded event must end on the live screen');
    assert.equal(recording.events[0].kind, 'snapshot', 'the ring is seeded so an attach cannot spin on an empty ring');
  } finally {
    await server.stop();
  }
});

test('STR-07 a small cap truncates, stays bounded, and tells a stale watcher to resync', opts, async () => {
  const server = startRuntime();
  try {
    // 4 KiB is far below one screenful of flood output, so truncation is certain
    // rather than merely possible -- a test that depends on crossing a 1 MiB default
    // would either be slow or flaky.
    const created = await server.create(spawnFixture({ recordBytes: 4096 }));
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');

    // Grab a cursor near the start, then flood past it.
    const { result: early } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 200 });
    assert.ok(early.snapshot, 'a first poll must carry a snapshot');
    const staleCursor = early.nextSequence;

    // Two ~3 KB payloads against a 4 KiB ring, using the fixture's `bytes` command.
    // The first version of this test sent forty `echo` commands instead and never
    // crossed the cap: a few dozen bytes of echo each is well under 4 KiB even forty
    // times over, so `truncated` stayed false and every assertion below it was
    // testing nothing. Truncation has to be certain here, not merely plausible.
    const filler = '41'.repeat(3000);
    await sendCommand(server, sessionId, owner, `bytes ${filler}`);
    await server.waitScreen(sessionId, 'BYTES-DONE');
    await sendCommand(server, sessionId, owner, `bytes ${filler}`);
    await server.waitScreen(sessionId, 'BYTES-DONE');

    const { result: recording } = await server.call('terminal.recording', { sessionId, owner });
    assert.equal(recording.truncated, true, 'the cap must have been hit');
    // No slack here. The re-anchoring snapshot a 60x20 screen produces is ~1.3 KB,
    // well inside a 4 KiB cap, so the bound is the cap exactly. The "cap plus one
    // viewport" case only bites when the cap is smaller than a viewport, and REC-20
    // covers that; padding this assertion to hide it would hide it here too.
    assert.ok(recording.bytes <= 4096, `retained ${recording.bytes} bytes against a 4096 cap`);
    assert.ok(recording.droppedEvents > 0, 'what was dropped must be reported, not silent');

    // The stale watcher is told it missed data and handed a current screen, rather
    // than being given a partial history that looks complete.
    //
    // Quiesced first, and this is load-bearing rather than tidiness: the flood above
    // types a 6000-character command line, whose ConPTY echo is still arriving when
    // the last BYTES-DONE lands. Comparing a stream snapshot against a separate
    // observe() while output is in flight asserts on the scheduler, not on the
    // resync, and fails intermittently on a busy runner. A final marker that nothing
    // follows makes the two reads comparable.
    await sendCommand(server, sessionId, owner, 'echo SETTLED');
    await server.waitScreen(sessionId, 'ECHO:SETTLED');

    const { result: late } = await server.call('terminal.stream', { sessionId, afterSequence: staleCursor, timeoutMs: 200 });
    assert.equal(late.resync, true, 'a cursor behind the ring must be reported as stale');
    assert.ok(late.snapshot, 'a resync must carry a fresh snapshot');
    const { result: observed } = await server.call('terminal.observe', { sessionId });
    assert.equal(late.snapshot.screen, observed.screen, 'the resync snapshot is the current screen');
    assert.ok(late.nextSequence >= staleCursor, 'the cursor must move forward so the watcher cannot spin');
    // The snapshot is a real observation, not a placeholder: it carries the marker
    // that was on screen, and the sequence it hands back is the ring's latest.
    assert.match(late.snapshot.screen, /ECHO:SETTLED/);
    assert.equal(late.nextSequence, late.latestSequence, 'a resync resumes the watcher at the end of the ring');
  } finally {
    await server.stop();
  }
});

test('STR-08 a watcher that never polls does not stall the session or grow the record', opts, async () => {
  const server = startRuntime();
  try {
    // Cap comfortably above what 30 commands produce, so nothing truncates and the
    // assertions below are about the producer rather than about the ring's bounds.
    // Bounding under pressure is STR-07's job; conflating the two is what made the
    // previous version of this test assert something it could not guarantee.
    const created = await server.create(spawnFixture({ recordBytes: 65536 }));
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');

    // Nobody ever calls terminal.stream. The producer must not notice: this is the
    // half of "a slow watcher does not slow the program" that a polling design has
    // to prove, because there is no back-pressure to hide behind.
    for (let i = 0; i < 30; i += 1) await sendCommand(server, sessionId, owner, `echo unwatched-${i}`);
    await server.waitScreen(sessionId, 'ECHO:unwatched-29');

    const { result: recording } = await server.call('terminal.recording', { sessionId, owner });
    assert.equal(recording.droppedEvents, 0, 'this cap must not truncate, or the assertions below are not about the producer');
    const retained = Buffer.concat(
      recording.events.filter(e => e.kind === 'output').map(e => Buffer.from(e.data, 'base64')),
    ).toString('latin1');
    // Output-dependent, which the assertion this replaces was not. `revision >= 30`
    // is guaranteed by the 30 accepted terminal.type calls alone -- input() bumps the
    // revision itself -- so it passed even if every byte of output had been dropped:
    // the same tautology class as the waitScreen assertion before it. Both ends of the
    // run must be in the record, so a producer that shed output cannot pass.
    //
    // The "does not STALL" half is carried by waitScreen above exceeding its own
    // budget and throwing. There is deliberately no wall-clock threshold here: on a
    // shared runner that is a guess about machine load, which is how WIN-02 became a
    // flake (#30).
    assert.ok(retained.includes('ECHO:unwatched-0'), 'the first unwatched command must be in the record');
    assert.ok(retained.includes('ECHO:unwatched-29'), 'and so must the last');
    assert.ok(recording.bytes <= 65536, `an unwatched session must stay bounded, retained ${recording.bytes}`);
  } finally {
    await server.stop();
  }
});

test('STR-09 streaming an exited session reports the exit and does not hang', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');
    // Attach BEFORE the exit. An attach returns a snapshot and a cursor at the end of
    // the ring, so attaching afterwards can hand back a cursor already past the exit
    // event, and the loop below would then wait out its whole deadline for an event
    // that will never be re-delivered -- reporting "must settle, not block" and
    // misdiagnosing a test bug as a product hang. Whether it fires depends on the
    // child exiting and being recorded before the first stream call lands, so it is
    // exactly the platform-dependent race this file was fixed for elsewhere.
    const { result: attach } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 200 });
    await sendCommand(server, sessionId, owner, 'exit 3');

    // waitScreen cannot help here: the child is going away. Poll the stream, which
    // is the thing under test, and let its own timeout bound the wait.
    //
    // With an ADVANCING cursor, as a consumer does. A snapshot response carries no
    // events by design, so breaking out on `running === false` at that point would
    // assert on an empty event list and report that the exit was never recorded when
    // it simply had not been asked for yet.
    const deadline = Date.now() + 20000;
    let cursor = attach.nextSequence;
    let exit = null;
    let last = null;
    for (;;) {
      const { result } = await server.call('terminal.stream', { sessionId, afterSequence: cursor, timeoutMs: 500 });
      last = result;
      cursor = result.nextSequence;
      exit = result.events.find(e => e.kind === 'exit') ?? exit;
      if (exit) break;
      assert.ok(Date.now() < deadline, 'streaming an exited session must settle, not block');
    }
    assert.equal(last.running, false, 'the session must be reported as no longer running');
    assert.equal(exit.exit?.exitCode ?? exit.exit?.exit, 3, 'the exit code must survive into the record');

    // Polling a dead session again must return immediately rather than waiting out
    // the timeout, or every consumer would pay the full poll interval on teardown.
    const started = Date.now();
    const { result: after } = await server.call('terminal.stream', { sessionId, afterSequence: cursor, timeoutMs: 5000 });
    assert.ok(Date.now() - started < 2000, 'a stream poll on an exited session must not block for its full timeout');
    assert.deepEqual(after.events, [], 'and there is nothing further to deliver');
  } finally {
    await server.stop();
  }
});

test('STR-10 stream and recording reject bad arguments and unknown sessions', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');

    const bad = [
      ['terminal.stream', { sessionId, afterSequence: -1 }],
      ['terminal.stream', { sessionId, afterSequence: 1.5 }],
      ['terminal.stream', { sessionId, afterSequence: 0, timeoutMs: -5 }],
      ['terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 'soon' }],
      ['terminal.stream', { sessionId: 'no-such-session', afterSequence: 0 }],
      ['terminal.recording', { sessionId: 'no-such-session', owner }],
    ];
    for (const [method, params] of bad) {
      const { response } = await server.request(method, params);
      assert.ok(response.error, `${method} ${JSON.stringify(params)} must be rejected`);
      assert.match(response.error.message, /Invalid sequence|Invalid stream|Unknown session/);
    }

    // create-time validation, so a bad cap is refused before anything is spawned
    // rather than after a session is consuming memory.
    for (const recordBytes of [0, -1, 1.5, 'lots', 1024 ** 3]) {
      const { response } = await server.request('terminal.create', spawnFixture({ recordBytes }));
      assert.ok(response.error, `recordBytes ${JSON.stringify(recordBytes)} must be rejected`);
      assert.match(response.error.message, /Invalid recordBytes/);
    }
    const { response: badInput } = await server.request('terminal.create', spawnFixture({ recordInput: 'yes' }));
    assert.match(badInput.error?.message ?? '', /Invalid recordInput/);
  } finally {
    await server.stop();
  }
});

test('STR-11 a rejected create leaves nothing registered and nothing recorded', opts, async () => {
  const server = startRuntime();
  try {
    const { response } = await server.request('terminal.create', spawnFixture({ recordBytes: 10 }));
    assert.match(response.error?.message ?? '', /Invalid recordBytes/);
    assert.deepEqual(await server.list(), [], 'a refused create must not consume a slot');
  } finally {
    await server.stop();
  }
});
