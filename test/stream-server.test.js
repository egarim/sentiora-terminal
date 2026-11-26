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
import { FIXTURE } from './helpers/native.mjs';

const { Terminal } = xterm;
const opts = { timeout: 180000 };
const spawnFixture = extra => ({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 20, ...extra });

// terminal.type requires the revision the caller last observed, so every keystroke
// has to be armed with a fresh observation. Doing that inline in each test would
// bury the assertion under bookkeeping.
async function type(server, sessionId, owner, text) {
  const { result: obs } = await server.call('terminal.observe', { sessionId });
  const { result } = await server.call('terminal.type', { sessionId, owner, revision: obs.revision, text });
  return result;
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
  let snapshots = 0;
  const deadline = Date.now() + timeout;
  for (;;) {
    const { result } = await server.call('terminal.stream', { sessionId, afterSequence: cursor, timeoutMs: 250 });
    resync = resync || result.resync;
    if (result.snapshot) snapshots += 1;
    events.push(...result.events);
    cursor = result.nextSequence;
    const text = outputText(events);
    if (marker ? text.includes(marker) : result.events.length === 0) break;
    if (Date.now() > deadline) throw new Error(`drain timed out after ${events.length} events; text so far:\n${text.slice(-500)}`);
  }
  return { events, cursor, resync, snapshots };
}

const outputText = events => Buffer.concat(
  events.filter(e => e.kind === 'output').map(e => Buffer.from(e.data, 'base64')),
).toString('latin1');

// Replays recorded bytes through a real emulator built with the same options
// src/server.js uses, so the comparison against observe() is like for like.
async function replayBytes(buffer, cols, rows) {
  const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(buffer, resolve));
    const b = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '').join('\n');
  } finally {
    terminal.dispose();
  }
}

test('STR-01 two independent watchers converge on the same screen observe reports', opts, async () => {
  const server = startRuntime();
  try {
    const created = await server.create(spawnFixture());
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');

    // Two watchers attach separately and poll separately. Neither knows about the
    // other, and neither holds the owner token.
    for (const command of ['echo one', 'echo two', 'echo three']) {
      await sendCommand(server, sessionId, owner, command);
    }
    await server.waitScreen(sessionId, 'ECHO:three');

    const watcherA = await drain(server, sessionId, { marker: 'ECHO:three' });
    const watcherB = await drain(server, sessionId, { marker: 'ECHO:three' });
    const observed = await server.call('terminal.observe', { sessionId });

    // Same bytes, in the same order, for both watchers.
    assert.equal(outputText(watcherA.events), outputText(watcherB.events), 'two watchers must see the same output');
    assert.deepEqual(
      watcherA.events.filter(e => e.kind === 'output').map(e => e.data),
      watcherB.events.filter(e => e.kind === 'output').map(e => e.data),
      'identical payload encoding, not merely identical decoded text',
    );

    // And what they saw renders to the screen the runtime itself reports.
    const replayed = await replayBytes(Buffer.from(outputText(watcherA.events), 'latin1'), observed.result.cols, observed.result.rows);
    assert.equal(replayed, observed.result.screen, 'a watcher replaying the stream must land on observe()\'s screen');

    // Sequences are strictly increasing with no gaps or repeats, which is what makes
    // "you missed some" detectable at all.
    const seqs = watcherA.events.map(e => e.seq);
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
    await sendCommand(server, sessionId, owner, 'ansi');
    await server.waitScreen(sessionId, 'ANSI-DONE');

    const { events } = await drain(server, sessionId, { marker: 'ANSI-DONE' });
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
    const { events } = await drain(server, sessionId, { marker: 'ECHO:top-secret-value' });
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
    assert.ok(recording.bytes <= 4096 + 512, `retained ${recording.bytes} bytes against a 4096 cap`);
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
    const created = await server.create(spawnFixture({ recordBytes: 8192 }));
    const { sessionId, owner } = created;
    await server.waitScreen(sessionId, 'FIXTURE READY');

    // Nobody ever calls terminal.stream. The producer must not notice: this is the
    // half of "a slow watcher does not slow the program" that a polling design has
    // to prove, because there is no back-pressure to hide behind.
    for (let i = 0; i < 30; i += 1) await sendCommand(server, sessionId, owner, `echo unwatched-${i}`);
    const observed = await server.waitScreen(sessionId, 'ECHO:unwatched-29');
    assert.match(observed.screen, /ECHO:unwatched-29/);

    const { result: recording } = await server.call('terminal.recording', { sessionId, owner });
    assert.ok(recording.bytes <= 8192 + 512, `an unwatched session must stay bounded, retained ${recording.bytes}`);
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
    await sendCommand(server, sessionId, owner, 'exit 3');

    // waitScreen cannot help here: the child is going away. Poll the stream, which
    // is the thing under test, and let its own timeout bound the wait.
    const deadline = Date.now() + 20000;
    let streamed = null;
    for (;;) {
      const { result } = await server.call('terminal.stream', { sessionId, afterSequence: 0, timeoutMs: 500 });
      streamed = result;
      if (!result.running || result.events.some(e => e.kind === 'exit')) break;
      assert.ok(Date.now() < deadline, 'streaming an exited session must settle, not block');
    }
    assert.equal(streamed.running, false);
    const exit = streamed.events.find(e => e.kind === 'exit');
    assert.ok(exit, 'the recording must carry the exit event');
    assert.equal(exit.exit?.exitCode ?? exit.exit?.exit, 3, 'the exit code must survive into the record');

    // Polling a dead session again must return immediately rather than waiting out
    // the timeout, or every consumer would pay the full poll interval on teardown.
    const started = Date.now();
    await server.call('terminal.stream', { sessionId, afterSequence: streamed.nextSequence, timeoutMs: 5000 });
    assert.ok(Date.now() - started < 2000, 'a stream poll on an exited session must not block for its full timeout');
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
