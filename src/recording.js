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
// Scrollback for a session's emulator, and the value replay must use to match it.
// One constant, imported by src/server.js, precisely because the two have to agree:
// scrollback changes what a resize puts in the viewport, since a live session with
// history can surface scrolled-off lines into newly added rows while a replay with
// none fills them with blanks. With the two disagreeing, "a recording played back
// ends in the same screen" holds only until the session scrolls and is then resized.
// A consumer rendering at a different scrollback should pass its own to
// replayRecording.
export const SESSION_SCROLLBACK = 2000;

// Monotonic clock for event timestamps. Injected in tests so ordering and elapsed
// times can be asserted exactly instead of slept through.
const defaultNow = () => Date.now();

export class Recording {
  // Re-entrancy guard for #enforceLimit; see the comment there for why it cannot be
  // replaced by a minimum-limit check.
  #truncating = false;

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
    // A snapshot carries up to a whole viewport of screen text (~45 KB at the
    // 300x150 ceiling dimensions() allows), so charging it the flat overhead alone
    // made `bytes` understate what was really retained. It is charged in full. Note
    // the consequence: truncation zeroes `bytes` and *then* appends the snapshot, and
    // a snapshot cannot be dropped without destroying replay fidelity, so the
    // reachable maximum is max(limit, one snapshot) -- not `limit`, and not
    // `limit + one viewport` as an earlier revision of this comment claimed.
    if (event.kind === 'snapshot') return overhead + (typeof event.screen === 'string' ? event.screen.length : 0);
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
    // The guard is load-bearing, not defensive. Truncation re-enters #append to store
    // the re-anchoring snapshot, and a snapshot is charged its screen text -- up to
    // ~45 KB at the 300x150 ceiling -- so with a small limit the snapshot alone can
    // exceed the cap. Without #truncating that would clear the ring, append another
    // snapshot, exceed the cap again, and recurse until the stack went.
    //
    // A sufficiently high minimum limit would also prevent this, since dimensions()
    // caps the viewport at 300x150 and therefore bounds any single snapshot; an
    // earlier comment here claimed otherwise, which was wrong. The guard is used
    // instead because it holds for *every* accepted limit and does not force a ~46 KB
    // floor on a caller that legitimately wants a small ring.
    if (this.bytes <= this.limit || this.#truncating) return;
    this.#truncating = true;
    try {
      // The screen is the only state a replay cannot reconstruct from a suffix, so it
      // is the one thing that has to survive truncation. Without a provider there is
      // nothing to snapshot and the log is dropped instead, reported as such.
      //
      // A single event larger than the whole limit is dropped with the rest. That is
      // not the silent loss it looks like: the snapshot is taken from the live screen,
      // which already reflects the dropped chunk, so replay still ends on the right
      // screen. What is lost is that chunk's raw bytes, and with them its colour --
      // the same limitation as any other truncation, reported by the same counters.
      const snapshot = this.snapshotProvider ? this.snapshotProvider() : null;
      this.droppedEvents += this.events.length;
      this.droppedBytes += this.bytes;
      this.events = [];
      this.bytes = 0;
      this.truncated = true;
      if (snapshot) this.recordSnapshot(snapshot);
    } finally {
      this.#truncating = false;
    }
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

  // Also the re-anchoring event used on truncation. Exposed because a session seeds
  // its ring with one at construction: an empty ring means an attach returns cursor
  // 0, and the consumer's next poll would attach again immediately, spinning without
  // ever reaching the long-poll.
  recordSnapshot(snapshot) { return this.#append({ kind: 'snapshot', ...snapshot }); }

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
export async function replayRecording({ events, cols, rows, Terminal, scrollback = SESSION_SCROLLBACK }) {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  try {
    for (const event of events) {
      switch (event.kind) {
        case 'snapshot': {
          // A snapshot states what the WHOLE screen was at that instant, so replay
          // has to replace the screen rather than overprint it. Normally a snapshot
          // is the first event and there is nothing to replace, but the stream can
          // also deliver one mid-list at a truncation boundary: a cursor of exactly
          // oldestSequence - 1 is not "stale", so it is served as ordinary events
          // rather than as a resync.
          if (typeof event.screen !== 'string') {
            // Throwing rather than skipping, for the same reason an unknown kind
            // throws: replay cannot proceed without the screen, and continuing would
            // produce a plausible but wrong result.
            throw Error(`snapshot event ${event.seq ?? '?'} carries no screen text`);
          }
          // Geometry first. A resize from before the truncation was dropped with the
          // prefix, so the snapshot's own cols/rows are the only surviving record of
          // the shape this screen was rendered in; writing it into the session's
          // initial geometry would wrap and scroll it into something else. Bounded by
          // the same ceiling dimensions() enforces, because a recording is data a
          // consumer may have read back off disk and terminal.resize would otherwise
          // allocate whatever it claims.
          if (Number.isInteger(event.cols) && Number.isInteger(event.rows)
            && event.cols >= 2 && event.rows >= 2
            && event.cols <= 300 && event.rows <= 150
            && (event.cols !== terminal.cols || event.rows !== terminal.rows)) {
            terminal.resize(event.cols, event.rows);
          }
          // Erase the viewport and the scrollback, then home, before writing the text.
          await write('\x1b[2J\x1b[3J\x1b[H');
          await write(event.screen.replace(/\n/g, '\r\n'));
          // Then the cursor, and this is not cosmetic. Writing the viewport text
          // leaves the cursor on the last row, but the live cursor was wherever the
          // child had left it -- typically mid-screen, at a prompt. Every output
          // event after the boundary is written relative to the cursor, so skipping
          // this replays the rest of the session in the wrong place and lands on a
          // different screen, which is the one thing a recording must not do.
          const cursor = event.cursor;
          if (cursor && Number.isInteger(cursor.x) && Number.isInteger(cursor.y)) {
            await write(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
          }
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
