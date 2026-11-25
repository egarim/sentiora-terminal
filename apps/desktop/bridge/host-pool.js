// Pool of Sentiora runtime host processes.
//
// One host is not enough and is not immortal:
//   * a host rejects terminal.create past 16 concurrent sessions ('Session limit');
//   * a host leaks ~1 fd and ~1.75 Win32 handles per session and never reclaims
//     them, degrading from ~363 create/close cycles and failing outright near
//     ~495 with 'Invalid pty handle'.
// So the pool spreads sessions across hosts and retires each one on a lifetime
// create counter -- before the degradation point, not at the failure point.
//
// A host that dies invalidates every sessionId on it at once. That is surfaced
// as 'host-lost' rather than retried: retrying a dead session id against a fresh
// host would silently attach the UI to a different process.
import { EventEmitter } from 'node:events';
import { SentioraError } from './errors.js';
import { SESSION_LIMIT, RECYCLE_AFTER_SESSIONS } from './protocol.js';

let nextHostId = 1;

class Host {
  constructor(client, id, sessionLimit) {
    this.id = id;
    this.client = client;
    this.sessionLimit = sessionLimit;
    this.active = 0;      // live sessions on this host
    this.draining = false; // retired: no new sessions, waiting for active to hit 0
    this.full = false;     // the runtime itself refused a create; re-checked on release
    this.dead = false;
  }

  get available() {
    return !this.draining && !this.full && !this.dead
      && this.client.alive && this.active < this.sessionLimit;
  }
}

export class RuntimeHostPool extends EventEmitter {
  #hosts = [];
  #closed = false;
  #factory;
  #recycleAfter;
  #maxHosts;
  #sessionLimit;

  constructor({
    factory,
    recycleAfter = RECYCLE_AFTER_SESSIONS,
    maxHosts = 4,
    sessionLimit = SESSION_LIMIT,
  } = {}) {
    super();
    if (typeof factory !== 'function') throw new Error('RuntimeHostPool needs a factory()');
    this.#factory = factory;
    this.#recycleAfter = recycleAfter;
    this.#maxHosts = maxHosts;
    this.#sessionLimit = sessionLimit;
  }

  get hosts() {
    return this.#hosts.map(h => ({
      id: h.id, active: h.active, draining: h.draining, full: h.full, dead: h.dead,
      lifetimeSessions: h.client.lifetimeSessions, alive: h.client.alive,
    }));
  }

  get liveSessionCount() {
    return this.#hosts.reduce((total, host) => total + host.active, 0);
  }

  // The handshake result of the first live host, so the UI can show which
  // platform/architecture/provider is actually serving sessions. Null until a
  // host has been started.
  get runtimeInfo() {
    return this.#hosts.find(host => host.client.info)?.client.info ?? null;
  }

  get limits() {
    return {
      sessionLimitPerHost: this.#sessionLimit,
      recycleAfterSessions: this.#recycleAfter,
      maxHosts: this.#maxHosts,
    };
  }

  // Live host clients, for diagnostics and tests. Exposed as the clients
  // themselves so a caller can read stderrTail when a host misbehaves; the UI
  // never sees this.
  get clients() {
    return this.#hosts.map(host => host.client);
  }

  async #spawnHost() {
    const client = await this.#factory();
    const host = new Host(client, `host-${nextHostId++}`, this.#sessionLimit);
    client.once('exit', () => this.#onHostLost(host, `runtime exited (${JSON.stringify(client.exitInfo)})`));
    client.once('transport-error', error => this.#onHostLost(host, error.message));
    this.#hosts.push(host);
    return host;
  }

  #onHostLost(host, reason) {
    if (host.dead) return;
    host.dead = true;
    host.draining = false;
    const lost = host.active;
    host.active = 0;
    this.#hosts = this.#hosts.filter(h => h !== host);
    // A host dropped for a transport error is still running: its stdout pipe would
    // keep this process's event loop alive forever, so it has to be killed. For a
    // host that already exited, shutdown() is a no-op.
    void host.client.shutdown({ graceMs: 1000 }).catch(() => {});
    // Consumers holding sessions on this host must mark them backend-lost; the
    // ids are meaningless now and must not be replayed against another host.
    this.emit('host-lost', { hostId: host.id, reason, lostSessions: lost });
  }

  // Reserves a slot on a usable host, starting a new host when every existing
  // one is full or retired. Throws 'session-limit' only when maxHosts is reached
  // and all of them are genuinely full.
  async acquire() {
    if (this.#closed) throw new SentioraError('pool-closed', 'the runtime host pool is closed');
    // Sweep before selecting: a host that has reached its lifetime budget must be
    // retired before the next session is placed on it, not after. Otherwise the
    // session that trips the counter lands on the worn-out host and fails.
    for (const host of this.#hosts) {
      if (!host.draining && !host.dead && host.client.lifetimeSessions >= this.#recycleAfter) host.draining = true;
    }
    let host = this.#hosts.find(h => h.available);
    if (!host) {
      if (this.#hosts.length >= this.#maxHosts) {
        const usable = this.#hosts.filter(h => !h.dead && h.client.alive);
        if (usable.length === 0) throw new SentioraError('backend-lost', 'every runtime host is dead');
        throw new SentioraError('session-limit', `all ${usable.length} runtime hosts are at the ${this.#sessionLimit}-session limit`);
      }
      host = await this.#spawnHost();
    }
    host.active += 1;
    return host;
  }

  // Creates a session on whichever host has room, moving to the next one when the
  // runtime itself reports 'Session limit'. That can happen even when the pool's
  // own count says there is room, so the refusal is treated as authoritative and
  // the host is marked full until a session closes on it.
  async runCreate(create) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.#maxHosts; attempt += 1) {
      const host = await this.acquire();
      try {
        return { host, result: await create(host.client) };
      } catch (error) {
        await this.release(host);
        if (error.kind !== 'session-limit') throw error;
        lastError = error;
        host.full = true;
      }
    }
    throw lastError ?? new SentioraError('session-limit', 'no runtime host could accept a session');
  }

  async release(host) {
    if (!host || host.dead) return;
    host.active = Math.max(0, host.active - 1);
    // Capacity came back, so a host the runtime had refused is usable again.
    if (host.full && host.active < host.sessionLimit) host.full = false;
    if (host.draining && host.active === 0) await this.#retire(host);
  }

  async #retire(host) {
    this.#hosts = this.#hosts.filter(h => h !== host);
    host.dead = true;
    const result = await host.client.shutdown();
    this.emit('host-recycled', { hostId: host.id, ...result });
  }

  async close() {
    this.#closed = true;
    const hosts = this.#hosts.splice(0);
    await Promise.all(hosts.map(async host => {
      host.dead = true;
      return host.client.shutdown();
    }));
  }
}
