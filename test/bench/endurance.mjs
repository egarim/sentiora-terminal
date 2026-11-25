// Duration-driven endurance harness (issue #18).
//
// Usage:
//   node test/bench/endurance.mjs --tier=1h|8h|24h
//   node test/bench/endurance.mjs --minutes=90 [--pool=4] [--max-churn=250]
//                                 [--sample-seconds=30] [--out=path.jsonl]
//                                 [--smoke]
//
// One long-lived src/server.js host is driven over its real stdio transport for
// the whole duration. Restarting the host would defeat the point: this measures
// whether a single runtime process degrades over hours.
//
// TWO workloads run concurrently, because they measure different things and one
// of them has a hard external ceiling:
//
//   pool    `--pool` sessions opened once and exercised continuously (type, wait
//           for the echo, observe, occasional resize). This is the sustained-use
//           case and its resource profile must be FLAT. Growth here is a defect.
//
//   churn   one create -> ready -> close cycle every `churnIntervalMs`. This
//           measures the per-session leak rate. node-pty 1.1.0 leaks one libuv
//           Socket and ~1.75 Win32 handles per create/close cycle and never
//           reclaims them, and stops creating sessions near 495 with "Invalid pty
//           handle", so total churn is capped by `--max-churn` and the interval is
//           derived from the duration to stay under that cap. Exceeding it would
//           measure node-pty's ceiling rather than this runtime's endurance.
//
// Thresholds are checked at the end and the exit code distinguishes outcomes, so
// "ran and passed" can never be confused with "ran and degraded" or "did not run":
//   0  completed the full requested duration and met every threshold
//   1  completed but breached at least one threshold
//   2  the host process died during the run
//   3  a stall was detected (no progress within --stall-timeout-ms)
//   4  the run was interrupted before the requested duration (Ctrl-C, host timeout)
//
// The time series is preserved as JSON Lines at --out so a long run can be
// analysed afterwards rather than reduced to its summary.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const here = import.meta.url;
const SERVER = fileURLToPath(new URL('../../src/server.js', here));
const FIXTURE = fileURLToPath(new URL('../fixtures/interactive.mjs', here));
const REPO_ROOT = fileURLToPath(new URL('../..', here));

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const flag = name => argv.includes(`--${name}`);

const TIERS = { smoke: 2, '1h': 60, '8h': 480, '24h': 1440 };
const tier = arg('tier', null);
const SMOKE = flag('smoke');
const MINUTES = SMOKE ? Number(arg('minutes', 2))
  : tier ? TIERS[tier] ?? Number(arg('minutes', 0))
    : Number(arg('minutes', 0));

if (!Number.isFinite(MINUTES) || MINUTES <= 0) {
  console.error('usage: --tier=1h|8h|24h or --minutes=N (or --smoke for a 2 minute shakedown)');
  process.exit(64);
}

const POOL = Number(arg('pool', 4));
const MAX_CHURN = Number(arg('max-churn', 250));
const SAMPLE_SECONDS = Number(arg('sample-seconds', 30));
const STALL_TIMEOUT_MS = Number(arg('stall-timeout-ms', 120000));
const REQUEST_TIMEOUT_MS = Number(arg('request-timeout-ms', 30000));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(arg('out', `artifacts/endurance-${tier ?? `${MINUTES}m`}-${stamp}.jsonl`));

// Derived: keep total churn under the cap, but never churn faster than once per
// 30s -- a tight churn loop measures the leak, not endurance.
const durationMs = MINUTES * 60000;
const churnIntervalMs = Math.max(30000, Math.floor(durationMs / Math.max(1, MAX_CHURN)));

// Thresholds. Compared as (median of the final quartile) - (median of the second
// quartile), skipping the first quartile as warm-up, so a one-off spike neither
// passes nor fails the run on its own.
//
// Handle growth is thresholded PER CHURN CYCLE rather than absolutely, because
// node-pty 1.1.0 leaks roughly 1.75 Win32 handles per create/close and never
// reclaims them -- a known upstream cost, not a defect in this runtime. An
// absolute bound would either fail every long run or be so loose it caught
// nothing. A per-cycle rate catches a regression that makes the leak worse while
// accepting the documented baseline.
const THRESHOLDS = {
  maxRssGrowthMb: Number(arg('max-rss-growth-mb', 150)),
  maxHandleGrowthPerChurn: Number(arg('max-handle-growth-per-churn', 4)),
  maxThreadGrowth: Number(arg('max-thread-growth', 20)),
  maxErrorRate: Number(arg('max-error-rate', 0.001)),
  maxStalls: Number(arg('max-stalls', 0)),
  maxP95LatencyMs: Number(arg('max-p95-latency-ms', 2000)),
  maxOrphans: Number(arg('max-orphans', 0)),
};

// ------------------------------------------------------------------- platform
// The host is a subprocess, so its resources have to be sampled from outside.
// Each platform gets the most it can offer cheaply; anything unavailable is
// reported as null rather than guessed at.
async function sampleHost(pid) {
  if (process.platform === 'win32') {
    const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`
      + `if($p){"$($p.WorkingSet64) $($p.HandleCount) $($p.Threads.Count)"}else{"gone"}`;
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
      const text = stdout.trim();
      if (!text || text === 'gone') return { gone: true };
      const [workingSet, handles, threads] = text.split(/\s+/).map(Number);
      return { rssMb: Number((workingSet / 1048576).toFixed(1)), handles, threads };
    } catch { return { error: true }; }
  }
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN);
      const threads = Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? NaN);
      let fds = null;
      try { fds = readdirSync(`/proc/${pid}/fd`).length; } catch { /* not permitted */ }
      return { rssMb: Number((rssKb / 1024).toFixed(1)), handles: fds, threads };
    } catch { return { gone: true }; }
  }
  // macOS: ps gives resident size but not a handle or thread count cheaply, so
  // those are reported as null rather than approximated.
  try {
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
    const rssKb = Number(stdout.trim());
    if (!Number.isFinite(rssKb)) return { gone: true };
    return { rssMb: Number((rssKb / 1024).toFixed(1)), handles: null, threads: null };
  } catch { return { gone: true }; }
}

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// ------------------------------------------------------------------- rpc client
const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95),
    p99: at(0.99), max: sorted[sorted.length - 1],
    mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)),
  };
};

function startHost() {
  const child = spawn(process.execPath, [SERVER], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrTail = '';
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4000); });
  child.stdin.on('error', () => {});

  let exitInfo = null;
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });

  const pending = new Map();
  let buffered = '';
  let corruptLines = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { corruptLines += 1; continue; }
      const wake = pending.get(message.id);
      if (wake) { pending.delete(message.id); wake(message); }
    }
  });

  let nextId = 1;
  async function call(method, params, timeout = REQUEST_TIMEOUT_MS) {
    if (exitInfo) throw Object.assign(new Error(`host exited (${JSON.stringify(exitInfo)})`), { hostDied: true });
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const message = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeout}ms`), { timedOut: true }));
      }, timeout);
      pending.set(id, response => { clearTimeout(timer); resolvePromise(response); });
    });
    if (message.error) throw Object.assign(new Error(`${method}: ${message.error.message}`), { rpcError: true });
    return message.result;
  }

  return {
    child, call,
    get pid() { return child.pid; },
    get exitInfo() { return exitInfo; },
    get stderrTail() { return stderrTail; },
    get corruptLines() { return corruptLines; },
    async stop() {
      if (!exitInfo) child.stdin.end();
      await new Promise(resolve => {
        if (exitInfo) { resolve(); return; }
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 60000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      return exitInfo;
    },
  };
}

// -------------------------------------------------------------------- counters
const counters = {
  cycles: 0, creates: 0, closes: 0, writes: 0, observes: 0, waits: 0, resizes: 0,
  churnCycles: 0, errors: 0, timeouts: 0, rpcErrors: 0, hostDeaths: 0,
};
const latencies = { create: [], ready: [], write: [], observe: [], resize: [], close: [], cycle: [] };
const errorMessages = new Map();
// Every child pid the host ever spawned, not just the ones a sample happened to
// catch: an orphan check over sampled pids only would miss short-lived churn
// sessions, which are the ones most likely to be dropped.
const allPids = new Set();
let stalls = 0;
const recordError = error => {
  counters.errors += 1;
  if (error?.timedOut) counters.timeouts += 1;
  if (error?.rpcError) counters.rpcErrors += 1;
  if (error?.hostDied) counters.hostDeaths += 1;
  const key = String(error?.message ?? error).slice(0, 160);
  errorMessages.set(key, (errorMessages.get(key) ?? 0) + 1);
};

// Progress heartbeat per worker, checked by the watchdog.
const lastProgress = new Map();
const touch = worker => lastProgress.set(worker, Date.now());

const series = [];
mkdirSync(dirname(OUT), { recursive: true });
const writeSeries = record => { series.push(record); appendFileSync(OUT, `${JSON.stringify(record)}\n`); };

// Wait for readiness by observation, never by sleeping: a spawned process is not
// the same as an operational terminal.
async function waitReady(host, sessionId, marker = 'FIXTURE READY', timeout = 30000) {
  const started = Date.now();
  const deadline = started + timeout;
  for (;;) {
    const observed = await host.call('terminal.observe', { sessionId });
    counters.observes += 1;
    if (observed.screen.includes(marker)) { latencies.ready.push(Date.now() - started); return observed; }
    if (Date.now() > deadline) throw new Error(`session never showed ${marker}`);
    await host.call('terminal.wait', { sessionId, afterRevision: observed.revision, timeoutMs: 250 });
    counters.waits += 1;
  }
}

// Every write must be armed with a fresh revision, and output landing in between
// makes it stale, so retry the way a real agent has to.
async function sendLine(host, sessionId, owner, text, marker, worker) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const observed = await host.call('terminal.observe', { sessionId });
    counters.observes += 1;
    touch(worker);
    const started = Date.now();
    try {
      await host.call('terminal.type', { sessionId, owner, revision: observed.revision, text: `${text}\r` });
      counters.writes += 1;
      latencies.write.push(Date.now() - started);
      break;
    } catch (error) {
      if (!/Stale observation/.test(error.message) || attempt === 24) throw error;
    }
  }
  return waitReady(host, sessionId, marker);
}

async function openSession(host, worker, cols = 60, rows = 20) {
  const started = Date.now();
  const created = await host.call('terminal.create', { command: process.execPath, args: [FIXTURE], cols, rows });
  counters.creates += 1;
  latencies.create.push(Date.now() - started);
  if (Number.isInteger(created.pid) && created.pid > 0) allPids.add(created.pid);
  touch(worker);
  await waitReady(host, created.sessionId);
  touch(worker);
  return created;
}

async function closeSession(host, created) {
  const started = Date.now();
  await host.call('terminal.close', { sessionId: created.sessionId, owner: created.owner });
  counters.closes += 1;
  latencies.close.push(Date.now() - started);
}

// ------------------------------------------------------------------- workloads
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const deadline = t0 + durationMs;
let aborted = null;

async function poolWorker(host, index) {
  const worker = `pool-${index}`;
  let serial = 0;
  let session = null;
  try {
    session = await openSession(host, worker);
    while (!aborted && Date.now() < deadline) {
      serial += 1;
      const marker = `ECHO:POOL-${index}-${serial}`;
      await sendLine(host, session.sessionId, session.owner, `echo POOL-${index}-${serial}`, marker, worker);
      counters.cycles += 1;
      if (serial % 20 === 0) {
        const started = Date.now();
        const cols = 60 + (serial % 3) * 10;
        await host.call('terminal.resize', { sessionId: session.sessionId, owner: session.owner, cols, rows: 20 });
        counters.resizes += 1;
        latencies.resize.push(Date.now() - started);
        touch(worker);
      }
      // Pace the pool: without this it spins as fast as the emulator can parse and
      // measures CPU rather than endurance.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    recordError(error);
    if (error?.hostDied) aborted = aborted ?? { reason: 'host-died', worker, error: error.message };
  } finally {
    if (session && !host.exitInfo) { try { await closeSession(host, session); } catch (error) { recordError(error); } }
  }
}

async function churnWorker(host) {
  const worker = 'churn';
  try {
    while (!aborted && Date.now() < deadline && counters.churnCycles < MAX_CHURN) {
      const started = Date.now();
      let created = null;
      try {
        created = await openSession(host, worker, 40, 10);
        await sendLine(host, created.sessionId, created.owner, 'echo CHURN', 'ECHO:CHURN', worker);
        await closeSession(host, created);
        counters.churnCycles += 1;
        counters.cycles += 1;
        latencies.cycle.push(Date.now() - started);
        touch(worker);
      } catch (error) {
        recordError(error);
        if (error?.hostDied) { aborted = aborted ?? { reason: 'host-died', worker, error: error.message }; break; }
        if (created) { try { await closeSession(host, created); } catch { /* already reported */ } }
      }
      const wait = Math.max(0, churnIntervalMs - (Date.now() - started));
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  } catch (error) {
    recordError(error);
  }
}

async function sampler(host) {
  const poolPids = [];
  while (!aborted && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, SAMPLE_SECONDS * 1000));
    if (aborted || Date.now() >= deadline) break;
    const hostSample = await sampleHost(host.pid);
    if (hostSample.gone) { aborted = aborted ?? { reason: 'host-gone', worker: 'sampler' }; break; }
    const listed = await host.call('terminal.list', {}).catch(error => { recordError(error); return null; });
    const record = {
      t: elapsed(),
      wallClock: new Date().toISOString(),
      host: hostSample,
      bench: {
        rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
        heapUsedMb: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
      },
      sessions: listed?.length ?? null,
      sessionPids: (listed ?? []).map(s => s.pid).filter(p => Number.isInteger(p) && p > 0),
      counters: { ...counters },
      errorRate: counters.cycles ? Number((counters.errors / counters.cycles).toFixed(6)) : 0,
      stalls,
    };
    poolPids.push(...record.sessionPids);
    writeSeries(record);
    console.log(`  [+${Math.round(record.t / 1000)}s] rss=${record.host.rssMb}MB handles=${record.host.handles} `
      + `threads=${record.host.threads} sessions=${record.sessions} cycles=${counters.cycles} errors=${counters.errors}`);
  }
  return poolPids;
}

// A worker that has not completed an operation within the stall window means the
// host stopped answering -- the deadlock case, which a plain timeout would report
// only as a slow run.
async function watchdog() {
  while (!aborted && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    const now = Date.now();
    for (const [worker, at] of lastProgress) {
      if (now - at > STALL_TIMEOUT_MS) {
        stalls += 1;
        aborted = aborted ?? { reason: 'stall', worker, idleMs: now - at };
        console.error(`STALL: ${worker} made no progress for ${now - at}ms`);
      }
    }
  }
}

// Hard ceiling so a hung harness cannot outlive the run it is measuring.
const guard = setTimeout(() => {
  aborted = aborted ?? { reason: 'guard', detail: 'harness exceeded duration + 10 minutes' };
}, durationMs + 10 * 60000);
guard.unref();

// --------------------------------------------------------------- run and report
console.log(`endurance: node ${process.version} ${process.platform}/${process.arch}`);
console.log(`  requested=${MINUTES}m tier=${tier ?? (SMOKE ? 'smoke' : 'custom')} pool=${POOL} `
  + `churnEvery=${Math.round(churnIntervalMs / 1000)}s maxChurn=${MAX_CHURN} sampleEvery=${SAMPLE_SECONDS}s`);
console.log(`  series -> ${OUT}`);

const host = startHost();
let interrupted = false;
const onSigint = () => { interrupted = true; aborted = aborted ?? { reason: 'interrupted' }; };
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigint);

const startedAt = new Date().toISOString();
await host.call('initialize', {});
const workers = [];
for (let i = 0; i < POOL; i += 1) { touch(`pool-${i}`); workers.push(poolWorker(host, i)); }
touch('churn');
workers.push(churnWorker(host));
workers.push(watchdog());
const samplerPromise = sampler(host);

await Promise.all(workers);
await samplerPromise;
const actualMs = elapsed();
// Captured BEFORE asking the host to stop. A host that exits on its own during the
// run is a failure; exit code 0 after stop() is the normal, expected outcome, and
// conflating the two would report every successful run as incomplete.
const hostDiedEarly = host.exitInfo !== null;
const earlyExitInfo = host.exitInfo;
const exitInfo = await host.stop();

// Everything the host ever spawned must be gone once it exits; a survivor is an
// orphaned shell, which is the leak this harness exists to catch.
const orphans = [];
{
  const orphansDeadline = Date.now() + 60000;
  for (;;) {
    const live = [...allPids].filter(alive);
    if (!live.length) break;
    if (Date.now() > orphansDeadline) { orphans.push(...live); break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Quartile comparison, skipping warm-up.
const quartileGrowth = (pick) => {
  const values = series.map(pick).filter(v => Number.isFinite(v));
  if (values.length < 8) return null; // too few samples to say anything honest
  const q = Math.floor(values.length / 4);
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return Number((median(values.slice(q * 3)) - median(values.slice(q, q * 2))).toFixed(1));
};

const totalOps = counters.cycles + counters.observes + counters.writes;
const handleGrowth = quartileGrowth(r => r.host.handles);
const churnGrowth = quartileGrowth(r => r.counters.churnCycles);
const measurement = {
  rssGrowthMb: quartileGrowth(r => r.host.rssMb),
  handleGrowth,
  threadGrowth: quartileGrowth(r => r.host.threads),
  // The window's churn count, so the handle rate is measured over the same span as
  // the handle growth rather than over the whole run.
  churnGrowth,
  handleGrowthPerChurn: handleGrowth !== null && churnGrowth
    ? Number((handleGrowth / churnGrowth).toFixed(2))
    : null,
  errorRate: totalOps ? Number((counters.errors / totalOps).toFixed(6)) : 0,
  stalls,
  orphans: orphans.length,
  spawnedPids: allPids.size,
  p95LatencyMs: stats(latencies.cycle)?.p95 ?? stats(latencies.write)?.p95 ?? null,
};

const breaches = [];
const check = (name, value, limit, comparator = (v, l) => v > l) => {
  if (value === null || value === undefined) return; // unmeasurable on this platform
  if (comparator(value, limit)) breaches.push({ threshold: name, value, limit });
};
check('maxRssGrowthMb', measurement.rssGrowthMb, THRESHOLDS.maxRssGrowthMb);
check('maxHandleGrowthPerChurn', measurement.handleGrowthPerChurn, THRESHOLDS.maxHandleGrowthPerChurn);
check('maxThreadGrowth', measurement.threadGrowth, THRESHOLDS.maxThreadGrowth);
check('maxErrorRate', measurement.errorRate, THRESHOLDS.maxErrorRate);
check('maxStalls', measurement.stalls, THRESHOLDS.maxStalls);
check('maxP95LatencyMs', measurement.p95LatencyMs, THRESHOLDS.maxP95LatencyMs);
check('maxOrphans', measurement.orphans, THRESHOLDS.maxOrphans);

const completed = !aborted && !hostDiedEarly && actualMs >= durationMs - 5000;
const result = {
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, arch: process.arch,
  tier: tier ?? (SMOKE ? 'smoke' : 'custom'),
  requestedMinutes: MINUTES,
  actualMinutes: Number((actualMs / 60000).toFixed(2)),
  actualMs,
  // The single field that separates "ran and passed" from "did not finish".
  completed,
  aborted: aborted ?? (hostDiedEarly ? { reason: 'host-exited-early', exitInfo: earlyExitInfo } : null),
  interrupted,
  hostExit: exitInfo,
  hostStderrTail: host.stderrTail.slice(-800),
  corruptResponseLines: host.corruptLines,
  config: { pool: POOL, maxChurn: MAX_CHURN, churnIntervalMs, sampleSeconds: SAMPLE_SECONDS, thresholds: THRESHOLDS },
  counters,
  latency: Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, stats(v)])),
  samples: series.length,
  seriesPath: OUT,
  measurement,
  breaches,
  topErrors: [...errorMessages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([message, count]) => ({ count, message })),
};

console.log(`RESULT ${JSON.stringify(result)}`);

let code = 0;
if (hostDiedEarly || aborted?.reason === 'host-died' || aborted?.reason === 'host-gone') code = 2;
else if (aborted?.reason === 'stall') code = 3;
else if (!completed) code = 4;
else if (breaches.length) code = 1;
console.log(`EXIT ${code} completed=${completed} breaches=${breaches.length} samples=${series.length}`);
process.exit(code);
