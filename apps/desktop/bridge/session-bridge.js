// The session service: owns every Sentiora session on behalf of the UI.
//
// What it is responsible for, and why each part is not obvious:
//
//   * Owner tokens. terminal.create returns an `owner` bearer credential that is
//     the only thing preventing input injection into a session. It never leaves
//     this object: every value handed to a caller or emitted to a subscriber is
//     built by #publicView(), which picks fields explicitly rather than
//     deleting one. Issue #7's "least privilege, no arbitrary frontend shell
//     bridge" depends on that.
//
//   * Revisions. Every write needs a revision from a fresh observation or it is
//     rejected with 'Stale observation'. The pump keeps a current revision so
//     the common keystroke costs one round trip; a stale rejection re-observes
//     and retries, bounded. Writes themselves bump the revision, so anything
//     waiting after a write must be armed with the revision the *write*
//     returned, not the one read before it.
//
//   * Ordered output with backpressure. One pump per session long-polls
//     terminal.wait and publishes monotonic snapshots. A slow consumer gets
//     intermediates coalesced into the newest snapshot plus resync:true, so it
//     repaints completely instead of drifting.
//
//   * Bounded scrollback. The runtime exposes only the rendered viewport, so
//     lines that scroll off the top are gone from the protocol. The pump recovers
//     them by exact pure-shift matching against the previous screen. That is
//     best-effort by construction: it cannot recover a line the child overwrote
//     in place, and it deliberately refuses to guess.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SentioraError } from './errors.js';
import {
  WAIT_POLL_MS, STALE_RETRY_LIMIT, MAX_INPUT_CHARS, clampDimensions, RUNTIME_KEYS,
} from './protocol.js';

const PUBLIC_OBSERVATION_FIELDS = [
  'sessionId', 'pid', 'state', 'revision', 'running', 'exit', 'cols', 'rows',
  'writeErrors', 'cursor', 'screen', 'idleMilliseconds',
];

// Explicit pick, never a spread-and-delete: a new field added to terminal.observe
// must not reach the UI just because nobody remembered to filter it. The runtime's
// own sessionId is replaced with the bridge's pooled id on the way out.
function publicView(record, observation) {
  const view = {};
  for (const field of PUBLIC_OBSERVATION_FIELDS) view[field] = observation[field];
  view.sessionId = record.sessionId;
  return view;
}

class Record {
  constructor({ sessionId, runtimeSessionId, hostId, owner, host, label, command, shell }) {
    // The id the UI uses. The runtime's own id is only unique within one host
    // process, and the bridge pools several hosts, so it cannot be handed out
    // directly: two hosts would collide. The runtime id stays internal and is used
    // only for RPC calls against the owning host.
    this.sessionId = sessionId;
    this.runtimeSessionId = runtimeSessionId;
    this.hostId = hostId;
    this.owner = owner;         // bearer credential; never leaves SessionBridge
    this.host = host;           // {id, client} from the pool
    this.label = label;
    this.command = command;     // remembered locally; the runtime does not echo it
    this.shell = shell ?? null; // catalog entry, so the UI can gate Ctrl+C on its prompt
    this.lastRevision = 0;
    this.state = 'spawned';
    this.writeErrors = 0;
    this.exit = null;
    this.cols = 0;
    this.rows = 0;
    this.cursor = { x: 0, y: 0 };
    this.lines = [];
    this.scrollback = [];
    this.subscribers = new Set();
    this.seq = 0;
    this.stopped = false;
    this.backendLost = null;
    this.pump = null;
    // Serialises writes: the bridge is the single owner, so the runtime will not
    // arbitrate between two concurrent callers (telekinesis.md section 5).
    this.writeChain = Promise.resolve();
  }
}

export class SessionBridge extends EventEmitter {
  #pool;
  #records = new Map();
  #scrollbackLimit;
  #maxQueuedFrames;

  constructor({ pool, scrollbackLimit = 2000, maxQueuedFrames = 4 } = {}) {
    super();
    if (!pool) throw new Error('SessionBridge needs a RuntimeHostPool');
    this.#pool = pool;
    this.#scrollbackLimit = scrollbackLimit;
    this.#maxQueuedFrames = maxQueuedFrames;
    pool.on('host-lost', ({ hostId, reason, lostSessions }) => this.#onHostLost(hostId, reason, lostSessions));
  }

  get sessions() {
    return [...this.#records.values()].map(record => this.describe(record));
  }

  describe(record) {
    return {
      sessionId: record.sessionId,
      hostId: record.hostId,
      label: record.label,
      command: record.command,
      shellId: record.shell?.id ?? null,
      // A heuristic prompt regex, exposed so the UI can gate Ctrl+C on an
      // observed readiness condition. Never a guarantee: see shell-catalog.js.
      promptPattern: record.shell?.promptPattern ?? null,
      state: record.state,
      revision: record.lastRevision,
      cols: record.cols,
      rows: record.rows,
      writeErrors: record.writeErrors,
      exit: record.exit,
      backendLost: record.backendLost,
      scrollbackLines: record.scrollback.length,
      subscribers: record.subscribers.size,
    };
  }

  // Pool visibility for the status bar and for /api/info. Host-level counters are
  // what make the ~495-session ceiling observable before it is hit.
  get hosts() {
    return this.#pool.hosts;
  }

  get runtimeInfo() {
    return this.#pool.runtimeInfo;
  }

  get limits() {
    return this.#pool.limits;
  }

  #get(sessionId) {
    const record = this.#records.get(sessionId);
    if (!record) throw new SentioraError('unknown-session', `no such session: ${sessionId}`);
    // A lost host invalidates every id on it. Refusing here is what stops a
    // caller from silently retrying into a different process.
    if (record.backendLost) {
      throw new SentioraError('backend-lost', `session ${sessionId} was lost with its runtime host: ${record.backendLost}`);
    }
    return record;
  }

  async create({ command, args = [], cwd, cols, rows, label, conptyDll, shell = null } = {}) {
    if (typeof command !== 'string' || command === '') throw new SentioraError('invalid-command', 'command must be a non-empty string');
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new SentioraError('invalid-command', 'args must be an array of strings');
    const size = clampDimensions(cols, rows);
    const params = { command, args, cwd, cols: size.cols, rows: size.rows, conptyDll };
    // The pool picks the host and moves on if the runtime reports 'Session limit',
    // so this never has to reason about capacity itself.
    const { host, result: created } = await this.#pool.runCreate(client => client.createSession(params));

    const record = new Record({
      sessionId: randomUUID(),
      runtimeSessionId: created.sessionId,
      hostId: host.id,
      owner: created.owner, host,
      label: label ?? command, command: { command, args }, shell,
    });
    this.#records.set(record.sessionId, record);
    this.#absorb(record, created);
    // Taken from the create observation rather than left at the Record default, so
    // a caller sees the real state before the pump's first frame lands.
    record.state = created.state;
    record.writeErrors = created.writeErrors;
    this.#startPump(record);
    this.emit('session-created', this.describe(record));
    return this.describe(record);
  }

  // ---------------------------------------------------------------- output pump

  #startPump(record) {
    record.pump = this.#pumpLoop(record).catch(error => {
      // A pump must never take the bridge down with it; the session is marked
      // lost so the UI can say so instead of silently freezing.
      record.backendLost ??= error.message;
      this.emit('session-lost', { sessionId: record.sessionId, reason: error.message });
    });
  }

  async #pumpLoop(record) {
    const client = record.host.client;
    let after = record.lastRevision;
    while (!record.stopped) {
      let observation;
      try {
        observation = await client.call('terminal.wait', {
          sessionId: record.runtimeSessionId, afterRevision: after, timeoutMs: WAIT_POLL_MS,
        }, { timeoutMs: WAIT_POLL_MS + 5000 });
      } catch (error) {
        if (record.stopped) return;
        // 'Unknown session' after a host death means backend lost, not a bad id.
        record.backendLost = error.message;
        record.state = error.kind === 'session-not-running' || error.kind === 'unknown-session' ? 'exited' : record.state;
        this.#emitFrame(record, { resync: true, lost: true });
        this.emit('session-lost', { sessionId: record.sessionId, reason: error.message });
        return;
      }
      // terminal.wait resolves on timeout with an unmoved revision, and explicit
      // observe()/waitUntil() polls re-read state that has not changed either.
      // #ingest drops both, so the pump can stay this simple.
      after = observation.revision;
      this.#ingest(record, observation);
      // terminal.wait returns immediately once the child is gone, so without
      // this the loop would spin at full speed on an exited session.
      if (observation.state === 'exited' || observation.state === 'released' || !observation.running) return;
    }
  }

  #ingest(record, observation) {
    // Observations can arrive out of order. The pump's terminal.wait and an
    // explicit observe() from waitUntil()/resize() are separate RPCs, and the
    // transport correlates them by id, not by send order -- so a response issued
    // first can land second. Applying an older screen over a newer one would move
    // the revision backwards and, worse, replay the pure-shift match and recover
    // the same scrollback lines twice.
    if (observation.revision < record.lastRevision) return;
    const previousRevision = record.lastRevision;
    const previousState = record.state;
    const previousWriteErrors = record.writeErrors;
    const scrolledOff = this.#absorb(record, observation);
    if (observation.writeErrors > previousWriteErrors) {
      // Non-zero writeErrors means input was silently dropped by the pty write
      // path. Surfacing it is the only way the user learns a keystroke was lost.
      this.emit('write-error', {
        sessionId: record.sessionId,
        writeErrors: observation.writeErrors,
        previous: previousWriteErrors,
      });
    }
    record.writeErrors = observation.writeErrors;
    const stateChanged = observation.state !== previousState;
    record.state = observation.state;
    record.exit = observation.exit ?? record.exit;
    // Nothing moved, so nothing is published. Without this guard an idle session
    // would emit a duplicate frame on every wait timeout -- four per second, per
    // session, forever -- and would break the strictly-increasing-revision
    // guarantee subscribers rely on to order and de-duplicate repaints.
    if (observation.revision === previousRevision && !stateChanged && scrolledOff.length === 0
      && observation.writeErrors === previousWriteErrors) return;
    this.#emitFrame(record, { resync: false, scrolledOff });
    if (stateChanged) this.emit('session-state', { sessionId: record.sessionId, state: record.state, exit: record.exit });
  }

  // Returns the lines recovered into scrollback by this observation, so the frame
  // can carry them to the UI instead of making it re-fetch the whole ring.
  //
  // This is a heuristic over a lossy channel, and its limits are measured rather
  // than hand-waved. Against a runtime that moves the screen one line at a time it
  // is exact: 400 lines emitted, 380 recovered, zero duplicates, in emission
  // order. Against a real console it recovers very little -- 7 distinct lines from
  // the same 400-line flood -- because ConPTY delivers output in batches roughly a
  // second apart, so the screen jumps by more rows than there is overlap left to
  // verify. Declining is the correct behaviour there: a fabricated or duplicated
  // history line would be a defect, an incomplete one is the documented cost of a
  // protocol that exposes a rendered screen instead of a byte stream. Hence the
  // rule "no confident match, no guess".
  #absorb(record, observation) {
    const next = observation.screen.split('\n');
    const previous = record.lines;
    const scrolledOff = [];
    // Pure-shift match: if the whole previous screen moved up by exactly k lines
    // and the rest is identical, those k top lines left the viewport and are the
    // only recoverable scrollback. No match means no guess -- the runtime exposes
    // the rendered viewport, not the bytes that produced it.
    //
    // The overlap has to be large enough to be evidence. shift === rows matches
    // vacuously -- nothing is left to compare, so it succeeds for ANY pair of
    // screens -- and would append the whole viewport to history on every frame.
    // Against a mock that moves one line at a time a small shift always matches
    // first and the defect stays hidden. Against a real console it fires on every
    // frame, because output arrives in batches roughly a second apart and the
    // screen often advances by more than a full viewport between observations, so
    // no genuine shift relationship exists and the loop falls through to the
    // vacuous case. Requiring at least two overlapping rows (one below a four-row
    // viewport), with at least one of them non-blank, makes a match mean something.
    const minOverlap = previous.length >= 4 ? 2 : 1;
    if (previous.length === next.length && previous.length > minOverlap && previous.join('\n') !== next.join('\n')) {
      for (let shift = 1; shift + minOverlap <= previous.length; shift += 1) {
        let matched = true;
        let sawContent = false;
        for (let i = 0; i < previous.length - shift; i += 1) {
          if (previous[i + shift] !== next[i]) { matched = false; break; }
          if (previous[i + shift].trim() !== '') sawContent = true;
        }
        if (!matched || !sawContent) continue;
        for (let i = 0; i < shift; i += 1) scrolledOff.push(previous[i]);
        break;
      }
    }
    if (scrolledOff.length > 0) record.scrollback.push(...scrolledOff);
    // Trimmed outside the match loop so the ring stays bounded even when a single
    // frame pushed it over.
    if (record.scrollback.length > this.#scrollbackLimit) {
      record.scrollback.splice(0, record.scrollback.length - this.#scrollbackLimit);
    }
    record.lines = next;
    record.cols = observation.cols;
    record.rows = observation.rows;
    // Carried in every frame: without it the UI cannot show where the child's
    // cursor is, and a terminal that hides the caret is unusable for typing.
    record.cursor = observation.cursor ?? record.cursor;
    record.lastRevision = observation.revision;
    return scrolledOff;
  }

  #emitFrame(record, { resync, lost = false, scrolledOff = [] } = {}) {
    const frame = {
      kind: lost ? 'lost' : 'frame',
      sessionId: record.sessionId,
      revision: record.lastRevision,
      state: record.state,
      exit: record.exit,
      cols: record.cols,
      rows: record.rows,
      writeErrors: record.writeErrors,
      backendLost: record.backendLost,
      cursor: { ...record.cursor },
      resync,
      // How many intermediate frames were folded into this one for this
      // subscriber. Zero except after backpressure; the UI shows it so a lagging
      // pane is visible rather than silently dropping output.
      coalesced: 0,
      // The lines that left the top of the viewport in this observation. Carried
      // in the frame so a consumer never has to re-fetch the ring to stay whole.
      scrolledOff,
      lines: record.lines,
      scrollbackLength: record.scrollback.length,
    };
    for (const subscriber of record.subscribers) this.#deliver(subscriber, frame);
  }

  // Backpressure: a subscriber that has not drained gets its queued intermediates
  // replaced by the newest snapshot. Frames are whole screens, so coalescing is
  // lossless for the viewport; the scrolled-off lines of the dropped frames are
  // folded into the surviving one so history stays lossless too, and resync tells
  // the consumer to repaint fully rather than apply a diff it lost the base for.
  #deliver(subscriber, frame) {
    if (subscriber.queue.length >= this.#maxQueuedFrames) {
      const dropped = subscriber.queue.splice(0);
      subscriber.coalesced += dropped.length;
      const recovered = dropped.flatMap(droppedFrame => droppedFrame.scrolledOff ?? []);
      frame = {
        ...frame,
        resync: true,
        coalesced: dropped.length,
        scrolledOff: recovered.length > 0 ? [...recovered, ...(frame.scrolledOff ?? [])] : frame.scrolledOff,
      };
    }
    subscriber.queue.push(frame);
    // Cleared *before* it runs. A drain callback left in place would be invoked
    // again by the next frame, shifting a frame off the queue into an
    // already-settled promise and silently dropping it.
    const drain = subscriber.drain;
    subscriber.drain = null;
    drain?.();
  }

  // --------------------------------------------------------------- subscriptions

  // Attaching always yields a complete snapshot first, so a UI that reconnects to
  // a live session (test U04) cannot start from a partial screen.
  attach(sessionId) {
    const record = this.#get(sessionId);
    const subscriber = {
      sessionId,
      queue: [],
      coalesced: 0,
      drain: null,
      pending: null,
      closed: false,
    };
    record.subscribers.add(subscriber);

    const snapshot = {
      kind: 'snapshot',
      sessionId,
      revision: record.lastRevision,
      state: record.state,
      exit: record.exit,
      cols: record.cols,
      rows: record.rows,
      writeErrors: record.writeErrors,
      backendLost: record.backendLost,
      cursor: { ...record.cursor },
      resync: true,
      scrolledOff: [],
      coalesced: 0,
      lines: record.lines,
      // Bounded: handed over as a copy so the consumer cannot mutate the ring.
      scrollback: record.scrollback.slice(-this.#scrollbackLimit),
      scrollbackLength: record.scrollback.length,
      describe: this.describe(record),
    };

    return {
      snapshot,
      get coalesced() { return subscriber.coalesced; },
      // Resolves the next frame, or null once detached. Async pull keeps the
      // consumer in control of its own rate instead of being pushed at.
      //
      // There is at most ONE parked waiter per subscriber, and a repeat call
      // returns the same promise. That is what makes next() safe to race against
      // a timeout: if every call minted a new promise and overwrote the wake
      // callback, an abandoned waiter would keep ownership of it, the next
      // delivery would shift a frame into an already-abandoned promise, and that
      // frame would vanish without ever reaching a consumer. Callers must be able
      // to time out and re-await without losing output.
      next() {
        if (subscriber.queue.length) return Promise.resolve(subscriber.queue.shift());
        if (subscriber.closed) return Promise.resolve(null);
        subscriber.pending ??= new Promise(resolve => {
          subscriber.drain = () => {
            subscriber.pending = null;
            subscriber.drain = null;
            resolve(subscriber.queue.shift() ?? null);
          };
        });
        return subscriber.pending;
      },
      detach() {
        subscriber.closed = true;
        record.subscribers.delete(subscriber);
        const drain = subscriber.drain;
        subscriber.drain = null;
        drain?.();
      },
    };
  }

  // ---------------------------------------------------------------------- input

  #send(record, method, params) {
    // Serialised per session; the runtime will not arbitrate concurrent writers.
    const run = record.writeChain.then(() => this.#sendNow(record, method, params));
    record.writeChain = run.catch(() => {});
    return run;
  }

  async #sendNow(record, method, params) {
    if (record.state === 'exited' || record.state === 'released') {
      throw new SentioraError('session-not-running', `session ${record.sessionId} is ${record.state}`);
    }
    let revision = record.lastRevision;
    for (let attempt = 0; attempt < STALE_RETRY_LIMIT; attempt += 1) {
      let response;
      try {
        response = await record.host.client.call(method, {
          sessionId: record.runtimeSessionId, owner: record.owner, revision, ...params,
        });
      } catch (error) {
        if (error.kind === 'stale-observation') {
          // Any output landing between the observe and the write invalidates it.
          // This is normal under load, not a fault.
          const fresh = await record.host.client.call('terminal.observe', { sessionId: record.runtimeSessionId });
          this.#ingest(record, fresh);
          revision = fresh.revision;
          continue;
        }
        throw error;
      }
      // The write bumped the revision itself. Publish it, because anything that
      // waits next must be armed with this value, not the pre-write one.
      record.lastRevision = response.revision;
      return { revision: response.revision, writeErrors: record.writeErrors };
    }
    throw new SentioraError('stale-observation', `gave up after ${STALE_RETRY_LIMIT} stale observations on ${record.sessionId}`);
  }

  async type(sessionId, text) {
    const record = this.#get(sessionId);
    if (typeof text !== 'string' || text.length === 0) throw new SentioraError('invalid-input', 'text must be a non-empty string');
    // Chunked because terminal.type rejects more than 65536 characters. Note the
    // runtime's own caveat: ConPTY may coalesce consecutive writes or split large
    // ones, so chunks are not observable as discrete child input events.
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += MAX_INPUT_CHARS) chunks.push(text.slice(offset, offset + MAX_INPUT_CHARS));
    let last = null;
    for (const chunk of chunks) last = await this.#send(record, 'terminal.type', { text: chunk });
    return last;
  }

  async key(sessionId, key) {
    const record = this.#get(sessionId);
    if (!RUNTIME_KEYS.includes(key)) throw new SentioraError('unknown-key', `runtime key map has no '${key}'; expected one of ${RUNTIME_KEYS.join(', ')}`);
    return this.#send(record, 'terminal.key', { key });
  }

  // Ctrl+C is three different things depending on the child's console mode when
  // byte 0x03 arrives: data in raw mode, SIGINT in cooked mode with a handler,
  // and an outright kill (0xC000013A) in cooked mode without one. create()
  // returns before the child has configured its console, so an early Ctrl+C is
  // fatal. It is therefore gated on an observed readiness condition, never on a
  // sleep and never on the 'spawned' state.
  async interrupt(sessionId, { readyPattern = null, timeoutMs = 0 } = {}) {
    const record = this.#get(sessionId);
    if (timeoutMs > 0) {
      await this.waitUntil(sessionId, obs => obs.state === 'operational' && (!readyPattern || readyPattern.test(obs.screen)), { timeoutMs });
    }
    // Gated on a *fresh* observation, not the cached pump state: the whole point
    // is that readiness must be observed rather than assumed, and a stale cache is
    // exactly how an early Ctrl+C would slip through and kill the child.
    const observation = await this.observe(sessionId);
    if (observation.state !== 'operational') {
      return {
        delivered: false,
        reason: `session is '${observation.state}', not 'operational': Ctrl+C would kill a child that has not rendered output yet`,
      };
    }
    if (readyPattern && !readyPattern.test(observation.screen)) {
      return {
        delivered: false,
        reason: `readiness condition ${readyPattern} is not present on screen; Ctrl+C could terminate the child instead of interrupting it`,
      };
    }
    await this.#send(record, 'terminal.key', { key: 'CtrlC' });
    return { delivered: true, reason: null };
  }

  async resize(sessionId, cols, rows) {
    const record = this.#get(sessionId);
    const requested = { cols: Math.trunc(cols), rows: Math.trunc(rows) };
    const applied = clampDimensions(requested.cols, requested.rows);
    // Clamping here is what keeps a UI resize handle from producing
    // 'Invalid dimensions'; the caller is told what actually got applied.
    const clamped = applied.cols !== requested.cols || applied.rows !== requested.rows;
    const observation = await record.host.client.call('terminal.resize', {
      sessionId: record.runtimeSessionId, owner: record.owner, cols: applied.cols, rows: applied.rows,
    });
    this.#ingest(record, observation);
    // terminal.resize returns before the child knows: convergence measured at
    // ~170ms. The returned size is the emulator's, not the child's confirmation.
    return { ...publicView(record, observation), requested, applied, clamped };
  }

  async observe(sessionId) {
    const record = this.#get(sessionId);
    const observation = await record.host.client.call('terminal.observe', { sessionId: record.runtimeSessionId });
    this.#ingest(record, observation);
    return publicView(record, observation);
  }

  // Readiness is always an observable condition reached by observe+wait polling.
  // A sleep would be a guess about a process we cannot see into.
  async waitUntil(sessionId, predicate, { timeoutMs = 15000, label = 'condition' } = {}) {
    const record = this.#get(sessionId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const observation = await record.host.client.call('terminal.observe', { sessionId: record.runtimeSessionId });
      this.#ingest(record, observation);
      const view = publicView(record, observation);
      if (predicate(view)) return view;
      if (Date.now() > deadline) {
        throw new SentioraError('readiness-timeout', `session ${sessionId} never satisfied ${label} within ${timeoutMs}ms; last screen:\n${observation.screen}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await record.host.client.call('terminal.wait', {
          sessionId: record.runtimeSessionId, afterRevision: observation.revision, timeoutMs: Math.min(WAIT_POLL_MS, remaining),
        }, { timeoutMs: Math.min(WAIT_POLL_MS, remaining) + 5000 });
      } catch {
        break; // exited or lost; the next observe will say which
      }
    }
    throw new SentioraError('readiness-timeout', `session ${sessionId} never satisfied ${label} within ${timeoutMs}ms`);
  }

  async close(sessionId) {
    const record = this.#records.get(sessionId);
    if (!record) return false;
    record.stopped = true;
    for (const subscriber of record.subscribers) {
      subscriber.closed = true;
      const drain = subscriber.drain;
      subscriber.drain = null;
      drain?.();
    }
    record.subscribers.clear();
    let closed = true;
    if (!record.backendLost) {
      try {
        await record.host.client.call('terminal.close', { sessionId: record.runtimeSessionId, owner: record.owner });
      } catch (error) {
        // An already-exited session can refuse to close; that is not a failure of
        // the bridge, but it is reported rather than swallowed.
        closed = false;
        this.emit('session-close-error', { sessionId, reason: error.message });
      }
    }
    this.#records.delete(sessionId);
    record.state = 'released';
    await this.#pool.release(record.host);
    this.emit('session-closed', { sessionId });
    return closed;
  }

  async closeAll() {
    const ids = [...this.#records.keys()];
    for (const id of ids) await this.close(id);
  }

  #onHostLost(hostId, reason) {
    for (const record of this.#records.values()) {
      if (record.host.id !== hostId) continue;
      record.stopped = true;
      record.backendLost = reason;
      // Tell every attached UI before detaching it, so the pane says "backend
      // lost" instead of silently freezing on its last frame. The record stays in
      // the map: #get() now throws backend-lost, which is what stops a caller
      // from blindly retrying an id that no longer refers to any process.
      this.#emitFrame(record, { resync: true, lost: true });
      for (const subscriber of record.subscribers) {
        subscriber.closed = true;
        subscriber.drain?.();
        subscriber.drain = null;
      }
      record.subscribers.clear();
      this.emit('session-lost', { sessionId: record.sessionId, reason });
    }
  }

  async shutdown() {
    await this.closeAll();
    await this.#pool.close();
  }
}

export { publicView, PUBLIC_OBSERVATION_FIELDS };
