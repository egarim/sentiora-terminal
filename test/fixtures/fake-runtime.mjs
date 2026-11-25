// Scriptable stand-in for src/server.js, used only by the bridge unit tests.
//
// It reproduces the parts of the real protocol that the bridge has to get right,
// so those can be tested deterministically and on every CI platform without
// spending a PTY:
//   * newline-delimited JSON-RPC 2.0 over stdio, every error code -32000;
//   * the revision guard ('Stale observation') and the fact that a write bumps
//     the revision itself;
//   * lifecycle states spawned -> operational -> exited -> released;
//   * 'Session limit', 'Invalid dimensions', 'Unknown session', ownership errors;
//   * a configurable host ceiling ('Invalid pty handle') and sudden death, which
//     is what exercises recycling and the backend-lost path.
//
// The real runtime is exercised separately by test/desktop-native.test.js. This
// fixture never replaces those tests.
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const flag = name => argv.includes(`--${name}`);

const SESSION_LIMIT = Number(option('session-limit', 16));
// Fails terminal.create with 'Invalid pty handle' once this many sessions have
// been created, mimicking the descriptor exhaustion the real host hits near ~495.
const FAIL_AFTER = Number(option('fail-after', Infinity));
const DEFAULT_ROWS = Number(option('rows', 12));
const DEFAULT_COLS = Number(option('cols', 40));
// Replies with this many lines per command, so a burst can be produced on demand.
const BURST_LINES = Number(option('burst-lines', 0));
const STALE_FIRST = Number(option('stale-first', 0));
// Leaves created sessions in 'spawned' instead of booting them to 'operational',
// so tests can prove 'spawned' is never treated as readiness.
const NO_AUTOBOOT = flag('no-autoboot');
let staleRemaining = STALE_FIRST;

let created = 0;
let nextSession = 1;
const sessions = new Map();

class FakeSession {
  constructor({ id, owner, cols, rows, command, args, pid }) {
    this.id = id;
    this.owner = owner;
    this.pid = pid;
    this.command = command;
    this.args = args;
    this.cols = cols;
    this.rows = rows;
    this.revision = 0;
    this.state = 'spawned';
    this.exit = null;
    this.closed = false;
    this.writeErrors = 0;
    this.lines = Array.from({ length: rows }, () => '');
    this.cursor = { x: 0, y: 0 };
    this.received = [];      // every input string, in order, for framing assertions
    this.waiters = new Set();
    this.lastActivity = Date.now();
  }

  changed() {
    this.revision += 1;
    this.lastActivity = Date.now();
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  print(text) {
    for (const line of text.split('\n')) {
      this.lines.push(line);
      while (this.lines.length > this.rows) this.lines.shift();
    }
    if (this.state === 'spawned') this.state = 'operational';
    this.changed();
  }

  observe() {
    return {
      sessionId: this.id,
      pid: this.pid,
      state: this.state,
      revision: this.revision,
      running: !this.exit && !this.closed,
      exit: this.exit,
      cols: this.cols,
      rows: this.rows,
      writeErrors: this.writeErrors,
      cursor: { ...this.cursor },
      screen: this.lines.join('\n'),
      idleMilliseconds: Date.now() - this.lastActivity,
    };
  }

  input({ owner, revision, text }) {
    if (this.closed || this.exit) throw Error('Session not running');
    if (owner !== this.owner) throw Error('Input ownership required');
    if (revision !== this.revision) throw Error('Stale observation');
    if (typeof text !== 'string' || text.length > 65536) throw Error('Invalid input');
    // Injected staleness: the first STALE_FIRST writes are refused however they
    // were armed, which is what forces the bridge's observe-and-retry path. In the
    // real runtime this happens whenever output lands between the observe and the
    // write, and it was observed in normal use rather than only under stress.
    if (staleRemaining > 0) {
      staleRemaining -= 1;
      this.changed();
      throw Error('Stale observation');
    }
    this.received.push(text);
    // The real runtime bumps the revision on input too, which is why a wait armed
    // with the pre-write revision returns before the child has answered.
    this.changed();
    if (flag('lose-input')) this.writeErrors += 1;
    for (const chunk of text.split(/[\r\n]/)) {
      if (chunk === '') continue;
      if (chunk === 'exit') { this.exit = { exitCode: 0, signal: null }; this.state = 'exited'; this.changed(); continue; }
      if (chunk.startsWith('echo ')) this.print(chunk.slice(5));
      else if (chunk === 'burst' && BURST_LINES > 0) {
        this.print(Array.from({ length: BURST_LINES }, (_, i) => `BURST-${i}`).join('\n'));
      } else this.print(`ECHO:${chunk}`);
    }
    return { revision: this.revision };
  }

  async wait(after, timeout = 1000) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(timeout) || timeout < 0) throw Error('Invalid wait');
    if (this.revision === after && !this.exit && !this.closed) {
      await new Promise(wake => {
        const timer = setTimeout(wake, Math.min(timeout, 30000));
        this.waiters.add(() => { clearTimeout(timer); wake(); });
      });
    }
    return this.observe();
  }

  resize(owner, cols, rows) {
    if (owner !== this.owner || this.closed || this.exit) throw Error('Resize denied');
    dimensions(cols, rows);
    this.cols = cols;
    this.rows = rows;
    while (this.lines.length > rows) this.lines.shift();
    while (this.lines.length < rows) this.lines.push('');
    this.changed();
    return this.observe();
  }
}

function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 300 || rows < 2 || rows > 150) {
    throw Error('Invalid dimensions');
  }
}

const keys = {
  Enter: '\r', Escape: '\x1b', Tab: '\t', Backspace: '\x7f',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D', CtrlC: '\x03',
};

async function dispatch(method, params = {}) {
  if (method === 'initialize') {
    return { protocolVersion: 1, platform: process.platform, arch: process.arch, conptyDll: false, fake: true };
  }
  if (method === 'terminal.create') {
    if (created >= FAIL_AFTER) throw Error('Invalid pty handle');
    if (sessions.size >= SESSION_LIMIT) throw Error('Session limit');
    const { command, args = [], cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = params;
    dimensions(cols, rows);
    if (typeof command !== 'string' || !command || !Array.isArray(args)) throw Error('Invalid command');
    created += 1;
    const n = nextSession++;
    // Ids restart per process, so two pooled hosts can hand out the same id. The
    // real runtime uses randomUUID and will not collide in practice, but the
    // protocol promises no cross-host uniqueness -- so this fixture deliberately
    // collides to prove the bridge namespaces ids itself instead of trusting it.
    const session = new FakeSession({
      id: `fake-${n}`, owner: `owner-${n}`, pid: 40000 + n, cols, rows, command, args,
    });
    sessions.set(session.id, session);
    // The owner token is announced on stderr only. It must never appear on stdout
    // (that is the RPC channel) and the bridge must never forward it to the UI;
    // the tests read stderr to learn what was issued so they can assert absence.
    process.stderr.write(`OWNER ${session.id} ${session.owner}\n`);
    // autoboot:false leaves the session in 'spawned', which is how the tests
    // assert that 'spawned' is not treated as readiness.
    if (!NO_AUTOBOOT && params.autoboot !== false) session.print('FAKE READY');
    return { ...session.observe(), owner: session.owner };
  }
  if (method === 'terminal.list') return [...sessions.values()].map(s => s.observe());
  const session = sessions.get(params.sessionId);
  if (!session) throw Error('Unknown session');
  switch (method) {
    case 'terminal.observe': return session.observe();
    case 'terminal.type': return session.input(params);
    case 'terminal.key':
      if (!Object.hasOwn(keys, params.key)) throw Error('Unknown key');
      return session.input({ ...params, text: keys[params.key] });
    case 'terminal.wait': return session.wait(params.afterRevision, params.timeoutMs);
    case 'terminal.resize': return session.resize(params.owner, params.cols, params.rows);
    case 'terminal.close':
      if (params.owner !== session.owner) throw Error('Ownership required');
      session.closed = true;
      session.state = 'released';
      sessions.delete(session.id);
      return true;
    default: throw Error('Unknown method');
  }
}

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });

// Host-death and framing-corruption injection. The bridge has to treat both as
// fatal for every session on that host rather than retrying into a new one.
const DIE_AFTER_REQUESTS = Number(option('die-after-requests', Infinity));
const DIE_EXIT_CODE = Number(option('die-exit-code', 7));
const CORRUPT_AFTER_REQUESTS = Number(option('corrupt-after-requests', Infinity));
let requestCount = 0;

readline.on('line', async line => {
  requestCount += 1;
  if (requestCount === CORRUPT_AFTER_REQUESTS) process.stdout.write('this is not json-rpc\n');
  if (requestCount >= DIE_AFTER_REQUESTS) process.exit(DIE_EXIT_CODE);
  let request;
  try {
    request = JSON.parse(line);
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !Object.hasOwn(request, 'id')) {
      throw Error('Invalid request');
    }
    const result = await dispatch(request.method, request.params);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message },
    })}\n`);
  }
});
readline.on('close', () => process.exit(0));
