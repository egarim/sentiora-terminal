// The MCP adapter (issue #4, M4 slice 3): a thin mapping from MCP tool calls onto the runtime's
// existing JSON-RPC. These tests speak the protocol over stdio exactly as a client would — no
// knowledge of the adapter's internals — and assert the one security property that matters:
// no capability token ever appears in a tool result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADAPTER = fileURLToPath(new URL('../packages/mcp-server/index.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/interactive.mjs', import.meta.url));

const opts = { timeout: 60000 };

function startAdapter() {
  const child = spawn(process.execPath, [ADAPTER], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
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
  async function request(method, params, timeoutMs = 30000) {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = responses.find(response => response.id === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no answer for ${method}; stderr:\n${stderr}`);
      await Promise.race([new Promise(resolve => idle.push(resolve)), new Promise(resolve => setTimeout(resolve, 20))]);
    }
  }

  return {
    child,
    get stderr() { return stderr; },
    request,
    /** Calls a tool and returns the parsed payload, asserting the call itself did not error. */
    async tool(name, args) {
      const response = await request('tools/call', { name, arguments: args });
      assert.ok(response.result, `${name} failed: ${JSON.stringify(response.error)}`);
      assert.ok(!response.result.isError, `${name} returned an error: ${response.result.content?.[0]?.text}`);
      return JSON.parse(response.result.content[0].text);
    },
    async stop() {
      child.stdin.end();
      await new Promise(resolve => { const t = setTimeout(resolve, 15000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    },
  };
}

test('MCP-01 initialize advertises the tools capability and a version', opts, async t => {
  const adapter = startAdapter();
  t.after(() => adapter.stop());

  const response = await adapter.request('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test' } });
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, 'sentiora-terminal');
});

test('MCP-02 tools/list describes the terminal surface', opts, async t => {
  const adapter = startAdapter();
  t.after(() => adapter.stop());

  const response = await adapter.request('tools/list', {});
  const names = response.result.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['terminal_close', 'terminal_create', 'terminal_line', 'terminal_list', 'terminal_observe', 'terminal_type']);
  for (const tool of response.result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('MCP-03 a session is created, typed into, observed and closed through tools', opts, async t => {
  const adapter = startAdapter();
  t.after(() => adapter.stop());

  const created = await adapter.tool('terminal_create', { command: process.execPath, args: [FIXTURE], cols: 80, rows: 20 });
  assert.equal(typeof created.sessionId, 'string');
  assert.ok(Number.isInteger(created.pid) && created.pid > 0, 'create must report the child pid');

  // A fresh shell needs a moment; observing is the documented way to wait, and polling it is what
  // a model does rather than guessing a sleep.
  let screen = '';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const observed = await adapter.tool('terminal_observe', { sessionId: created.sessionId });
    screen = observed.screen;
    if (screen.includes('FIXTURE READY')) break;
  }
  assert.match(screen, /FIXTURE READY/);

  await adapter.tool('terminal_line', { sessionId: created.sessionId, line: 'echo MCP-OK' });
  let echoed = '';
  const echoDeadline = Date.now() + 15000;
  while (Date.now() < echoDeadline) {
    const observed = await adapter.tool('terminal_observe', { sessionId: created.sessionId });
    echoed = observed.screen;
    if (echoed.includes('ECHO:MCP-OK')) break;
  }
  assert.match(echoed, /ECHO:MCP-OK/);

  const closed = await adapter.tool('terminal_close', { sessionId: created.sessionId });
  assert.equal(closed.closed, true);
  const listed = await adapter.tool('terminal_list', {});
  assert.deepEqual(listed.sessions, []);
});

test('MCP-04 no tool result carries a capability token', opts, async t => {
  const adapter = startAdapter();
  t.after(() => adapter.stop());

  const created = await adapter.tool('terminal_create', { command: process.execPath, args: [FIXTURE] });
  const observed = await adapter.tool('terminal_observe', { sessionId: created.sessionId });
  const listed = await adapter.tool('terminal_list', {});

  for (const payload of [created, observed, listed]) {
    const text = JSON.stringify(payload);
    // The keys themselves are the contract: an `owner` or `mailbox` field would mean the model can
    // type into a session it was only given to watch.
    assert.doesNotMatch(text, /"owner"|"mailbox"|"childMailbox"/, `a capability field leaked: ${text}`);
  }
  await adapter.tool('terminal_close', { sessionId: created.sessionId });
});

test('MCP-05 an unknown tool or session is an error result, not a crash', opts, async t => {
  const adapter = startAdapter();
  t.after(() => adapter.stop());

  const unknown = await adapter.request('tools/call', { name: 'terminal_nope', arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /Unknown tool/);

  const missing = await adapter.request('tools/call', { name: 'terminal_observe', arguments: { sessionId: 'nope' } });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Unknown session/);

  // The adapter is still serving after both failures.
  const alive = await adapter.request('tools/list', {});
  assert.ok(Array.isArray(alive.result.tools));
});
