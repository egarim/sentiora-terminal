// Duration-driven endurance harness (issue #18).
//
// Usage:
//   node test/bench/endurance.mjs --tier=smoke|1h|8h|24h
//   node test/bench/endurance.mjs --minutes=90 [--pool=4] [--max-churn=250]
//                                 [--sample-seconds=30] [--out=path.jsonl]
//
// One long-lived src/server.js host is driven over its real stdio transport for
// the whole duration. Restarting the host would defeat the point: this measures
// whether a single runtime process degrades over hours.
//
// TWO workloads run concurrently, because they measure different things and one
// of them has a hard external ceiling:
//
//   pool    `--pool` sessions opened once and exercised continuously (type, wait
//           for the child to echo it, observe, resize). Sustained use must be
//           FLAT; growth here is a defect in this runtime.
//
//   churn   one create -> ready -> write -> close cycle on an interval. Measures
//           the per-session leak rate. node-pty 1.1.0 leaks one libuv Socket and
//           ~1.75 Win32 handles per cycle and stops creating sessions near 495
//           with "Invalid pty handle", so total churn is capped and the budget is
//           spread across the elapsed duration. Exceeding it would measure
//           node-pty's ceiling and report it as this runtime's failure.
//
// What "completed" means, and why it is hard to earn: the run must reach its
// requested duration on a MONOTONIC clock (a wall-clock step or a suspended
// laptop must not be able to consume the budget without doing the work), every
// workload must have made progress right up to the end, and the host must exit
// cleanly on its own. Exit codes:
//   0  completed the full duration, every workload alive to the end, all
//      thresholds met
//   1  completed but breached at least one threshold
//   2  the host process died during the run
//   3  a stall was detected (no progress within --stall-timeout-ms)
//   4  interrupted before the requested duration (signal, or a workload gave up)
//   5  the harness itself failed (could not sample, could not write the series)
//
// The time series is preserved as JSON Lines at --out so a long run can be
// analysed afterwards rather than reduced to its summary.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

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
const numArg = (name, fallback) => {
  const raw = arg(name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`--${name} must be a number, got ${JSON.stringify(raw)}`);
    process.exit(64);
  }
  return value;
};

const TIERS = { smoke: 2, '1h': 60, '8h': 480, '24h': 1440 };
const tier = arg('tier', null);
if (tier !== null && TIERS[tier] === undefined) {
  console.error(`unknown tier ${JSON.stringify(tier)}; expected one of ${Object.keys(TIERS).join(', ')} `
    + '(or use --minutes=N)');
  process.exit(64);
}
const MINUTES = tier !== null ? TIERS[tier] : numArg('minutes', 0);
if (!Number.isFinite(MINUTES) || MINUTES <= 0) {
  console.error('usage: --tier=smoke|1h|8h|24h or --minutes=N');
  process.exit(64);
}

// Validated rather than trusted: --pool=0 would otherwise produce a green
// "sustained use" run with no sustained use in it, and an out-of-range
// --max-churn would defeat the node-pty ceiling the cap exists to respect.
const POOL = numArg('pool', 4);
if (!Number.isInteger(POOL) || POOL < 1 || POOL > 16) {
  console.error(`--pool must be an integer 1..16, got ${JSON.stringify(arg('pool', 4))}`);
  process.exit(64);
}
const NODE_PTY_SESSION_CEILING = 495;
const MAX_CHURN = numArg('max-churn', 250);
if (!Number.isInteger(MAX_CHURN) || MAX_CHURN < 1 || MAX_CHURN > NODE_PTY_SESSION_CEILING) {
  console.error(`--max-churn must be an integer 1..${NODE_PTY_SESSION_CEILING} (node-pty 1.1.0 stops `
    + `creating sessions near ${NODE_PTY_SESSION_CEILING}), got ${JSON.stringify(arg('max-churn', 250))}`);
  process.exit(64);
}
const SAMPLE_SECONDS = numArg('sample-seconds', 30);
const STALL_TIMEOUT_MS = numArg('stall-timeout-ms', 120000);
const REQUEST_TIMEOUT_MS = numArg('request-timeout-ms', 30000);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(arg('out', `artifacts/endurance-${tier ?? `${MINUTES}m`}-${stamp}.jsonl`));

const durationMs = MINUTES * 60000;
// Churn budget spread over elapsed time rather than run as fast as possible: a
// free-running loop would exhaust the budget early and then measure nothing for
// the rest of the duration.
const churnTargetAt = fraction => Math.floor(fraction * MAX_CHURN);
const churnFloorIntervalMs = 30000;
const churnIntervalEstimateMs = Math.max(churnFloorIntervalMs, Math.floor(durationMs / MAX_CHURN));
// How long a worker may legitimately be silent before the watchdog calls it a
// stall. The churn worker sleeps for most of a long tier -- 346s at 24h -- so a
// single global timeout would flag a healthy idle worker as dead two minutes in
// and abort every long run. Each worker declares its own budget instead: its
// sleep, plus enough request timeouts to cover one wedged cycle.
const STALL_SLACK_MS = 4 * REQUEST_TIMEOUT_MS;

// Thresholds. Growth and degradation compare the median of the FINAL quartile
// against the SECOND quartile, skipping the first as warm-up. Fewer than
// MIN_SAMPLES_FOR_TREND samples reports null, and a null is skipped rather than
// failed -- so the floor is set high enough that a quartile median is not decided
// by a single sample.
const MIN_SAMPLES_FOR_TREND = 20;
const THRESHOLDS = {
  maxRssGrowthMb: numArg('max-rss-growth-mb', 150),
  // Per cycle, not absolute: node-pty 1.1.0 leaks ~1.75 handles per create/close
  // and cannot be fixed from here, so an absolute bound would either fail every
  // long run or be too loose to catch anything. A rate catches a regression.
  maxHandleGrowthPerChurn: numArg('max-handle-growth-per-churn', 4),
  maxThreadGrowth: numArg('max-thread-growth', 20),
  // errors / (successful operations + errors). Deliberately NOT errors/successes:
  // that ratio reports 0 when everything failed.
  maxErrorRate: numArg('max-error-rate', 0.001),
  maxStalls: numArg('max-stalls', 0),
  // Latency is checked as DEGRADATION between quartiles, not as an absolute
  // figure: an absolute ceiling passes a run that got 8x slower over its own
  // duration, which is the thing endurance testing exists to catch.
  maxLatencyDegradationRatio: numArg('max-latency-degradation-ratio', 3),
  maxP95LatencyMs: numArg('max-p95-latency-ms', 5000),
  // Throughput must not collapse: a run that still answers, but ten times slower,
  // is a failure even though no single call breached anything.
  minThroughputRatio: numArg('min-throughput-ratio', 0.5),
  maxOrphans: numArg('max-orphans', 0),
  // Live sessions must stay at pool + at most one transient churn session. If
  // terminal.close stopped releasing registry entries this climbs to 16.
  maxLiveSessions: POOL + 2,
  // A run that could not measure the host's resources is not a pass, however
  // green everything else looks.
  minMeasurableSampleFraction: numArg('min-measurable-sample-fraction', 0.9),
};

// ------------------------------------------------------------------- platform
// Which metrics this platform can provide at all. A metric that is unavailable by
// design is reported as unsupported; one that is available but failed to read is
// counted as a measurement failure and can fail the run. The two must not look
// alike in the output, or "we could not measure" becomes indistinguishable from
// "there was nothing to measure".
const SUPPORTED = {
  win32: ['rss', 'handles', 'threads'],
  linux: ['rss', 'handles', 'threads'],
  darwin: ['rss'],
}[process.platform] ?? ['rss'];

async function sampleHost(pid) {
  if (process.platform === 'win32') {
    const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`
      + `if($p){"$($p.WorkingSet64) $($p.HandleCount) $($p.Threads.Count)"}else{"gone"}`;
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
      const text = stdout.trim();
      if (!text) return { readFailed: true };
      if (text === 'gone') return { gone: true };
      const [workingSet, handles, threads] = text.split(/\s+/).map(Number);
      if (!Number.isFinite(workingSet)) return { readFailed: true };
      return { rssMb: Number((workingSet / 1048576).toFixed(1)), handles, threads };
    } catch { return { readFailed: true }; }
  }
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN);
      const threads = Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? NaN);
      if (!Number.isFinite(rssKb)) return { readFailed: true };
      let fds = null;
      try { fds = readdirSync(`/proc/${pid}/fd`).length; } catch { /* not permitted */ }
      return { rssMb: Number((rssKb / 1024).toFixed(1)), handles: fds, threads };
    } catch { return { gone: true }; }
  }
  // macOS: ps gives resident size but no cheap handle or thread count, so those
  // are reported as unsupported rather than approximated.
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

// ------------------------------------------------------------------- rpc client
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
    // Reports whether a kill was needed: a host that will not exit on stdin EOF is
    // itself a regression (a live ConPTY worker keeps the event loop alive), and
    // silently SIGKILLing it would report that as a clean shutdown.
    async stop() {
      if (!exitInfo) child.stdin.end();
      const graceful = await new Promise(resolve => {
        if (exitInfo) { resolve(true); return; }
        const timer = setTimeout(() => resolve(false), 60000);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!graceful) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise(resolve => {
          if (exitInfo) { resolve(); return; }
          const timer = setTimeout(resolve, 30000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      return { exitInfo, neededKill: !graceful };
    },
  };
}

// -------------------------------------------------------------------- counters
const counters = {
  cycles: 0, creates: 0, closes: 0, writes: 0, observes: 0, waits: 0, resizes: 0,
  churnCycles: 0, errors: 0, timeouts: 0, rpcErrors: 0, hostDeaths: 0,
};
// Every latency series, including observe -- the highest-volume call. Omitting it
// would let a two-order-of-magnitude regression in observation go unmeasured while
// the churn-cycle figure stayed flat.
const latencies = {
  create: [], ready: [], write: [], observe: [], wait: [], resize: [], close: [], cycle: [],
};
// Per-sample windows, so latency and throughput can be compared between quartiles
// instead of only across the whole run.
let windowOps = 0;
let windowCycles = 0;
let windowLatencies = [];
const errorMessages = new Map();
// Every pid the host ever reported, from create responses AND from terminal.list
// samples: a pid that is 0 at create time (node-pty >= 1.2 defers its pty
// connection) still shows up in a later listing, and dropping it would silently
// narrow the orphan check.
const allPids = new Set();
let stalls = 0;
let measurementFailures = 0;

const recordError = error => {
  counters.errors += 1;
  if (error?.timedOut) counters.timeouts += 1;
  if (error?.rpcError) counters.rpcErrors += 1;
  if (error?.hostDied) counters.hostDeaths += 1;
  const key = String(error?.message ?? error).slice(0, 160);
  errorMessages.set(key, (errorMessages.get(key) ?? 0) + 1);
};

// Progress heartbeat per worker, checked by the watchdog. Monotonic, because the
// wall clock can step.
const lastProgress = new Map();
const workerState = new Map();
const touch = worker => { lastProgress.set(worker, performance.now()); };

const series = [];
mkdirSync(dirname(OUT), { recursive: true });
let seriesWriteError = null;
const writeSeries = record => {
  series.push(record);
  try {
    appendFileSync(OUT, `${JSON.stringify(record)}\n`);
  } catch (error) {
    // Recorded rather than thrown: a full disk must not lose a multi-hour run's
    // in-memory summary, and it must not surface as an unhandled rejection with
    // an exit code that means something else.
    seriesWriteError = String(error?.message ?? error);
  }
};

const timed = async (bucket, fn) => {
  const started = performance.now();
  try {
    const value = await fn();
    const ms = performance.now() - started;
    latencies[bucket].push(ms);
    windowLatencies.push(ms);
    windowOps += 1;
    return value;
  } catch (error) {
    recordError(error);
    throw error;
  }
};

// Wait for readiness by observation, never by sleeping: a spawned process is not
// the same as an operational terminal.
async function waitReady(host, sessionId, marker = 'FIXTURE READY', timeout = 30000) {
  const started = performance.now();
  const deadline = started + timeout;
  for (;;) {
    const observed = await timed('observe', () => host.call('terminal.observe', { sessionId }));
    counters.observes += 1;
    if (observed.screen.includes(marker)) { latencies.ready.push(performance.now() - started); return observed; }
    if (performance.now() > deadline) throw new Error(`session never showed ${marker}`);
    await timed('wait', () => host.call('terminal.wait', { sessionId, afterRevision: observed.revision, timeoutMs: 250 }));
    counters.waits += 1;
  }
}

// Every write must be armed with a fresh revision, and output landing in between
// makes it stale. That is ordinary protocol behaviour, not a fault, so it is
// retried rather than counted as an error -- counting it would inflate errorRate
// with noise and eventually abort a healthy run.
async function sendLine(host, sessionId, owner, text, marker, worker) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const observed = await timed('observe', () => host.call('terminal.observe', { sessionId }));
    counters.observes += 1;
    touch(worker);
    const started = performance.now();
    try {
      await host.call('terminal.type', {
        sessionId, owner, revision: observed.revision, text: `${text}\r`,
      });
      const ms = performance.now() - started;
      latencies.write.push(ms);
      windowLatencies.push(ms);
      windowOps += 1;
      counters.writes += 1;
      break;
    } catch (error) {
      if (!/Stale observation/.test(error.message) || attempt === 24) { recordError(error); throw error; }
    }
  }
  return waitReady(host, sessionId, marker);
}

async function openSession(host, worker, cols = 60, rows = 20) {
  const created = await timed('create', () => host.call('terminal.create', {
    command: process.execPath, args: [FIXTURE], cols, rows,
  }));
  counters.creates += 1;
  if (Number.isInteger(created.pid) && created.pid > 0) allPids.add(created.pid);
  touch(worker);
  await waitReady(host, created.sessionId);
  if (Number.isInteger(created.pid) && created.pid > 0) allPids.add(created.pid);
  touch(worker);
  return created;
}

async function closeSession(host, created) {
  await timed('close', () => host.call('terminal.close', { sessionId: created.sessionId, owner: created.owner }));
  counters.closes += 1;
}

// ------------------------------------------------------------------- workloads
// Monotonic throughout: a wall-clock step forward, or a machine suspending
// mid-run, must not be able to consume the budget without the work happening.
const t0 = performance.now();
const elapsed = () => performance.now() - t0;
const deadline = durationMs;
let aborted = null;
const abort = reason => { aborted = aborted ?? { reason, atMs: Math.round(elapsed()) }; };

// Sleeps in slices so a long wait can still be cut short by an abort or the
// deadline. Deliberately does NOT heartbeat: a worker that is idle by design
// declares its own idle budget (maxIdleMs) instead, so faking progress here would
// blind the stall detector -- which is the entire reason the watchdog exists.
async function heartbeatSleep(ms) {
  const slice = 10000;
  let remaining = ms;
  while (remaining > 0 && !aborted && elapsed() < deadline) {
    const step = Math.min(slice, remaining);
    await new Promise(resolve => setTimeout(resolve, step));
    remaining -= step;
  }
}

async function poolWorker(host, index) {
  const worker = `pool-${index}`;
  // One cycle is observe + type + wait + observe; allow a wedged request timeout
  // on each before calling it a stall.
  workerState.set(worker, { finished: false, cycles: 0, maxIdleMs: (4 * REQUEST_TIMEOUT_MS) + 30000 });
  let serial = 0;
  let session = null;
  try {
    session = await openSession(host, worker);
    while (!aborted && elapsed() < deadline) {
      serial += 1;
      const cycleStart = performance.now();
      await sendLine(host, session.sessionId, session.owner, `echo POOL-${index}-${serial}`,
        `ECHO:POOL-${index}-${serial}`, worker);
      counters.cycles += 1;
      windowCycles += 1;
      latencies.cycle.push(performance.now() - cycleStart);
      workerState.get(worker).cycles += 1;
      if (serial % 20 === 0) {
        const cols = 60 + (serial % 3) * 10;
        await timed('resize', () => host.call('terminal.resize', {
          sessionId: session.sessionId, owner: session.owner, cols, rows: 20,
        }));
        counters.resizes += 1;
        touch(worker);
      }
      // Pace the pool: without this it spins as fast as the emulator can parse and
      // measures CPU rather than endurance.
      await heartbeatSleep(250);
    }
    workerState.get(worker).finished = !aborted;
  } catch (error) {
    recordError(error);
    if (error?.hostDied) abort('host-died');
    else abort('pool-worker-died');
    workerState.get(worker).error = String(error?.message ?? error).slice(0, 200);
  } finally {
    if (session && !host.exitInfo) {
      try { await closeSession(host, session); } catch (error) { recordError(error); }
    }
  }
}

async function churnWorker(host) {
  const worker = 'churn';
  workerState.set(worker, { finished: false, cycles: 0, maxIdleMs: churnIntervalEstimateMs + STALL_SLACK_MS });
  try {
    while (!aborted && elapsed() < deadline) {
      // Budget spread over elapsed time, so the cap cannot be exhausted early and
      // leave the rest of the run measuring nothing.
      const budget = churnTargetAt(Math.min(1, elapsed() / durationMs));
      if (counters.churnCycles >= budget || counters.churnCycles >= MAX_CHURN) {
        await heartbeatSleep(churnFloorIntervalMs);
        continue;
      }
      const started = performance.now();
      let created = null;
      try {
        created = await openSession(host, worker, 40, 10);
        await sendLine(host, created.sessionId, created.owner, 'echo CHURN', 'ECHO:CHURN', worker);
        await closeSession(host, created);
        counters.churnCycles += 1;
        counters.cycles += 1;
        windowCycles += 1;
        latencies.cycle.push(performance.now() - started);
        workerState.get(worker).cycles += 1;
        touch(worker);
      } catch (error) {
        recordError(error);
        if (error?.hostDied) { abort('host-died'); break; }
        if (created) { try { await closeSession(host, created); } catch { /* already counted */ } }
      }
      const interval = Math.max(churnFloorIntervalMs,
        Math.floor((durationMs / MAX_CHURN) - (performance.now() - started)));
      // The watchdog's budget has to cover the sleep this worker is about to take,
      // or a long tier flags its own idle worker as stalled.
      workerState.get(worker).maxIdleMs = interval + STALL_SLACK_MS;
      touch(worker);
      await heartbeatSleep(interval);
    }
    workerState.get(worker).finished = !aborted;
  } catch (error) {
    recordError(error);
    abort('churn-worker-died');
    workerState.get(worker).error = String(error?.message ?? error).slice(0, 200);
  }
}

async function sampler(host) {
  let previousCycles = 0;
  let previousAt = performance.now();
  while (!aborted && elapsed() < deadline) {
    await new Promise(resolve => setTimeout(resolve, SAMPLE_SECONDS * 1000));
    if (aborted || elapsed() >= deadline) break;

    const hostSample = await sampleHost(host.pid);
    if (hostSample.gone) { abort('host-gone'); break; }
    if (hostSample.readFailed) measurementFailures += 1;

    let listed = null;
    try {
      listed = await host.call('terminal.list', {});
    } catch (error) {
      recordError(error);
      if (error?.hostDied) { abort('host-died'); break; }
    }
    // Fold the live pids into the orphan set (see allPids).
    for (const entry of listed ?? []) {
      if (Number.isInteger(entry.pid) && entry.pid > 0) allPids.add(entry.pid);
    }

    const now = performance.now();
    const windowMs = now - previousAt;
    const cyclesInWindow = counters.cycles - previousCycles;
    previousCycles = counters.cycles;
    previousAt = now;

    const record = {
      t: Math.round(elapsed()),
      wallClock: new Date().toISOString(),
      host: hostSample,
      bench: {
        rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
        heapUsedMb: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
      },
      sessions: listed?.length ?? null,
      sessionPids: (listed ?? []).map(s => s.pid).filter(p => Number.isInteger(p) && p > 0),
      counters: { ...counters },
      // Throughput and latency for THIS window, so degradation over the run is
      // visible rather than averaged away into a single whole-run figure.
      cyclesPerMinute: windowMs > 0 ? Number(((cyclesInWindow * 60000) / windowMs).toFixed(1)) : null,
      windowP95Ms: (() => { const s = stats(windowLatencies); return s ? s.p95 : null; })(),
      windowOps,
      stalls,
      measurementFailures,
    };
    windowLatencies = [];
    windowOps = 0;
    writeSeries(record);
    console.log(`  [+${Math.round(record.t / 1000)}s] rss=${record.host.rssMb ?? '?'}MB `
      + `handles=${record.host.handles ?? '?'} threads=${record.host.threads ?? '?'} `
      + `sessions=${record.sessions} cycles=${counters.cycles} errors=${counters.errors} `
      + `cpm=${record.cyclesPerMinute}`);
  }
}

// A worker that has not made progress within the stall window means the host
// stopped answering -- the deadlock case, which a plain timeout reports only as a
// slow run.
async function watchdog() {
  while (!aborted && elapsed() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    const now = performance.now();
    for (const [worker, at] of lastProgress) {
      // Per-worker budget: a churn worker on a 24h tier legitimately sleeps ~346s
      // between cycles, so one global timeout would abort a healthy long run.
      const budget = Math.max(STALL_TIMEOUT_MS, workerState.get(worker)?.maxIdleMs ?? 0);
      if (now - at > budget) {
        stalls += 1;
        console.error(`STALL: ${worker} made no progress for ${Math.round(now - at)}ms (budget ${budget}ms)`);
        abort('stall');
      }
    }
  }
}

// --------------------------------------------------------------- run and report
console.log(`endurance: node ${process.version} ${process.platform}/${process.arch}`);
console.log(`  requested=${MINUTES}m tier=${tier ?? 'custom'} pool=${POOL} maxChurn=${MAX_CHURN} `
  + `sampleEvery=${SAMPLE_SECONDS}s stallTimeout=${STALL_TIMEOUT_MS}ms`);
console.log(`  series -> ${OUT}`);

const host = startHost();
let interrupted = false;
const onSignal = signal => { interrupted = true; abort(`interrupted:${signal}`); };
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

// Everything below is guarded: this harness exists to detect orphans, so it must
// not become one when its own startup fails.
let startedAt = null;
let stopReport = { exitInfo: null, neededKill: false };
let workloadsRan = false;
try {
  startedAt = new Date().toISOString();
  await host.call('initialize', {});
  workloadsRan = true;

  const workers = [];
  for (let i = 0; i < POOL; i += 1) { touch(`pool-${i}`); workers.push(poolWorker(host, i)); }
  touch('churn');
  workers.push(churnWorker(host));
  workers.push(watchdog());
  const samplerPromise = sampler(host).catch(error => {
    seriesWriteError = seriesWriteError ?? `sampler failed: ${error?.stack ?? error}`;
    abort('sampler-failed');
  });

  await Promise.all(workers);
  await samplerPromise;
} catch (error) {
  seriesWriteError = seriesWriteError ?? `harness failed: ${error?.stack ?? error}`;
  abort('harness-failed');
} finally {
  stopReport = await host.stop();
}

const actualMs = elapsed();
// An exit is expected during stop(); what must not have happened is an exit the
// workloads noticed first, which is what `aborted` records.
const hostDiedDuringRun = aborted !== null && ['host-died', 'host-gone'].includes(aborted.reason);

// Orphans: everything the host ever spawned must be gone once it exits. Measured
// before any reaping, so the number is real rather than self-fulfilling.
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
for (const pid of orphans) { try { process.kill(pid); } catch { /* gone */ } }

// Quartile trend comparison. Returns null below the sample floor rather than
// producing a number decided by a single sample.
const quartileTrend = (pick, combine = (last, second) => last - second) => {
  const values = series.map(pick).filter(v => Number.isFinite(v));
  if (values.length < MIN_SAMPLES_FOR_TREND) return null;
  const q = Math.floor(values.length / 4);
  if (q < 2) return null;
  const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return Number(combine(median(values.slice(q * 3)), median(values.slice(q, q * 2))).toFixed(2));
};

const measurableSamples = series.filter(s => Number.isFinite(s.host?.rssMb)).length;
const measurableFraction = series.length ? Number((measurableSamples / series.length).toFixed(3)) : 0;

const handleGrowth = quartileTrend(r => r.host.handles);
const churnGrowth = quartileTrend(r => r.counters.churnCycles);
const rssGrowthMb = quartileTrend(r => r.host.rssMb);
const threadGrowth = quartileTrend(r => r.host.threads);
const latencyTrendRatio = quartileTrend(r => r.windowP95Ms,
  (last, second) => (second > 0 ? last / second : null));
const throughputRatio = quartileTrend(r => r.cyclesPerMinute,
  (last, second) => (second > 0 ? last / second : null));

const successOps = counters.cycles + counters.observes + counters.writes + counters.waits
  + counters.resizes + counters.creates + counters.closes;
const attemptedOps = successOps + counters.errors;
const measurement = {
  rssGrowthMb,
  handleGrowth,
  threadGrowth,
  churnGrowth,
  // A rate needs a denominator. If churn produced no cycles inside the comparison
  // window the rate is unknowable, and that is reported as a measurement failure
  // rather than silently skipped -- otherwise a dead churn workload would delete
  // the only leak metric and still look green.
  handleGrowthPerChurn: handleGrowth !== null && churnGrowth > 0
    ? Number((handleGrowth / churnGrowth).toFixed(2))
    : null,
  churnProducedNoCycles: churnGrowth !== null && churnGrowth <= 0,
  errorRate: attemptedOps ? Number((counters.errors / attemptedOps).toFixed(6)) : 0,
  latencyTrendRatio,
  p95LatencyMs: stats(latencies.cycle)?.p95 ?? null,
  p95ObserveMs: stats(latencies.observe)?.p95 ?? null,
  throughputRatio,
  stalls,
  orphans: orphans.length,
  orphanPids: orphans.slice(0, 20),
  spawnedPids: allPids.size,
  maxLiveSessions: Math.max(0, ...series.map(s => s.sessions ?? 0)),
  measurableSamples,
  totalSamples: series.length,
  measurableFraction,
  measurementFailures,
  supportedMetrics: SUPPORTED,
  neededKillToStop: stopReport.neededKill,
  seriesWriteError,
};

const breaches = [];
const check = (name, value, limit, worse) => {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  if (worse(value, limit)) breaches.push({ threshold: name, value, limit });
};
check('maxRssGrowthMb', rssGrowthMb, THRESHOLDS.maxRssGrowthMb, (v, l) => v > l);
check('maxHandleGrowthPerChurn', measurement.handleGrowthPerChurn, THRESHOLDS.maxHandleGrowthPerChurn, (v, l) => v > l);
check('maxThreadGrowth', threadGrowth, THRESHOLDS.maxThreadGrowth, (v, l) => v > l);
check('maxErrorRate', measurement.errorRate, THRESHOLDS.maxErrorRate, (v, l) => v > l);
check('maxStalls', measurement.stalls, THRESHOLDS.maxStalls, (v, l) => v > l);
check('maxP95LatencyMs', measurement.p95LatencyMs, THRESHOLDS.maxP95LatencyMs, (v, l) => v > l);
check('maxLatencyDegradationRatio', latencyTrendRatio, THRESHOLDS.maxLatencyDegradationRatio, (v, l) => v > l);
check('minThroughputRatio', throughputRatio, THRESHOLDS.minThroughputRatio, (v, l) => v < l);
check('maxOrphans', measurement.orphans, THRESHOLDS.maxOrphans, (v, l) => v > l);
check('maxLiveSessions', measurement.maxLiveSessions, THRESHOLDS.maxLiveSessions, (v, l) => v > l);
check('minMeasurableSampleFraction', measurableFraction, THRESHOLDS.minMeasurableSampleFraction, (v, l) => v < l);

// Conditions that are failures rather than threshold breaches, because they mean
// the run did not measure what it claimed to.
if (measurement.churnProducedNoCycles) {
  breaches.push({ threshold: 'churnWorkloadProducedNoCycles', value: churnGrowth, limit: '> 0' });
}
if (stopReport.neededKill) {
  breaches.push({ threshold: 'hostExitedOnItsOwn', value: false, limit: true });
}
// Every workload must have run to the end. A pool worker that died in minute one
// and a run that finished are not the same result, even if the host stayed up.
for (const [worker, state] of workerState) {
  if (!state.finished && !aborted) {
    breaches.push({ threshold: `workloadRanToCompletion:${worker}`, value: false, limit: true, detail: state.error ?? null });
  }
}

const allWorkersFinished = [...workerState.values()].every(s => s.finished);
const completed = workloadsRan && !aborted && !hostDiedDuringRun && allWorkersFinished
  && actualMs >= durationMs - 5000;

const result = {
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, arch: process.arch,
  tier: tier ?? 'custom',
  requestedMinutes: MINUTES,
  actualMinutes: Number((actualMs / 60000).toFixed(2)),
  actualMs: Math.round(actualMs),
  // The field that separates "ran and passed" from "did not finish".
  completed,
  aborted,
  interrupted,
  allWorkersFinished,
  workerState: Object.fromEntries(workerState),
  hostExit: stopReport.exitInfo,
  neededKillToStop: stopReport.neededKill,
  hostStderrTail: host.stderrTail.slice(-800),
  corruptResponseLines: host.corruptLines,
  config: {
    pool: POOL, maxChurn: MAX_CHURN, sampleSeconds: SAMPLE_SECONDS,
    stallTimeoutMs: STALL_TIMEOUT_MS, minSamplesForTrend: MIN_SAMPLES_FOR_TREND, thresholds: THRESHOLDS,
  },
  counters,
  latency: Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, stats(v)])),
  samples: series.length,
  seriesPath: OUT,
  measurement,
  breaches,
  topErrors: [...errorMessages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([message, count]) => ({ count, message })),
};

let code = 0;
if (seriesWriteError && !series.length) code = 5;
else if (hostDiedDuringRun || (stopReport.exitInfo && !completed && aborted?.reason?.startsWith('host'))) code = 2;
else if (aborted?.reason === 'stall') code = 3;
else if (!completed) code = 4;
else if (seriesWriteError) code = 5;
else if (breaches.length) code = 1;

// Flushed through the write callback rather than process.exit(): stdout is a pipe
// here, and exiting immediately can truncate the very line the CI reporter parses.
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`, () => {
  process.stdout.write(`EXIT ${code} completed=${completed} breaches=${breaches.length} `
    + `samples=${series.length} actualMinutes=${result.actualMinutes}/${MINUTES}\n`, () => {
    process.exit(code);
  });
});
