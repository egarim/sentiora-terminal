// ConPTY provider benchmark: compares node-pty's default OS ConPTY path
// (useConptyDll:false) against the bundled-DLL path (useConptyDll:true).
//
// Usage: node test/bench/conpty-provider-bench.mjs <os|dll> [trials] [guardMs]
//
// Runs in its own process per configuration so that a hang in one cannot mask
// the other. Prints a JSON summary on the last line.
//
// Deliberately avoids counting conhost.exe: a console-less runner is handed a
// transient conhost for every subprocess it spawns, so that metric measures the
// harness. Child cleanup is checked by exact pid instead, and Win32 handle and
// thread counts come from the process itself.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import { Session } from '../../src/session.js';

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('../fixtures/interactive.mjs', import.meta.url));

const provider = process.argv[2] ?? 'os';
const useConptyDll = provider === 'dll';
const TRIALS = Number(process.argv[3] ?? 30);
const GUARD_MS = Number(process.argv[4] ?? 90000);
const SETTLE_MS = 10000;

const t0 = Date.now();
const elapsed = () => Date.now() - t0;

function handleKinds() {
  const kinds = {};
  for (const h of process._getActiveHandles()) {
    const name = h.constructor?.name ?? typeof h;
    kinds[name] = (kinds[name] ?? 0) + 1;
  }
  return kinds;
}

// Win32 HANDLE count and thread count for this process, from the OS.
async function win32() {
  const script = `$p=Get-Process -Id ${process.pid}; "$($p.HandleCount) $($p.Threads.Count) $([math]::Round($p.WorkingSet64/1MB,1))"`;
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const [handles, threads, wsMb] = stdout.trim().split(/\s+/).map(Number);
    return { handles, threads, workingSetMb: wsMb };
  } catch (error) {
    return { error: error.message };
  }
}

async function alivePids(pids) {
  if (!pids.length) return [];
  // Reject non-positive pids loudly. PID 0 is the System Idle Process and is
  // always present in the tasklist, so an unavailable pid would silently read as
  // "alive forever" and report every child as an orphan. node-pty 1.2.0-beta
  // reports pid 0 until its deferred pty connection completes, which is exactly
  // how this was caught.
  const invalid = pids.filter(pid => !Number.isInteger(pid) || pid <= 0);
  if (invalid.length) {
    throw new Error(`alivePids received ${invalid.length} invalid pid(s): ${invalid.slice(0, 5).join(', ')}`);
  }
  try {
    const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH']);
    const live = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('","')) continue;
      const fields = line.split('","').map(f => f.replace(/^"|"$/g, ''));
      const pid = Number(fields[1]);
      if (Number.isInteger(pid)) live.add(pid);
    }
    return pids.filter(pid => live.has(pid));
  } catch {
    return pids;
  }
}

const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: Number((sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)).toFixed(1)),
  };
};

const summary = {
  provider,
  useConptyDll,
  trials: TRIALS,
  node: process.version,
  arch: process.arch,
  platform: process.platform,
  startedAt: new Date().toISOString(),
};

const startupMs = [];
const closeMs = [];
const roundTripMs = [];
const pids = [];
const handleTrail = [];
let echoOk = 0;
let spawnErrors = [];

summary.baseline = { handles: handleKinds(), rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)), win32: await win32() };

for (let i = 0; i < TRIALS; i += 1) {
  const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 500, allowProposedApi: true });
  let child;
  const spawnAt = Date.now();
  try {
    child = pty.spawn(process.execPath, [FIXTURE], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConptyDll,
    });
  } catch (error) {
    spawnErrors.push({ trial: i, message: error.message });
    terminal.dispose();
    continue;
  }
  const session = new Session(child, terminal);

  // Readiness is an observable terminal condition, never a sleep: poll the
  // emulator until the fixture's banner has actually been rendered.
  let ready = null;
  const readyDeadline = Date.now() + 20000;
  for (;;) {
    const snap = await session.observe();
    if (snap.screen.includes('FIXTURE READY')) { ready = snap; break; }
    if (Date.now() > readyDeadline) break;
    await session.wait(snap.revision, 100);
  }
  if (ready) startupMs.push(Date.now() - spawnAt);
  // Recorded from the observation, after readiness, not from child.pid at spawn:
  // node-pty 1.2.0-beta defers the pty connection and reports pid 0 until then.
  if (ready?.pid) pids.push(ready.pid);

  // One interactive round trip through the revision-guarded input path.
  if (ready) {
    const rtStart = Date.now();
    try {
      const typed = await session.input({ owner: session.owner, revision: ready.revision, text: `echo TRIAL-${i}\r` });
      const rtDeadline = Date.now() + 15000;
      for (;;) {
        const snap = await session.observe();
        if (snap.screen.includes(`ECHO:TRIAL-${i}`)) { echoOk += 1; roundTripMs.push(Date.now() - rtStart); break; }
        if (Date.now() > rtDeadline) break;
        await session.wait(snap.revision, 100);
      }
      void typed;
    } catch (error) {
      spawnErrors.push({ trial: i, phase: 'input', message: error.message });
    }
  }

  const closeAt = Date.now();
  await session.close();
  closeMs.push(Date.now() - closeAt);

  if (i % 5 === 0 || i === TRIALS - 1) {
    handleTrail.push({ trial: i, handles: handleKinds(), rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)) });
  }
}

summary.spawnErrors = spawnErrors;
summary.startupMs = stats(startupMs);
summary.roundTripMs = roundTripMs.length ? stats(roundTripMs) : null;
summary.closeMs = stats(closeMs);
summary.echoOk = echoOk;
summary.handleTrail = handleTrail;
summary.peak = { handles: handleKinds(), rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)), win32: await win32() };

// Cleanup verification by exact pid: no console-host counting.
const aliveImmediately = await alivePids(pids);
await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
const aliveAfterSettle = await alivePids(pids);
summary.cleanup = {
  children: pids.length,
  aliveImmediatelyAfterClose: aliveImmediately.length,
  aliveAfterSettle: aliveAfterSettle.length,
  survivingPids: aliveAfterSettle.slice(0, 10),
};
summary.final = { handles: handleKinds(), rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)), win32: await win32() };
summary.settleMs = SETTLE_MS;
summary.elapsedBeforeDrainMs = elapsed();

process.on('exit', code => {
  summary.timeToNaturalExitMs = elapsed();
  summary.exitCode = code;
  summary.hung = code === 99;
  console.log('RESULT ' + JSON.stringify(summary));
});

// unref'd so the watchdog can never be the reason the process stays alive.
setTimeout(() => {
  console.error(`GUARD: still alive at +${elapsed()}ms, handles=${JSON.stringify(handleKinds())}`);
  process.exit(99);
}, GUARD_MS).unref();
