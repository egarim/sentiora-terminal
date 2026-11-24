// Protocol constants for the Sentiora JSON-RPC runtime.
//
// Every number here is a measured property of the runtime, not a guess. The
// sources are docs/validation/conpty-provider-comparison.md and
// docs/integrations/telekinesis.md section 7. If the runtime changes, change it
// here and nowhere else: the bridge clamps, retries and recycles against these.

export const PROTOCOL_VERSION = 1;

// terminal.resize / terminal.create reject cols outside 2-300 and rows outside
// 2-150 with 'Invalid dimensions'. A UI slider must never be able to produce
// that error, so the bridge clamps and reports what it actually applied.
export const COLS = Object.freeze({ min: 2, max: 300, default: 120 });
export const ROWS = Object.freeze({ min: 2, max: 150, default: 40 });

// terminal.type rejects a text longer than 65536 characters.
export const MAX_INPUT_CHARS = 65536;

// terminal.create throws 'Session limit' at 16 concurrent sessions per host.
export const SESSION_LIMIT = 16;

// The host process leaks ~1 fd and ~1.75 Win32 handles per session and is never
// able to reclaim them. Degradation was observed from ~363 create/close cycles
// and outright failure ('Invalid pty handle') near ~495. Recycle well before the
// degradation point rather than at the failure point.
export const RECYCLE_AFTER_SESSIONS = 350;

// Closing the runtime's stdin makes it reap every session and exit; measured at
// ~5.1s with 5 active sessions, exit code 0. Allow >=6s before force-killing.
export const SHUTDOWN_GRACE_MS = 6000;

// terminal.wait clamps timeoutMs to 30000 server-side. There is no request
// cancellation in the protocol, so an in-flight wait can only be outlasted:
// short timeouts are how the bridge keeps shutdown and resync responsive, and
// the cancellation granularity equals the timeout.
export const WAIT_POLL_MS = 250;
export const WAIT_MAX_MS = 30000;

// Exit detection lags the child's death by a median of ~1025ms (node-pty's 1s
// flush interval), and resize reaches the child ~170ms after terminal.resize
// returns. Neither is instantaneous; UI code must not assume otherwise.
export const EXIT_DETECT_LAG_MS = 1025;
export const RESIZE_CONVERGENCE_MS = 170;

// Stale-observation retries are normal, not exceptional: any output landing
// between the observe and the write invalidates it. Bounded so a session that
// is streaming continuously cannot spin forever.
export const STALE_RETRY_LIMIT = 12;

export const clamp = (value, { min, max }) => Math.min(max, Math.max(min, Math.trunc(value)));

export const clampDimensions = (cols, rows) => ({
  cols: clamp(Number.isFinite(cols) ? cols : COLS.default, COLS),
  rows: clamp(Number.isFinite(rows) ? rows : ROWS.default, ROWS),
});

// The runtime's fixed key map (src/server.js). Anything outside it has to be
// sent as raw control bytes through terminal.type instead.
export const RUNTIME_KEYS = Object.freeze([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Up', 'Down', 'Right', 'Left', 'CtrlC',
]);

// Lifecycle states, in order. There is deliberately no 'ready' state: 'spawned'
// means a process exists, not that the application can take input.
export const STATES = Object.freeze(['spawned', 'operational', 'exited', 'released']);
