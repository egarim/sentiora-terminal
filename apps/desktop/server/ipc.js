// Local authenticated IPC between the UI and the session bridge.
//
// This is the trust boundary. Everything the browser is allowed to do is
// enumerated here, and the two things it must never be able to do are enforced
// structurally rather than by convention:
//
//   1. It must never see a session `owner` token. The bridge holds those; every
//      payload built here comes from SessionBridge.describe() or publicView(),
//      which pick fields explicitly. There is no path from this file to an owner.
//   2. It must never spawn an arbitrary command. POST /api/sessions accepts a
//      shellId from the detected catalog or a validated absolute path -- not a
//      command line. `command`/`args` in the request body are rejected outright.
//
// Authentication is a per-launch bearer token on a loopback-only listener. The
// token is handed out in the URL *fragment*, which browsers never transmit and
// access logs never record, and is then presented as an Authorization header.
// Requests carrying an Origin header are refused unless the origin is allowed,
// which is what stops a random web page from driving a local terminal through a
// browser that happens to hold the token.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { detectShells, resolveShell, validateCustomShell } from '../bridge/shell-catalog.js';
import { resolveAnimation } from '../bridge/settings.js';

const MAX_BODY_BYTES = 1 << 20; // 1 MiB: bounds a hostile or buggy client
// A keystroke storm from a compromised page is the realistic abuse here. This is
// far above any human or paste rate and far below a spin loop.
const INPUT_RATE_LIMIT = 400;
const INPUT_RATE_WINDOW_MS = 1000;

// Errors are mapped to HTTP status by kind so the UI can distinguish "try again"
// from "this session is gone" from "you are not allowed".
const STATUS_BY_KIND = {
  'backend-lost': 503,
  'unknown-session': 404,
  'session-not-running': 409,
  'stale-observation': 409,
  'session-limit': 429,
  'rate-limited': 429,
  'ownership-required': 500, // a wrong owner here would be a bridge bug, not a client one
  'resize-denied': 409,
  'invalid-dimensions': 400,
  'invalid-input': 400,
  'invalid-command': 400,
  'unknown-key': 400,
  'invalid-shell': 400,
  'no-shell': 400,
  'shell-bridge-refused': 403,
  'readiness-timeout': 408,
  'pool-closed': 503,
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'request body was not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

// Server-Sent Events. The client uses fetch() rather than EventSource because
// EventSource cannot send an Authorization header.
function openEventStream(response, { onClose } = {}) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(': connected\n\n');
  // Comment frames keep idle timers and proxies from dropping a quiet stream.
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': ping\n\n');
  }, 15000);
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
    onClose?.();
  };
  response.once('close', finish);
  return {
    get closed() { return closed; },
    // Serialises fire-and-forget sends. send() awaits drain under backpressure, so
    // two concurrent calls could otherwise reach the socket out of order.
    chain: Promise.resolve(),
    // Resolves once the frame is handed to the socket, waiting for drain when the
    // socket is backed up. That wait is the backpressure: the bridge keeps
    // coalescing while a slow consumer catches up, instead of the server growing
    // an unbounded buffer per client.
    async send(event, data) {
      if (closed || response.writableEnded) return false;
      const flushed = response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (flushed) return true;
      await once(response, 'drain').catch(() => {});
      return !closed && !response.writableEnded;
    },
    close: finish,
  };
}

class RateLimiter {
  #hits = new Map();

  allow(key, limit, windowMs) {
    const now = Date.now();
    for (const [staleKey, entry] of this.#hits) {
      if (now - entry.start > windowMs) this.#hits.delete(staleKey);
    }
    const entry = this.#hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      this.#hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }
}

export class IpcServer {
  #bridge;
  #settings;
  #server;
  #token;
  #allowedOrigins;
  #staticRoot;
  #rate = new RateLimiter();
  #eventClients = new Set();
  #inputRateLimit;
  #inputRateWindowMs;

  constructor({
    bridge,
    settings,
    token = generateToken(),
    host = '127.0.0.1',
    port = 0,
    allowedOrigins = [],
    staticRoot = null,
    inputRateLimit = INPUT_RATE_LIMIT,
    inputRateWindowMs = INPUT_RATE_WINDOW_MS,
  }) {
    if (!bridge) throw new Error('IpcServer needs a SessionBridge');
    if (!settings) throw new Error('IpcServer needs a SettingsStore');
    this.#bridge = bridge;
    this.#settings = settings;
    this.#token = token;
    this.#inputRateLimit = inputRateLimit;
    this.#inputRateWindowMs = inputRateWindowMs;
    this.host = host;
    this.requestedPort = port;
    this.port = null;
    this.url = null;
    this.entryUrl = null;
    this.#allowedOrigins = new Set(allowedOrigins);
    this.#staticRoot = staticRoot;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch(error => {
        if (!response.headersSent) sendJson(response, 500, { error: error.message });
        else response.end();
      });
    });
    this.#wireBridgeEvents();
  }

  #wireBridgeEvents() {
    const forward = (event, payload) => {
      for (const client of this.#eventClients) {
        client.chain = client.chain
          .then(() => client.send(event, payload))
          .catch(() => client.close());
      }
    };
    // None of these payloads may contain an owner token; they are all built from
    // describe() or from explicitly listed fields.
    this.#bridge.on('session-created', payload => forward('session-created', payload));
    this.#bridge.on('session-closed', payload => forward('session-closed', payload));
    this.#bridge.on('session-lost', payload => forward('session-lost', payload));
    this.#bridge.on('session-state', payload => forward('session-state', payload));
    this.#bridge.on('write-error', payload => forward('write-error', payload));
    this.#settings.subscribe(values => forward('settings-changed', values));
  }

  listen() {
    return new Promise((resolveListen, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.requestedPort, this.host, () => {
        const address = this.#server.address();
        this.port = address.port;
        this.url = `http://${this.host}:${address.port}`;
        // The fragment is never transmitted to a server, so handing the token out
        // this way keeps it out of access logs and referer headers.
        this.entryUrl = `${this.url}/#token=${this.#token}`;
        resolveListen({ url: this.url, port: this.port, token: this.#token, entryUrl: this.entryUrl });
      });
    });
  }

  async close() {
    for (const client of this.#eventClients) client.close();
    this.#eventClients.clear();
    // server.close() waits for every connection to finish, and HTTP keep-alive
    // connections sit idle for seconds before a client gives them up. Closing
    // idle ones immediately -- and all of them after a short grace, since an SSE
    // stream is never "idle" -- is what makes shutdown and Ctrl+C prompt.
    this.#server.closeIdleConnections?.();
    const closed = new Promise(resolveClose => this.#server.close(resolveClose));
    const forced = setTimeout(() => this.#server.closeAllConnections?.(), 2000);
    try {
      await closed;
    } finally {
      clearTimeout(forced);
    }
  }

  #authorized(request) {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return tokenMatches(header.slice(7).trim(), this.#token);
    }
    return false;
  }

  #originAllowed(request) {
    const origin = request.headers.origin;
    // No Origin header means a non-browser client (curl, a packaged webview's
    // native fetch, or a test). Loopback binding plus the bearer token is what
    // protects that path.
    if (origin === undefined) return true;
    if (origin === 'null') return false;
    if (this.#allowedOrigins.has(origin)) return true;
    return origin === this.url;
  }

  async #handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (!this.#originAllowed(request)) return sendJson(response, 403, { error: 'origin not allowed' });

    // The entry document is served without the token so the browser can load the
    // page that then reads the token out of its own fragment. Everything under
    // /api requires it.
    if (!path.startsWith('/api/')) return this.#serveStatic(request, response, path);
    if (!this.#authorized(request)) {
      return sendJson(response, 401, { error: 'a valid bearer token is required' });
    }

    const method = request.method ?? 'GET';
    const route = path.split('/').filter(Boolean).slice(1).join('/');

    try {
      if (route === 'health' && method === 'GET') {
        return sendJson(response, 200, { ok: true, sessions: this.#bridge.sessions.length });
      }
      if (route === 'info' && method === 'GET') return sendJson(response, 200, this.#info());
      if (route === 'shells' && method === 'GET') return sendJson(response, 200, { shells: detectShells() });
      if (route === 'settings' && method === 'GET') {
        return sendJson(response, 200, {
          settings: this.#settings.values, warnings: this.#settings.warnings, path: this.#settings.path,
        });
      }
      if (route === 'settings' && method === 'PUT') {
        const result = await this.#settings.updateAndSave(await readBody(request));
        return sendJson(response, 200, { settings: result.values, warnings: result.warnings });
      }
      if (route === 'animation' && method === 'GET') {
        // The OS reduced-motion preference lives in the browser, so the caller
        // reports it; keeping the resolution rule server-side means there is one
        // implementation of "what animation is actually allowed".
        const systemReducedMotion = url.searchParams.get('reducedMotion') === '1';
        return sendJson(response, 200, resolveAnimation(this.#settings.values, { systemReducedMotion }));
      }
      if (route === 'sessions' && method === 'GET') {
        return sendJson(response, 200, { sessions: this.#bridge.sessions });
      }
      if (route === 'sessions' && method === 'POST') return this.#createSession(request, response);
      if (route === 'events' && method === 'GET') {
        const client = openEventStream(response, { onClose: () => this.#eventClients.delete(client) });
        this.#eventClients.add(client);
        return undefined;
      }

      const sessionMatch = route.match(/^sessions\/([^/]+)(?:\/(.+))?$/);
      if (sessionMatch) {
        return await this.#sessionRoute(request, response, decodeURIComponent(sessionMatch[1]), sessionMatch[2] ?? '', method);
      }
      return sendJson(response, 404, { error: `no such endpoint: ${path}` });
    } catch (error) {
      const status = error.status ?? STATUS_BY_KIND[error.kind] ?? 400;
      return sendJson(response, status, { error: error.message, kind: error.kind ?? 'error' });
    }
  }

  #info() {
    return {
      product: 'Sentiora Living Terminal',
      milestone: 'PR1',
      // Snapshot delivery is the only mode the current runtime can support: it
      // exposes the rendered viewport, not raw output bytes, so there is no
      // faithful byte stream to forward. See docs/desktop/living-terminal.md.
      outputMode: 'snapshot',
      outputModes: ['snapshot'],
      hosts: this.#bridge.hosts,
      runtime: this.#bridge.runtimeInfo,
      limits: this.#bridge.limits,
      // Declared so PR2 can wire typed animation events through this transport
      // without changing it.
      animationEvents: [],
    };
  }

  async #createSession(request, response) {
    const body = await readBody(request);
    // The webview may select a shell; it may not compose one. Accepting a command
    // string here would turn the frontend into an arbitrary process launcher.
    if (body.command !== undefined || body.args !== undefined) {
      return sendJson(response, 403, {
        error: 'command and args are not accepted from the UI; select a shellId or provide a customPath',
        kind: 'shell-bridge-refused',
      });
    }
    const shells = detectShells();
    let shell;
    if (typeof body.customPath === 'string' && body.customPath) {
      const validated = validateCustomShell(body.customPath);
      if (!validated.ok) return sendJson(response, 400, { error: validated.reason, kind: 'invalid-shell' });
      shell = validated.shell;
    } else if (typeof body.shellId === 'string' && body.shellId) {
      shell = shells.find(candidate => candidate.id === body.shellId);
      if (!shell) return sendJson(response, 400, { error: `unknown shellId: ${body.shellId}`, kind: 'invalid-shell' });
    } else {
      shell = resolveShell({ shell: { id: 'auto' } }, shells).shell;
    }
    if (!shell) return sendJson(response, 400, { error: 'no shell is available on this machine', kind: 'no-shell' });

    const session = await this.#bridge.create({
      command: shell.command,
      args: shell.args,
      cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined,
      cols: body.cols,
      rows: body.rows,
      label: typeof body.label === 'string' ? body.label.slice(0, 120) : shell.label,
      shell,
    });
    return sendJson(response, 201, { session });
  }

  async #sessionRoute(request, response, sessionId, action, method) {
    if (action === '' && method === 'GET') {
      return sendJson(response, 200, { session: await this.#bridge.observe(sessionId) });
    }
    if (action === '' && method === 'DELETE') {
      return sendJson(response, 200, { closed: await this.#bridge.close(sessionId) });
    }
    if (action === 'stream' && method === 'GET') {
      const subscription = this.#bridge.attach(sessionId);
      const client = openEventStream(response, { onClose: () => subscription.detach() });
      request.once('close', () => client.close());
      // A reconnecting client always gets the full snapshot plus the recovered
      // scrollback first, so it can never paint a partial screen (test U04).
      await client.send('snapshot', subscription.snapshot);
      (async () => {
        for (;;) {
          const frame = await subscription.next();
          if (frame === null || client.closed) break;
          if (!await client.send('frame', frame)) break;
        }
        client.close();
      })().catch(() => client.close());
      return undefined;
    }
    if (action === 'input' && method === 'POST') {
      const body = await readBody(request);
      const hasText = typeof body.text === 'string' && body.text.length > 0;
      const hasKey = typeof body.key === 'string';
      if (!hasText && !hasKey) {
        return sendJson(response, 400, { error: 'input requires a non-empty text or a key name', kind: 'invalid-input' });
      }
      // Counted after validation so a malformed request cannot consume the budget
      // that exists to stop a keystroke storm from reaching the runtime.
      if (!this.#rate.allow(`input:${sessionId}`, this.#inputRateLimit, this.#inputRateWindowMs)) {
        return sendJson(response, 429, { error: 'input rate limit exceeded', kind: 'rate-limited' });
      }
      if (hasText) return sendJson(response, 200, await this.#bridge.type(sessionId, body.text));
      return sendJson(response, 200, await this.#bridge.key(sessionId, body.key));
    }
    if (action === 'interrupt' && method === 'POST') {
      const body = await readBody(request);
      const result = await this.#bridge.interrupt(sessionId, {
        readyPattern: typeof body.readyPattern === 'string' && body.readyPattern
          ? new RegExp(body.readyPattern.slice(0, 200))
          : null,
        timeoutMs: Number.isFinite(body.timeoutMs) ? Math.min(Math.max(body.timeoutMs, 0), 30000) : 0,
      });
      return sendJson(response, result.delivered ? 200 : 409, result);
    }
    if (action === 'resize' && method === 'POST') {
      const body = await readBody(request);
      return sendJson(response, 200, await this.#bridge.resize(sessionId, body.cols, body.rows));
    }
    return sendJson(response, 404, { error: `no such session action: ${action}` });
  }

  async #serveStatic(request, response, path) {
    if (!this.#staticRoot) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return response.end([
        'Sentiora Living Terminal bridge is running.',
        '',
        'No built UI was found. Either:',
        '  npm --prefix apps/desktop run build   (then restart this server)',
        '  npm --prefix apps/desktop run dev     (vite dev server, proxied here)',
        '',
        `API base: ${this.url}/api  (bearer token required)`,
      ].join('\n'));
    }
    const relative = path === '/' ? 'index.html' : normalize(path).replace(/^[/\\]+/, '');
    const target = resolve(this.#staticRoot, relative);
    // Containment check after resolve(): a traversal that escapes the build
    // directory must not be able to read arbitrary files off disk.
    if (target !== this.#staticRoot && !target.startsWith(this.#staticRoot + sep)) {
      return sendJson(response, 403, { error: 'path outside the served directory' });
    }
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      const index = join(target, 'index.html');
      return this.#streamFile(response, index, await stat(index).catch(() => null));
    }
    if (info) return this.#streamFile(response, target, info);
    // Single-page app: unknown paths fall back to the entry document.
    const fallback = join(this.#staticRoot, 'index.html');
    return this.#streamFile(response, fallback, await stat(fallback).catch(() => null));
  }

  #streamFile(response, target, info) {
    if (!info?.isFile()) return sendJson(response, 404, { error: 'not found' });
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(response);
    return undefined;
  }
}

export { INPUT_RATE_LIMIT, INPUT_RATE_WINDOW_MS, MAX_BODY_BYTES, STATUS_BY_KIND };
