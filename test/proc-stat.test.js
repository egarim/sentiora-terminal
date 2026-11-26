// Unit tests for parseProcStat and classifyLiveness, the two pieces behind
// describePid.
//
// These exist because one diagnosis depends on them. FI-05 SIGKILLs the runtime and
// then has to say whether the shells it left behind are still RUNNING or merely
// unreaped exit records (zombies). Those are opposite conclusions -- one is a leaked
// process, the other is a pid-table entry that a container without an init will
// never clear -- and kill(pid, 0) cannot tell them apart because it succeeds for
// both. Only the kernel's state field can.
//
// A parser that silently returns null would not fail loudly; it would make the
// question unanswerable and invite a guess. So the parser is pure and tested here,
// on every platform, without needing a Linux kernel to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcStat, classifyLiveness } from './helpers/runtime.mjs';

// A realistically long line: /proc/<pid>/stat has 52 fields on modern kernels, and
// a parser that only copes with the first few would pass a toy fixture and break in
// production. The tail is filler with the right shape.
const TAIL = '4194304 500 100 10 5 0 0 120 30 20 0 1 0 987654 12345678 900 '
  + '18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0';

test('PROC-01 parses a sleeping process, the shape a live shell has', () => {
  const parsed = parseProcStat(`4865 (bash) S 4800 4865 4865 34817 4865 ${TAIL}`);
  assert.deepEqual(parsed, { comm: 'bash', state: 'S', ppid: 4800 });
});

test('PROC-02 parses a zombie reparented to PID 1, the shape an unreaped orphan has', () => {
  // ppid 1 is the load-bearing half: it proves the process was orphaned and handed
  // to the namespace init, which is what makes that init responsible for reaping it.
  const parsed = parseProcStat(`4865 (node) Z 1 4865 4865 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${TAIL}`);
  assert.equal(parsed.state, 'Z');
  assert.equal(parsed.ppid, 1);
  assert.equal(parsed.comm, 'node');
});

test('PROC-03 keys off the LAST parenthesis, because comm may contain spaces and parens', () => {
  // Splitting on the first ')' -- the obvious implementation -- would read comm as
  // "Web Content (gpu" and then take "(gpu)" as the state column and "R" as the
  // ppid, returning a number for a column that is not one. Real browser and helper
  // processes are named this way, so the naive parse is not a hypothetical.
  const parsed = parseProcStat(`1234 (Web Content (gpu)) R 1000 1234 1234 0 -1 ${TAIL}`);
  assert.deepEqual(parsed, { comm: 'Web Content (gpu)', state: 'R', ppid: 1000 });
});

test('PROC-04 parses PID 1 itself, so the log can name the reaper', () => {
  const systemd = parseProcStat(`1 (systemd) S 0 1 1 0 -1 ${TAIL}`);
  assert.deepEqual(systemd, { comm: 'systemd', state: 'S', ppid: 0 });

  // The container case: PID 1 is not an init, it is whatever the runner started.
  const containerInit = parseProcStat(`1 (bash) S 0 1 1 0 -1 ${TAIL}`);
  assert.deepEqual(containerInit, { comm: 'bash', state: 'S', ppid: 0 });
});

test('PROC-05 reports every runnable state, not just S and Z', () => {
  for (const state of ['R', 'S', 'D', 'Z', 'T', 't', 'X', 'I']) {
    assert.equal(parseProcStat(`77 (sh) ${state} 12 77 77 0 -1 ${TAIL}`).state, state);
  }
});

test('PROC-06 returns nulls rather than throwing on truncated input', () => {
  // State present but ppid cut off: a partial read must not be reported as ppid 0,
  // which would make an orphan look like a kernel thread.
  assert.deepEqual(parseProcStat('99 (x) S'), { comm: 'x', state: 'S', ppid: null });
  // Cut off immediately after comm: no state to report at all.
  assert.deepEqual(parseProcStat('99 (x)'), { comm: 'x', state: null, ppid: null });
  assert.deepEqual(parseProcStat(''), { comm: null, state: null, ppid: null });
});

test('PROC-07 returns nulls on input that is not a stat line at all', () => {
  const unknown = { comm: null, state: null, ppid: null };
  assert.deepEqual(parseProcStat('not a stat line'), unknown);
  // Unbalanced: an open paren with no close is not a comm field.
  assert.deepEqual(parseProcStat('1 (unclosed S 0 1'), unknown);
  // A negative or non-numeric ppid column must not be coerced to a number.
  assert.deepEqual(parseProcStat('5 (sh) S -1 5 5 0 -1').ppid, null);
});

test('PROC-08 returns nulls on non-string input instead of throwing', () => {
  const unknown = { comm: null, state: null, ppid: null };
  for (const value of [null, undefined, 42, {}, [], Buffer.from('1 (sh) S 2 3')]) {
    assert.deepEqual(parseProcStat(value), unknown);
  }
});

// classifyLiveness decides what FI-05 asserts on. The shape it consumes is what
// describePid returns: the kill(pid, 0) probe plus whatever /proc could be read for.
const probe = (pid, killSaysAlive, state) => ({ pid, killSaysAlive, state, ppid: 1, comm: 'sh' });

test('PROC-09 classifies a zombie as not running, but still reports it', () => {
  // The exact shape the debian/arm64 container produced for FI-05: three children
  // that exited on SIGHUP and were reparented to a PID 1 that never calls wait().
  const zombies = [probe(4871, true, 'Z'), probe(4879, true, 'Z'), probe(4887, true, 'Z')];
  const { running, zombies: reported } = classifyLiveness(zombies);
  assert.deepEqual(running, [], 'a zombie is not a leaked process');
  assert.deepEqual(reported, zombies, 'but it must not be dropped silently either');
});

test('PROC-10 classifies every live state as running', () => {
  for (const state of ['R', 'S', 'D', 'T', 't', 'I']) {
    const { running, zombies } = classifyLiveness([probe(10, true, state)]);
    assert.equal(running.length, 1, `state ${state} should count as running`);
    assert.equal(zombies.length, 0, `state ${state} should not be called a zombie`);
  }
});

test('PROC-11 treats an unreadable state as running, which is what keeps Windows strict', () => {
  // The load-bearing case. Without /proc there is no state to read, so `null` must
  // fall back to the kill probe and count as running. Treating unknown as gone would
  // make every leak assertion on Windows and macOS pass by asserting nothing -- the
  // exact failure mode this file exists to prevent.
  const { running, zombies } = classifyLiveness([probe(51424, true, null)]);
  assert.equal(running.length, 1);
  assert.equal(zombies.length, 0);
});

test('PROC-12 counts a pid the kill probe says is gone as neither', () => {
  // Reaped between the probe and the /proc read, or a stale state left in the entry.
  const { running, zombies } = classifyLiveness([probe(99, false, 'Z'), probe(98, false, null)]);
  assert.deepEqual(running, []);
  assert.deepEqual(zombies, []);
});

test('PROC-13 splits a mixed batch without losing or reordering entries', () => {
  const entries = [
    probe(1, true, 'S'),    // running
    probe(2, true, 'Z'),    // exited, unreaped
    probe(3, false, null),  // gone
    probe(4, true, null),   // no /proc: treat as running
    probe(5, true, 'R'),    // running
  ];
  const { running, zombies } = classifyLiveness(entries);
  assert.deepEqual(running.map(e => e.pid), [1, 4, 5]);
  assert.deepEqual(zombies.map(e => e.pid), [2]);
  // Nothing was invented and nothing was lost between the two buckets and "gone".
  assert.equal(running.length + zombies.length, 4);
});

test('PROC-14 classifies an empty batch as empty rather than throwing', () => {
  assert.deepEqual(classifyLiveness([]), { running: [], zombies: [] });
});
