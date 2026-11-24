// Native Windows ConPTY integration tests.
//
// These run against a real pseudoterminal and a real headless emulator; nothing
// here is mocked. They are skipped on other platforms so the existing suite
// keeps its cross-platform meaning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  FIXTURE, SIGINT_FIXTURE, alivePidsAmong, ask, conhostBaseline, createSession,
  forceKill, handleKinds, isPidAlive, pidsOf, rawHex, screenHas, send, sendLine,
  until, untilTrue,
} from './helpers/native.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROVIDER_PROBE = fileURLToPath(new URL('./fixtures/conpty-dll-probe.mjs', import.meta.url));

// Runs the provider probe in its own process and returns its exit code plus the
// decoded PROBE events. Out-of-process is required: the bundled-DLL path never
// releases its conout worker, so running it in-process would hang the suite.
async function probeProvider(provider) {
  let code = 0;
  let stdout = '';
  try {
    const result = await execFileAsync(process.execPath, [PROVIDER_PROBE, provider], { cwd: REPO_ROOT, timeout: 90000 });
    stdout = result.stdout;
  } catch (error) {
    code = typeof error.code === 'number' ? error.code : 1;
    stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const events = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^PROBE (\w+) (\{.*\})$/);
    if (match) events[match[1]] = JSON.parse(match[2]);
  }
  return { code, events, stdout };
}

const windows = process.platform === 'win32';
const skip = windows ? false : 'native ConPTY scenario: Windows only';
const opts = { skip, timeout: 60000 };

test('WIN-01 creates a native ConPTY session backed by a real TTY', opts, async () => {
  const { session, child } = createSession();
  try {
    const ready = await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    assert.match(ready.sessionId, /^[0-9a-f-]{36}$/, 'session id must be a uuid');
    assert.equal(ready.running, true);
    assert.equal(ready.exit, null);
    assert.equal(ready.cols, 80);
    assert.equal(ready.rows, 24);
    assert.ok(child.pid > 0, `expected a real child pid, got ${child.pid}`);
    assert.ok(await isPidAlive(child.pid), 'child pid must exist in the OS process table');

    // A pipe-backed child reports isTTY=false. Both flags true proves ConPTY
    // attached a genuine console to the child rather than anonymous pipes.
    const tty = await ask(session, 'tty', 'TTY:');
    assert.match(tty.screen, /TTY:in=true,out=true,cols=80,rows=24/);
  } finally {
    await session.close();
  }
});

test('WIN-02 executes PowerShell commands and reports their output', opts, async () => {
  const oneShot = createSession({
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', "Write-Output 'PS-ONE-SHOT-OK'; Write-Output ('PS-MAJOR=' + $PSVersionTable.PSVersion.Major)"],
  });
  try {
    const done = await until(oneShot.session, s => s.screen.includes('PS-ONE-SHOT-OK') && s.screen.includes('PS-MAJOR='), { label: 'powershell one-shot output' });
    assert.match(done.screen, /PS-MAJOR=\d+/);
    await until(oneShot.session, s => !s.running, { label: 'powershell exit' });
    assert.equal((await oneShot.session.observe()).exit.exitCode, 0);
  } finally {
    await oneShot.session.close();
  }

  // Interactive shell: state set on one line must be visible to the next,
  // which only holds if keystrokes really reach a persistent PowerShell.
  const interactive = createSession({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-NoLogo'] });
  try {
    await until(interactive.session, s => s.screen.length > 0, { label: 'powershell prompt' });
    await sendLine(interactive.session, '$sentiora = 6 * 7');
    await sendLine(interactive.session, 'Write-Output "PS-INTERACTIVE=$sentiora"');
    const seen = await until(interactive.session, screenHas('PS-INTERACTIVE=42'), { label: 'powershell interactive result' });
    assert.match(seen.screen, /PS-INTERACTIVE=42/);
  } finally {
    await interactive.session.close();
  }
});

test('WIN-03 executes CMD commands and reports their output', opts, async () => {
  const oneShot = createSession({ command: 'cmd.exe', args: ['/c', 'echo CMD-ONE-SHOT-OK'] });
  try {
    await until(oneShot.session, screenHas('CMD-ONE-SHOT-OK'), { label: 'cmd one-shot output' });
    await until(oneShot.session, s => !s.running, { label: 'cmd exit' });
    assert.equal((await oneShot.session.observe()).exit.exitCode, 0);
  } finally {
    await oneShot.session.close();
  }

  const interactive = createSession({ command: 'cmd.exe', args: [] });
  try {
    await until(interactive.session, s => s.screen.trim().length > 0, { label: 'cmd prompt' });
    await sendLine(interactive.session, 'set SENTIORA_VAR=cmd-state-ok');
    await sendLine(interactive.session, 'echo CMD-INTERACTIVE=%SENTIORA_VAR%');
    const seen = await until(interactive.session, screenHas('CMD-INTERACTIVE=cmd-state-ok'), { label: 'cmd interactive result' });
    assert.match(seen.screen, /CMD-INTERACTIVE=cmd-state-ok/);
  } finally {
    await interactive.session.close();
  }
});

test('WIN-04 delivers individual key presses to the child', opts, async () => {
  const { session } = createSession({ args: [FIXTURE, '--raw-echo'] });
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    const keys = [
      ['\r', 'Enter'],
      ['\t', 'Tab'],
      ['\x1b[A', 'Up arrow'],
      ['\x1b[B', 'Down arrow'],
      ['\x1b', 'Escape'],
      ['\x7f', 'Backspace'],
      ['\x03', 'Ctrl+C arrives as a byte in raw mode'],
    ];

    // ConPTY is free to coalesce consecutive writes into a single input chunk,
    // so assertions are made on the ordered byte stream the child received
    // rather than on one echoed line per key press.
    let expected = '';
    for (const [bytes, label] of keys) {
      expected += Buffer.from(bytes, 'utf8').toString('hex');
      await send(session, bytes);
      await until(session, s => rawHex(s).startsWith(expected), {
        label: `${label} to reach the child (expected stream ${expected})`,
      });
    }

    const final = await session.observe();
    assert.equal(rawHex(final), expected, 'the child must receive exactly the bytes sent, in order');
    assert.ok(final.running, 'raw-mode Ctrl+C must not terminate the child');
  } finally {
    await session.close();
  }
});

test('WIN-05 renders ANSI escape sequences into cell attributes', opts, async () => {
  const { session, terminal } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    const after = await ask(session, 'ansi', 'ANSI-DONE');
    const lines = after.screen.split('\n');
    const y = lines.findIndex(l => l.includes('RGBN'));
    assert.ok(y >= 0, `expected the coloured line on screen, got:\n${after.screen}`);

    // The escape bytes must be consumed by the emulator, not shown as text.
    assert.ok(!after.screen.includes('\x1b'), 'raw ESC leaked into the rendered screen');
    assert.ok(!after.screen.includes('[31m'), 'raw SGR parameters leaked into the rendered screen');

    const red = terminal.buffer.active.getLine(y).getCell(0);
    const green = terminal.buffer.active.getLine(y).getCell(1);
    const blue = terminal.buffer.active.getLine(y).getCell(2);
    const plain = terminal.buffer.active.getLine(y).getCell(3);
    assert.equal(red.getChars(), 'R');
    assert.equal(red.getFgColor(), 1, 'expected ANSI red foreground');
    assert.equal(green.getFgColor(), 2, 'expected ANSI green foreground');
    assert.equal(blue.getFgColor(), 4, 'expected ANSI blue foreground');
    assert.ok(blue.isBold(), 'expected the bold attribute to survive the pty round trip');
    assert.equal(plain.getFgColorMode(), 0, 'expected the reset to clear the foreground colour');
  } finally {
    await session.close();
  }
});

test('WIN-06 reports cursor position after explicit movement', opts, async () => {
  const { session } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    // The marker is numbered so each wait targets this specific move instead of
    // matching the previous one that is still on screen.
    await ask(session, 'cursor 5 10', 'CURSOR-1');
    let observed = await session.observe();
    assert.deepEqual(observed.cursor, { x: 9, y: 4 }, 'CUP 5;10 must land on zero-based 9,4');

    await ask(session, 'cursor 12 40', 'CURSOR-2');
    observed = await session.observe();
    assert.deepEqual(observed.cursor, { x: 39, y: 11 }, 'CUP 12;40 must land on zero-based 39,11');

    // Output must move the reported cursor: writing one line from a known cell
    // has to leave the cursor at column zero of the following row.
    await ask(session, 'cursor 3 1', 'CURSOR-3');
    observed = await session.observe();
    assert.deepEqual(observed.cursor, { x: 0, y: 2 }, 'CUP 3;1 must land on zero-based 0,2');

    await sendLine(session, 'echo MOVE');
    const moved = await until(session, screenHas('ECHO:MOVE'), { label: 'line to be written' });
    assert.deepEqual(moved.cursor, { x: 0, y: 3 }, 'writing a line must advance the cursor to the next row');
  } finally {
    await session.close();
  }
});

test('WIN-07 resizes the terminal and propagates it to the child', opts, async () => {
  const { session, terminal } = createSession({ cols: 80, rows: 24 });
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });

    // resize() resolves once the emulator and the pty know the new geometry, but
    // the child learns about it asynchronously tens of milliseconds later. Poll
    // with a deadline so a genuine propagation failure still fails the test.
    let redraws = 0;
    const readChildSize = async () => {
      redraws += 1;
      await sendLine(session, 'redraw');
      await until(session, screenHas(`REDRAW-${redraws}`), { label: `screen cleared (${redraws})` });
      const snap = await ask(session, 'size', 'SIZE:');
      return snap.screen.split('\n').filter(l => l.startsWith('SIZE:')).pop() ?? '';
    };
    const converge = async expected => {
      const deadline = Date.now() + 8000;
      let seen = await readChildSize();
      while (seen !== expected && Date.now() < deadline) seen = await readChildSize();
      return seen;
    };

    assert.equal(await converge('SIZE:80x24'), 'SIZE:80x24', 'child must start at the created size');

    const resized = await session.resize(session.owner, 60, 10);
    assert.equal(resized.cols, 60);
    assert.equal(resized.rows, 10);
    assert.equal(terminal.cols, 60);
    assert.equal(terminal.rows, 10);
    assert.equal(await converge('SIZE:60x10'), 'SIZE:60x10', 'child must see the shrunk ConPTY dimensions');

    // Growing must work too, so the propagation is not a one-way latch.
    await session.resize(session.owner, 100, 30);
    assert.equal(await converge('SIZE:100x30'), 'SIZE:100x30', 'child must see the grown ConPTY dimensions');

    await assert.rejects(session.resize('not-the-owner', 50, 20), /Resize denied/);
    await assert.rejects(session.resize(session.owner, 1, 10), /Invalid dimensions/);
    await assert.rejects(session.resize(session.owner, 301, 10), /Invalid dimensions/);
    assert.equal((await session.observe()).cols, 100, 'a rejected resize must not change state');
  } finally {
    await session.close();
  }
});

test('WIN-08 redraws the screen interactively', opts, async () => {
  const { session } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    await ask(session, 'echo BEFORE-REDRAW', 'ECHO:BEFORE-REDRAW');

    const first = await ask(session, 'redraw', 'REDRAW-1');
    assert.match(first.screen, /REDRAW-1/);
    assert.ok(!first.screen.includes('BEFORE-REDRAW'), 'clear-screen must erase prior content');

    const second = await ask(session, 'redraw', 'REDRAW-2');
    assert.match(second.screen, /REDRAW-2/);
    assert.ok(!second.screen.includes('REDRAW-1'), 'the previous frame must be gone after a redraw');
  } finally {
    await session.close();
  }
});

test('WIN-09 renders Spanish, Russian and Chinese output', opts, async () => {
  const { session } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    const seen = await ask(session, 'unicode', 'UNICODE-DONE');
    assert.ok(seen.screen.includes('ES:cañón Ñandú ÄÖÜß'), `Spanish text mangled:\n${seen.screen}`);
    assert.ok(seen.screen.includes('RU:Съешь ещё этих булок'), `Russian text mangled:\n${seen.screen}`);
    assert.ok(seen.screen.includes('ZH:汉字终端测试'), `Chinese text mangled:\n${seen.screen}`);

    // Byte-level proof: send explicit UTF-8 for "ñ漢" and require it back intact.
    const hex = Buffer.from('ñ漢', 'utf8').toString('hex');
    const echoed = await ask(session, `bytes ${hex}`, 'BYTES-DONE');
    assert.ok(echoed.screen.includes('ñ漢'), `raw UTF-8 bytes mangled:\n${echoed.screen}`);
  } finally {
    await session.close();
  }
});

test('WIN-10 keeps concurrent sessions isolated', opts, async () => {
  const tokens = ['ALPHA', 'BRAVO', 'CHARLIE'];
  const created = tokens.map(token => ({ token, ...createSession() }));
  try {
    for (const { session } of created) await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });

    const ids = new Set(created.map(c => c.session.id));
    const pids = new Set(created.map(c => c.child.pid));
    assert.equal(ids.size, 3, 'sessions must have distinct ids');
    assert.equal(pids.size, 3, 'sessions must have distinct child pids');

    for (const { token, session } of created) await ask(session, `echo TOKEN-${token}`, `ECHO:TOKEN-${token}`);

    for (const { token, session } of created) {
      const observed = await session.observe();
      assert.ok(observed.screen.includes(`TOKEN-${token}`), `session ${token} lost its own output`);
      for (const other of tokens) {
        if (other === token) continue;
        assert.ok(!observed.screen.includes(`TOKEN-${other}`), `session ${token} leaked output from ${other}`);
      }
    }
  } finally {
    for (const { session } of created) await session.close();
  }
});

test('WIN-11 rejects input against a stale revision', opts, async () => {
  const { session } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    const stale = await session.observe();
    await ask(session, 'echo ADVANCE', 'ECHO:ADVANCE');

    await assert.rejects(
      session.input({ owner: session.owner, revision: stale.revision, text: 'SHOULD-NOT-SEND\r' }),
      /Stale observation/,
    );
    const observed = await session.observe();
    assert.ok(!observed.screen.includes('SHOULD-NOT-SEND'), 'stale input must never reach the pty');

    // The current revision still works, so the guard is not a blanket refusal.
    await sendLine(session, 'echo FRESH-OK');
    await until(session, screenHas('ECHO:FRESH-OK'), { label: 'fresh revision accepted' });
  } finally {
    await session.close();
  }
});

test('WIN-12 rejects input from an unauthorised owner', opts, async () => {
  const { session } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    const observed = await session.observe();

    await assert.rejects(
      session.input({ owner: 'not-the-owner', revision: observed.revision, text: 'INTRUDER\r' }),
      /Input ownership required/,
    );
    await assert.rejects(
      session.input({ owner: undefined, revision: observed.revision, text: 'INTRUDER\r' }),
      /Input ownership required/,
    );
    const after = await session.observe();
    assert.ok(!after.screen.includes('INTRUDER'), 'unauthorised input must never reach the pty');
    assert.equal(after.revision, observed.revision, 'a rejected input must not bump the revision');
  } finally {
    await session.close();
  }
});

test('WIN-13 reports the real child exit status', opts, async () => {
  for (const code of [0, 3, 42]) {
    const { session } = createSession();
    try {
      await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
      await sendLine(session, `exit ${code}`);
      const exited = await until(session, s => !s.running, { label: `exit ${code}` });
      assert.equal(exited.exit.exitCode, code, `expected exit code ${code}`);
      assert.equal(exited.running, false);
      await assert.rejects(send(session, 'x'), /Session not running/);
    } finally {
      await session.close();
    }
  }

  // A real shell exit code must survive ConPTY too, not just the fixture's.
  const { session } = createSession({ command: 'cmd.exe', args: ['/c', 'exit 7'] });
  try {
    const exited = await until(session, s => !s.running, { label: 'cmd exit 7' });
    assert.equal(exited.exit.exitCode, 7);
  } finally {
    await session.close();
  }
});

test('WIN-14 cleans up without orphaned processes', opts, async () => {
  // node-pty defaults to the OS ConPTY (useConptyDll:false), which hosts each
  // session in conhost.exe rather than in a bundled OpenConsole.exe. Tracking
  // the identity of the new hosts, instead of a global count, keeps the
  // assertion immune to unrelated console churn elsewhere on the machine.
  const baselineHosts = await conhostBaseline();
  const newHosts = async () => (await pidsOf('conhost.exe')).filter(p => !baselineHosts.has(p));

  const sessions = [];
  let childPids = [];
  try {
    for (let i = 0; i < 3; i += 1) sessions.push(createSession());
    for (const { session } of sessions) await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });

    childPids = sessions.map(s => s.child.pid);
    assert.equal(new Set(childPids).size, 3, 'each session needs its own child process');
    for (const pid of childPids) assert.ok(await isPidAlive(pid), `child ${pid} should be alive while the session runs`);

    await untilTrue(async () => (await newHosts()).length >= 3, {
      timeout: 15000, label: 'one conhost per ConPTY session to appear',
    });
  } finally {
    for (const { session } of sessions) await session.close();
  }

  // The processes Sentiora itself spawned must be gone. This is the strict,
  // noise-immune part: it matches exact pids we own. One batched tasklist call
  // per poll, because each spawned console program is itself handed a conhost
  // by a console-less runner.
  await untilTrue(async () => (await alivePidsAmong(childPids)).length === 0, {
    timeout: 25000, interval: 1000, label: 'every session child to exit',
  });

  // The global conhost count is deliberately reported rather than asserted. On a
  // live desktop it is dominated by unrelated console subprocesses: the same
  // measurement was observed at 0, 1, 1, 0 and 8 leftovers across five runs of
  // this suite with no change to the code under test, and a console-less test
  // runner is handed a transient conhost for every process it spawns. Dedicated
  // probes (docs/validation/windows-native-validation.md §5.9) established that
  // session hosts are fully reaped by +8s, so asserting here would only encode
  // machine noise. The "at least one host per session appears" check above is
  // kept because that direction is monotonic and therefore stable.
  await new Promise(resolve => setTimeout(resolve, 10000));
  const leftoverHosts = await newHosts();
  console.log(`    WIN-14 conhost hosts remaining after close (informational): ${leftoverHosts.length}${leftoverHosts.length ? ` (${leftoverHosts.join(',')})` : ''}`);
});

test('WIN-16 waits for changes and honours timeouts', opts, async () => {
  const { session } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });

    // A quiescent session must return on the timeout, not block forever.
    const quiet = await session.observe();
    const started = Date.now();
    const timedOut = await session.wait(quiet.revision, 400);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 350, `wait returned too early: ${elapsed}ms`);
    assert.ok(elapsed < 5000, `wait overshot its timeout: ${elapsed}ms`);
    assert.equal(timedOut.revision, quiet.revision, 'nothing changed, so the revision must be stable');

    // input() itself bumps the revision, so a caller must arm wait() with the
    // revision returned by the write. Waiting on the pre-input revision is
    // already stale and returns at once, before the child has replied.
    const before = await session.observe();
    const typed = await sendLine(session, 'echo WAKE-UP');
    assert.ok(typed.revision > before.revision, 'a successful write must advance the revision');

    const stale = await session.wait(before.revision, 10000);
    assert.ok(stale.revision >= typed.revision, 'wait on a stale revision must return immediately');

    const started2 = Date.now();
    const woken = await session.wait(typed.revision, 10000);
    assert.match(woken.screen, /ECHO:WAKE-UP/, 'wait must not resolve before the reply is rendered');
    assert.ok(woken.revision > typed.revision, 'the reply must be a further observable change');
    assert.ok(Date.now() - started2 < 10000, 'wait must be woken by output, not by its timeout');

    await assert.rejects(session.wait(-1, 100), /Invalid wait/);
    await assert.rejects(session.wait(0, -1), /Invalid wait/);
    await assert.rejects(session.wait(0, Number.NaN), /Invalid wait/);
  } finally {
    await session.close();
  }
});

test('WIN-17 Ctrl+C interrupts only the targeted process', opts, async () => {
  const target = createSession({ args: [SIGINT_FIXTURE] });
  // The bystander deliberately runs the command-protocol fixture so that
  // "unaffected" can be proven by it still answering input afterwards.
  const bystander = createSession();
  try {
    await until(target.session, screenHas('WAITING-FOR-CTRL-C'), { label: 'target ready' });
    await until(bystander.session, screenHas('FIXTURE READY'), { label: 'bystander ready' });

    await send(target.session, '\x03');

    const interrupted = await until(target.session, s => s.screen.includes('GOT-SIGINT') || !s.running, { label: 'Ctrl+C to take effect' });
    assert.match(interrupted.screen, /GOT-SIGINT/, 'ConPTY must turn byte 0x03 into a real CTRL_C_EVENT');
    const settled = await until(target.session, s => !s.running, { label: 'target exit' });
    assert.equal(settled.exit.exitCode, 130, 'SIGINT handler exit code must be reported');

    // The other session must be completely untouched and still interactive.
    const other = await bystander.session.observe();
    assert.equal(other.running, true, 'Ctrl+C must not leak into a concurrent session');
    assert.ok(!other.screen.includes('GOT-SIGINT'));
    const echoed = await ask(bystander.session, 'echo STILL-ALIVE', 'ECHO:STILL-ALIVE');
    assert.match(echoed.screen, /ECHO:STILL-ALIVE/);
  } finally {
    await target.session.close();
    await bystander.session.close();
  }

  // Third mode, and the one that bites agents in practice: a cooked-mode child
  // with no SIGINT handler is terminated by the console itself and reports
  // STATUS_CONTROL_C_EXIT. A child is still in this mode during start-up, before
  // it can call setRawMode, so Ctrl+C sent right after terminal.create kills it
  // instead of reaching it as data. Callers must wait for a readiness marker.
  const cooked = createSession({ args: ['-e', 'setInterval(()=>{},1000)'] });
  try {
    await send(cooked.session, '\x03');
    const killed = await until(cooked.session, s => !s.running, { label: 'cooked child to be terminated by Ctrl+C' });
    assert.equal(killed.exit.exitCode >>> 0, 0xc000013a, 'expected STATUS_CONTROL_C_EXIT');
  } finally {
    await cooked.session.close();
  }
});

test('WIN-18 supports full-screen alternate-buffer applications', opts, async () => {
  const { session, terminal } = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    await ask(session, 'echo NORMAL-BUFFER-CONTENT', 'ECHO:NORMAL-BUFFER-CONTENT');
    assert.equal(terminal.buffer.active.type, 'normal');

    const alt = await ask(session, 'alt', 'ALT-SCREEN');
    assert.equal(terminal.buffer.active.type, 'alternate', 'the app must switch to the alternate screen buffer');
    assert.match(alt.screen, /ALT-SCREEN/);
    assert.ok(alt.screen.includes('┌') && alt.screen.includes('┘'), 'box-drawing glyphs must survive ConPTY');
    assert.ok(!alt.screen.includes('NORMAL-BUFFER-CONTENT'), 'the alternate screen starts clean');

    const restored = await ask(session, 'unalt', 'ALT-SCREEN-EXITED');
    assert.equal(terminal.buffer.active.type, 'normal', 'leaving the alternate buffer must restore the primary screen');
    assert.ok(restored.screen.includes('NORMAL-BUFFER-CONTENT'), 'primary screen content must be restored intact');
  } finally {
    await session.close();
  }
});

test('WIN-19 survives repeated create and close without leaking', opts, async () => {
  const iterations = 20;
  const baselineHosts = await conhostBaseline();
  const baseline = handleKinds();
  const baselineRss = process.memoryUsage().rss;
  const pids = [];

  for (let i = 0; i < iterations; i += 1) {
    const { session, child } = createSession({ cols: 40, rows: 10 });
    pids.push(child.pid);
    try {
      await until(session, screenHas('FIXTURE READY'), { timeout: 10000, label: `iteration ${i} banner` });
      await ask(session, `echo ITER-${i}`, `ECHO:ITER-${i}`, { timeout: 10000 });
    } finally {
      await session.close();
    }
  }

  await untilTrue(async () => (await alivePidsAmong(pids)).length === 0, {
    timeout: 30000, interval: 1000, label: 'every session child to exit after churn',
  });

  // Reported, not asserted: see WIN-14 for why a global conhost count measures
  // desktop noise rather than session leaks.
  await new Promise(resolve => setTimeout(resolve, 10000));
  const leftoverHosts = (await pidsOf('conhost.exe')).filter(p => !baselineHosts.has(p));

  // node-pty drains the conout worker on a one second timer before terminating
  // it. Zero is the only correct floor: a session that closed cleanly leaves no
  // worker thread behind, whatever earlier tests in this file were still
  // draining when the baseline was taken.
  await untilTrue(async () => (handleKinds().MessagePort ?? 0) === 0, {
    timeout: 30000, label: 'every ConPTY conout worker thread to terminate',
  });

  const after = handleKinds();
  const rssGrowth = process.memoryUsage().rss - baselineRss;
  const leakedSockets = (after.Socket ?? 0) - (baseline.Socket ?? 0);

  // The signal Sentiora owns: an undisposed ConPTY conout worker leaves one
  // MessagePort behind per session and keeps the host event loop alive.
  assert.equal(after.MessagePort ?? 0, 0, 'no ConPTY conout worker may survive close()');
  assert.ok(rssGrowth < 64 * 1024 * 1024, `resident set grew by ${(rssGrowth / 1048576).toFixed(1)}MB over ${iterations} sessions`);

  // Known upstream leak, measured not ignored: node-pty's _cleanUpProcess()
  // destroys the conout socket but never the conin socket it opened with
  // fs.openSync, so roughly one handle per session outlives close(). Bounding
  // it at one per session pins the current behaviour and fails if it gets worse.
  assert.ok(leakedSockets <= iterations, `socket handles leaked ${leakedSockets} over ${iterations} sessions`);
  console.log(`    WIN-19 ${iterations} sessions: handles ${JSON.stringify(baseline)} -> ${JSON.stringify(after)}, `
    + `conin sockets leaked ${leakedSockets}, conhosts left (informational) ${leftoverHosts.length}, rss +${(rssGrowth / 1048576).toFixed(1)}MB`);
});

test('WIN-20 recovers after an unexpected child process exit', opts, async () => {
  const victim = createSession();
  const survivor = createSession();
  try {
    await until(victim.session, screenHas('FIXTURE READY'), { label: 'victim banner' });
    await until(survivor.session, screenHas('FIXTURE READY'), { label: 'survivor banner' });

    // Kill from outside the runtime: this is a crash, not a graceful exit.
    await forceKill(victim.child.pid);

    const exited = await until(victim.session, s => !s.running, { label: 'victim to be reported dead' });
    assert.equal(exited.running, false);
    assert.ok(exited.exit, 'an unexpected exit must still produce exit information');
    await assert.rejects(send(victim.session, 'echo NOPE'), /Session not running/);

    // The runtime itself must stay usable for other and new sessions.
    const stillWorking = await ask(survivor.session, 'echo SURVIVOR-OK', 'ECHO:SURVIVOR-OK');
    assert.match(stillWorking.screen, /ECHO:SURVIVOR-OK/);

    const replacement = createSession();
    try {
      await until(replacement.session, screenHas('FIXTURE READY'), { label: 'replacement banner' });
      const ok = await ask(replacement.session, 'echo REPLACEMENT-OK', 'ECHO:REPLACEMENT-OK');
      assert.match(ok.screen, /ECHO:REPLACEMENT-OK/);
    } finally {
      await replacement.session.close();
    }

    // Closing an already-dead session must be safe and must not throw.
    await victim.session.close();
    await victim.session.close();
  } finally {
    await victim.session.close();
    await survivor.session.close();
  }
});

test('lifecycle states and child pid are observable through a real ConPTY session', opts, async () => {
  const { session, child } = createSession();
  try {
    // 'spawned' means a pid exists, not that the application can take input.
    assert.equal(session.state, 'spawned');
    assert.equal(session.pid, child.pid, 'the session must expose the real child pid');
    assert.ok(session.pid > 0);
    assert.ok(await isPidAlive(session.pid), 'the exposed pid must exist in the OS process table');

    const ready = await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    assert.equal(ready.state, 'operational', 'first rendered output must make the session operational');
    assert.equal(ready.pid, child.pid, 'every observation must carry the pid');
    assert.equal(ready.running, true);

    await sendLine(session, 'exit 5');
    const exited = await until(session, s => !s.running, { label: 'child exit' });
    assert.equal(exited.state, 'exited', 'a dead child must be distinguishable from a live one');
    assert.equal(exited.exit.exitCode, 5);
    assert.equal(exited.pid, child.pid, 'the pid must survive exit so a caller can verify identity');
  } finally {
    await session.close();
  }

  assert.equal(session.state, 'released');
  // The final screen stays readable after release, so a caller can still
  // inspect what the application showed without keeping the session open.
  const final = await session.observe();
  assert.equal(final.state, 'released');
  assert.equal(final.running, false);
  assert.equal(final.pid, child.pid);
  assert.ok(final.screen.includes('FIXTURE READY'), 'the last rendered screen must survive close()');
  await assert.rejects(session.resize(session.owner, 40, 10), /Resize denied/);
});

test('ConPTY provider comparison: bundled DLL path works but never releases its worker', { skip, timeout: 240000 }, async () => {
  const os = await probeProvider('os');
  const dll = await probeProvider('dll');

  // Both providers are functionally usable on this architecture: the bundled
  // ARM64 conpty.dll and OpenConsole.exe really do load and drive a session.
  for (const [name, { events }] of [['os', os], ['dll', dll]]) {
    assert.equal(events.spawned?.arch, process.arch, `${name}: probe ran on an unexpected architecture`);
    assert.ok(events.spawned?.pid > 0, `${name}: expected a child pid`);
    assert.equal(events.ready?.ok, true, `${name}: child never became operational through the pseudoconsole`);
    assert.equal(events.ready?.state, 'operational');
    assert.equal(events.roundTrip?.echoed, true, `${name}: interactive round trip failed`);
    assert.equal(events.closed?.state, 'released');
  }

  // The difference that decides the default: only OS ConPTY lets the host exit.
  assert.equal(os.code, 0, `OS ConPTY must drain and exit 0, got ${os.code}; output:\n${os.stdout}`);
  assert.equal(os.events.didNotDrain, undefined, 'OS ConPTY must not report an undisposed worker');
  assert.ok(os.events.exit.ms < 12000, `OS ConPTY drain took ${os.events.exit?.ms}ms`);

  assert.equal(dll.code, 98, `bundled-DLL path is expected to report it never drains, got ${dll.code}; output:\n${dll.stdout}`);
  assert.ok(dll.events.didNotDrain, 'bundled-DLL path must report the undisposed conout worker');
  assert.equal(dll.events.didNotDrain.messagePorts, 1, 'exactly one conout worker survives close() on the DLL path');
});

test('an asynchronous ConPTY input-socket failure cannot crash the host', opts, async () => {
  // Regression test for a host-killing defect found by the stress harness.
  // node-pty attaches an 'error' listener to its ConPTY output socket but not to
  // the input socket, so an asynchronous write failure there -- EAGAIN once the
  // input pipe is full, EINVAL once the child is gone -- surfaces as an unhandled
  // 'error' event that terminates the whole runtime and every concurrent session
  // with it. Reproduced by driving ~1.25M writes through a resize loop.
  const { session } = createSession();
  const other = createSession();
  try {
    await until(session, screenHas('FIXTURE READY'), { label: 'fixture banner' });
    await until(other.session, screenHas('FIXTURE READY'), { label: 'bystander banner' });

    const socket = session.pty._agent?.inSocket;
    assert.ok(socket, 'expected to reach the ConPTY input socket');
    assert.equal(socket.listenerCount('error') >= 1, true, 'Session must guard the input socket');

    const before = (await session.observe()).writeErrors;
    socket.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN', syscall: 'write' }));

    const after = await session.observe();
    assert.equal(after.writeErrors, before + 1, 'the failure must be recorded, not thrown');
    assert.equal(after.running, true, 'a failed write must not tear down the session');

    // The session stays usable and the concurrent one is untouched.
    const echoed = await ask(session, 'echo STILL-USABLE', 'ECHO:STILL-USABLE');
    assert.match(echoed.screen, /ECHO:STILL-USABLE/);
    const otherEcho = await ask(other.session, 'echo OTHER-OK', 'ECHO:OTHER-OK');
    assert.match(otherEcho.screen, /ECHO:OTHER-OK/);
    assert.equal((await other.session.observe()).writeErrors, 0);
  } finally {
    await session.close();
    await other.session.close();
  }
});
