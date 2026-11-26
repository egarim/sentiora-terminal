# Streaming and recording

Issue #27. A read-only live stream of a running session, and a record of it that can be played back.
The driver is Vivarium ([egarim/vivarium#215](https://github.com/egarim/vivarium/issues/215)): watching
an agent work, and keeping the screens as evidence afterwards.

## What `terminal.observe` cannot do, and why that forced new methods

`observe().screen` is built from `translateToString()`, which returns **text only** — every colour
and attribute is dropped. That is not an oversight to be fixed in place: `test/desktop-native.test.js`
pins that no escape byte may appear in `screen`, because a snapshot is a rendered result and raw
control bytes in it would be injected into whatever renders it.

So colour cannot be added to `observe()` without breaking a guarantee callers rely on. The stream
carries the child's **original bytes** instead, which is strictly more information and leaves
`observe()` exactly as it was.

## `terminal.stream` — read-only, sequence-numbered

```jsonc
// request
{"jsonrpc":"2.0","id":7,"method":"terminal.stream",
 "params":{"sessionId":"…","afterSequence":0,"timeoutMs":250}}

// first response: a snapshot, then everything retained
{"jsonrpc":"2.0","id":7,"result":{
  "sessionId":"…","state":"operational","revision":12,"running":true,"exit":null,
  "resync":false,
  "snapshot":{"screen":"…","cols":60,"rows":20,"cursor":{"x":0,"y":3},"revision":12, …},
  "events":[{"seq":1,"at":4,"kind":"output","data":"RklYNFVSRSBSRUFEWQ=="}],
  "nextSequence":1,"oldestSequence":1,"latestSequence":1,
  "truncated":false,"droppedEvents":0,"inputRecorded":false}}
```

- **`events`** are the child's raw output chunks, base64 (`data`), each with a monotonic `seq` and an
  `at` in milliseconds since the session started. Base64 because a PTY emits arbitrary bytes — WIN-15
  deliberately feeds invalid UTF-8 — and JSON cannot carry them. This is also what preserves colour.
- **`afterSequence`** is the cursor. Pass `0`, or omit it, to attach from the beginning of what is
  retained; pass the previous `nextSequence` to continue. Gaps are detectable because `seq` never
  repeats and never goes backwards.
- **`resync: true`** is the "you missed some" signal. It is set when the cursor is behind the retained
  window, and the response then carries a fresh `snapshot` and a `nextSequence` at the end of the
  ring. A consumer must treat a resync as a new attach, not as a continuation.
- **`snapshot`** is present on the first poll and on every resync, and is a full `observe()` result —
  so a watcher can always render a complete screen before applying any bytes.
- **Long poll.** With nothing new, the call waits up to `timeoutMs` (capped at 30000, the same bound
  as `terminal.wait`) and then returns an empty `events`. It returns immediately once the session has
  exited, so consumers do not pay the full interval on teardown.

### Why a poll and not a server-initiated notification

`docs/desktop/living-terminal.md` §9.1 proposes push notifications (`terminal.output` lines emitted
unsolicited on stdout), and it is the better design for latency. It is not what this implements, for a
reason that file also gives: **WIN-15 pins that the RPC channel stays perfectly framed** — a child
printing a byte-exact JSON-RPC response must never be able to put a line on stdout. Emitting
unsolicited lines means every client has to distinguish server pushes from child injection, and the
two existing clients (`bridge/runtime-client.js`, the Telekinesis adapter) both parse stdout as
responses to what they sent.

That is a deliberate framing decision affecting every consumer, so it stays a proposal. The poll
satisfies every acceptance criterion in #27 without touching the invariant, and it is additive: a
client that ignores `terminal.stream` is unaffected, and `initialize` now advertises `stream: 1` so
the push variant can be negotiated later rather than probed for.

**Cost of polling:** latency is bounded by `timeoutMs`, and an idle watcher costs one request per
interval. That is the same tradeoff `terminal.wait` already makes, and the bridge already runs it at
250 ms.

## `terminal.recording` — owner-gated, replayable

```jsonc
{"jsonrpc":"2.0","id":9,"method":"terminal.recording","params":{"sessionId":"…","owner":"…"}}

{"jsonrpc":"2.0","id":9,"result":{
  "sessionId":"…","revision":40,
  "inputRecorded":false,"initialCols":60,"initialRows":20,
  "truncated":false,"droppedEvents":0,"droppedBytes":0,"bytes":1834,
  "oldestSequence":1,"latestSequence":9,"startedAt":1764158400000,
  "events":[
    {"seq":1,"at":4,"kind":"output","data":"…"},
    {"seq":2,"at":900,"kind":"input","data":"…"},          // only when inputRecorded
    {"seq":3,"at":1200,"kind":"resize","cols":80,"rows":24},
    {"seq":9,"at":5400,"kind":"exit","exit":{"exitCode":3,"signal":null}}]}}
```

Event kinds are `output`, `input`, `resize`, `exit`, and `snapshot` (only after truncation, see
below). Replay feeds them to a fresh emulator in order: write `output` bytes, call `resize`, ignore
`input` (its effect is already in the output that follows) and `exit` (no visual effect).
`replayRecording()` in `src/recording.js` does exactly that and is what the tests use, so the
acceptance criterion "a recording played back ends in the same screen" is asserted rather than
claimed.

**Input is off by default.** Pass `recordInput: true` to `terminal.create` to capture keystrokes.
`inputRecorded` is in every response either way, so a consumer holding a record can distinguish
"nothing was typed" from "typing was not being recorded" — which matters when the record is evidence.

Keystrokes are filtered out of `terminal.stream` **at the source**, not by the caller: the filter is
inside `Recording.eventsAfter`, so there is no cursor and no argument a watcher can pass that reaches
them, including ones recorded before it attached. `terminal.recording` requires the `owner` token and
answers `Ownership required` without it, the same gate as `terminal.close`.

**Bounded.** The record is a ring capped by `recordBytes` at create (default 1 MiB, minimum 1024,
maximum 16 MiB — a caller cannot ask the host for unbounded memory). On overflow the whole retained
prefix is replaced by a single `snapshot` event of the screen at that instant, and `truncated`,
`droppedEvents` and `droppedBytes` report what was lost.

Replacing the prefix rather than dropping only the overflow is the part worth explaining: a prefix
whose beginning is gone **cannot** be replayed to a correct answer, because replaying from the middle
of a byte stream yields garbage rather than a slightly older screen. Losing the prefix and saying so
is honest; quietly replaying a partial one is not. The snapshot is taken synchronously from the
emulator, and output is recorded only *after* the emulator has accepted that chunk, so the snapshot
never lags the events that follow it — an ordering that REC-10 tests by replaying a truncated ring
against an intact one and requiring identical screens.

## Guarantees, and the test that holds each one

| #27 acceptance criterion | Test |
| --- | --- |
| Two watchers see the same final screen as `observe` | `STR-01` — two independent cursors, byte-identical payloads, replayed to `observe().screen` |
| A slow watcher does not slow the program | `STR-08` — 30 commands typed with no watcher polling at all; the session keeps up |
| A slow watcher does not grow memory without limit | `STR-07`, `STR-08` — retained `bytes` asserted against the configured cap |
| A recording played back ends in the same screen | `STR-06` end to end through the real runtime; `REC-09`/`REC-10`/`REC-11` at unit level |
| Colours included | `STR-02` — `\x1b[31m` present in the stream and absent from `observe().screen` |
| A watcher never gets the owner token and cannot type | `STR-03` — asserted on the serialised payload, not a field list, plus a refused `terminal.type` that must not reach the child |
| Input off unless asked, and the record says so | `STR-04`, `STR-05`, `REC-03` |
| Bounded, with a clear "you missed some" | `STR-07`, `REC-05`, `REC-07` |

`STR-05` and `REC-04` were verified non-vacuous by mutation: disabling the input filter in
`eventsAfter` fails both. Replay rejects an event kind it does not know (`REC-12`) rather than
skipping it, because silently ignoring an event would replay to a plausible but wrong screen.

## Limits, stated rather than discovered later

- **The runtime does not persist anything.** A recording lives in the host's memory and dies with it.
  Retaining evidence is the consumer's job: call `terminal.recording` and store the result. That is
  deliberate — the runtime has no filesystem side effects beyond what it is told to spawn.
- **A truncated recording loses colour that scrolled into the dropped prefix.** The boundary snapshot
  is screen *text*, so replay after a truncation reproduces the visible characters but not the
  attributes of the part that was dropped. An untruncated recording replays byte-exactly, colour
  included. If the whole session matters as evidence, size `recordBytes` for it.
- **A watcher must run its own emulator.** The stream delivers bytes, not pixels or cells; rendering
  is the consumer's problem. `replayRecording()` shows the shape of it and takes an injected
  `Terminal` so this module does not decide what a consumer renders with.
- **No cancellation.** An in-flight `terminal.stream` can only be outlasted, exactly like
  `terminal.wait` (§9.4 of the desktop design doc). Granularity equals `timeoutMs`.
- **The child's own echo of a secret still appears in output.** Input recording being off stops the
  runtime capturing keystrokes; it cannot stop a shell echoing a typed password back into the output
  stream, which is what `STR-04` documents rather than hides. Redaction is a separate concern and
  belongs to whatever keeps the record.
- **`snapshot` after truncation is not scrollback.** It is the visible viewport, matching
  `observe().screen`; lines that scrolled off are gone with the dropped prefix.

## Not delivered

- **Push notifications**, for the framing reason above. Still proposed in
  `docs/desktop/living-terminal.md` §9.1.
- **Migrating the desktop bridge** to the stream. It still long-polls `terminal.wait` and publishes
  rendered snapshots. The bridge already negotiates `outputModes`, so switching is a capability check
  rather than a rewrite, but it is a separate change with its own UI consequences and is not bundled
  here.
- **Disk persistence, redaction, and a playback tool.** Out of scope for the runtime.
