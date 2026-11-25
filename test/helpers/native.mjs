// Shared helpers for the native Windows integration tests.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import { Session } from '../../src/session.js';

const execFileAsync = promisify(execFile);
const { Terminal } = xterm;

export const FIXTURE = fileURLToPath(new URL('../fixtures/interactive.mjs', import.meta.url));
export const SIGINT_FIXTURE = fileURLToPath(new URL('../fixtures/sigint.mjs', import.meta.url));

// A real PTY plus a real headless emulator, wired exactly the way src/server.js
// wires them, so these tests exercise the production code path.
export function createSession({ command = process.execPath, args = [FIXTURE], cols = 80, rows = 24 } = {}) {
  const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  const child = pty.spawn(command, args, {
    name: 'xterm-256color', cols, rows, cwd: process.cwd(), env: process.env,
  });
  const session = new Session(child, terminal);
  return { session, terminal, child };
}

// Polls wait() until predicate holds. wait() is the production wake-up path, so
// this also exercises revision-based waiting rather than sleeping blindly.
export async function until(session, predicate, { timeout = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let snapshot = await session.observe();
  while (!predicate(snapshot)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${label}; last observation:\n${snapshot.screen}`);
    }
    snapshot = await session.wait(snapshot.revision, Math.min(250, deadline - Date.now()));
  }
  return snapshot;
}

export const screenHas = text => snapshot => snapshot.screen.includes(text);

// input() enforces owner + revision, so every send must observe first.
export async function send(session, text) {
  const snapshot = await session.observe();
  return session.input({ owner: session.owner, revision: snapshot.revision, text });
}

export async function sendLine(session, text) {
  return send(session, `${text}\r`);
}

// Waits for the fixture to answer a command and returns the whole observation,
// so callers can assert on the full screen and not just the matching line.
export async function ask(session, command, marker, { timeout = 15000 } = {}) {
  await sendLine(session, command);
  return until(session, screenHas(marker), { timeout, label: `${command} -> ${marker}` });
}

// ConPTY may deliver several writes as one input chunk, so the --raw-echo
// fixture can report multiple key presses in a single RAW:<hex> line. Tests
// must therefore compare the concatenated byte stream in order rather than
// expecting one line per key.
export function rawHex(snapshot) {
  return snapshot.screen
    .split('\n')
    .map(l => l.match(/^RAW:([0-9a-f]*)/)?.[1] ?? '')
    .join('');
}

// Windows process introspection. tasklist is used instead of PowerShell/CIM
// because it is an order of magnitude faster and has no startup cost.
async function tasklist(filter) {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH', ...(filter ? ['/FI', filter] : [])]);
    return stdout;
  } catch (error) {
    return error.stdout ?? '';
  }
}

function parseRows(csv) {
  return csv.split(/\r?\n/).filter(l => l.includes('","')).map(l => l.split('","').map(f => f.replace(/^"|"$/g, '')));
}

export async function pidsOf(imageName) {
  const rows = parseRows(await tasklist(`IMAGENAME eq ${imageName}`));
  return rows.filter(r => r[0]?.toLowerCase() === imageName.toLowerCase()).map(r => Number(r[1]));
}

export async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const rows = parseRows(await tasklist(`PID eq ${pid}`));
  return rows.some(r => Number(r[1]) === pid);
}

// Generic async polling: Windows teardown is asynchronous (ConPTY flush timers
// plus node-pty's console-process-list fork), so cleanup assertions must poll
// to a deadline instead of checking a single instant.
export async function untilTrue(predicate, { timeout = 15000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

export async function forceKill(pid) {
  try {
    await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)]);
  } catch {
    // Already gone is the outcome we wanted.
  }
}

// Counts live libuv handles by kind. MessagePort is the ConPTY conout worker
// and Socket is the conin/conout pipe pair, so this is what turns a vague
// "resource leak" into an attributable one.
export function handleKinds() {
  const kinds = {};
  for (const handle of process._getActiveHandles()) {
    const kind = handle.constructor?.name ?? typeof handle;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return kinds;
}

// Under `node --test` the test process has no console, so Windows gives every
// subprocess it spawns (tasklist included) a transient conhost.exe. Warm up and
// settle before taking a baseline, otherwise the harness's own console hosts get
// counted as session leaks.
export async function conhostBaseline() {
  for (let i = 0; i < 3; i += 1) await pidsOf('conhost.exe');
  await new Promise(resolve => setTimeout(resolve, 1000));
  return new Set(await pidsOf('conhost.exe'));
}

// Answers for many pids with a single subprocess. Measuring process state on
// Windows costs a spawned console program per call, and each of those gets its
// own transient conhost, so batching keeps the measurement from polluting the
// very thing it is measuring.
export async function alivePidsAmong(pids) {
  // Reject non-positive pids up front. PID 0 is the System Idle Process and is
  // always present in the tasklist, so an unavailable pid would read as "alive
  // forever" and turn a clear failure into a 30s timeout. node-pty 1.2.0-beta
  // reports pid 0 until its deferred pty connection completes, which is exactly
  // how this was found.
  const invalid = pids.filter(pid => !Number.isInteger(pid) || pid <= 0);
  if (invalid.length) {
    throw new Error(`alivePidsAmong received ${invalid.length} invalid pid(s): ${invalid.slice(0, 5).join(', ')}`);
  }
  const live = new Set(parseRows(await tasklist()).map(row => Number(row[1])));
  return pids.filter(pid => live.has(pid));
}
