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
// request: attach
{"jsonrpc":"2.0","id":7,"method":"terminal.stream",
 "params":{"sessionId":"…","afterSequence":0,"timeoutMs":250}}

// response: a snapshot and NO events -- the snapshot already accounts for everything
// recorded so far, and nextSequence is the position it was taken at.
{"jsonrpc":"2.0","id":7,"result":{
  "sessionId":"…","state":"operational","revision":12,"running":true,"exit":null,
  "resync":false,
  "snapshot":{"screen":"…","cols":60,"rows":20,"cursor":{"x":0,"y":3},"revision":12, …},
  "events":[],
  "nextSequence":9,"oldestSequence":1,"latestSequence":9,
  "truncated":false,"droppedEvents":0,"inputRecorded":false}}

// request: continue from the cursor handed back
{"jsonrpc":"2.0","id":8,"method":"terminal.stream",
 "params":{"sessionId":"…","afterSequence":9,"timeoutMs":250}}

// response: events and NO snapshot
{"jsonrpc":"2.0","id":8,"result":{
  "sessionId":"…","state":"operational","revision":15,"running":true,"exit":null,
  "resync":false,"snapshot":null,
  "events":[{"seq":10,"at":904,"kind":"output","data":"RklYNFVSRSBSRUFEWQ=="}],
  "nextSequence":10,"oldestSequence":1,"latestSequence":10,
  "truncated":false,"droppedEvents":0,"inputRecorded":false}}
```

- **`events`** are the child's raw output chunks, base64 (`data`), each with a monotonic `seq` and an
  `at` in milliseconds since the session started. Base64 because a PTY emits arbitrary bytes — WIN-15
  deliberately feeds invalid UTF-8 — and JSON cannot carry them. This is also what preserves colour.
  `events` can also carry a `snapshot` at a truncation boundary (see the replay recipe below), which
  is why a consumer must handle that kind rather than assume every event is bytes. It never carries
  `input`.
- **`afterSequence`** is the cursor. Pass the previous `nextSequence` to continue. Gaps are detectable
  because `seq` never repeats and never goes backwards.
- **The stream is live from the point of attach.** Pass `0` (or omit it) and the response carries a
  `snapshot` of the current screen and **no events**, with `nextSequence` set to the ring position the
  snapshot was taken at. It does *not* replay retained history. That is deliberate: the snapshot
  already accounts for those bytes, so returning them as well would make a consumer that renders the
  snapshot and then applies the events paint that output twice. A consumer that wants history wants
  `terminal.recording`, not the stream.
- **A response carries a snapshot or events, never both.** One or the other, so there is no overlap to
  reason about and no double-application to guard against.
- **`resync: true`** is the "you missed some" signal. It is set when the cursor is behind the retained
  window, and the response is then shaped exactly like an attach: a fresh `snapshot`, no events, and a
  `nextSequence` at the end of the ring. Treat a resync as a new attach, not a continuation, and do
  not assume the missed bytes are recoverable from the stream — they may have been dropped, which is
  what `truncated` and `droppedEvents` report.
- **`snapshot`** is a full `observe()` result, so a watcher can always render a complete screen before
  applying any bytes. It never contains the owner token.
- **Long poll.** With a current cursor and nothing new, the call waits up to `timeoutMs` (capped at
  30000, the same bound as `terminal.wait`) and then returns empty `events`. It returns immediately
  once the session has exited, so consumers do not pay the full interval on teardown. An attach or a
  resync also returns immediately: the snapshot *is* the answer, so there is nothing to wait for.

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
    {"seq":1,"at":0,"kind":"snapshot","screen":"…","cols":60,"rows":20,"cursor":{"x":0,"y":0}},
    {"seq":2,"at":4,"kind":"output","data":"…"},
    {"seq":3,"at":900,"kind":"input","data":"…"},          // only when inputRecorded
    {"seq":4,"at":1200,"kind":"resize","cols":80,"rows":24},
    {"seq":9,"at":5400,"kind":"exit","exit":{"exitCode":3,"signal":null}}]}}
```

Every recording's **first event is a `snapshot`**, seeded when the session is created: an empty ring
would make an attach hand back cursor 0, and the consumer's next poll would attach again immediately
instead of long-polling. Further `snapshot` events appear only at truncation boundaries.

Replay feeds the events to a fresh emulator in order:

- `snapshot` — resize to its geometry, **clear the screen and scrollback**, write its text, then
  restore its cursor. Clearing matters even though a snapshot is usually first, because
  `terminal.stream` can also deliver one *inside* `events` at a truncation boundary (a cursor of
  exactly `oldestSequence - 1` is not stale, so it is served as an ordinary event with `resync` false),
  and by then the consumer's emulator already holds content. Restoring the cursor is not cosmetic
  either: writing a viewport-sized block of text leaves the cursor on the last row, while the live
  cursor was wherever the child had put it.
- `output` — write the decoded bytes.
- `resize` — resize the emulator.
- `input`, `exit` — ignored. Input's effect is already in the output that follows it; exit has no
  visual effect.

`replayRecording()` in `src/recording.js` does exactly this and is what the tests use, so the
acceptance criterion "a recording played back ends in the same screen" is asserted rather than
claimed. Its emulator must be built with the same scrollback the runtime uses — exported as
`SESSION_SCROLLBACK` and imported by `src/server.js` so there is one value, not two that must agree —
because scrollback changes what a resize puts in the viewport once content has scrolled off.

**Input is off by default.** Pass `recordInput: true` to `terminal.create` to capture keystrokes.
`inputRecorded` is in every response either way, so a consumer holding a record can distinguish
"nothing was typed" from "typing was not being recorded" — which matters when the record is evidence.

Keystrokes are filtered out of `terminal.stream` **at the source**, not by the caller: the filter is
inside `Recording.eventsAfter`, so there is no cursor and no argument a watcher can pass that reaches
them, including ones recorded before it attached. `terminal.recording` requires the `owner` token and
answers `Ownership required` without it, the same gate as `terminal.close`.

**Bounded.** The record is a ring capped by `recordBytes` at create (default 1 MiB, minimum 1024,
maximum 16 MiB — a caller cannot ask the host for unbounded memory). Every event is charged its
payload **plus a 64-byte envelope**, so the cap bounds event count as well as bytes. Charging payload
alone was the first implementation, and it let an owner spam `terminal.resize` to grow the ring
forever while `bytes` stayed at zero — the cap looked enforced while doing nothing (`REC-15` pins the
fix). On overflow the whole retained prefix is replaced by a single `snapshot` event of the screen at
that instant, and `truncated`, `droppedEvents` and `droppedBytes` report what was lost.

The reachable maximum is **max(cap, one viewport)** — not `cap + one viewport`, which is what an
earlier revision of this document claimed. Truncation zeroes the retained total and *then* appends the
re-anchoring snapshot, and a snapshot cannot be dropped without destroying replay fidelity. So a cap
larger than a viewport is honoured exactly, while a cap smaller than one viewport (up to ~45 KB at the
300×150 ceiling `dimensions()` allows) retains that snapshot and nothing else — degenerate, but
reported through `truncated` and `droppedEvents` rather than hidden. `bytes` charges the snapshot's
screen text in full, so the figure reflects what is actually held.

Replacing the prefix rather than dropping only the overflow is the part worth explaining: a prefix
whose beginning is gone **cannot** be replayed to a correct answer, because replaying from the middle
of a byte stream yields garbage rather than a slightly older screen. Losing the prefix and saying so
is honest; quietly replaying a partial one is not. The snapshot is taken synchronously from the
emulator, and output is recorded only *after* the emulator has accepted that chunk, so the snapshot
never lags the events that follow it.

Replay restores the snapshot's **geometry and cursor**, not only its text. Review found this after the
first version passed its own tests: writing a viewport-sized screen leaves the cursor on the last row,
while the live cursor was wherever the child had put it — typically mid-screen, at a prompt — so every
output event after the boundary landed in the wrong place and the replay diverged from the session it
was supposed to reproduce. `REC-10` passed anyway, because its content happened to leave the cursor at
the bottom-left, which is exactly where the naive replay also put it. It now asserts a cursor
mid-screen, and fails on the *screen* comparison if the restore is removed.

**Recording is on by default for every session**, including those whose caller never reads it: the
ring is what lets a watcher attach late and resync, so it cannot be lazy. The cost is up to
`recordBytes` per session — 1 MiB by default — which a host running at the 16-session cap should
budget for. Setting `recordBytes` lower is the lever.

## Guarantees, and the test that holds each one

| #27 acceptance criterion | Test |
| --- | --- |
| Two watchers see the same final screen as `observe` | `STR-01` — two watchers attaching at *different times*, converging by different routes (early snapshot + more bytes vs late snapshot + fewer bytes), both equal to `observe().screen`, with divergent content assertions that fail if the cursor is ignored |
| A slow watcher does not slow the program | `STR-08` — 30 commands typed with no watcher polling at all. A stall is caught by `waitScreen`'s own budget throwing. That the producer actually *rendered* is checked against the retained bytes of the first and last command — not against the revision, which `input()` bumps on acceptance alone and so would pass even if every byte of output were dropped |
| A slow watcher does not grow memory without limit | `STR-07`, `STR-08`, `REC-05`, `REC-15` — retained `bytes` *and* event count asserted against the configured cap |
| A recording played back ends in the same screen | `STR-06` end to end through the real runtime; `REC-09`, `REC-10`, `REC-11`, `REC-17` at unit level |
| Colours included | `STR-02` — `\x1b[31m` present in the stream and absent from `observe().screen` |
| A watcher never gets the owner token and cannot type | `STR-03` — asserted on the serialised payload, not a field list, plus a refused `terminal.type` that must not reach the child |
| Input off unless asked, and the record says so | `STR-04`, `STR-05`, `REC-03` |
| Bounded, with a clear "you missed some" | `STR-07`, `REC-05`, `REC-07`, `REC-15` |

Non-vacuity was checked by mutation rather than assumed, in each place a test could have passed for
the wrong reason:

- Disabling the input filter in `eventsAfter` fails `STR-05` and `REC-04`.
- Removing the cursor restore from replay fails `REC-10` on its **screen** assertion — the defect
  review found, reproduced on demand.
- Charging events zero overhead fails `REC-15` with `5000 events retained against a cap of 16`.
- Building the replay emulator with `scrollback: 0` instead of `SESSION_SCROLLBACK` fails `REC-23`,
  which scrolls and *then* grows the viewport — the one case where the two settings diverge, and the
  reason the value is a shared constant rather than two literals that happen to agree.

Each mutation was reverted, and the absence of it confirmed, before the suite was re-run. Replay also
rejects an event kind it does not know (`REC-12`) and a snapshot carrying no screen text (`REC-18`)
rather than skipping either, because silently ignoring an event produces a plausible but wrong screen.

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
- **The stream is live from attach, not a history read.** Attaching returns the current screen and
  resumes from there; it does not replay what the ring already holds. A consumer that attaches after
  output it cares about has that output in its snapshot but not as bytes, and cannot recover the
  bytes from the stream. The history call is `terminal.recording` — **and it is owner-gated**, so a
  read-only watcher, which is precisely the party that lost the bytes, cannot call it. Recovering
  missed history is the session owner's job; a watcher's only remedy is to resync and continue. This
  cost two test failures during development before it was written down, which is why it is written
  down.
- **Concurrent polls are not capped.** Each in-flight `terminal.stream` or `terminal.wait` registers a
  waiter that is removed when it wakes or times out, so the set is bounded in *time* but not in
  *count*. That is pre-existing behaviour for `terminal.wait`; `terminal.stream` makes it reachable
  without an owner token. The transport is a single stdio pipe, so concurrency is bounded in practice
  by the client, but a client that opens thousands of simultaneous polls is not defended against.
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

## Cross-session messages — `terminal.post` and `terminal.mailbox`

Issue #34, transport slice only. A message is a sequenced entry in a bounded, host-relayed queue;
it is **not** keystrokes in the target's PTY. That distinction is the whole design: writing into the
target with `terminal.type` and scraping it with `observe` is not a protocol — a prompt, an echo and
a progress bar are the same bytes, an ANSI repaint can erase the answer, interleaving with human
input is undefined, and whatever is sent becomes part of scrollback and the recording.

`initialize` advertises `"mailbox": 1`. `terminal.create` returns a `mailbox` capability beside the
owner token. **They are different tokens on purpose:** the capability authorises messages only, and
there is no path from either method below to `terminal.type`, so a session cannot type into another
just because it can send it a message. MB-04 pins that a mailbox capability used as an owner is
refused with `{"error":{"message":"Input ownership required"}}`.

```jsonc
// post: enqueue for a session
{"jsonrpc":"2.0","id":8,"method":"terminal.post",
 "params":{"sessionId":"…","capability":"…","payload":{"kind":"task","text":"run the suite"}}}
{"jsonrpc":"2.0","id":8,"result":{"sequence":1,"dropped":0}}

// mailbox: drain after a cursor; long-polls like terminal.wait
{"jsonrpc":"2.0","id":9,"method":"terminal.mailbox",
 "params":{"sessionId":"…","capability":"…","afterSequence":0,"timeoutMs":5000}}
{"jsonrpc":"2.0","id":9,"result":{
  "messages":[{"sequence":1,"payload":{"kind":"task","text":"run the suite"}}],
  "nextSequence":1,"dropped":0}}
```

Guarantees, each held by a test in `test/mailbox.test.js`:

| guarantee | test |
| --- | --- |
| messages arrive in sequence, with a cursor that returns only later ones | MB-01, MB-02 |
| a wrong, missing or foreign capability is refused; `Unknown session` for a closed one | MB-03 |
| a capability is not an input right | MB-04 |
| an unencodable payload and one over the size limit are refused, not silently dropped | MB-05 |
| overflow drops the **oldest** and reports the gap through `dropped` | MB-06 |
| a waiting mailbox wakes when a message is posted | MB-07 |

Limits, stated rather than discovered later: **64 KiB** per message (its JSON encoding), **256**
queued per session with the oldest dropped past that, **100** posts per second per session, and a
long poll capped at **30 s**. The poll timer is unref'd, so a pending mailbox can never be the reason
the host cannot exit.

Not delivered by this slice: parent/child or pair capabilities (#35), payload recording (deliberately
off by default, and it follows the same opt-in rule as input recording if it is ever added), and
server-push notifications — the poll matches the rest of the protocol, and a push variant still needs
the framing decision in `docs/desktop/living-terminal.md` §9.

## Parent and child edges — `terminal.create { parent }`

Issue #35, the edge slice. A parented create mints **one capability for the edge**, and that
capability is accepted at either end and nowhere else. This is the structural form of the policy
the issue asks for: "no sibling-to-sibling, no broadcast" is not a check anyone can forget, because
a sibling never holds the capability to begin with. PE-04 pins it.

```jsonc
// parent creates a child
{"jsonrpc":"2.0","id":10,"method":"terminal.create",
 "params":{"command":"…","parent":"<parent session id>"}}
{"jsonrpc":"2.0","id":10,"result":{
  "sessionId":"…","owner":"…","mailbox":"…",         // the child's own mailbox capability
  "childMailbox":"…"}}                              // the edge capability, for the parent
```

The child receives the edge through its **env allowlist**, never through an inherited owner token:

| variable | value |
| --- | --- |
| `SENTIORA_MAILBOX_CAPABILITY` | the edge capability |
| `SENTIORA_PARENT_SESSION` | the parent's session id |

Both ends then use the same capability with `terminal.post` / `terminal.mailbox`: the parent targets
the child's session, the child targets the parent's. Neither direction carries input rights — the
capability is still refused for `terminal.type` and `terminal.close`.

Guarantees, each held by `test/parent-edge.test.js`:

| guarantee | test |
| --- | --- |
| the child is created with the edge capability and its parent's id in its env | PE-01 |
| the parent can post to the child through the edge | PE-02 |
| the child can answer its parent through the same edge | PE-03 |
| the capability cannot open a session that is not one of its ends | PE-04 |
| an unknown or malformed `parent` is refused before anything spawns | PE-05 |
| closing either end drops the edge and its capability | PE-06 |

**Lifecycle, chosen explicitly:** closing either end drops the edge. Closing a parent **detaches**
its children rather than killing them — a cascade has to be asked for, not implied, because killing
processes a caller did not name is the more surprising default. A `closeChildren` option is the
natural next slice; until then the rule is stated here rather than assumed.
