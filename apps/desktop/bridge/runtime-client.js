// Client for one Sentiora runtime host process: newline-delimited JSON-RPC 2.0
// over stdio, exactly the surface src/server.js speaks.
//
// Zero dependencies on purpose. The root package installs only node-pty and
// @xterm/headless, so the bridge has to be loadable and testable under a plain
// `npm ci` -- and under Tauri it will run as a sidecar with no UI toolchain
// present.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { classify, TransportError, SentioraError } from './errors.js';
import { PROTOCOL_VERSION, SHUTDOWN_GRACE_MS } from './protocol.js';

export class RuntimeClient extends EventEmitter {
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #stderr = '';
  #exit = null;
  #fatal = null;
  #lifetimeSessions = 0;

  // `env` is the environment of the runtime HOST process. Since issue #26 it is no
  // longer also the environment of every session: the runtime now defaults a
  // session to a small allowlist (PATH, HOME or USERPROFILE, TERM, LANG, the
  // platform temp variable -- TMPDIR on POSIX, TEMP/TMP on Windows -- and the
  // Windows essentials) and inherits nothing else unless the caller names it.
  // createSession below opts this bridge in explicitly, because the desktop runs as
  // the local user and its sessions are that user's own shells -- see the comment
  // there for why that is not a privilege boundary being crossed.
  constructor({ command = process.execPath, args = [], cwd, env = process.env, name = 'host' } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.name = name;
    this.info = null;
  }

  get alive() {
    return this.#child !== null && this.#exit === null && this.#fatal === null;
  }

  get dead() {
    return this.#exit !== null || this.#fatal !== null;
  }

  // Lifetime terminal.create calls, not the live count. The ceiling that kills a
  // host is counted in create/close cycles because the leaked descriptors are
  // never reclaimed, so a host that has churned 350 short sessions is as worn
  // out as one holding 350 live ones.
  get lifetimeSessions() {
    return this.#lifetimeSessions;
  }

  get exitInfo() {
    return this.#exit;
  }

  get fatalError() {
    return this.#fatal;
  }

  start() {
    if (this.#child) throw new Error('runtime host already started');
    // windowsHide keeps a spawned runtime from flashing a console window, and
    // piped stdio is what makes a misbehaving child unable to corrupt the
    // bridge's own streams (verified by WIN-15).
    this.#child = spawn(this.command, this.args, {
      cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', chunk => {
      // Bounded: a chatty child must not grow the bridge without limit.
      this.#stderr = (this.#stderr + chunk).slice(-8192);
    });
    this.#child.once('exit', (code, signal) => {
      this.#exit = { code, signal };
      this.#failPending(new SentioraError('backend-lost', `runtime host exited (code ${code}, signal ${signal})`));
      this.emit('exit', this.#exit);
    });
    this.#child.once('error', error => {
      this.#fatal = error;
      this.#failPending(new SentioraError('backend-lost', `runtime host failed to start: ${error.message}`));
      this.emit('transport-error', error);
    });

    createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
      .on('line', line => this.#onLine(line));
    return this;
  }

  #onLine(line) {
    if (line === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      // A non-parsing line means the framing is broken. Skipping it would hide
      // the corruption, so it is fatal and every in-flight request fails.
      this.#fatal = new TransportError(`runtime stdout was not JSON: ${line.slice(0, 200)}`, { cause: error });
      this.#failPending(this.#fatal);
      this.emit('transport-error', this.#fatal);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return; // a response nobody asked for; ignored, never trusted
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(classify(message.error.message));
    else pending.resolve(message.result);
  }

  #failPending(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  call(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (!this.alive) {
      let detail = 'not started';
      if (this.#fatal) detail = this.#fatal.message;
      else if (this.#exit) detail = `code ${this.#exit.code} signal ${this.#exit.signal}`;
      return Promise.reject(new SentioraError('backend-lost', `runtime host is not alive (${detail})`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new SentioraError('timeout', `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new SentioraError('backend-lost', `write to runtime stdin failed: ${error.message}`));
      }
    });
  }

  // Handshake before any session work. protocolVersion is verified rather than
  // assumed, and the host's platform/arch/conptyDll are recorded so a run is
  // attributable to a specific configuration.
  async initialize({ timeoutMs = 15000 } = {}) {
    const info = await this.call('initialize', {}, { timeoutMs });
    if (info?.protocolVersion !== PROTOCOL_VERSION) {
      throw new SentioraError(
        'protocol-mismatch',
        `runtime protocolVersion ${info?.protocolVersion} is not ${PROTOCOL_VERSION}`,
      );
    }
    this.info = info;
    this.emit('ready', info);
    return info;
  }

  async createSession(params) {
    // Opt in to the host environment explicitly. The runtime's default is now a
    // small allowlist (issue #26), which is the right default for a remote or agent
    // caller that must not read the host's secrets. This bridge is different: it
    // runs as the local user, and its sessions ARE that user's shells, so narrowing
    // them would silently drop the user's own variables with no security gain --
    // there is no privilege boundary between the bridge and the session. An
    // explicit `env` in params still wins, so a caller can narrow a single session.
    const env = params?.env === undefined ? this.env : params.env;
    const result = await this.call('terminal.create', { ...params, env });
    // Counted only on success: a rejected create leaked nothing.
    this.#lifetimeSessions += 1;
    return result;
  }

  // Graceful shutdown: close stdin, let the runtime reap its sessions (measured
  // ~5.1s), then force-kill the tree. Never returns before the process is gone
  // or provably unkillable.
  async shutdown({ graceMs = SHUTDOWN_GRACE_MS } = {}) {
    if (!this.#child) return { exited: false, forced: false };
    const exited = new Promise(resolve => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) return resolve(true);
      this.#child.once('exit', () => resolve(true));
    });
    try {
      this.#child.stdin.end();
    } catch { /* already closed */ }
    const clean = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), graceMs))]);
    if (clean) return { exited: true, forced: false };
    await this.#forceKill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    return { exited: this.#child.exitCode !== null, forced: true };
  }

  #forceKill() {
    if (!this.#child || this.#child.exitCode !== null) return Promise.resolve();
    const pid = this.#child.pid;
    if (process.platform === 'win32') {
      // /T so the ConPTY helper processes go with it; a detached child left
      // behind would hold the pseudoconsole open.
      return new Promise(resolve => {
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
        killer.once('exit', () => resolve());
        killer.once('error', () => resolve());
      });
    }
    try {
      this.#child.kill('SIGKILL');
    } catch { /* already gone */ }
    return Promise.resolve();
  }

  get stderrTail() {
    return this.#stderr;
  }
}
