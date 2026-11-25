// Reproduction: the runtime host dies with STATUS_ACCESS_VIOLATION (0xC0000005,
// reported by Node as exit code 3221225477) when ConPTY children are killed
// externally while the host keeps creating and closing sessions.
//
// This is a bench, not a test, because the crash is intermittent and is not
// caused by anything in src/: it reproduces on unmodified main at the same rate.
// The mechanism is node-pty 1.1.0's global `std::vector<std::unique_ptr<pty_baton>>
// ptyHandles` in src/win/conpty.cc, which has no mutex -- the child-exit callback
// thread runs remove_pty_baton (std::remove_if) while the main thread runs
// emplace_back, which can reallocate the vector out from under the other thread.
// node-pty is held at 1.1.0 by the lockfile (package.json declares ^1.1.0, so a
// lock refresh could admit 1.2.x), and project policy is not to adopt
// 1.2.0-beta.18 until it is the stable latest. So this measures and documents the
// exposure rather than fixing it.
//
// Usage: node test/bench/conpty-external-kill.mjs [rounds] [killFraction]
//   rounds        create/close rounds per host process (default 8)
//   killFraction  kill every Nth child externally each round (default 3)
//
// Exits 0 if every round completed, 1 if the host died. Prints a RESULT line
// either way so a caller can collect the numbers without parsing prose.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/interactive.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const ROUNDS = Number(process.argv[2] ?? 8);
const KILL_EVERY = Number(process.argv[3] ?? 3);
const t0 = Date.now();
const log = (...args) => console.log(`+${String(Date.now() - t0).padStart(6)}ms`, ...args);

const child = spawn(process.execPath, [SERVER], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
let stderrBytes = 0;
child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
// The whole purpose of this bench is to make the host die mid-request. Without a
// listener, the write that races the death raises EPIPE as an unhandled 'error'
// event and kills the bench before it can print RESULT -- i.e. it would fail at
// exactly the moment it is measuring a failure.
child.stdin.on('error', () => {});

let exitInfo = null;
child.on('exit', (code, signal) => { exitInfo = { code, signal }; });

const responses = [];
const idle = [];
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
    try { responses.push(JSON.parse(line)); } catch { corruptLines += 1; }
    for (const wake of idle.splice(0)) wake();
  }
});

let nextId = 1;
async function request(method, params, timeout = 20000) {
  if (exitInfo) return { hostDied: true };
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = responses.find(r => r.id === id);
    if (found) return found;
    if (exitInfo) return { hostDied: true };
    if (Date.now() > deadline) return { timedOut: true };
    await Promise.race([new Promise(r => idle.push(r)), new Promise(r => setTimeout(r, 100))]);
  }
}

// Guarded: the whole point of this bench is that children die at moments nobody
// scheduled, so an already-reaped pid must not take the harness down with it.
function killQuietly(pid) {
  try { process.kill(pid); return true; } catch { return false; }
}

const params = { command: process.execPath, args: [FIXTURE], cols: 40, rows: 10 };
let completedRounds = 0;
let sessionsCreated = 0;
let childrenKilled = 0;
let failure = null;

await request('initialize', {});

for (let round = 0; round < ROUNDS; round += 1) {
  const opened = [];
  for (;;) {
    const response = await request('terminal.create', params);
    if (response.hostDied) { failure = { round, stage: 'create', ...exitInfo }; break; }
    if (response.timedOut) { failure = { round, stage: 'create', timedOut: true }; break; }
    if (response.error) {
      // Only a capacity refusal ends the round. Any other error means the server
      // is broken, and treating it as "full" would let a dead host read as a
      // completed round.
      if (!/Session limit/.test(response.error.message ?? '')) {
        failure = { round, stage: 'create', error: response.error.message };
      }
      break;
    }
    opened.push(response.result);
    sessionsCreated += 1;
  }
  if (failure) break;

  for (const [i, entry] of opened.entries()) {
    if (i % KILL_EVERY === 0 && killQuietly(entry.pid)) childrenKilled += 1;
  }
  await new Promise(resolve => setTimeout(resolve, 500));

  // Any request after the external kills is what races the exit callbacks against
  // the next spawn, so keep issuing them rather than waiting for things to settle.
  for (const entry of opened) {
    const response = await request('terminal.close', { sessionId: entry.sessionId, owner: entry.owner });
    if (response.hostDied) { failure = { round, stage: 'close', ...exitInfo }; break; }
    if (response.timedOut) { failure = { round, stage: 'close', timedOut: true }; break; }
    // Recorded but not fatal, so the bench keeps measuring after a close starts
    // failing. Ignoring it would let a server that errors on every close report a
    // full set of completed rounds.
    if (response.error) failure = failure ?? { round, stage: 'close', error: response.error.message };
  }
  if (failure) break;

  // The one response that used to go unchecked: a crash here recorded no failure
  // and the bench exited 0 while exitInfo showed the access violation.
  const listed = await request('terminal.list', {});
  if (listed.hostDied) { failure = { round, stage: 'list', ...exitInfo }; break; }
  if (listed.timedOut) { failure = { round, stage: 'list', timedOut: true }; break; }

  completedRounds = round + 1;
  log(`round ${round}: created ${opened.length}, registry now ${listed.result?.length ?? 'n/a'}`);
}

const result = {
  node: process.version, arch: process.arch, platform: process.platform,
  rounds: ROUNDS, completedRounds, sessionsCreated, childrenKilledExternally: childrenKilled,
  hostExit: exitInfo, failure, stderrBytes, corruptLines, elapsedMs: Date.now() - t0,
  accessViolation: exitInfo?.code === 3221225477 || exitInfo?.code === -1073741819,
};
console.log(`RESULT ${JSON.stringify(result)}`);

if (!exitInfo) {
  child.stdin.end();
  await new Promise(resolve => { const t = setTimeout(resolve, 20000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
}
if (!exitInfo) {
  // The host outlived a clean shutdown request. Kill it rather than leave it and
  // its children behind, and record it: exiting 0 here would report a hung host as
  // a completed run.
  failure = failure ?? { stage: 'shutdown', detail: 'host still alive 20s after stdin was closed' };
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  await new Promise(resolve => { const t = setTimeout(resolve, 10000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
}
// Non-zero on any incomplete round, on a recorded failure, or on a host that died
// abnormally at any point -- including after the last round finished, which the
// per-round checks would otherwise miss.
const hostDiedBadly = Boolean(exitInfo) && (exitInfo.code !== 0 || exitInfo.signal !== null);
process.exit(failure || hostDiedBadly ? 1 : 0);
