// Centralized mapping of runtime errors to typed bridge errors.
//
// Every runtime failure arrives as JSON-RPC error code -32000; only the message
// string distinguishes them (see docs/integrations/telekinesis.md section 10).
// That is brittle, so this file is the single place the strings live. If the
// runtime ever grows distinct error codes, only `classify` has to change and
// every caller keeps working against `error.kind`.

// kind -> {match, retryable, terminal}. `retryable` means the bridge itself
// should retry transparently; `terminal` means the session can never recover.
const KINDS = {
  'stale-observation': { match: /^Stale observation$/, retryable: true },
  'ownership-required': { match: /^Input ownership required$/, terminal: true },
  'close-ownership-required': { match: /^Ownership required$/, terminal: true },
  'session-not-running': { match: /^Session not running$/, terminal: true },
  'unknown-session': { match: /^Unknown session$/, terminal: true },
  'unknown-key': { match: /^Unknown key$/ },
  'invalid-dimensions': { match: /^Invalid dimensions$/ },
  'invalid-command': { match: /^Invalid command$/ },
  'invalid-conpty-dll': { match: /^Invalid conptyDll$/ },
  'resize-denied': { match: /^Resize denied$/, terminal: true },
  'session-limit': { match: /^Session limit$/, retryable: true },
  'invalid-wait': { match: /^Invalid wait$/ },
  'invalid-input': { match: /^Invalid input$/ },
  'invalid-request': { match: /^Invalid request$/ },
  'unknown-method': { match: /^Unknown method$/, terminal: true },
  // The runtime's node-pty handle table runs dry near ~495 create/close cycles.
  // It is not in the documented table because it only appears at the ceiling,
  // but the bridge must recognise it: the whole host is unusable afterwards.
  'invalid-pty-handle': { match: /Invalid pty handle/, terminal: true },
};

export class SentioraError extends Error {
  constructor(kind, message, { cause, code = -32000 } = {}) {
    super(message, { cause });
    this.name = 'SentioraError';
    this.kind = kind;
    this.code = code;
    this.retryable = KINDS[kind]?.retryable === true;
    // A terminal error means retrying cannot help: the session is gone or the
    // credential is wrong. Callers must surface it, not loop on it.
    this.terminal = KINDS[kind]?.terminal === true;
  }
}

export function classify(message, cause) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  for (const [kind, spec] of Object.entries(KINDS)) {
    if (spec.match.test(text)) return new SentioraError(kind, text, { cause });
  }
  return new SentioraError('unknown', text || 'runtime error with no message', { cause });
}

// 'Unknown session' is ambiguous: it means either a bad id or a runtime that
// died and restarted, in which case every id the bridge holds is invalid. The
// host pool resolves the ambiguity by checking whether the host is still alive;
// this is the kind it substitutes when it is not.
export const BACKEND_LOST = 'backend-lost';

export function backendLost(detail) {
  return new SentioraError(BACKEND_LOST, `Sentiora runtime host was lost: ${detail}`);
}

// Thrown by the transport when the runtime's stdout stops being parseable
// newline-delimited JSON-RPC. Treated as fatal rather than skipped: a silent
// skip would hide framing corruption (telekinesis.md section 9.3).
export class TransportError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'TransportError';
  }
}
