// Regression tests for the failed-spawn host leak.
//
// node-pty's WindowsTerminal constructor creates the ConPTY and starts its
// ConoutConnection worker BEFORE the native connect() spawns the child. When connect()
// fails, the constructor throws, the caller never receives a terminal, and so nothing
// ever disposes that worker. The host then cannot exit: measured at 20 s (the client's
// dispose cap) with the process tree killed, versus a ~5 s normal ConPTY shutdown tail.
//
// Two inputs reach that path and neither is exotic: a cwd that does not exist (WIN-21) and
// a command that exists but that CreateProcess cannot execute (WIN-22). A bad cwd is
// decidable before anything is spawned; a bad command is not, because CreateProcess -- not
// this runtime -- decides what it can run. Both are answered as errors and the host exits:
// for the second, that is exactly what scripts/patch-node-pty.mjs guarantees.
//
// WIN-25 guards the other direction, which an earlier allowlist got wrong: a valid image
// under an extension this runtime used to refuse must still spawn.
//
// These drive the real runtime over its real stdio transport and assert both halves:
// the create is an error, and the host still exits promptly afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/interactive.mjs', import.meta.url));
const EXIT_BUDGET_MS = 8000;

function startRuntime() {
  const child = spawn(process.execPath, [SERVER], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = '';
  const responses = [];
  const idle = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      responses.push(JSON.parse(line));
      for (const wake of idle.splice(0)) wake();
    }
  });
  let nextId = 0;
  return {
    child,
    get stderr() { return stderr; },
    async request(method, params, timeoutMs = 30000) {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = responses.find(response => response.id === id);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no response for ${method} within ${timeoutMs}ms; stderr:\n${stderr}`);
        await Promise.race([new Promise(resolve => idle.push(resolve)), new Promise(resolve => setTimeout(resolve, 50))]);
      }
    },
    async exited(timeoutMs) {
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
    },
  };
}

// The second half of every case: a host that leaked its ConPTY worker stays alive after
// stdin closes. The budget is the assertion, not the wall clock -- a clean host exits on
// ConPTY teardown, a leaking one waits forever.
async function assertHostStillExits(t, runtime, label) {
  const listed = await runtime.request('terminal.list', {});
  assert.equal(listed.result.length, 0, `${label}: a failed create must not register a session`);

  const closedAt = Date.now();
  runtime.child.stdin.end();
  const exit = await runtime.exited(EXIT_BUDGET_MS + 7000);
  const elapsed = Date.now() - closedAt;

  assert.ok(exit, `${label}: the host was still alive ${EXIT_BUDGET_MS + 7000}ms after stdin closed; stderr:\n${runtime.stderr}`);
  assert.ok(elapsed < EXIT_BUDGET_MS,
    `${label}: the host took ${elapsed}ms to exit after a failed spawn; budget is ${EXIT_BUDGET_MS}ms. ` +
    `A leaked ConoutConnection worker is the usual cause. stderr:\n${runtime.stderr}`);
  assert.equal(exit.code, 0, `${label}: the host should exit cleanly, got ${JSON.stringify(exit)}`);
}

const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows ConPTY only' : false, timeout: 60000 };

test('WIN-21 a failed spawn does not leave the host unable to exit', windowsOnly, async t => {
  const runtime = startRuntime();
  t.after(() => { try { runtime.child.kill('SIGKILL'); } catch { /* gone */ } });

  const failed = await runtime.request('terminal.create', {
    command: process.execPath,
    args: [FIXTURE],
    cols: 40,
    rows: 10,
    cwd: 'Z:/definitely/not/here',
  });
  assert.ok(failed.error, 'a create whose cwd does not exist must be answered with an error');

  await assertHostStillExits(t, runtime, 'bad cwd');
});

test('WIN-22 a command that exists but cannot be executed does not strand the host', windowsOnly, async t => {
  const runtime = startRuntime();
  t.after(() => { try { runtime.child.kill('SIGKILL'); } catch { /* gone */ } });

  // A real file, an absolute path, and not an executable image: CreateProcess would fail
  // inside connect(), after the ConoutConnection worker has already started.
  const notAnExecutable = fileURLToPath(new URL('./failed-spawn.test.js', import.meta.url));
  const failed = await runtime.request('terminal.create', {
    command: notAnExecutable,
    cols: 40,
    rows: 10,
    cwd: REPO,
  });
  assert.ok(failed.error, 'a create whose command cannot be executed must be answered with an error');
  // 193 is ERROR_BAD_EXE_FORMAT from CreateProcess. With the extension allowlist gone this
  // reaches node-pty's connect(), which is the path the constructor patch makes safe -- so
  // this asserts the test still exercises cleanup, not a pre-spawn refusal.
  assert.match(failed.error.message, /error code: 193/u,
    `expected the CreateProcess failure from connect(), got: ${failed.error.message}`);

  await assertHostStillExits(t, runtime, 'unexecutable command');
});

// The case no pre-check can decide: an absolute path carrying an image extension, so it
// passes every check this runtime makes, and CreateProcess still refuses it. It is the
// reason scripts/patch-node-pty.mjs exists -- without the patch the host never exits.
test('WIN-23 a spawn that fails inside connect() releases its ConPTY worker', windowsOnly, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sentiora-win23-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* gone */ } });
  // Zero bytes: a file, an image extension, and not a loadable image.
  const truncated = join(directory, 'truncated.exe');
  writeFileSync(truncated, Buffer.alloc(0));

  const runtime = startRuntime();
  t.after(() => { try { runtime.child.kill('SIGKILL'); } catch { /* gone */ } });

  const failed = await runtime.request('terminal.create', {
    command: truncated,
    cols: 40,
    rows: 10,
    cwd: REPO,
  });
  assert.ok(failed.error, 'a create whose command cannot be loaded must be answered with an error');
  // 193 is ERROR_BAD_EXE_FORMAT from CreateProcess, i.e. this reached node-pty's connect()
  // rather than the pre-spawn checks above it. Without that, the test would prove nothing
  // about the constructor cleanup.
  assert.match(failed.error.message, /error code: 193/u,
    `expected the CreateProcess failure from connect(), got: ${failed.error.message}`);

  await assertHostStillExits(t, runtime, 'truncated image');
});

// The regression an extension allowlist introduced, guarded so it cannot come back: a real
// image under another extension is a spawn CreateProcess accepts. Measured: a copy of
// cmd.exe named tool.bin runs. Refusing it broke a caller that worked before the allowlist.
test('WIN-25 a valid image under another extension still spawns', windowsOnly, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sentiora-win25-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* gone */ } });
  const renamed = join(directory, 'tool.bin');
  cpSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', renamed);

  const runtime = startRuntime();
  t.after(() => { try { runtime.child.kill('SIGKILL'); } catch { /* gone */ } });

  const created = await runtime.request('terminal.create', {
    command: renamed,
    args: ['/c', 'echo BIN-OK'],
    cols: 40,
    rows: 10,
    cwd: REPO,
  });
  assert.equal(created.error, undefined,
    `a valid PE named tool.bin must spawn; got error: ${JSON.stringify(created.error)}`);
  assert.ok(created.result?.sessionId, 'the create must return a session');

  const listed = await runtime.request('terminal.list', {});
  assert.equal(listed.result.length, 1, 'the spawned session must be registered');
});
