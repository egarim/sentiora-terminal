// A bounded, replayable event log for one session (issue #27).
//
// Two consumers read it with different rights, and that difference is why it is one
// structure rather than two: a watcher polls it for output only, while the session's
// owner can retrieve the whole recording including keystrokes. One log means the two
// views cannot disagree about what happened or in what order, which separate buffers
// eventually do.
//
// Raw bytes, not screen text. A PTY emits arbitrary bytes -- WIN-15 deliberately
// feeds invalid UTF-8 -- and JSON cannot carry them, so output payloads are base64.
// That is also what preserves colour: observe().screen is produced by
// translateToString(), which drops every attribute and is pinned by an existing test
// as containing no escape bytes. The stream carries the original bytes instead, so
// ANSI colour survives without changing what observe() promises.
//
// Truncation replaces the whole retained prefix with one snapshot rather than
// dropping just the overflow, because a prefix whose beginning is gone cannot be
// replayed to a correct answer: replaying from the middle of a byte stream yields
// garbage, not a slightly older screen. Losing the prefix and reporting that it was
// lost is honest; quietly replaying a partial one is not.

// Retained payload per session. Bounded so a watcher that never polls cannot grow
// the host without limit, which is half of what issue #27's acceptance test asks.
export const BYTES_LIMIT = 1 << 20;
// Per-response payload cap, so one stream call cannot return the entire ring in a
// single line and stall the transport on a huge write.
export const RESPONSE_BYTES_LIMIT = 1 << 18;
// Charged against the limit for every event, so that the cap bounds event COUNT and
// not only payload bytes. See #cost.
export const RECORD_EVENT_OVERHEAD = 64;

// Monotonic clock for event timestamps. Injected in tests so ordering and elapsed
// times can be asserted exactly instead of slept through.
const defaultNow = () => Date.now();

export class Recording {
  // snapshotProvider is called only when truncation needs to replace the prefix, so
  // a session that never overflows never pays for a snapshot here.
  constructor({ limit = BYTES_LIMIT, inputRecorded = false, snapshotProvider = null, now = defaultNow, cols = null, rows = null } = {}) {
    // A limit that could not hold a single event is not a usable limit: #enforceLimit
    // would clear the ring, append a re-anchoring snapshot that is itself over the
    // limit, and truncate again forever. Rejecting it here turns that into a clear
    // error at construction instead of a stack overflow during a session.
    if (!Number.isFinite(limit) || limit <= RECORD_EVENT_OVERHEAD) throw Error('Invalid recording limit');
    this.limit = limit;
    this.inputRecorded = Boolean(inputRecorded);
    this.snapshotProvider = snapshotProvider;
    this.now = now;
    // The size the session started at, named for what it is: a resize event only
    // describes the change, so replay needs the starting size to build an emulator
    // that converges on the same screen. Deliberately not updated by recordResize,
    // which would make the name a lie and replay start from the wrong geometry.
    this.initialCols = cols;
    this.initialRows = rows;
    this.events = [];
    this.bytes = 0;
    this.sequence = 0;
    this.startedAt = this.now();
    this.truncated = false;
    this.droppedEvents = 0;
    this.droppedBytes = 0;
  }

  // Sequence 0 means "before anything was recorded", so a caller passing 0 receives
  // the whole log. That is what makes the first poll of a new watcher identical in
  // shape to every later one.
  get oldestSequence() { return this.events.length ? this.events[0].seq : this.sequence + 1; }
  get latestSequence() { return this.sequence; }

  #cost(event) {
    // Every event is charged at least its envelope, and payload-bearing events their
    // payload on top. Charging zero for the envelope -- the obvious simplification,
    // and what this did first -- makes the byte limit blind to event COUNT: an owner
    // calling terminal.resize in a loop records an event that costs nothing, so
    // #enforceLimit never fires and the ring grows without bound. That defeats the
    // one property issue #27 requires of a slow or absent watcher, and it is
    // reachable with an owner token, which is not a privileged position to trust.
    // 64 bytes is an estimate of the seq/at/kind envelope; it does not need to be
    // exact, only non-zero, so that the limit bounds events as well as bytes.
    const overhead = RECORD_EVENT_OVERHEAD;
    if (event.kind === 'output' || event.kind === 'input') return overhead + event.data.length;
    return overhead;
  }

  #append(event) {
    this.sequence += 1;
    const stored = { seq: this.sequence, at: this.now() - this.startedAt, ...event };
    this.bytes += this.#cost(stored);
    this.events.push(stored);
    this.#enforceLimit();
    return stored;
  }

  #enforceLimit() {
    if (this.bytes <= this.limit) return;
    // The screen is the only state a replay cannot reconstruct from a suffix, so it
    // is the one thing that has to survive truncation. Without a provider there is
    // nothing to snapshot and the log is dropped instead, reported as such.
    //
    // This re-enters #append for the snapshot, which re-enters here. It terminates
    // because the constructor rejects any limit that could not hold one event, so
    // the snapshot alone is always within bounds -- that check is the guard, and
    // removing it would turn this into infinite recursion rather than a slow path.
    //
    // A single event larger than the whole limit is therefore dropped with the rest.
    // That is not silent data loss in the way it looks: the snapshot is taken from
    // the live screen, which already reflects the dropped chunk, so replay still ends
    // on the right screen. What is lost is that chunk's raw bytes, and with them its
    // colour -- the same limitation as any other truncation, and reported by the same
    // truncated/droppedEvents counters.
    const snapshot = this.snapshotProvider ? this.snapshotProvider() : null;
    this.droppedEvents += this.events.length;
    this.droppedBytes += this.bytes;
    this.events = [];
    this.bytes = 0;
    this.truncated = true;
    if (snapshot) this.#append({ kind: 'snapshot', ...snapshot });
  }

  recordOutput(data) {
    const payload = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(String(data), 'utf8').toString('base64');
    return this.#append({ kind: 'output', data: payload });
  }

  // Keystrokes are only retained when the caller asked for them at create time. The
  // flag is part of the record either way, so a consumer can tell "nothing was
  // typed" from "typing was not recorded" -- the difference matters when the
  // recording is being kept as evidence.
  recordInput(text) {
    if (!this.inputRecorded) return null;
    return this.#append({ kind: 'input', data: Buffer.from(String(text), 'utf8').toString('base64') });
  }

  recordResize(cols, rows) { return this.#append({ kind: 'resize', cols, rows }); }
  recordExit(exit) { return this.#append({ kind: 'exit', exit: exit ?? null }); }

  // includeInput is false for watchers. Filtering here rather than in the caller
  // means there is no path by which a read-only stream can be handed keystrokes,
  // including ones recorded before the watcher attached.
  eventsAfter(afterSequence, { byteCap = RESPONSE_BYTES_LIMIT, includeInput = false } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw Error('Invalid sequence');
    const selected = [];
    let bytes = 0;
    for (const event of this.events) {
      if (event.seq <= afterSequence) continue;
      if (!includeInput && event.kind === 'input') continue;
      const cost = this.#cost(event);
      // Always return at least one event so a caller cannot spin on a payload larger
      // than the cap; after that, stop before exceeding it.
      if (selected.length && bytes + cost > byteCap) break;
      selected.push(event);
      bytes += cost;
    }
    return { events: selected, bytes };
  }

  // True when a cursor cannot be honoured from the retained log, meaning the caller
  // missed events and has to take a fresh snapshot rather than trust a gap-free
  // replay. `afterSequence` of 0 is never stale.
  missedEvents(afterSequence) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw Error('Invalid sequence');
    if (afterSequence === 0) return false;
    return afterSequence < this.oldestSequence - 1;
  }

  toJSON() {
    return {
      inputRecorded: this.inputRecorded,
      initialCols: this.initialCols,
      initialRows: this.initialRows,
      truncated: this.truncated,
      droppedEvents: this.droppedEvents,
      droppedBytes: this.droppedBytes,
      bytes: this.bytes,
      oldestSequence: this.oldestSequence,
      latestSequence: this.latestSequence,
      startedAt: this.startedAt,
    };
  }
}

// Replays a recording into a fresh emulator and returns the resulting screen, so
// "a recording played back ends in the same screen" is something a test can assert
// rather than something the implementation claims.
//
// The Terminal is injected: this module must not import @xterm/headless itself, or
// replaying a recording would depend on the runtime's emulator rather than on
// whatever the consumer uses to render it.
export async function replayRecording({ events, cols, rows, Terminal, snapshotToScreen }) {
  const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  try {
    for (const event of events) {
      switch (event.kind) {
        case 'snapshot': {
          // A snapshot is the truncation boundary: it replaces everything before it,
          // so replay starts from it rather than trying to merge it with prior output.
          const screen = snapshotToScreen ? snapshotToScreen(event) : event.screen;
          if (typeof screen === 'string') await write(screen.replace(/\n/g, '\r\n'));
          break;
        }
        case 'output':
          await write(Buffer.from(event.data, 'base64'));
          break;
        case 'resize':
          terminal.resize(event.cols, event.rows);
          break;
        case 'input':
        case 'exit':
          // Input already produced the output that follows it, and exit has no visual
          // effect, so neither changes the screen during replay.
          break;
        default:
          throw Error(`Unknown recording event kind: ${event.kind}`);
      }
    }
    const buffer = terminal.buffer.active;
    return {
      screen: Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '').join('\n'),
      cols: terminal.cols,
      rows: terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
    };
  } finally {
    terminal.dispose();
  }
}
