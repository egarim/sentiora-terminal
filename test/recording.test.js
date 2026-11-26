// Unit tests for the bounded recording ring and its replay (issue #27).
//
// These run without a PTY, so they execute identically on every platform -- which
// matters because the POSIX cells skip 28 ConPTY-specific tests and this is the
// layer where the stream's core invariants can be checked everywhere.
//
// The property the whole feature rests on is REC-10: after the ring truncates, a
// replay still ends at the same screen as an uninterrupted one. Truncation is the
// only place where "bounded memory" and "faithful playback" pull against each
// other, so it is tested rather than argued.
import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
import { Recording, replayRecording, RECORD_EVENT_OVERHEAD } from '../src/recording.js';

const { Terminal } = xterm;

// A real headless emulator, not a mock: replay's entire claim is that feeding the
// recorded bytes back through a terminal reproduces the screen, and asserting that
// against a stub would test the stub. scrollback 0 keeps the comparison to the
// visible viewport, which is what screen text can express.
function emulator(cols = 20, rows = 6) {
  const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  const screen = () => {
    const b = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '').join('\n');
  };
  return { terminal, write, screen };
}

const snapshotOf = emu => ({ screen: emu.screen(), cols: emu.terminal.cols, rows: emu.terminal.rows, cursor: { x: 0, y: 0 } });

test('REC-01 numbers events from 1 and returns them in insertion order', () => {
  const r = new Recording({ cols: 20, rows: 6 });
  r.recordOutput('a');
  r.recordOutput('b');
  r.recordResize(30, 8);
  r.recordExit({ exitCode: 0, signal: null });
  const { events } = r.eventsAfter(0, { includeInput: true });
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(events.map(e => e.kind), ['output', 'output', 'resize', 'exit']);
  assert.equal(r.oldestSequence, 1);
  assert.equal(r.latestSequence, 4);
  assert.ok(events.every(e => Number.isFinite(e.at)), 'every event carries a relative timestamp');
});

test('REC-02 carries raw bytes exactly, including bytes that are not valid UTF-8', () => {
  const r = new Recording();
  // The same class of payload WIN-15 throws at the RPC channel: an ANSI colour
  // sequence plus invalid UTF-8 and control bytes.
  const hostile = Buffer.concat([Buffer.from('\x1b[31mred\x1b[0m', 'utf8'), Buffer.from([0xff, 0xfe, 0x00, 0x1a])]);
  r.recordOutput(hostile);
  const { events } = r.eventsAfter(0);
  const decoded = Buffer.from(events[0].data, 'base64');
  assert.deepEqual(decoded, hostile);
  // Colour survives because the original bytes are kept. observe().screen cannot do
  // this: translateToString() drops every attribute, and an existing test pins that
  // no escape byte leaks into it.
  assert.ok(decoded.toString('latin1').includes('\x1b[31m'));
});

test('REC-03 does not record input unless asked, and reports that it did not', () => {
  const r = new Recording();
  assert.equal(r.recordInput('hunter2'), null, 'a refused keystroke must not be recorded');
  assert.deepEqual(r.eventsAfter(0, { includeInput: true }).events, []);
  // The distinction that matters for evidence: "nothing was typed" versus "typing
  // was not being recorded" must be tellable apart after the fact.
  assert.equal(r.toJSON().inputRecorded, false);
});

test('REC-04 keeps recorded input out of the watcher view', () => {
  const r = new Recording({ inputRecorded: true });
  r.recordInput('secret-passw0rd\r');
  r.recordOutput('ok');
  const owner = r.eventsAfter(0, { includeInput: true }).events;
  const watcher = r.eventsAfter(0, { includeInput: false }).events;
  assert.deepEqual(owner.map(e => e.kind), ['input', 'output']);
  assert.deepEqual(watcher.map(e => e.kind), ['output']);
  // Filtered at the source rather than by the caller, so there is no argument a
  // read-only consumer can pass that yields keystrokes.
  assert.ok(!JSON.stringify(watcher).includes('secret-passw0rd'));
  assert.equal(r.toJSON().inputRecorded, true);
});

test('REC-05 stays within its byte limit however much is written', () => {
  const limit = 4096;
  const r = new Recording({ limit });
  for (let i = 0; i < 500; i += 1) r.recordOutput('x'.repeat(200));
  assert.ok(r.bytes <= limit, `retained ${r.bytes} bytes against a ${limit} limit`);
  assert.equal(r.truncated, true);
  assert.ok(r.droppedEvents > 0, 'truncation must report what it dropped');
  assert.ok(r.droppedBytes > 0);
});

test('REC-06 replaces the dropped prefix with one snapshot from the provider', () => {
  let calls = 0;
  const r = new Recording({
    limit: 1024,
    snapshotProvider: () => { calls += 1; return { screen: 'SNAPSHOT', cols: 20, rows: 6, cursor: { x: 0, y: 0 } }; },
  });
  for (let i = 0; i < 50; i += 1) r.recordOutput('y'.repeat(100));
  const { events } = r.eventsAfter(0);
  assert.equal(events[0].kind, 'snapshot');
  assert.equal(events[0].screen, 'SNAPSHOT');
  assert.ok(calls >= 1, 'the provider must actually be consulted');
  assert.ok(events.slice(1).every(e => e.kind === 'output'), 'the boundary snapshot is the only non-output event');
});

test('REC-07 reports a cursor that fell behind the ring, and never calls 0 stale', () => {
  const emu = emulator();
  const r = new Recording({ limit: 512, snapshotProvider: () => snapshotOf(emu) });
  for (let i = 0; i < 40; i += 1) r.recordOutput('z'.repeat(100));
  emu.terminal.dispose();
  const oldest = r.oldestSequence;
  assert.ok(oldest > 2, 'the ring must have dropped enough for the boundary to be testable');
  assert.equal(r.missedEvents(0), false, 'a first-time reader is not stale');
  // The boundary is oldest-1, not oldest. A caller holding oldest-1 asks for
  // everything after it, which is exactly the retained window, so nothing it could
  // still be given is missing. One further back there is a gap it can never be told
  // about, and that is what has to be reported.
  assert.equal(r.missedEvents(oldest - 1), false, 'the last fully-serviceable cursor is not stale');
  assert.equal(r.missedEvents(oldest - 2), true, 'a cursor with a dropped event behind it is stale');
  assert.equal(r.missedEvents(oldest), false);
  assert.equal(r.missedEvents(r.latestSequence), false);
  assert.equal(r.missedEvents(r.latestSequence + 1), false, 'a cursor ahead of the ring has merely caught up');
  assert.throws(() => r.missedEvents(-1), /Invalid sequence/);
  assert.throws(() => r.missedEvents(1.5), /Invalid sequence/);
});

test('REC-08 respects the response cap but always makes progress', () => {
  const r = new Recording();
  r.recordOutput('a'.repeat(1000));
  r.recordOutput('b'.repeat(1000));
  r.recordOutput('c'.repeat(1000));
  // base64 of 1000 bytes is 1336 characters, so a 1500 cap admits exactly one.
  assert.equal(r.eventsAfter(0, { byteCap: 1500 }).events.length, 1);
  // A cap smaller than one event must still return it, or a caller would spin
  // forever on a chunk it can never be given.
  assert.equal(r.eventsAfter(0, { byteCap: 1 }).events.length, 1);
  assert.equal(r.eventsAfter(r.latestSequence).events.length, 0);
});

test('REC-09 replays output into the same screen the live emulator shows', async () => {
  const emu = emulator();
  const r = new Recording({ cols: 20, rows: 6 });
  for (const chunk of ['hello\r\n', 'world\r\n', 'third']) {
    await emu.write(chunk);
    r.recordOutput(chunk);
  }
  const expected = emu.screen();
  emu.terminal.dispose();
  const replayed = await replayRecording({ events: r.eventsAfter(0).events, cols: 20, rows: 6, Terminal });
  assert.equal(replayed.screen, expected);
});

test('REC-10 a truncated recording replays to the same screen as an intact one', async () => {
  // The acceptance criterion "a recording played back ends in the same screen" has
  // to hold *after* truncation, or the byte limit quietly buys itself by breaking
  // playback. Two rings see identical output; only one is allowed to keep it all.
  // 120 lines against a 512-byte ring truncates several times over, which is what
  // makes the comparison meaningful, while keeping the unit suite fast enough that
  // nobody is tempted to skip it.
  const lines = Array.from({ length: 120 }, (_, i) => `line-${String(i).padStart(3, '0')}\r\n`);

  const full = new Recording({ cols: 20, rows: 6 });
  const ref = emulator();
  for (const line of lines) { await ref.write(line); full.recordOutput(line); }
  const expected = ref.screen();
  ref.terminal.dispose();
  assert.equal(full.truncated, false);

  const live = emulator();
  const small = new Recording({ limit: 512, cols: 20, rows: 6, snapshotProvider: () => snapshotOf(live) });
  for (const line of lines) { await live.write(line); small.recordOutput(line); }
  assert.equal(small.truncated, true, 'the small ring must have truncated or this test proves nothing');
  assert.ok(small.bytes <= 512 + 200, 'and it must still be inside its bound');
  live.terminal.dispose();

  const intact = await replayRecording({ events: full.eventsAfter(0).events, cols: 20, rows: 6, Terminal });
  const truncated = await replayRecording({ events: small.eventsAfter(0).events, cols: 20, rows: 6, Terminal });
  assert.equal(intact.screen, expected, 'sanity: the intact replay reproduces the live screen');
  assert.equal(truncated.screen, expected, 'a truncated recording must still replay to the same final screen');
});

test('REC-11 replays a resize so the recording converges on the final geometry', async () => {
  const emu = emulator(20, 6);
  const r = new Recording({ cols: 20, rows: 6 });
  await emu.write('before\r\n');
  r.recordOutput('before\r\n');
  emu.terminal.resize(40, 10);
  r.recordResize(40, 10);
  await emu.write('after');
  r.recordOutput('after');
  const expected = emu.screen();
  const expectedCols = emu.terminal.cols;
  emu.terminal.dispose();

  const replayed = await replayRecording({ events: r.eventsAfter(0).events, cols: 20, rows: 6, Terminal });
  assert.equal(replayed.cols, expectedCols, 'the replayed emulator must end at the recorded size');
  assert.equal(replayed.screen, expected);
});

test('REC-12 rejects an event kind it does not know instead of skipping it', async () => {
  // Silently ignoring an unknown kind would let a recording replay to a plausible
  // but wrong screen, which is worse than refusing to answer.
  await assert.rejects(
    replayRecording({ events: [{ seq: 1, kind: 'teleport', data: '' }], cols: 20, rows: 6, Terminal }),
    /Unknown recording event kind: teleport/,
  );
});

test('REC-13 refuses a nonsensical limit at construction rather than at overflow', () => {
  assert.throws(() => new Recording({ limit: 0 }), /Invalid recording limit/);
  assert.throws(() => new Recording({ limit: -1 }), /Invalid recording limit/);
  assert.throws(() => new Recording({ limit: NaN }), /Invalid recording limit/);
  assert.throws(() => new Recording({ limit: Infinity }), /Invalid recording limit/);
  // A limit that cannot hold one event would make #enforceLimit append a snapshot
  // that is itself over the limit and recurse forever. Rejecting it at construction
  // is what keeps that a clear error instead of a stack overflow mid-session.
  assert.throws(() => new Recording({ limit: RECORD_EVENT_OVERHEAD }), /Invalid recording limit/);
  assert.doesNotThrow(() => new Recording({ limit: RECORD_EVENT_OVERHEAD + 1 }));
});

test('REC-14 works without a snapshot provider, dropping history rather than inventing it', () => {
  const r = new Recording({ limit: 256 });
  for (let i = 0; i < 20; i += 1) r.recordOutput('q'.repeat(100));
  const { events } = r.eventsAfter(0);
  assert.equal(r.truncated, true);
  // No provider means nothing can be snapshotted, so the ring holds only what was
  // written after the last truncation. Reported, not papered over.
  assert.ok(events.every(e => e.kind === 'output'));
  assert.ok(r.bytes <= 256);
});

test('REC-15 bounds a flood of payload-free events, which a byte-only limit would not', () => {
  // Regression for a real hole in the first version of this file. Resize and exit
  // events carry no payload, so while the envelope cost nothing, an owner calling
  // terminal.resize in a loop grew the ring forever: `bytes` stayed at zero, the
  // limit never fired, and memory grew without bound -- the exact failure issue #27
  // requires be impossible. Only an owner token is needed to do it, which is not a
  // privileged position to trust.
  const emu = emulator();
  const r = new Recording({ limit: 1024, snapshotProvider: () => snapshotOf(emu) });
  for (let i = 0; i < 5000; i += 1) r.recordResize(60 + (i % 10), 20);
  emu.terminal.dispose();
  const maxEvents = Math.ceil(1024 / RECORD_EVENT_OVERHEAD);
  assert.ok(r.events.length <= maxEvents, `${r.events.length} events retained against a cap of ${maxEvents}`);
  assert.ok(r.bytes <= 1024, `retained ${r.bytes} bytes against a 1024 cap`);
  assert.equal(r.truncated, true);
  assert.ok(r.droppedEvents > 4000, 'the flood must be reported as dropped, not silently absorbed');
});

test('REC-16 an event larger than the whole cap is dropped, but the snapshot carries its effect', async () => {
  // A chunk bigger than the entire ring cannot be retained, and pretending otherwise
  // would mean an unbounded ring. What must survive is the screen, because that is
  // what replay is promised to reproduce -- the snapshot is taken from the live
  // emulator, so it already reflects the bytes that were dropped.
  const emu = emulator();
  const r = new Recording({ limit: 1024, snapshotProvider: () => snapshotOf(emu) });
  const big = 'B'.repeat(4000);
  await emu.write(big);
  r.recordOutput(big);
  assert.equal(r.truncated, true);
  const { events } = r.eventsAfter(0);
  assert.deepEqual(events.map(e => e.kind), ['snapshot'], 'the oversized chunk is dropped and re-anchored');
  assert.ok(events[0].screen.includes('B'), 'the snapshot must reflect what the dropped chunk rendered');
  assert.ok(r.bytes <= 1024);
  emu.terminal.dispose();
});
