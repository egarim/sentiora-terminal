// End-to-end tests of the JSON-RPC server over a real Windows ConPTY session.
//
// These drive src/server.js exactly as an agent would: newline-delimited
// JSON-RPC on stdio, real child processes on the other side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FIXTURE, rawHex } from './helpers/native.mjs';

const execFileAsync = promisify(execFile);

const windows = process.platform === 'win32';
const skip = windows ? false : 'native ConPTY scenario: Windows only';
const opts = { skip, timeout: 60000 };

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

// Minimal JSON-RPC client that records every raw stdout line so the tests can
// prove the channel stayed parseable rather than merely assuming it did.
function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rawLines = [];
  const responses = [];
  const corrupted = [];
  let stderr = '';
  const idle = [];

  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    rawLines.push(line);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupted.push(line);
      return;
    }
    responses.push(parsed);
    for (const wake of idle.splice(0)) wake();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });

  let nextId = 1;
  async function request(method, params, { timeout = 20000 } = {}) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = responses.find(r => r.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no response to ${method} (id ${id}) within ${timeout}ms`);
      await Promise.race([
        new Promise(resolve => idle.push(resolve)),
        new Promise(resolve => setTimeout(resolve, 100)),
      ]);
    }
  }

  async function call(method, params, options) {
    const response = await request(method, params, options);
    assert.equal(response.jsonrpc, '2.0');
    assert.ok(response.result !== undefined, `${method} failed: ${JSON.stringify(response.error)}`);
    return response.result;
  }

  return {
    child, request, call, rawLines, corrupted, responses,
    get stderr() { return stderr; },
    async stop() {
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 30000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
    // Needed for sessions created with conptyDll:true, whose undisposed conout
    // worker means the server can never exit on its own.
    async forceStop() {
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode === null) {
        try { await execFileAsync('taskkill', ['/F', '/T', '/PID', String(child.pid)]); } catch { /* already gone */ }
      }
    },
  };
}

test('WIN-15 keeps JSON-RPC stdout clean while children write hostile output', opts, async () => {
  const server = startServer();
  try {
    const init = await server.call('initialize', {});
    assert.equal(init.platform, 'win32');
    assert.equal(init.arch, process.arch);

    const created = await server.call('terminal.create', {
      command: process.execPath, args: [FIXTURE], cols: 100, rows: 30,
    });
    assert.ok(created.owner, 'create must return the session owner token');
    const { sessionId, owner } = created;
    await waitForScreen(server, sessionId, 'FIXTURE READY');

    // A child printing a byte-for-byte valid JSON-RPC response is the sharpest
    // possible probe: if ConPTY let the child anywhere near the server's stdout,
    // this line would show up as a response with an id nobody asked for.
    const injected = '{"jsonrpc":"2.0","id":424242,"result":{"INJECTED":true}}';
    await armed(server, 'terminal.type', sessionId, owner, { text: `echo ${injected}\r` });
    await waitForScreen(server, sessionId, 'INJECTED');

    // Then raw bytes: embedded newlines, braces, quotes, control characters and
    // an invalid UTF-8 sequence, all aimed at the framing of the RPC channel.
    const hostile = Buffer.concat([
      Buffer.from('\n{"jsonrpc":"2.0","id":424243}\n\x1b[31m{\x7f"broken\n', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x00, 0x1a]),
    ]);
    await armed(server, 'terminal.type', sessionId, owner, { text: `bytes ${hostile.toString('hex')}\r` });
    const observed = await waitForScreen(server, sessionId, 'BYTES-DONE');
    assert.ok(observed.screen.includes('INJECTED'), 'the injected text must reach the child screen');

    // The channel itself must still be perfectly framed.
    const listed = await server.call('terminal.list', {});
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, sessionId);
    await server.call('terminal.close', { sessionId, owner });

    assert.deepEqual(server.corrupted, [], `server stdout contained non-JSON lines: ${JSON.stringify(server.corrupted)}`);
    for (const line of server.rawLines) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.jsonrpc, '2.0', `line is not JSON-RPC 2.0: ${line}`);
      assert.ok(Number.isInteger(parsed.id), `response id must be one we sent: ${line}`);
      assert.notEqual(parsed.id, 424242, 'a child-forged response reached the RPC channel');
      assert.notEqual(parsed.id, 424243, 'a child-forged response reached the RPC channel');
    }
    const bodies = server.rawLines.join('\n');
    assert.ok(!/"INJECTED"/.test(bodies), 'child output leaked into the server stdout stream');
  } finally {
    await server.stop();
  }
});

test('protocol surface behaves over stdio on Windows', opts, async () => {
  const server = startServer();
  try {
    // Key mapping is verified against a raw-echo child so the exact bytes that
    // crossed ConPTY can be asserted. A command-protocol child cannot be used
    // for this: Ctrl+C sent before it enables raw mode terminates it outright.
    const keys = await server.call('terminal.create', {
      command: process.execPath, args: [FIXTURE, '--raw-echo'], cols: 90, rows: 25,
    });
    await waitForScreen(server, keys.sessionId, 'FIXTURE READY');
    const expected = [
      ['Enter', '0d'], ['Tab', '09'], ['Up', '1b5b41'], ['Down', '1b5b42'],
      ['Right', '1b5b43'], ['Left', '1b5b44'], ['Escape', '1b'], ['Backspace', '7f'], ['CtrlC', '03'],
    ];
    let stream = '';
    for (const [key, hex] of expected) {
      stream += hex;
      await armed(server, 'terminal.key', keys.sessionId, keys.owner, { key });
      await waitForRawStream(server, keys.sessionId, stream);
    }
    const keyRevision = (await server.call('terminal.observe', { sessionId: keys.sessionId })).revision;
    const unknownKey = await server.request('terminal.key', { sessionId: keys.sessionId, owner: keys.owner, revision: keyRevision, key: 'NoSuchKey' });
    assert.match(unknownKey.error.message, /Unknown key/);
    assert.equal(await server.call('terminal.close', { sessionId: keys.sessionId, owner: keys.owner }), true);

    const created = await server.call('terminal.create', {
      command: process.execPath, args: [FIXTURE], cols: 90, rows: 25,
    });
    const { sessionId, owner } = created;
    await waitForScreen(server, sessionId, 'FIXTURE READY');

    await armed(server, 'terminal.type', sessionId, owner, { text: 'echo TYPE-OK\r' });
    await waitForScreen(server, sessionId, 'ECHO:TYPE-OK');

    const resized = await server.call('terminal.resize', { sessionId, owner, cols: 50, rows: 12 });
    assert.equal(resized.cols, 50);
    assert.equal(resized.rows, 12);

    const foreign = await server.request('terminal.type', {
      sessionId, owner: 'not-the-owner', revision: resized.revision, text: 'x',
    });
    assert.match(foreign.error.message, /Input ownership required/);

    const closeWithWrongOwner = await server.request('terminal.close', { sessionId, owner: 'not-the-owner' });
    assert.match(closeWithWrongOwner.error.message, /Ownership required/);

    const missing = await server.request('terminal.observe', { sessionId: 'does-not-exist' });
    assert.match(missing.error.message, /Unknown session/);

    const unknownMethod = await server.request('terminal.nope', { sessionId });
    assert.match(unknownMethod.error.message, /Unknown method/);

    const malformed = await server.request('terminal.create', { command: '', args: [] });
    assert.match(malformed.error.message, /Invalid command/);

    const badDimensions = await server.request('terminal.create', {
      command: process.execPath, args: [FIXTURE], cols: 1, rows: 10,
    });
    assert.match(badDimensions.error.message, /Invalid dimensions/);

    assert.equal(await server.call('terminal.close', { sessionId, owner }), true);
    const afterClose = await server.call('terminal.list', {});
    assert.deepEqual(afterClose, [], 'a closed session must leave the registry');
  } finally {
    await server.stop();
  }
});

test('a non-JSON stdin line is answered as an error without breaking framing', opts, async () => {
  const server = startServer();
  try {
    await server.call('initialize', {});
    server.child.stdin.write('this is not json\n');
    server.child.stdin.write('{"jsonrpc":"2.0","method":"terminal.list"}\n'); // missing id
    const listed = await server.call('terminal.list', {});
    assert.deepEqual(listed, []);
    assert.deepEqual(server.corrupted, [], 'garbage in must not produce garbage out');
    const errors = server.responses.filter(r => r.error);
    assert.ok(errors.length >= 2, `expected error responses for both bad lines, got ${JSON.stringify(server.responses)}`);
    assert.ok(errors.every(e => e.error.code === -32000));
  } finally {
    await server.stop();
  }
});

test('server shuts its sessions down and exits when stdin closes', opts, async () => {
  const server = startServer();
  try {
    for (let i = 0; i < 3; i += 1) {
      const created = await server.call('terminal.create', {
        command: process.execPath, args: [FIXTURE], cols: 60, rows: 15,
      });
      await waitForScreen(server, created.sessionId, 'FIXTURE READY');
      // Deliberately not closed: the stdin-close handler must reap them.
    }
  } finally {
    const started = Date.now();
    await server.stop();
    const elapsed = Date.now() - started;
    console.log(`    server exit after stdin close took ${elapsed}ms`);
    assert.ok(elapsed < 30000, 'server must exit on stdin close rather than hang');
  }
});

test('lifecycle state, child pid and provider default are exposed over the protocol', opts, async () => {
  const server = startServer();
  try {
    const init = await server.call('initialize', {});
    assert.equal(init.conptyDll, false, 'the bundled-DLL provider must not be the default');

    const created = await server.call('terminal.create', {
      command: process.execPath, args: [FIXTURE], cols: 80, rows: 24,
    });
    const { sessionId, owner } = created;
    assert.ok(Number.isInteger(created.pid) && created.pid > 0, `create must expose the child pid, got ${created.pid}`);
    assert.ok(['spawned', 'operational'].includes(created.state), `unexpected initial state ${created.state}`);

    const ready = await waitForScreen(server, sessionId, 'FIXTURE READY');
    assert.equal(ready.state, 'operational', 'a spawned process is not the same as an operational terminal');
    assert.equal(ready.pid, created.pid, 'the pid must be stable across observations');

    await armed(server, 'terminal.type', sessionId, owner, { text: 'exit 9\r' });
    const exited = await waitForState(server, sessionId, 'exited');
    assert.equal(exited.exit.exitCode, 9);
    assert.equal(exited.pid, created.pid, 'the pid must survive exit so a caller can verify identity');

    assert.equal(await server.call('terminal.close', { sessionId, owner }), true);
    assert.deepEqual(await server.call('terminal.list', {}), []);

    const badProvider = await server.request('terminal.create', {
      command: process.execPath, args: [FIXTURE], conptyDll: 'yes',
    });
    assert.match(badProvider.error.message, /Invalid conptyDll/);
  } finally {
    await server.stop();
  }
});

test('the bundled-DLL ConPTY provider can be selected over the protocol', opts, async () => {
  const server = startServer();
  try {
    const created = await server.call('terminal.create', {
      command: process.execPath, args: [FIXTURE], cols: 80, rows: 24, conptyDll: true,
    });
    const ready = await waitForScreen(server, created.sessionId, 'FIXTURE READY');
    assert.equal(ready.state, 'operational', 'the bundled ARM64 conpty.dll must drive a real session');
    await armed(server, 'terminal.type', created.sessionId, created.owner, { text: 'echo DLL-PROVIDER-OK\r' });
    const echoed = await waitForScreen(server, created.sessionId, 'ECHO:DLL-PROVIDER-OK');
    assert.match(echoed.screen, /ECHO:DLL-PROVIDER-OK/);
    assert.equal(await server.call('terminal.close', { sessionId: created.sessionId, owner: created.owner }), true);
  } finally {
    // The DLL provider leaves an undisposed conout worker inside the server, so
    // the server can never exit on its own. Kill it rather than orphan it.
    await server.forceStop();
  }
});

// The revision guard means every write must be armed with a fresh observation,
// and any output landing in between makes that write stale. Retrying is what a
// real agent has to do, so the tests do the same.
async function armed(server, method, sessionId, owner, params) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const observed = await server.call('terminal.observe', { sessionId });
    const response = await server.request(method, { sessionId, owner, revision: observed.revision, ...params });
    if (response.result !== undefined) return response.result;
    if (!/Stale observation/.test(response.error?.message ?? '')) {
      throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    }
  }
  throw new Error(`${method} kept hitting stale observations`);
}

async function waitForScreen(server, sessionId, marker, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const observed = await server.call('terminal.observe', { sessionId });
    if (observed.screen.includes(marker)) return observed;
    if (Date.now() > deadline) throw new Error(`screen never contained ${marker}; last:\n${observed.screen}`);
    await server.call('terminal.wait', { sessionId, afterRevision: observed.revision, timeoutMs: 250 });
  }
}

async function waitForState(server, sessionId, state, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const observed = await server.call('terminal.observe', { sessionId });
    if (observed.state === state) return observed;
    if (Date.now() > deadline) throw new Error(`session never reached state ${state}; last was ${observed.state}`);
    await server.call('terminal.wait', { sessionId, afterRevision: observed.revision, timeoutMs: 250 });
  }
}

// Waits until the raw-echo child has received exactly this ordered byte stream.
async function waitForRawStream(server, sessionId, expectedHex, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const observed = await server.call('terminal.observe', { sessionId });
    const stream = rawHex(observed);
    if (stream.startsWith(expectedHex)) return stream;
    if (Date.now() > deadline) throw new Error(`child never received ${expectedHex}; got ${stream}`);
    await server.call('terminal.wait', { sessionId, afterRevision: observed.revision, timeoutMs: 250 });
  }
}
