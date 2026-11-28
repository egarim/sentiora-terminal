// Tests for the loopback IPC server: the trust boundary between the webview and
// the session bridge.
//
// These are the security properties issue #7 asks for -- "local authenticated IPC
// with least privilege, no arbitrary frontend shell bridge" -- so they assert
// refusals rather than happy paths wherever a refusal is the point. Sessions are
// backed by the fake runtime; test/desktop-native.test.js covers the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createFakeBackend, temporaryDirectory, removeDirectory,
} from './helpers/desktop.mjs';
import { IpcServer, generateToken, INPUT_RATE_LIMIT } from '../apps/desktop/server/ipc.js';
import { SettingsStore } from '../apps/desktop/bridge/settings.js';
import { detectShells } from '../apps/desktop/bridge/shell-catalog.js';

const opts = { timeout: 60000 };

// The fake runtime never spawns the command it is given, so any catalogued shell
// works here; using a real detected id is what exercises the real code path.
const SHELL_ID = detectShells()[0]?.id ?? 'sh';

// Raw HTTP so a test can set headers a browser would forbid (Origin), which is
// exactly the header the server's cross-origin defence depends on.
function raw(options, body) {
  return new Promise((resolveRaw, reject) => {
    const req = httpRequest(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolveRaw({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function startServer({ staticRoot = null, allowedOrigins = [], inputRateLimit = INPUT_RATE_LIMIT, runtimeArgs = [] } = {}) {
  const backend = await createFakeBackend({ runtimeArgs });
  const dir = await temporaryDirectory('sentiora-ipc-settings-');
  const settings = new SettingsStore({ path: join(dir, 'settings.json') });
  await settings.load();
  const token = generateToken();
  const server = new IpcServer({
    bridge: backend.bridge, settings, token, allowedOrigins, staticRoot, inputRateLimit,
  });
  const { url, port } = await server.listen();
  const bodies = [];

  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    // Every byte the server ever sent back is collected, so the owner-token test
    // can assert absence across the whole surface instead of per endpoint.
    bodies.push(text);
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  };

  return {
    backend, settings, server, token, url, port, bodies, call, settingsDir: dir,
    async stop() {
      await server.close();
      await backend.shutdown();
      await removeDirectory(dir);
    },
  };
}

// Minimal SSE client. EventSource cannot send an Authorization header, which is
// why the real UI parses the stream from fetch() too.
async function openSse(url, path, token) {
  const response = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  });
  assert.equal(response.status, 200, 'the event stream must open');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const waiters = [];
  let buffer = '';
  let closed = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const name = /^event:\s*(.+)$/m.exec(block)?.[1];
          const data = /^data:\s*([\s\S]+)$/m.exec(block)?.[1];
          if (!name) continue; // comment frame / heartbeat
          events.push({ name, data: data ? JSON.parse(data) : null });
          for (const wake of waiters.splice(0)) wake();
        }
      }
    } finally {
      closed = true;
      for (const wake of waiters.splice(0)) wake();
    }
  })();

  let cursor = 0;
  return {
    events,
    get closed() { return closed; },
    // Returns the next event matching `predicate`, in arrival order.
    async next(predicate, { timeoutMs = 15000, label = 'event' } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (let i = cursor; i < events.length; i += 1) {
          if (predicate(events[i])) { cursor = i + 1; return events[i]; }
        }
        cursor = events.length;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || closed) {
          throw new Error(`no ${label} within ${timeoutMs}ms; saw [${events.map(e => e.name).join(', ')}]`);
        }
        await Promise.race([
          new Promise(resolveWait => waiters.push(resolveWait)),
          new Promise(resolveWait => setTimeout(resolveWait, remaining)),
        ]);
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

// ------------------------------------------------------------------- authn/authz

test('the API refuses requests without a valid bearer token', opts, async () => {
  const context = await startServer();
  try {
    const anonymous = await fetch(`${context.url}/api/health`);
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(`${context.url}/api/health`, { headers: { authorization: 'Bearer not-the-token' } });
    assert.equal(wrong.status, 401);

    const malformed = await fetch(`${context.url}/api/health`, { headers: { authorization: context.token } });
    assert.equal(malformed.status, 401, 'a token without the Bearer scheme must be refused');

    const good = await fetch(`${context.url}/api/health`, { headers: { authorization: `Bearer ${context.token}` } });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);
  } finally {
    await context.stop();
  }
});

test('a browser origin that is not allowed is refused, an allowed one is not', opts, async () => {
  const context = await startServer({ allowedOrigins: ['http://localhost:5173'] });
  try {
    const evil = await raw({
      host: '127.0.0.1', port: context.port, method: 'GET', path: '/api/health',
      headers: { authorization: `Bearer ${context.token}`, origin: 'http://evil.example' },
    });
    assert.equal(evil.status, 403, 'a cross-origin page holding the token must still be refused');

    const opaque = await raw({
      host: '127.0.0.1', port: context.port, method: 'GET', path: '/api/health',
      headers: { authorization: `Bearer ${context.token}`, origin: 'null' },
    });
    assert.equal(opaque.status, 403, 'an opaque origin must be refused');

    const allowed = await raw({
      host: '127.0.0.1', port: context.port, method: 'GET', path: '/api/health',
      headers: { authorization: `Bearer ${context.token}`, origin: 'http://localhost:5173' },
    });
    assert.equal(allowed.status, 200);

    // Same-origin is always allowed: that is how the packaged app talks to it.
    const same = await raw({
      host: '127.0.0.1', port: context.port, method: 'GET', path: '/api/health',
      headers: { authorization: `Bearer ${context.token}`, origin: context.url },
    });
    assert.equal(same.status, 200);

    // No Origin header means a non-browser client; loopback plus the token is the
    // protection there.
    const noOrigin = await raw({
      host: '127.0.0.1', port: context.port, method: 'GET', path: '/api/health',
      headers: { authorization: `Bearer ${context.token}` },
    });
    assert.equal(noOrigin.status, 200);
  } finally {
    await context.stop();
  }
});

test('the UI cannot make the backend spawn an arbitrary command', opts, async () => {
  const context = await startServer();
  try {
    // This is the "no arbitrary frontend shell bridge" requirement, enforced
    // structurally: a command line in the body is refused outright.
    const withCommand = await context.call('POST', '/api/sessions', { command: 'cmd.exe', args: ['/c', 'whoami'] });
    assert.equal(withCommand.status, 403);
    assert.equal(withCommand.json.kind, 'shell-bridge-refused');

    const withArgsOnly = await context.call('POST', '/api/sessions', { args: ['--dangerous'] });
    assert.equal(withArgsOnly.status, 403);

    const unknownShell = await context.call('POST', '/api/sessions', { shellId: 'definitely-not-a-shell' });
    assert.equal(unknownShell.status, 400);
    assert.equal(unknownShell.json.kind, 'invalid-shell');

    const relativePath = await context.call('POST', '/api/sessions', { customPath: 'cmd.exe' });
    assert.equal(relativePath.status, 400);
    assert.match(relativePath.json.error, /absolute/);

    const missingPath = await context.call('POST', '/api/sessions', { customPath: join(process.cwd(), 'no-such-binary-anywhere') });
    assert.equal(missingPath.status, 400);

    // The node executable is an absolute path to a real executable on every
    // platform, so it is the one custom path that must be accepted.
    const valid = await context.call('POST', '/api/sessions', { customPath: process.execPath, cols: 30, rows: 8 });
    assert.equal(valid.status, 201, valid.text);
    await context.call('DELETE', `/api/sessions/${valid.json.session.sessionId}`);

    assert.equal(context.backend.bridge.sessions.length, 0, 'no session may have been created by a refused request');
  } finally {
    await context.stop();
  }
});

test('an owner token never appears in any HTTP response body', opts, async () => {
  const context = await startServer();
  try {
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    assert.equal(created.status, 201, created.text);
    const sessionId = created.json.session.sessionId;

    const stream = await openSse(context.url, `/api/sessions/${sessionId}/stream`, context.token);
    await stream.next(event => event.name === 'snapshot', { label: 'the initial snapshot' });
    await context.call('GET', `/api/sessions/${sessionId}`);
    await context.call('GET', '/api/sessions');
    await context.call('GET', '/api/info');
    await context.call('GET', '/api/settings');
    await context.call('GET', '/api/shells');
    await context.call('POST', `/api/sessions/${sessionId}/input`, { text: 'echo owner-probe\r' });
    await context.call('POST', `/api/sessions/${sessionId}/resize`, { cols: 50, rows: 12 });
    await context.call('POST', `/api/sessions/${sessionId}/interrupt`, {});
    const events = await openSse(context.url, '/api/events', context.token);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    await events.close();
    await stream.close();

    const owners = context.backend.ownerTokensIssued();
    assert.ok(owners.length >= 1, 'the fixture must have issued an owner token');
    const everything = context.bodies.join('\n');
    for (const owner of owners) {
      assert.ok(!everything.includes(owner), `an owner token leaked into an HTTP response: ${owner}`);
    }
    assert.ok(!/"owner"/.test(everything), 'no response may even carry an "owner" field');

    await context.call('DELETE', `/api/sessions/${sessionId}`);
  } finally {
    await context.stop();
  }
});

// -------------------------------------------------------------------- session API

test('a session can be created, streamed, typed into and closed over HTTP', opts, async () => {
  const context = await startServer();
  try {
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10, label: 'pane-a' });
    assert.equal(created.status, 201);
    const session = created.json.session;
    assert.equal(session.label, 'pane-a');
    assert.equal(session.state, 'operational');
    assert.equal(session.cols, 40);
    assert.ok(!('owner' in session));

    const stream = await openSse(context.url, `/api/sessions/${session.sessionId}/stream`, context.token);
    const snapshot = await stream.next(event => event.name === 'snapshot', { label: 'snapshot' });
    assert.equal(snapshot.data.kind, 'snapshot');
    assert.equal(snapshot.data.resync, true);
    assert.equal(snapshot.data.lines.length, 10, 'the snapshot must cover the whole viewport');
    assert.match(snapshot.data.lines.join('\n'), /FAKE READY/);

    const typed = await context.call('POST', `/api/sessions/${session.sessionId}/input`, { text: 'echo OVER-HTTP\r' });
    assert.equal(typed.status, 200);
    assert.ok(Number.isInteger(typed.json.revision));

    const frame = await stream.next(
      event => event.name === 'frame' && event.data.lines.join('\n').includes('OVER-HTTP'),
      { label: 'a frame carrying the echo' },
    );
    assert.equal(frame.data.kind, 'frame');
    assert.ok(frame.data.revision > snapshot.data.revision, 'frames must advance the revision');
    await stream.close();

    const closed = await context.call('DELETE', `/api/sessions/${session.sessionId}`);
    assert.equal(closed.status, 200);
    assert.equal(closed.json.closed, true);
    const after = await context.call('GET', `/api/sessions/${session.sessionId}`);
    assert.equal(after.status, 404);
    assert.equal(after.json.kind, 'unknown-session');
  } finally {
    await context.stop();
  }
});

test('reconnecting to a live session replays a complete snapshot (U04)', opts, async () => {
  const context = await startServer();
  try {
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 6 });
    const sessionId = created.json.session.sessionId;
    for (let i = 0; i < 8; i += 1) {
      await context.call('POST', `/api/sessions/${sessionId}/input`, { text: `echo RECONNECT-${i}\r` });
    }
    // Wait for the last line to be on screen before attaching, so the snapshot the
    // second client receives is a settled one.
    await context.backend.bridge.waitUntil(
      sessionId, observation => observation.screen.includes('RECONNECT-7'),
      { timeoutMs: 15000, label: 'the last echoed line' },
    );

    const late = await openSse(context.url, `/api/sessions/${sessionId}/stream`, context.token);
    const snapshot = await late.next(event => event.name === 'snapshot', { label: 'the late snapshot' });
    assert.equal(snapshot.data.resync, true);
    assert.equal(snapshot.data.lines.length, 6);
    assert.match(snapshot.data.lines.join('\n'), /RECONNECT-7/, 'a reconnecting client must see the current screen');
    assert.ok(Array.isArray(snapshot.data.scrollback), 'the snapshot must carry recovered scrollback');
    await late.close();

    // And the stream must keep working after the reconnect.
    const live = await openSse(context.url, `/api/sessions/${sessionId}/stream`, context.token);
    await live.next(event => event.name === 'snapshot', { label: 'snapshot on second reconnect' });
    await context.call('POST', `/api/sessions/${sessionId}/input`, { text: 'echo STILL-LIVE\r' });
    const frame = await live.next(
      event => event.name === 'frame' && event.data.lines.join('\n').includes('STILL-LIVE'),
      { label: 'a frame after reconnecting' },
    );
    assert.ok(frame.data.revision > snapshot.data.revision);
    await live.close();
    await context.call('DELETE', `/api/sessions/${sessionId}`);
  } finally {
    await context.stop();
  }
});

test('resize reports the applied size and clamping over HTTP', opts, async () => {
  const context = await startServer();
  try {
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    const sessionId = created.json.session.sessionId;
    const wild = await context.call('POST', `/api/sessions/${sessionId}/resize`, { cols: 4000, rows: 900 });
    assert.equal(wild.status, 200, wild.text);
    assert.equal(wild.json.clamped, true);
    assert.deepEqual(wild.json.applied, { cols: 300, rows: 150 });
    const exact = await context.call('POST', `/api/sessions/${sessionId}/resize`, { cols: 70, rows: 20 });
    assert.equal(exact.json.clamped, false);
    assert.equal(exact.json.cols, 70);
    await context.call('DELETE', `/api/sessions/${sessionId}`);
  } finally {
    await context.stop();
  }
});

test('input validation and rate limiting are enforced at the boundary', opts, async () => {
  const context = await startServer({ inputRateLimit: 3 });
  try {
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    const sessionId = created.json.session.sessionId;

    const empty = await context.call('POST', `/api/sessions/${sessionId}/input`, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.json.kind, 'invalid-input');

    const badKey = await context.call('POST', `/api/sessions/${sessionId}/input`, { key: 'NotAKey' });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.json.kind, 'unknown-key');

    // A separate session, so the requests above (which did reach the limiter,
    // because a bad key name is only known to be bad once the bridge is asked)
    // cannot consume this session's budget.
    const fresh = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    const freshId = fresh.json.session.sessionId;
    for (let i = 0; i < 3; i += 1) {
      const ok = await context.call('POST', `/api/sessions/${freshId}/input`, { text: `echo RL-${i}\r` });
      assert.equal(ok.status, 200, `request ${i} should be within the limit: ${ok.text}`);
    }
    const throttled = await context.call('POST', `/api/sessions/${freshId}/input`, { text: 'echo too-much\r' });
    assert.equal(throttled.status, 429, 'a keystroke storm must be throttled');
    assert.equal(throttled.json.kind, 'rate-limited');
    await context.call('DELETE', `/api/sessions/${freshId}`);
    await context.call('DELETE', `/api/sessions/${sessionId}`);
  } finally {
    await context.stop();
  }
});

test('a lost runtime host is reported to the UI rather than retried', opts, async () => {
  const context = await startServer({ runtimeArgs: ['--die-after-requests', '4'] });
  try {
    // Subscribed before the session exists: the host dies within a few requests,
    // so attaching afterwards would miss the event and prove nothing.
    const events = await openSse(context.url, '/api/events', context.token);
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    const sessionId = created.json.session.sessionId;

    const lost = await events.next(
      event => event.name === 'session-lost' && event.data.sessionId === sessionId,
      { label: 'a session-lost event' },
    );
    assert.ok(lost.data.reason.length > 0);
    await events.close();

    const observed = await context.call('GET', `/api/sessions/${sessionId}`);
    assert.equal(observed.status, 503, observed.text);
    assert.equal(observed.json.kind, 'backend-lost');

    const listed = await context.call('GET', '/api/sessions');
    assert.equal(listed.status, 200);
    const described = listed.json.sessions.find(entry => entry.sessionId === sessionId);
    assert.ok(described.backendLost, 'the session list must show that the backend was lost');
  } finally {
    await context.stop();
  }
});

test('bridge lifecycle events reach subscribers on /api/events', opts, async () => {
  const context = await startServer();
  try {
    const events = await openSse(context.url, '/api/events', context.token);
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    const sessionId = created.json.session.sessionId;
    const createdEvent = await events.next(
      event => event.name === 'session-created' && event.data.sessionId === sessionId,
      { label: 'session-created' },
    );
    assert.ok(!('owner' in createdEvent.data), 'the created event must not carry an owner token');

    await context.call('PUT', '/api/settings', { appearance: { fontSize: 17 } });
    const settingsEvent = await events.next(event => event.name === 'settings-changed', { label: 'settings-changed' });
    assert.equal(settingsEvent.data.appearance.fontSize, 17);

    await context.call('DELETE', `/api/sessions/${sessionId}`);
    await events.next(
      event => event.name === 'session-closed' && event.data.sessionId === sessionId,
      { label: 'session-closed' },
    );
    await events.close();
  } finally {
    await context.stop();
  }
});

// --------------------------------------------------------------------- settings

test('settings are readable and writable over the API and persist to disk', opts, async () => {
  const context = await startServer();
  try {
    const before = await context.call('GET', '/api/settings');
    assert.equal(before.status, 200);
    assert.equal(before.json.settings.appearance.themeSource, 'system');
    assert.equal(before.json.settings.animation.enabled, false, 'animation must default to off');
    assert.ok(typeof before.json.path === 'string');

    const updated = await context.call('PUT', '/api/settings', {
      appearance: { themeSource: 'light', fontSize: 15 },
      animation: { preset: 'living', enabled: true },
      onboarding: { completed: true },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.settings.appearance.themeSource, 'light');
    assert.equal(updated.json.settings.animation.preset, 'living');
    assert.deepEqual(updated.json.warnings, []);

    // Invalid values are corrected and reported, not silently stored.
    const invalid = await context.call('PUT', '/api/settings', { appearance: { themeSource: 'neon' } });
    assert.equal(invalid.json.settings.appearance.themeSource, 'light', 'a rejected value must leave the stored one alone');
    assert.ok(invalid.json.warnings.some(w => /themeSource/.test(w)), `expected a warning, got ${JSON.stringify(invalid.json.warnings)}`);

    const reloaded = new SettingsStore({ path: context.settings.path });
    await reloaded.load();
    assert.equal(reloaded.values.appearance.fontSize, 15);
    assert.equal(reloaded.values.onboarding.completed, true);

    const animation = await context.call('GET', '/api/animation');
    assert.equal(animation.status, 200);
    assert.equal(animation.json.preset, 'living');
  } finally {
    await context.stop();
  }
});

// ----------------------------------------------------------------- info + static

test('/api/info declares the snapshot output mode and the real limits', opts, async () => {
  const context = await startServer();
  try {
    const info = await context.call('GET', '/api/info');
    assert.equal(info.status, 200);
    // The runtime exposes a rendered viewport, not raw bytes, so snapshot is the
    // only honest mode. Declaring it lets a future raw-output protocol addition
    // be negotiated rather than assumed.
    assert.equal(info.json.outputMode, 'snapshot');
    assert.deepEqual(info.json.outputModes, ['snapshot']);
    assert.equal(info.json.limits.sessionLimitPerHost, 16);
    assert.equal(info.json.limits.recycleAfterSessions, 350);
    assert.equal(info.json.milestone, 'PR1');
    assert.deepEqual(info.json.animationEvents, [], 'PR1 wires no animation events; PR2 fills this in');
    assert.deepEqual(info.json.hosts, [], 'runtime hosts are started lazily, on first session');
    assert.equal(info.json.runtime, null, 'no handshake has happened yet');

    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    assert.equal(created.status, 201);
    const after = await context.call('GET', '/api/info');
    assert.equal(after.json.runtime.protocolVersion, 1, 'the handshake must be reported once a host exists');
    assert.equal(after.json.runtime.platform, process.platform);
    assert.equal(after.json.runtime.arch, process.arch);
    assert.equal(after.json.hosts.length, 1);
    assert.equal(after.json.hosts[0].active, 1);
    await context.call('DELETE', `/api/sessions/${created.json.session.sessionId}`);
  } finally {
    await context.stop();
  }
});

test('static serving cannot be used to read outside the build directory', opts, async () => {
  const parent = await temporaryDirectory('sentiora-static-');
  const staticRoot = join(parent, 'dist');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(parent, 'secret.txt'), 'TOP-SECRET-VALUE', 'utf8');
  await writeFile(join(staticRoot, 'index.html'), '<html><body>ui</body></html>', 'utf8');
  const context = await startServer({ staticRoot });
  try {
    const index = await raw({ host: '127.0.0.1', port: context.port, method: 'GET', path: '/' });
    assert.equal(index.status, 200);
    assert.match(index.text, /<body>ui<\/body>/);
    assert.match(index.headers['content-type'], /text\/html/);

    for (const path of ['/%2e%2e/secret.txt', '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e%2f%2e%2e%2fpackage.json']) {
      const escaped = await raw({ host: '127.0.0.1', port: context.port, method: 'GET', path });
      assert.ok(!escaped.text.includes('TOP-SECRET-VALUE'), `${path} leaked a file outside the build directory`);
      assert.ok([200, 403, 404].includes(escaped.status), `${path} returned ${escaped.status}`);
    }
    // Unknown paths fall back to the entry document, which is what an SPA needs.
    const spa = await raw({ host: '127.0.0.1', port: context.port, method: 'GET', path: '/some/deep/route' });
    assert.equal(spa.status, 200);
    assert.match(spa.text, /<body>ui<\/body>/);
  } finally {
    await context.stop();
    await removeDirectory(parent);
  }
});

test('without a build the server says so instead of serving nothing', opts, async () => {
  const context = await startServer({ staticRoot: null });
  try {
    const root = await raw({ host: '127.0.0.1', port: context.port, method: 'GET', path: '/' });
    assert.equal(root.status, 200);
    assert.match(root.text, /No built UI was found/);
    assert.match(root.text, /npm --prefix apps\/desktop run build/);
  } finally {
    await context.stop();
  }
});

// ------------------------------------------------------------------ session env
//
// Round 1 of review found that living-terminal.md promised callers they could
// narrow a session with `env`, while SessionBridge.create had no such parameter and
// POST /api/sessions never forwarded one -- so a client posting {"env":{}} got 201
// and the user's entire environment. These tests exist so that path cannot silently
// regress again: the fake runtime echoes what it actually received.

test('POST /api/sessions forwards a caller env to the runtime', opts, async () => {
  const context = await startServer();
  try {
    const created = await context.call('POST', '/api/sessions', {
      shellId: SHELL_ID, cols: 40, rows: 10, env: { SENTIORA_ENV_PROBE: 'narrow' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const stream = await openSse(context.url, `/api/sessions/${created.json.session.sessionId}/stream`, context.token);
    const snapshot = await stream.next(event => event.name === 'snapshot', { label: 'snapshot' });
    const screen = snapshot.data.lines.join('\n');
    // keys=1 is the load-bearing part: it proves the caller's env REPLACED the
    // bridge's own environment rather than being merged into it. Deleting the
    // forwarding line in ipc.js or SessionBridge.create makes this fail.
    assert.match(screen, /FAKE ENV probe=narrow keys=1/,
      `the caller env did not reach the runtime intact:\n${screen}`);
    await stream.close();
    await context.call('DELETE', `/api/sessions/${created.json.session.sessionId}`);
  } finally {
    await context.stop();
  }
});

test('a session created without an explicit env still gets the bridge environment', opts, async () => {
  // The desktop bridge deliberately opts into its own environment: it runs as the
  // local user and its sessions ARE that user's shells, so applying the runtime's
  // allowlist would drop the user's variables with no security gain. If
  // RuntimeClient stopped substituting this.env, every desktop shell would silently
  // lose the user's environment -- and nothing else would notice.
  process.env.SENTIORA_BRIDGE_MARKER = 'bridge-default';
  const context = await startServer();
  try {
    const created = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10 });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const stream = await openSse(context.url, `/api/sessions/${created.json.session.sessionId}/stream`, context.token);
    const snapshot = await stream.next(event => event.name === 'snapshot', { label: 'snapshot' });
    assert.match(snapshot.data.lines.join('\n'), /FAKE ENV bridge=bridge-default/,
      'the bridge did not opt its own environment in for a default create');
    await stream.close();
    await context.call('DELETE', `/api/sessions/${created.json.session.sessionId}`);
  } finally {
    delete process.env.SENTIORA_BRIDGE_MARKER;
    await context.stop();
  }
});

test('a malformed env is refused with 400 invalid-env, not a runtime 500', opts, async () => {
  const context = await startServer();
  try {
    // `null` is the important one: it used to mean "not supplied", so the bridge
    // substituted its OWN environment and answered 201 -- a narrowing feature
    // failing open on the only externally reachable path.
    const shapes = [null, 'not-an-object', 42, true, [], { 'A=B': 'x' }, { A: 1 }, { A: null }, { A: 'x\u0000y' }, { '': 'x' }];
    for (const env of shapes) {
      const refused = await context.call('POST', '/api/sessions', { shellId: SHELL_ID, cols: 40, rows: 10, env });
      assert.equal(refused.status, 400, `env ${JSON.stringify(env)} should be refused, got ${refused.status}`);
      assert.equal(refused.json.kind, 'invalid-env',
        `env ${JSON.stringify(env)} got the wrong kind: ${JSON.stringify(refused.json)}`);
      // The refusal must not become a second leak.
      assert.ok(!JSON.stringify(refused.json).includes('\u0000'), 'the refusal echoed a control character');
    }
    assert.deepEqual((await context.call('GET', '/api/sessions')).json.sessions, [],
      'a refused create must not leave a session behind');
  } finally {
    await context.stop();
  }
});

// ------------------------------------------------------- session tree and messages

test('the UI gets the session tree and messages over HTTP, never a capability', opts, async () => {
  const context = await startServer();
  try {
    // Created through the bridge directly: this test is about what the HTTP surface exposes,
    // not about create validation, which has its own tests above.
    const parent = await context.backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const child = await context.backend.bridge.create({ command: 'fake', cols: 40, rows: 10, parentSessionId: parent.sessionId });

    const listing = await context.call('GET', '/api/sessions');
    assert.equal(listing.status, 200);
    const byId = new Map(listing.json.sessions.map(session => [session.sessionId, session]));
    assert.equal(byId.get(parent.sessionId).parent, null);
    assert.equal(byId.get(child.sessionId).parent, parent.sessionId, 'the tree reaches the UI');

    const posted = await context.call('POST', `/api/sessions/${child.sessionId}/messages`, { payload: { text: 'hello' } });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.posted.sequence, 1);

    const frame = await context.call('GET', `/api/sessions/${child.sessionId}/messages?after=0&timeoutMs=100`);
    assert.equal(frame.status, 200);
    assert.deepEqual(frame.json.messages.map(message => message.payload.text), ['hello']);

    // The webview must never receive a credential, on any route this test touched.
    for (const body of context.bodies) assert.doesNotMatch(body, /"owner"|"capability"|"mailbox"/);
  } finally {
    await context.stop();
  }
});

test('a message cursor that is not a non-negative number is refused', opts, async () => {
  const context = await startServer();
  try {
    const session = await context.backend.bridge.create({ command: 'fake', cols: 40, rows: 10 });
    const bad = await context.call('GET', `/api/sessions/${session.sessionId}/messages?after=-1`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.kind, 'invalid-request');
  } finally {
    await context.stop();
  }
});
