// Long-running reliability stress harness.
//
// Usage: node test/bench/lifecycle-stress.mjs [scale]
//   scale multiplies the per-phase iteration counts (default 1). Use a fraction
//   such as 0.2 for a quick smoke pass.
//
// Measurement rules, learned the hard way in the Windows validation:
//   - never count conhost.exe; a console-less runner is handed a transient one
//     for every subprocess it spawns, so that metric measures the harness
//   - verify child cleanup by exact pid, batched into one tasklist call
//   - take Win32 handle/thread counts only at phase boundaries, never per
//     iteration, because each sample costs a spawned PowerShell
//   - keep every watchdog unref'd so the harness can never be the reason the
//     process stays alive
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import { Session } from '../../src/session.js';
import { processIdentities, identityIsOurs } from './lib/identity.mjs';

const run = promisify(execFile);
const here = import.meta.url;
const FIXTURE = fileURLToPath(new URL('../fixtures/interactive.mjs', here));
const SIGINT_FIXTURE = fileURLToPath(new URL('../fixtures/sigint.mjs', here));
const SERVER = fileURLToPath(new URL('../../src/server.js', here));
const REPO_ROOT = fileURLToPath(new URL('../..', here));

// Flags are filtered out before the positional scale, so `--assert` on its own
// does not become NaN and silently reduce every phase to a single iteration.
const SCALE = Number(process.argv.slice(2).find(a => !a.startsWith('--')) ?? 1);
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error(`invalid scale: expected a positive number, got ${JSON.stringify(process.argv[2])}`);
  process.exit(64);
}
const n = value => Math.max(1, Math.round(value * SCALE));

// A misspelled flag must not produce a silent, unasserted, exit-0 run. ASSERT is a
// bare includes() check, so `--asert` printed a RESULT, evaluated nothing and
// exited 0 -- indistinguishable from a passing assert run, in the one harness whose
// entire purpose is to fail loudly.
const KNOWN_FLAGS = new Set(['--assert']);
const argvRest = process.argv.slice(2);
const unknownFlags = argvRest.filter(a => a.startsWith('--') && !KNOWN_FLAGS.has(a));
const positionals = argvRest.filter(a => !a.startsWith('--'));
if (unknownFlags.length || positionals.length > 1) {
  console.error(`unrecognised arguments: ${[...unknownFlags, ...positionals.slice(1)].join(' ') || '(none)'}`);
  console.error(`usage: lifecycle-stress.mjs [scale] [--assert]   (known flags: ${[...KNOWN_FLAGS].join(', ')})`);
  process.exit(64);
}
const t0 = Date.now();
const elapsed = () => Date.now() - t0;

const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  arch: process.arch,
  platform: process.platform,
  scale: SCALE,
  phases: {},
};

function handleKinds() {
  const kinds = {};
  for (const h of process._getActiveHandles()) {
    const name = h.constructor?.name ?? typeof h;
    kinds[name] = (kinds[name] ?? 0) + 1;
  }
  return kinds;
}

function memoryMb() {
  const m = process.memoryUsage();
  return { rss: Number((m.rss / 1048576).toFixed(1)), heapUsed: Number((m.heapUsed / 1048576).toFixed(1)) };
}

async function win32() {
  const script = `$p=Get-Process -Id ${process.pid}; "$($p.HandleCount) $($p.Threads.Count)"`;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const [handles, threads] = stdout.trim().split(/\s+/).map(Number);
    return { handles, threads };
  } catch (error) {
    return { error: error.message };
  }
}

async function alivePids(pids) {
  // Fail loudly rather than silently filtering: dropping an unavailable pid
  // would make "0 children surviving" vacuously true. node-pty 1.2.0-beta
  // reports pid 0 until its deferred pty connection completes, so pids must be
  // captured after readiness, not at spawn.
  const invalid = pids.filter(p => !Number.isInteger(p) || p <= 0);
  if (invalid.length) {
    throw new Error(`alivePids received ${invalid.length} non-positive pid(s); capture pids after readiness`);
  }
  const wanted = pids;
  if (!wanted.length) return [];
  // process.kill(pid, 0) delivers no signal and throws ESRCH once the process is
  // gone. Portable, in-process and free.
  //
  // This replaces a `tasklist` shell-out whose catch returned EVERY pid. tasklist
  // does not exist on POSIX, so on Linux and macOS the catch fired and all seven
  // childrenSurviving checks reported every child as surviving -- seven false
  // breaches on an otherwise clean run, which is worse than not measuring.
  // EPERM means the process exists but is not ours, so it counts as alive.
  const live = wanted.filter(pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  });
  if (!live.length) return [];
  // Liveness is not identity. Windows recycles process ids, and a recycled id answers
  // process.kill(pid, 0) while belonging to something else entirely -- measured: nine "survivors"
  // out of 200 externally-killed children were all conhost.exe created AFTER the child they
  // replaced. Counting those as leaked shells made #24's rate and #16's zero-survivor threshold
  // measure the pid space rather than this runtime. Compare the process's creation time with when we
  // spawned the pid: a process created after that moment cannot be our child.
  const identities = await processIdentities(live);
  // The predicate lives in ./lib/identity.mjs so it can be tested without a pty: this is the check
  // that decides whether a "survivor" is a leaked child or a recycled pid.
  return live.filter(pid => identityIsOurs(identities.get(pid), spawnTimes.get(pid)));
}

const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)),
  };
};

// Every in-process create/close cycle goes through openSession, so counting here
// is the only divisor that cannot drift out of step with what the phases actually
// do. Phase G is deliberately excluded: its sessions belong to the server child
// process and leak nothing in this one.
let inProcessSessions = 0;
// pid -> when we spawned it, so a recycled pid can be told apart from a leaked child.
const spawnTimes = new Map();

function openSession({ args = [FIXTURE], cols = 80, rows = 24 } = {}) {
  const terminal = new xterm.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  const child = pty.spawn(process.execPath, args, {
    name: 'xterm-256color', cols, rows, cwd: process.cwd(), env: process.env,
  });
  inProcessSessions += 1;
  if (Number.isInteger(child.pid) && child.pid > 0) spawnTimes.set(child.pid, Date.now());
  return { session: new Session(child, terminal), child, terminal };
}

// Readiness is an observable terminal condition, never a sleep.
async function waitScreen(session, marker, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const snap = await session.observe();
    if (snap.screen.includes(marker)) return snap;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${marker}; last screen:\n${snap.screen}`);
    await session.wait(snap.revision, Math.min(150, Math.max(1, deadline - Date.now())));
  }
}

async function askLine(session, command, marker, timeout = 20000) {
  // Every write needs a fresh revision, and output landing in between makes it
  // stale, so retry the way a real agent has to.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const snap = await session.observe();
    try {
      await session.input({ owner: session.owner, revision: snap.revision, text: `${command}\r` });
      break;
    } catch (error) {
      if (!/Stale observation/.test(error.message) || attempt === 24) throw error;
    }
  }
  return waitScreen(session, marker, timeout);
}

async function snapshot(label) {
  const snap = { at: label, elapsedMs: elapsed(), handles: handleKinds(), memoryMb: memoryMb(), win32: await win32() };
  console.log(`  [${label}] +${snap.elapsedMs}ms handles=${JSON.stringify(snap.handles)} rss=${snap.memoryMb.rss}MB win32=${JSON.stringify(snap.win32)}`);
  return snap;
}

// ---------------------------------------------------------------- phase A
async function phaseSequential(count) {
  console.log(`\nPHASE A: ${count} sequential sessions`);
  const startup = [];
  const close = [];
  const spawned = [];
  let readyFailures = 0;
  let echoFailures = 0;
  const closeErrors = [];
  const trail = [];

  for (let i = 0; i < count; i += 1) {
    const { session, child } = openSession({ cols: 60, rows: 16 });
    spawned.push({ pid: child.pid, session });
    const spawnAt = Date.now();
    try {
      await waitScreen(session, 'FIXTURE READY');
      startup.push(Date.now() - spawnAt);
      try {
        await askLine(session, `echo SEQ-${i}`, `ECHO:SEQ-${i}`, 10000);
      } catch {
        echoFailures += 1;
      }
    } catch {
      readyFailures += 1;
    } finally {
      const closeAt = Date.now();
      await session.close();
      close.push(Date.now() - closeAt);
      // close() absorbs cleanup failures by design so they cannot strand a slot,
      // which means nothing else here would ever see one. Collect them: a close
      // that failed is the leading explanation for a child that outlives it, and
      // without this the two are indistinguishable in the report.
      if (session.closeError) closeErrors.push({ session: i, pid: child.pid, error: session.closeError });
    }
    if (i % 10 === 0 || i === count - 1) {
      trail.push({ session: i, handles: handleKinds(), rssMb: memoryMb().rss });
    }
  }

  // Only a child whose session never reported an exit can be an orphan. Windows
  // recycles pids, and across 100 spawns in about a minute a reuse is likely: a pid
  // that is alive but whose session already reported exit is somebody else's
  // process, not a leaked shell. This is the false positive docs/validation/
  // endurance.md predicts, and it was observed for real here -- the 8s and 38s
  // checks each found exactly one survivor but with DIFFERENT pids, which cannot be
  // the same child and cannot be a process coming back to life.
  const exitedReported = spawned.filter(s => s.session.exit).length;
  const candidates = spawned
    .filter(s => !s.session.exit)
    .map(s => s.pid)
    .filter(p => Number.isInteger(p) && p > 0);
  const unprobeable = spawned.length - exitedReported - candidates.length;

  await new Promise(resolve => setTimeout(resolve, 8000));
  const survivors = await alivePids(candidates);
  // A survivor at 8s is not yet proof of a leak: Session.close() on Windows forks
  // conpty_console_list_agent, which dies with "AttachConsole failed" for an
  // already-exited child, so node-pty only resolves via a 5s timeout -- and a child
  // mid-write when the pseudoconsole closes may take longer still. Waiting again
  // separates "slow teardown" from "orphaned", which a single sample cannot. #24
  // was filed on a single 8s sample and said so; this is what upgrades or retires it.
  let lateSurvivors = survivors;
  if (survivors.length) {
    await new Promise(resolve => setTimeout(resolve, 30000));
    lateSurvivors = await alivePids(candidates);
  }
  return {
    sessions: count, readyFailures, echoFailures,
    closeErrors: closeErrors.length, closeErrorDetail: closeErrors.slice(0, 5),
    startupMs: stats(startup), closeMs: stats(close),
    childrenSurviving: survivors.length, survivorPids: survivors.slice(0, 10),
    // The definitive figure: 0 here with childrenSurviving > 0 means slow teardown,
    // not a leak.
    childrenSurvivingLate: lateSurvivors.length, survivorPidsLate: lateSurvivors.slice(0, 10),
    exitedReported, orphanCandidates: candidates.length, unprobeablePids: unprobeable,
    trail,
  };
}

// ---------------------------------------------------------------- phase B
async function phaseConcurrent(count) {
  console.log(`\nPHASE B: ${count} concurrent sessions`);
  const opened = [];
  const pids = [];
  const spawnAt = Date.now();
  for (let i = 0; i < count; i += 1) {
    const entry = openSession({ cols: 60, rows: 16 });
    opened.push(entry);
    pids.push(entry.child.pid);
  }
  const ready = [];
  for (const [i, { session }] of opened.entries()) {
    try {
      await waitScreen(session, 'FIXTURE READY');
      ready.push(i);
    } catch { /* counted below */ }
  }
  const allReadyMs = Date.now() - spawnAt;
  const peak = await snapshot(`concurrent-peak (${opened.length} open)`);

  // Isolation under concurrency: each session answers only its own token.
  let crossTalk = 0;
  for (const [i, { session }] of opened.entries()) {
    const snap = await askLine(session, `echo CONC-${i}`, `ECHO:CONC-${i}`);
    for (let j = 0; j < opened.length; j += 1) {
      if (j !== i && snap.screen.includes(`CONC-${j}`)) crossTalk += 1;
    }
  }

  const closeStart = Date.now();
  for (const { session } of opened) await session.close();
  const closeAllMs = Date.now() - closeStart;
  await new Promise(resolve => setTimeout(resolve, 8000));
  const survivors = await alivePids(pids);
  return {
    sessions: count, becameReady: ready.length, allReadyMs, crossTalk,
    closeAllMs, peak, childrenSurviving: survivors.length, survivorPids: survivors.slice(0, 10),
  };
}

// ---------------------------------------------------------------- phase C
async function phaseCancellation(count) {
  console.log(`\nPHASE C: ${count} Ctrl+C cancellations`);
  const pids = [];
  let interrupted = 0;
  let wrongCode = 0;
  const latencies = [];
  for (let i = 0; i < count; i += 1) {
    const { session, child } = openSession({ args: [SIGINT_FIXTURE], cols: 60, rows: 12 });
    pids.push(child.pid);
    try {
      const ready = await waitScreen(session, 'WAITING-FOR-CTRL-C', 10000);
      const sentAt = Date.now();
      await session.input({ owner: session.owner, revision: ready.revision, text: '\x03' });
      let exited = null;
      const deadline = Date.now() + 10000;
      for (;;) {
        const snap = await session.observe();
        if (!snap.running) { exited = snap; break; }
        if (Date.now() > deadline) break;
        await session.wait(snap.revision, 100);
      }
      if (exited?.screen.includes('GOT-SIGINT')) interrupted += 1;
      if (exited?.exit?.exitCode === 130) latencies.push(Date.now() - sentAt); else wrongCode += 1;
    } catch {
      wrongCode += 1;
    } finally {
      await session.close();
    }
  }
  await new Promise(resolve => setTimeout(resolve, 8000));
  const survivors = await alivePids(pids);
  return { attempts: count, interrupted, wrongExitCode: wrongCode, interruptLatencyMs: stats(latencies), childrenSurviving: survivors.length };
}

// ---------------------------------------------------------------- phase D
async function phaseUnexpectedExit(count) {
  console.log(`\nPHASE D: ${count} unexpected child terminations`);
  const pids = [];
  let detected = 0;
  let inputRejected = 0;
  let recoveryOk = 0;
  for (let i = 0; i < count; i += 1) {
    const { session, child } = openSession({ cols: 60, rows: 12 });
    pids.push(child.pid);
    try {
      await waitScreen(session, 'FIXTURE READY', 10000);
      await run('taskkill', ['/F', '/T', '/PID', String(child.pid)]).catch(() => {});
      let exited = null;
      const deadline = Date.now() + 10000;
      for (;;) {
        const snap = await session.observe();
        if (!snap.running) { exited = snap; break; }
        if (Date.now() > deadline) break;
        await session.wait(snap.revision, 100);
      }
      if (exited?.state === 'exited' && exited.exit) detected += 1;
      try {
        await session.input({ owner: session.owner, revision: exited?.revision ?? 0, text: 'x' });
      } catch (error) {
        if (/Session not running/.test(error.message)) inputRejected += 1;
      }
      // The runtime must still be able to serve a fresh session.
      const next = openSession({ cols: 60, rows: 12 });
      try {
        await waitScreen(next.session, 'FIXTURE READY', 10000);
        recoveryOk += 1;
        pids.push(next.child.pid);
      } catch { /* counted by shortfall */ } finally {
        await next.session.close();
      }
    } catch { /* counted by shortfall */ } finally {
      await session.close();
    }
  }
  await new Promise(resolve => setTimeout(resolve, 8000));
  const survivors = await alivePids(pids);
  // Issue #24 asks the question this answers: does the survivor exit if given longer than the
  // settle window? One that is gone at +30 s was slow teardown (a timing leak); one still alive is
  // an orphan. Phase A has had this check since the first leak; phase D did not, which is why every
  // D breach recorded a count and nothing that could classify it.
  let lateSurvivors = [];
  if (survivors.length) {
    await new Promise(resolve => setTimeout(resolve, 30000));
    lateSurvivors = await alivePids(survivors);
  }
  return {
    attempts: count, exitDetected: detected, inputRejected, recoveredWithNewSession: recoveryOk,
    childrenSurviving: survivors.length, survivorPids: survivors.slice(0, 10),
    childrenSurvivingLate: lateSurvivors.length, survivorPidsLate: lateSurvivors.slice(0, 10),
  };
}

// ---------------------------------------------------------------- phase E
async function phaseResize(cycles) {
  console.log(`\nPHASE E: ${cycles} repeated resizes on one session`);
  const { session, child } = openSession({ cols: 80, rows: 24 });
  const pids = [child.pid];
  const sizes = [[60, 10], [100, 30], [40, 8], [120, 40], [80, 24]];
  let mismatches = 0;
  let checked = 0;
  let writes = 0;
  let writeErrors = 0;

  // Each sample clears the screen first and waits on a numbered marker. Waiting
  // on a bare 'SIZE:' would match the previous sample still on screen and spin
  // hot, issuing hundreds of thousands of writes per second -- which is how the
  // unguarded ConPTY input-socket crash was originally found.
  let redraws = 0;
  const readChildSize = async () => {
    redraws += 1;
    await askLine(session, 'redraw', `REDRAW-${redraws}`);
    writes += 2;
    const snap = await askLine(session, 'size', 'SIZE:');
    return snap.screen.split('\n').filter(l => l.startsWith('SIZE:')).pop() ?? '';
  };

  try {
    await waitScreen(session, 'FIXTURE READY');
    for (let i = 0; i < cycles; i += 1) {
      const [cols, rows] = sizes[i % sizes.length];
      await session.resize(session.owner, cols, rows);
      // The child learns the new geometry asynchronously, so poll for it.
      const deadline = Date.now() + 5000;
      let seen = await readChildSize();
      while (seen !== `SIZE:${cols}x${rows}` && Date.now() < deadline) seen = await readChildSize();
      checked += 1;
      if (seen !== `SIZE:${cols}x${rows}`) mismatches += 1;
    }
  } finally {
    writeErrors = (await session.observe()).writeErrors;
    await session.close();
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
  return {
    cycles, checked, childDisagreements: mismatches, writes, writeErrors,
    childrenSurviving: (await alivePids(pids)).length,
  };
}

// ---------------------------------------------------------------- phase F
async function phaseInput(count) {
  console.log(`\nPHASE F: ${count} interactive inputs on one session`);
  const { session, child } = openSession({ cols: 100, rows: 30 });
  const pids = [child.pid];
  const latencies = [];
  let failures = 0;
  try {
    await waitScreen(session, 'FIXTURE READY');
    for (let i = 0; i < count; i += 1) {
      const start = Date.now();
      try {
        await askLine(session, `echo IN-${i}`, `ECHO:IN-${i}`, 10000);
        latencies.push(Date.now() - start);
      } catch {
        failures += 1;
      }
      if (i % 50 === 0) await session.resize(session.owner, 100, 30);
    }
  } finally {
    await session.close();
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
  return { inputs: count, failures, roundTripMs: stats(latencies), childrenSurviving: (await alivePids(pids)).length };
}

// ---------------------------------------------------------------- phase G
async function phaseShutdownWithActiveSessions(sessions) {
  console.log(`\nPHASE G: runtime shutdown with ${sessions} active sessions`);
  const child = spawn(process.execPath, [SERVER], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = [];
  const idle = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    try { responses.push(JSON.parse(line)); } catch { responses.push({ corrupt: line }); }
    for (const wake of idle.splice(0)) wake();
  });
  let nextId = 1;
  async function call(method, params, timeout = 20000) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = responses.find(r => r.id === id);
      if (found) {
        if (found.error) throw new Error(`${method}: ${found.error.message}`);
        return found.result;
      }
      if (Date.now() > deadline) throw new Error(`${method} timed out`);
      await Promise.race([new Promise(r => idle.push(r)), new Promise(r => setTimeout(r, 50))]);
    }
  }

  const corrupt = [];
  const created = [];
  try {
    await call('initialize', {});
    for (let i = 0; i < sessions; i += 1) {
      const result = await call('terminal.create', { command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
      created.push(result);
      // Wait for readiness by observation, then leave the session open.
      const deadline = Date.now() + 15000;
      for (;;) {
        const observed = await call('terminal.observe', { sessionId: result.sessionId });
        if (observed.screen.includes('FIXTURE READY')) break;
        if (Date.now() > deadline) break;
        await call('terminal.wait', { sessionId: result.sessionId, afterRevision: observed.revision, timeoutMs: 200 });
      }
    }
  } catch (error) {
    corrupt.push(error.message);
  }

  const pids = created.map(c => c.pid).filter(p => Number.isInteger(p));
  const stdinClosedAt = Date.now();
  child.stdin.end();
  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('TIMEOUT'), 60000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const shutdownMs = Date.now() - stdinClosedAt;
  await new Promise(resolve => setTimeout(resolve, 5000));
  const survivors = await alivePids(pids);
  return {
    sessionsCreated: created.length, errors: corrupt, exitCode, shutdownMs,
    childrenSurviving: survivors.length, survivorPids: survivors.slice(0, 10),
  };
}

// ------------------------------------------------- acceptance thresholds (#16)
// This harness reported measurements nobody could fail. These limits make it an
// assertion. Every number has a stated reason, so a breach reads as a regression
// rather than as noise -- and so raising one later has to confront the reason.
//
// Two of them encode a KNOWN UPSTREAM COST rather than a target. node-pty 1.1.0
// leaks exactly one libuv Socket per create/close cycle (WindowsPtyAgent._inSocket
// is never destroyed, only marked unreadable) plus roughly 1.75 Win32 handles, and
// neither is reclaimable through its public API. Those two are therefore expressed
// PER SESSION CREATED: they accept the documented leak and fail anything
// materially worse, which is the only honest bound while the dependency stays
// pinned at the current stable release.
const ASSERT = process.argv.includes('--assert');

// Everything in this table is enforced by evaluateThresholds below, and every
// check evaluateThresholds performs is listed here. The two were allowed to drift
// apart once already -- `cancellationRate` and `exitDetectionRate` sat here, were
// documented as limits and counted in the summary, but nothing ever read them. The
// intent they expressed is enforced directly, by comparing each phase's success
// count against that phase's own attempt count, which is strictly stronger than a
// rate and cannot go stale against a changed phase size.
const THRESHOLDS = {
  // Hard correctness limits -- no tolerance, any breach is a defect.
  childrenSurvivingPerPhase: 0,   // a surviving child is a leaked shell process
  readyFailures: 0,               // a session that never became operational
  echoFailures: 0,                // a round trip that did not come back
  inputFailures: 0,               // an accepted write that failed
  crossTalk: 0,                   // output appearing in the wrong session
  childDisagreements: 0,          // runtime geometry differing from the child's own
  writeErrors: 0,                 // asynchronous writes lost
  wrongExitCode: 0,               // Ctrl+C reporting anything but 130/1
  closeErrors: 0,                 // a close() that had to absorb a cleanup failure

  // Phase G drives a real server child over stdio, so it has failure modes the
  // in-process phases do not. Each is asserted; without these, a phase G in which
  // initialize failed and no session was ever created would report
  // childrenSurviving 0 and pass having measured nothing.
  maxShutdownMs: 30000,           // stdin EOF to host exit; measured 5082ms
  runtimeExitCode: 0,             // the host must exit cleanly, not 'TIMEOUT'

  // Per-session resource budgets. See the note above: these bound a known leak.
  maxSocketLeakPerSession: 1.5,       // measured 1.00 on node-pty 1.1.0
  maxWin32HandleLeakPerSession: 3,    // measured ~1.75 on node-pty 1.1.0

  // Absolute budgets that must not scale with session count at all.
  maxMessagePortGrowth: 2,   // ConPTY conout workers; kill() disposes them
  maxThreadGrowth: 5,
  maxRssGrowthMb: 250,

  // Latency ceilings, p95. Generous on purpose: these catch a hang or an order of
  // magnitude regression, not a busy runner.
  maxStartupP95Ms: 10000,
  maxCloseP95Ms: 5000,
  maxInputRoundTripP95Ms: 5000,
  maxInterruptP95Ms: 5000,
};

function evaluateThresholds(r) {
  const breaches = [];
  const skip = [];
  // A missing limit is a defect in this function, not a pass. `v < undefined` and
  // `v > undefined` are both false, so a limit sourced from a phase that never ran
  // used to sail through silently.
  const check = (name, value, limit, worse = (v, l) => v > l) => {
    if (value === undefined || value === null || Number.isNaN(value)) { skip.push(name); return; }
    if (limit === undefined || limit === null || Number.isNaN(limit)) {
      breaches.push({ threshold: name, value, limit: 'missing -- the phase that supplies it did not report' });
      return;
    }
    if (worse(value, limit)) breaches.push({ threshold: name, value, limit });
  };
  const P = r.phases;

  // Every phase, without exception, must leave nothing running. Where a phase
  // re-checks after a longer settle, the late figure is the definitive one: a pid
  // alive at 8s and gone at 38s is a slow teardown, not an orphan.
  for (const [name, ph] of Object.entries(P)) {
    const surviving = ph?.childrenSurvivingLate ?? ph?.childrenSurviving;
    check(`${name}.childrenSurviving`, surviving, THRESHOLDS.childrenSurvivingPerPhase);
  }

  check('A.readyFailures', P.A_sequential?.readyFailures, THRESHOLDS.readyFailures);
  check('A.echoFailures', P.A_sequential?.echoFailures, THRESHOLDS.echoFailures);
  check('A.startupMs.p95', P.A_sequential?.startupMs?.p95, THRESHOLDS.maxStartupP95Ms);
  check('A.closeMs.p95', P.A_sequential?.closeMs?.p95, THRESHOLDS.maxCloseP95Ms);

  check('B.crossTalk', P.B_concurrent?.crossTalk, THRESHOLDS.crossTalk);
  check('B.becameReady', P.B_concurrent?.becameReady, P.B_concurrent?.sessions, (v, l) => v < l);

  check('C.interrupted', P.C_cancellation?.interrupted, P.C_cancellation?.attempts, (v, l) => v < l);
  check('C.wrongExitCode', P.C_cancellation?.wrongExitCode, THRESHOLDS.wrongExitCode);
  check('C.interruptLatencyMs.p95', P.C_cancellation?.interruptLatencyMs?.p95, THRESHOLDS.maxInterruptP95Ms);

  check('D.exitDetected', P.D_unexpectedExit?.exitDetected, P.D_unexpectedExit?.attempts, (v, l) => v < l);
  check('D.inputRejected', P.D_unexpectedExit?.inputRejected, P.D_unexpectedExit?.attempts, (v, l) => v < l);
  // recoveredWithNewSession is a COUNT of successful recoveries, not a boolean:
  // every crashed session must be followed by a working replacement.
  check('D.recoveredWithNewSession', P.D_unexpectedExit?.recoveredWithNewSession, P.D_unexpectedExit?.attempts, (v, l) => v < l);

  check('E.childDisagreements', P.E_resize?.childDisagreements, THRESHOLDS.childDisagreements);
  check('E.writeErrors', P.E_resize?.writeErrors, THRESHOLDS.writeErrors);

  check('F.failures', P.F_input?.failures, THRESHOLDS.inputFailures);
  check('F.roundTripMs.p95', P.F_input?.roundTripMs?.p95, THRESHOLDS.maxInputRoundTripP95Ms);

  // Phase G drives a real server child over stdio, so it can fail in ways the
  // in-process phases cannot -- and all of them used to go unasserted. The only
  // field read before was childrenSurviving, which a phase that never managed to
  // create a single session also satisfies.
  const G = P.G_shutdownWithActiveSessions;
  check('G.sessionsCreated', G?.sessionsCreated, n(5), (v, l) => v < l);
  check('G.protocolErrors', G?.errors?.length, 0);
  // exitCode is the string 'TIMEOUT' when the host never exited inside 60s, which
  // no numeric comparison would catch.
  check('G.runtimeExitCode', G?.exitCode, THRESHOLDS.runtimeExitCode,
    (v, l) => v !== l);
  check('G.shutdownMs', G?.shutdownMs, THRESHOLDS.maxShutdownMs);
  check('G.childrenSurviving', G?.childrenSurviving, THRESHOLDS.childrenSurvivingPerPhase);

  // A close that had to absorb a cleanup failure is reported by Session.close()
  // rather than thrown, so it is invisible to every other check here. Phase A
  // collects them; a non-zero count means a child may have been left in an
  // undefined state, which is the leading candidate for the #24 survivor.
  check('A.closeErrors', P.A_sequential?.closeErrors, THRESHOLDS.closeErrors);

  // Resource growth is measured baseline -> final, after the 10s settle, so it
  // reflects what the process is still holding rather than what it peaked at.
  const { baseline: base, final } = r;
  if (base && final) {
    // Counted at the source rather than reconstructed from phase totals. The
    // reconstruction was wrong in both directions: it omitted the replacement
    // session phase D spawns per attempt and the single session each of phases E
    // and F uses (22 cycles at scale 1), and it added phase G's 5 sessions, which
    // live in the SERVER child process and leak nothing here. That gave 155
    // against a true 172, publishing 1.11/1.94 per session where the real rates
    // are 1.00/1.75 -- and enforcing a limit ~11% stricter than the reasoning that
    // chose it.
    const sessionsCreated = inProcessSessions;
    const socketGrowth = (final.handles?.Socket ?? 0) - (base.handles?.Socket ?? 0);
    const portGrowth = (final.handles?.MessagePort ?? 0) - (base.handles?.MessagePort ?? 0);
    const rssGrowthMb = Number((final.memoryMb.rss - base.memoryMb.rss).toFixed(1));

    check('socketGrowthPerSession', sessionsCreated ? Number((socketGrowth / sessionsCreated).toFixed(2)) : 0,
      THRESHOLDS.maxSocketLeakPerSession);
    check('messagePortGrowth', portGrowth, THRESHOLDS.maxMessagePortGrowth);
    check('rssGrowthMb', rssGrowthMb, THRESHOLDS.maxRssGrowthMb);

    if (Number.isFinite(final.win32?.handles) && Number.isFinite(base.win32?.handles)) {
      const handleGrowth = final.win32.handles - base.win32.handles;
      check('win32HandleGrowthPerSession', sessionsCreated ? Number((handleGrowth / sessionsCreated).toFixed(2)) : 0,
        THRESHOLDS.maxWin32HandleLeakPerSession);
      check('threadGrowth', final.win32.threads - base.win32.threads, THRESHOLDS.maxThreadGrowth);
      r.thresholdInputs = { sessionsCreated, socketGrowth, handleGrowth, messagePortGrowth: portGrowth, rssGrowthMb };
    } else {
      r.thresholdInputs = { sessionsCreated, socketGrowth, messagePortGrowth: portGrowth, rssGrowthMb, win32: 'unavailable' };
    }
  }
  return { breaches, skipped: skip };
}

// ---------------------------------------------------------------- driver
console.log(`lifecycle stress: node ${process.version} ${process.arch} scale=${SCALE}`);

// Each phase is isolated. An abort inside one used to propagate out of the driver
// and skip evaluateThresholds entirely, so the run ended with an unstructured stack
// instead of a BREACH line -- and the thresholds that phase existed to enforce
// (B.becameReady, E.writeErrors) could not breach in exactly the failure modes they
// name. A failed phase is now recorded, the rest still run, and the failure itself
// becomes a breach so it cannot read as a pass.
const phaseErrors = [];
async function phase(name, fn) {
  try {
    return await fn();
  } catch (error) {
    const detail = String(error?.message ?? error);
    phaseErrors.push({ phase: name, error: detail });
    console.error(`PHASE ${name} ABORTED: ${detail}`);
    return { aborted: true, error: detail };
  }
}
async function snap(label) {
  try {
    return await snapshot(label);
  } catch (error) {
    phaseErrors.push({ phase: `snapshot:${label}`, error: String(error?.message ?? error) });
    return null;
  }
}

try {
  report.baseline = await snap('baseline');

  report.phases.A_sequential = await phase('A_sequential', () => phaseSequential(n(100)));
  report.peakAfterA = await snap('after A');

  report.phases.B_concurrent = await phase('B_concurrent', () => phaseConcurrent(n(10)));
  report.peakAfterB = await snap('after B');

  report.phases.C_cancellation = await phase('C_cancellation', () => phaseCancellation(n(20)));
  report.phases.D_unexpectedExit = await phase('D_unexpectedExit', () => phaseUnexpectedExit(n(20)));
  report.peakAfterD = await snap('after D');

  report.phases.E_resize = await phase('E_resize', () => phaseResize(n(25)));
  report.phases.F_input = await phase('F_input', () => phaseInput(n(200)));
  report.peakAfterF = await snap('after F');

  report.phases.G_shutdownWithActiveSessions =
    await phase('G_shutdownWithActiveSessions', () => phaseShutdownWithActiveSessions(n(5)));
} catch (error) {
  phaseErrors.push({ phase: 'driver', error: String(error?.message ?? error) });
  console.error(`DRIVER ABORTED: ${error?.stack ?? error}`);
}

await new Promise(resolve => setTimeout(resolve, 10000));
report.final = await snap('final');
report.totalMs = elapsed();
report.phaseErrors = phaseErrors;
report.inProcessSessions = inProcessSessions;

if (ASSERT) {
  const { breaches, skipped } = evaluateThresholds(report);
  report.thresholds = THRESHOLDS;
  for (const failure of phaseErrors) {
    breaches.push({ threshold: `phaseCompleted:${failure.phase}`, value: failure.error, limit: 'no error' });
  }
  report.breaches = breaches;
  report.skippedChecks = skipped;
  for (const breach of breaches) console.log(`BREACH ${JSON.stringify(breach)}`);
  // A skipped check is not a passing one. Named explicitly so a run where a phase
  // never reported cannot be read as clean.
  if (skipped.length) console.log(`SKIPPED ${skipped.length} check(s) for want of a measurement: ${skipped.join(', ')}`);
  console.log(`THRESHOLDS ${breaches.length} breach(es), ${skipped.length} skipped, `
    + `${Object.keys(THRESHOLDS).length} declared limits, ${inProcessSessions} in-process sessions`);
  process.exitCode = breaches.length ? 1 : 0;
}

process.on('exit', code => {
  report.exitCode = code;
  console.log('RESULT ' + JSON.stringify(report));
});
setTimeout(() => {
  console.error(`GUARD: stress harness still alive at +${elapsed()}ms, handles=${JSON.stringify(handleKinds())}`);
  process.exit(97);
}, 15 * 60000).unref();
