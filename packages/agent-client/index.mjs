// Zero-dependency client for the Sentiora runtime (src/server.js, protocolVersion 1).
//
// Written for agents rather than people: the two things a caller gets wrong with the
// raw protocol are handled here, and nowhere else.
//
//   1. terminal.type requires the CURRENT revision. Observe-then-type races with any
//      output that arrives in between, so sendText() observes, types, and retries on
//      "Stale observation" instead of making every caller implement that loop.
//   2. terminal.stream is a cursor, not a subscription. read() decodes the base64
//      output events, reports resync explicitly (the first attach and any overflow
//      return a screen snapshot instead of bytes), and returns the exit event so a
//      caller never has to poll observe() to learn that the child is gone.
//
// What is deliberately NOT here: retries for a dead host, a shell, or command
// suggestion. A dead host is an error (issue #21), not something to paper over.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_SERVER = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const DEFAULT_TIMEOUT_MS = 30000;

/** A live session handle. `owner` is required for type/resize/close and is never public. */
export class AgentSession {
  constructor(client, observation) {
    this.client = client;
    this.sessionId = observation.sessionId;
    this.owner = observation.owner;
    this.pid = observation.pid ?? null;
    this.cols = observation.cols;
    this.rows = observation.rows;
  }

  observe() { return this.client.observe(this); }
  sendText(text) { return this.client.sendText(this, text); }
  sendLine(line) { return this.client.sendLine(this, line); }
  read(options) { return this.client.read(this, options); }
  close() { return this.client.close(this); }
}

export class AgentClient {
  /**
   * Spawns the runtime and completes `initialize`. The runtime is a child process with
   * its own stdio, so a misbehaving shell cannot corrupt this client's channel.
   */
  static async connect({
    serverPath = DEFAULT_SERVER,
    node = process.execPath,
    cwd = process.cwd(),
    env = process.env,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    serverArgs = [],
  } = {}) {
    const child = spawn(node, [serverPath, ...serverArgs], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new AgentClient(child, { requestTimeoutMs });
    await client.initialize();
    return client;
  }

  constructor(child, { requestTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.info = null;
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.buffered = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('exit', (code, signal) => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`runtime exited (code=${code} signal=${signal}) before answering`));
      }
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buffered += chunk;
    let newline;
    while ((newline = this.buffered.indexOf('\n')) !== -1) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // The runtime never writes non-JSON to stdout (WIN-15). If that changes, say so
        // rather than silently dropping the line.
        this.stderr += `unparseable stdout line: ${line}\n`;
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? 'runtime error');
        error.code = message.error.code;
        error.method = pending.method;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('client is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} did not answer within ${timeoutMs}ms`), { code: 'ETIMEDOUT', method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize() {
    this.info = await this.request('initialize', {});
    return this.info;
  }

  async create({ command, args = [], cols = 120, rows = 40, cwd, env, conptyDll, recordInput, recordBytes } = {}) {
    const observation = await this.request('terminal.create', {
      command, args, cols, rows, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}),
      ...(conptyDll !== undefined ? { conptyDll } : {}),
      ...(recordInput !== undefined ? { recordInput } : {}),
      ...(recordBytes !== undefined ? { recordBytes } : {}),
    });
    return new AgentSession(this, observation);
  }

  async list() {
    return this.request('terminal.list', {});
  }

  observe(session) {
    return this.request('terminal.observe', { sessionId: session.sessionId });
  }

  /**
   * Revision-armed input. The runtime rejects a stale revision rather than guessing, so
   * the retry lives here: observe, type, and re-observe if output moved the revision in
   * between. Three attempts is enough for a quiet shell; a shell that never stops
   * writing is a caller decision, not something to retry forever.
   */
  async sendText(session, text, { attempts = 3 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const observation = await this.observe(session);
      if (observation.exit || observation.state === 'released') {
        throw Object.assign(new Error('session is not running'), { code: 'ESESSIONCLOSED' });
      }
      try {
        return await this.request('terminal.type', {
          sessionId: session.sessionId, owner: session.owner, revision: observation.revision, text,
        });
      } catch (error) {
        if (!/Stale observation/.test(error.message) || attempt === attempts) throw error;
      }
    }
    throw new Error('unreachable');
  }

  sendLine(session, line) {
    return this.sendText(session, `${line}\r`);
  }

  /**
   * One cursor step. Returns decoded output, the next cursor, whether this was a
   * resync (a snapshot instead of bytes), and the exit event if the child ended.
   */
  async read(session, { afterSequence = 0, timeoutMs = 1000 } = {}) {
    const frame = await this.request('terminal.stream', {
      sessionId: session.sessionId, afterSequence, timeoutMs,
    }, { timeoutMs: timeoutMs + this.requestTimeoutMs });
    const events = frame.events ?? [];
    const exitEvent = events.find(event => event.kind === 'exit');
    const output = events
      .filter(event => event.kind === 'output')
      .map(event => Buffer.from(event.data, 'base64').toString('utf8'))
      .join('');
    if (frame.resync || (frame.snapshot && events.length === 0)) {
      return {
        text: frame.snapshot?.screen ?? '', nextSequence: frame.nextSequence,
        resync: true, truncated: frame.truncated === true, exit: frame.exit ?? null,
        running: frame.running, events,
      };
    }
    return {
      text: output, nextSequence: frame.nextSequence, resync: false,
      truncated: frame.truncated === true, exit: frame.exit ?? exitEvent?.exit ?? null,
      running: frame.running, events,
    };
  }

  async wait(session, afterRevision, timeoutMs = 1000) {
    return this.request('terminal.wait', { sessionId: session.sessionId, afterRevision, timeoutMs });
  }

  /**
   * The agent-shaped read: keep consuming until the collected text contains `needle`.
   * A resync replaces the collected text with the snapshot (the snapshot already
   * accounts for the bytes, so appending would duplicate them), and a child exit ends
   * the wait with `exited: true` instead of burning the timeout.
   */
  async waitForText(session, needle, { timeoutMs = 20000, afterSequence = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let cursor = afterSequence;
    let text = '';
    for (;;) {
      const remaining = deadline - Date.now();
      const frame = await this.read(session, { afterSequence: cursor, timeoutMs: Math.max(1, Math.min(500, remaining)) });
      cursor = frame.nextSequence;
      text = frame.resync ? frame.text : text + frame.text;
      if (text.includes(needle)) return { text, frame, nextSequence: cursor };
      if (frame.exit !== null && frame.exit !== undefined) return { text, frame, nextSequence: cursor, exited: true };
      if (Date.now() >= deadline) {
        throw new Error(`text ${JSON.stringify(needle)} not seen within ${timeoutMs}ms; last text:\n${text}`);
      }
    }
  }

  async close(session) {
    return this.request('terminal.close', { sessionId: session.sessionId, owner: session.owner });
  }

  /** Ends the runtime's stdin and waits for it to exit; SIGKILLs only after the cap. */
  async dispose({ timeoutMs = 20000 } = {}) {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, timeoutMs);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export default AgentClient;
