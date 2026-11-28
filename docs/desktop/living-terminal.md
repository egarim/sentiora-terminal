# Living Terminal desktop UI — PR1 (issue #7)

**Status: PR1 implemented and tested against the real runtime, with one BLOCKED item.**

This document covers what PR1 of [issue #7](https://github.com/egarim/sentiora-terminal/issues/7)
actually builds, how it is wired to the existing JSON-RPC runtime, what was measured rather than
assumed, and what is deliberately **not** here yet. PR2 (motion, Rive mascot, animation packs),
PR3 (ownership leases, agent dashboard, command blocks) and PR4 (recording/replay/remote) are out
of scope for this document except where PR1 lays plumbing they will use.

Everything asserted about the runtime below is either measured in this repository's own validation
documents or re-measured by the tests added in this PR. Where a claim comes from reading source
rather than from an experiment, it says so.

---

## 1. What PR1 delivers

| Deliverable | Where | Status |
| --- | --- | --- |
| Native session bridge (JSON-RPC client, owner custody, revisions, ordered output, backpressure, snapshot/resync, bounded scrollback) | `apps/desktop/bridge/` | **Implemented, tested** |
| Runtime host pool with per-host session counter and recycling before the descriptor ceiling | `apps/desktop/bridge/host-pool.js` | **Implemented, tested** |
| Local authenticated IPC with least privilege | `apps/desktop/server/ipc.js` | **Implemented, tested** |
| UI shell: React 19 + TypeScript + xterm.js 5.5 | `apps/desktop/ui/` | **Implemented, typechecks and builds** |
| Tabs and independent per-pane splits | `ui/lib/layout.ts`, `ui/components/SplitPane.tsx` | **Implemented** |
| Persistent settings, light/dark themes, animation-off switch, preset plumbing | `apps/desktop/bridge/settings.js`, `apps/desktop/theme/tokens.js` | **Implemented, tested** |
| Onboarding and shell selection (S1, minimal) | `ui/components/Onboarding.tsx`, `bridge/shell-catalog.js` | **Implemented, tested** |
| Design tokens with measured WCAG contrast | `apps/desktop/theme/tokens.js` | **Implemented, tested** |
| Tauri 2 desktop packaging | — | **BLOCKED — no Rust or MSVC toolchain on this machine (section 8)** |

The Node/node-pty runtime in `src/` is **unchanged**. The desktop app is a client of it and lives
entirely under `apps/desktop/`, so the runtime remains independently usable and independently
testable.

---

## 2. The output model, and why it is snapshots

This is the single most consequential design fact in PR1, so it comes first.

`terminal.observe` returns the **rendered viewport** — `screen` is built from
`terminal.buffer.active` via `translateToString(true)` (`src/session.js`). The runtime has no push
channel: it never emits unsolicited lines on stdout, and WIN-15 pins that it must not.

When PR1 landed that was the whole story, and
[`../integrations/telekinesis.md`](../integrations/telekinesis.md) section 4 concluded that "a
faithful raw-byte stream cannot be reconstructed." **That is no longer true.** Issue #27 added
`terminal.stream`, which returns the child's original output chunks base64-encoded with monotonic
sequence numbers from a bounded server-side ring. What has *not* changed is that this bridge still
consumes `terminal.observe`, so everything below still describes the bridge as built rather than the
runtime as it now is.

So the bridge does what that document recommended at the time: one pump per session runs a
`terminal.wait(afterRevision, 250ms)` long-poll and publishes **whole rendered screens**, keyed by
revision. Consequences, stated plainly:

**What survives**
- Text content, layout and Unicode. Verified end to end against the real runtime: `cañón Ñandú ÄÖÜß`,
  `Съешь ещё этих булок`, `汉字终端测试`.
- Alternate screen. `buffer.active` *is* the alternate buffer when a TUI has switched to it, so an
  alt-screen application renders correctly and the primary screen returns on `\x1b[?1049l`. Tested.
- Cursor position, geometry, lifecycle state, exit code, `writeErrors`.
- Escape sequences are **applied**, not forwarded: the test asserts no raw `\x1b[` reaches the UI.

**What does not survive**
- **Colour.** `translateToString()` returns plain text, so SGR attributes are lost. The UI applies
  its own theme to a monochrome screen. When PR1 landed this was a *protocol* limitation; it is now a
  **bridge** limitation — `terminal.stream` carries the original bytes with their escape sequences
  intact, and the bridge simply has not been migrated to it.
- **Lines that scroll past between two observations.** The bridge recovers scrollback by exact
  pure-shift matching between consecutive screens: if the previous screen moved up by exactly *k*
  rows and the remainder is identical, those *k* rows are recovered. No confident match means no
  guess, and the match must leave enough overlapping rows to be evidence — a shift equal to the
  viewport height matches *vacuously* (nothing left to compare) and would otherwise swallow the whole
  screen into history on every single frame.
  Against a runtime that changes the screen one line at a time this is exact: measured 400 lines
  emitted through a 20-row viewport, **380 recovered, in emission order, zero duplicates**.
  On a **real Windows console it is mostly ineffective**, also measured: ConPTY delivers output in
  batches roughly a second apart, so the screen commonly jumps by more rows than there is overlap
  left to verify, and the heuristic correctly declines to guess. Recovery there is partial and
  sometimes nil. That gap between the two measurements is the concrete case for proposal 9.1.
- **Byte-level framing.** One keystroke is not one child input event; ConPTY coalesces and splits.

All three are now addressable at the protocol level through `terminal.stream`, which carries every
byte the child wrote rather than a periodic sampling of the screen: colour and byte framing arrive
with the raw chunks, and output cannot scroll past unobserved because the ring retains the bytes
between polls — up to its bound, beyond which it reports `resync: true` and hands over a fresh
snapshot rather than pretending to be complete. What section 9.1 still proposes is the *push*
transport, which would remove the polling interval rather than the loss.

The bridge publishes `outputMode: 'snapshot'` and `outputModes: ['snapshot']` on `GET /api/info` so
a future raw-output mode is *negotiated* rather than assumed.

### Repainting

Because a frame is a whole screen, the UI repaints by absolute cursor addressing rather than
appending: for each changed row it writes `ESC[row;1H`, the row text, `ESC[K`, then repositions the
cursor from the frame's `cursor:{x,y}`. Rows that did not change are not rewritten. `resync: true`
forces a full repaint. xterm.js's own scrollback is disabled (`scrollback: 0`) — the bridge owns
history, and a second divergent copy would be worse than none. Recovered history is rendered in a
separate panel that says it is a reconstruction.

Screen content is treated as untrusted: `ui/lib/paint.ts` strips C0/C1 control bytes from every line
before handing it to the emulator, so printed output cannot inject escape sequences into the
repaint stream.

---

## 3. Runtime semantics the bridge implements

Each of these is a measured property of the runtime. The numbers come from
[`../validation/conpty-provider-comparison.md`](../validation/conpty-provider-comparison.md) and
[`../integrations/telekinesis.md`](../integrations/telekinesis.md) section 7.

| Semantics | Implementation |
| --- | --- |
| **Revision guard.** A write with a stale `revision` is rejected with `Stale observation`. | The pump keeps a current revision so the common keystroke costs one round trip. On `Stale observation` the bridge re-observes and retries, bounded at 12 attempts, then fails with a typed error. Tested both ways against the real runtime. |
| **Writes bump the revision.** | `#sendNow` publishes the revision the *write* returned, so the next wait is armed correctly rather than returning before the child has answered. Asserted explicitly. |
| **Out-of-order observations.** | The pump's `wait` and an explicit `observe` are separate RPCs correlated by id, not send order. An observation older than what has already been applied is dropped. Without this the revision moves backwards and the scrollback match replays the same lines — caught by the U11 flood test and now covered by a dedicated regression test. |
| **Idle waits.** | `terminal.wait` resolves on timeout with an unmoved revision. Publishing that would emit a duplicate frame every 250 ms per session forever, so `#ingest` drops no-op observations. Regression-tested. |
| **`owner` is a bearer credential.** | Held only inside `SessionBridge`. Every UI-facing value is built by `describe()` or `publicView()`, which pick fields explicitly rather than spreading and deleting. Tested by collecting every string in every payload and asserting no owner token appears — including scanning every HTTP response body. |
| **Session ids are per-host.** | The protocol promises no cross-host uniqueness. The bridge mints its own UUID per session and keeps the runtime's id internal, so two pooled hosts cannot collide. Regression-tested with a fixture that deliberately reuses ids. |
| **Lifecycle states.** | `spawned → operational → exited → released`, surfaced on every frame and as a `session-state` event. There is no `ready` state and the bridge does not invent one. |
| **`writeErrors > 0`.** | Raised as a `write-error` event, carried on every frame, and rendered as a banner: "that keystroke did not reach the child." Never presented as delivered. |
| **Exit detection is ~1025 ms late.** | The pump stops on `state === 'exited'` or `!running`. The UI shows "process exited (code N)" and keeps the last screen. Nothing treats `running` as immediate. |
| **Resize is eventually consistent (~170 ms) and range-limited (cols 2–300, rows 2–150).** | Clamped in the bridge *and* in the UI, with the applied size and a `clamped` flag returned. The native test confirms the child's own reported geometry converges, rather than asserting immediately after the call. |
| **Ctrl+C is mode-dependent and can kill the child.** | `interrupt()` gates on a **fresh** observation, not a cached one: it requires `state === 'operational'` and, when supplied, a readiness pattern present on screen. A refusal returns `{delivered:false, reason}` and the UI shows the reason. Tested against the real runtime in raw mode (byte `0x03` received, child survives) and against a spawned-not-operational session (refused). |
| **16 sessions per host, ceiling near ~495 cycles.** | See section 4. |
| **Input ≤ 65536 characters.** | `type()` chunks transparently. Tested with a 70 000-character paste. |
| **Shutdown takes ~5.1 s.** | `RuntimeClient.shutdown()` closes stdin, waits 6 s, then force-kills the tree (`taskkill /F /T` on Windows). |
| **Every error is code `-32000`.** | All message-string matching lives in one file, `bridge/errors.js`, mapping to a stable `kind`. If the runtime grows real error codes, only that file changes. The mapping table is asserted exhaustively. |

---

## 4. Host pooling and the descriptor ceiling

A single runtime host is neither big enough nor immortal. It refuses `terminal.create` past 16
concurrent sessions, and it leaks ~1 fd and ~1.75 Win32 handles per session that are never
reclaimed — degradation from ~363 create/close cycles, outright `Invalid pty handle` near ~495.

`RuntimeHostPool` therefore:

- counts **lifetime** creates per host (not live sessions, since the leak is per cycle);
- retires a host when it reaches `recycleAfter` (default **350**, below the measured degradation
  point rather than at the failure point) — it stops accepting new sessions, keeps serving existing
  ones, and is shut down when the last one closes;
- sweeps the counter *before* placing a session, so the create that trips the threshold never lands
  on the worn-out host;
- spreads sessions across up to `maxHosts` (default 4) hosts;
- treats a runtime-reported `Session limit` as authoritative even when its own count says there is
  room, marks that host full and moves to the next one.

Recycling is tested with a fixture that starts refusing creates after 3: six sessions succeed across
two hosts and the worn-out host is retired when its sessions close. The same fixture with recycling
disabled proves the ceiling surfaces as a typed `invalid-pty-handle` error rather than being hidden.
The real ~495-cycle ceiling is **not** re-measured here — that is a long-running leak test and the
existing benchmark harnesses (`npm run bench:conpty`, `test/bench/fd-exhaustion.mjs`) already cover it.

### Backend lost

If a host dies or its stdout stops being parseable, **every** sessionId on it becomes meaningless.
The pool emits `host-lost`; the bridge marks those sessions `backendLost`, pushes a final
`kind:'lost'` frame so each pane says so instead of silently freezing, and then refuses every
operation on them with kind `backend-lost`. It does **not** retry, because retrying would attach a
pane to a different process. A non-parsing stdout line is treated as fatal rather than skipped —
skipping would hide framing corruption, the one property the whole transport rests on.

A dropped host is also force-killed even though it is no longer pooled: on a transport error the
process is still alive, and its stdout pipe would keep the bridge's event loop alive forever.

---

## 5. Backpressure, ordering and resync

Per session there is one pump and one bounded queue per subscriber (default 4 frames).

- Frames carry a monotonic `revision`. Asserted strictly increasing, never repeated, against both the
  fake and the real runtime.
- When a subscriber has not drained, its queued intermediates are replaced by the newest whole
  screen, the frame is flagged `resync: true`, and the `scrolledOff` lines of the dropped frames are
  folded into the survivor so history is not lost by coalescing either. The count folded in is
  reported as `coalesced` and shown in the status bar.
- `attach()` always yields a complete `snapshot` first — the full viewport plus the recovered scroll
  ring — so a UI that reconnects to a live session (U04) cannot paint a partial screen. Tested with
  two concurrent consumers converging on byte-identical screens.
- No synchronous work is done in the input path beyond building one repaint string per frame.

Measured under the 400-line flood with a queue of 2: 1 frame delivered to the slow consumer, 10
coalesced, final screen byte-identical to the runtime's own observation.

---

## 6. Security model

Issue #7 requires "local authenticated IPC with least privilege, no arbitrary frontend shell
bridge". Concretely:

1. **Loopback only.** The server binds `127.0.0.1` on an ephemeral port.
2. **Per-launch bearer token**, `randomBytes(32)`, compared with `timingSafeEqual`. Delivered in the
   URL **fragment**, which browsers never transmit and access logs never record; the UI reads it and
   immediately strips it with `history.replaceState`. It is held in a module-scoped variable — never
   localStorage, a cookie or a query string.
3. **Origin allowlist.** A request carrying an `Origin` header is refused unless the origin is
   allowed. This is what stops a random web page from driving a local terminal through a browser
   that happens to hold the token. Requests with no `Origin` (the packaged webview, curl, tests) are
   protected by loopback binding plus the token.
4. **No arbitrary process launcher.** `POST /api/sessions` accepts only a `shellId` from the detected
   catalog or a `customPath` that must be an **absolute path to an existing regular file**. A body
   containing `command` or `args` is refused with `403 shell-bridge-refused`. Relative names are
   refused too, because they would be resolved against whatever `PATH` the runtime host has.
5. **Owner tokens never cross the boundary.** See section 3; enforced by construction and asserted by
   scanning every response body.
6. **Bounded input.** 1 MiB request bodies; 400 input operations per second per session, counted
   after validation so a malformed request cannot consume the budget.
7. **Static serving is contained.** The path is resolved and then containment-checked against the
   build directory; encoded traversals (`%2e%2e%2f`) are never decoded into a filesystem path.
8. **Environment inheritance is scoped, and the desktop opts in deliberately.** The runtime no
   longer spawns children with `env: process.env`; since issue #26 a session defaults to a small
   allowlist (`PATH`, `HOME`/`USERPROFILE`, `TERM`, `LANG`, temp and locale, plus the Windows
   essentials) and inherits nothing else unless the caller names it (telekinesis.md §11.1).
   `RuntimeClient.createSession` passes the bridge's own `env` explicitly, so a desktop shell still
   gets the user's environment. That is a deliberate opt-in rather than an oversight: the bridge
   runs as the local user and its sessions *are* that user's shells, so narrowing them would drop
   the user's own variables with no security gain — there is no privilege boundary to enforce
   between the two. A caller can still narrow a single session by passing `env` in the create
   params, which then wins over the bridge default.
9. **Observations are unredacted.** `screen` can contain a password a child echoed. PR1 does not log
   observations. Redaction belongs to whatever starts auditing sessions (PR4's recording), and is
   called out here so it is not forgotten.

Not covered, and stated rather than glossed: this is a loopback HTTP boundary. A Tauri IPC boundary
would additionally allow per-window capability grants and would not need a network listener at all.
That is part of what section 8 is blocked on.

---

## 7. UI shell

React 19 + TypeScript (strict) + Vite 7 + xterm.js 5.5, matching `@xterm/headless@^5.5.0` on the
runtime side so both emulators are the same major version.

- **Compact, Ghostty-inspired.** ~28 px tab strip, ~24 px pane header, ~22 px status bar, 1 px
  borders, no chrome shadows. Terminal content occupies the rest.
- **Design tokens.** `apps/desktop/theme/tokens.js` is the single source of truth. The React app
  turns it into CSS custom properties at runtime; the Node tests import the *same object* to compute
  WCAG contrast. A theme that lives only in a stylesheet cannot be tested.
- **Themes.** Dark and light. Contrast is asserted in CI: 23 UI text/component pairs must clear
  AA 4.5:1 (or 3:1 for non-text), and all 16 ANSI colours must clear 3:1 against the terminal
  background. The dark palette's ANSI "black" is a visible grey, because a black drawn darker than
  the background is unreadable and every program emitting `SGR 30` hits it.
  One documented exemption: ANSI `white`/`brightWhite` in the **light** theme. A literal white is
  invisible on a light background, and remapping it to grey would break the far more common case of a
  program that sets its own coloured background and draws white on it. This is a real readability
  hole for a light-theme program emitting bare `SGR 37/97` with no background, and it is recorded
  rather than papered over.
- **Keyboard accessible (U07).** Every action has a focusable button as well as a shortcut; the
  shortcut list is in-app (`F1`). Shortcuts are **Alt-based chords** because browsers reserve most
  Ctrl+Shift combinations and cannot be told otherwise — relevant because the browser is the current
  runnable target. Alt+Arrow for browser navigation is avoided by using Alt+Shift+Arrow for pane
  focus. Split dividers are focusable `role="separator"` elements adjustable with arrow keys, Home
  and Shift for fine steps. Tabs are a real `tablist`. One `:focus-visible` treatment everywhere at
  the 3:1 token weight.
- **Animation plumbing only.** `data-animation`, `data-preset` and `data-reduced-motion` attributes
  on the root, a resolved-flags endpoint, and CSS that kills all transitions when animation is off or
  reduced motion is requested. Nothing animates in PR1 beyond short transitions the off switch
  suppresses. There is exactly one `// PR2:` marker where the typed-event → mascot-state mapping
  will hook in.
- **Not implemented in the UI:** mouse reporting to the child. Snapshot delivery plus
  revision-armed writes make high-frequency mouse events expensive and lossy, and it needs the raw
  stream proposed in section 9. Selection and copy inside xterm.js work normally.

### Running it

```bash
npm ci                                    # runtime deps (root)
npm --prefix apps/desktop ci              # UI deps
npm --prefix apps/desktop run build       # produces apps/desktop/dist

node apps/desktop/bin/living-terminal.mjs # prints: open http://127.0.0.1:<port>/#token=<token>
```

The bridge serves `apps/desktop/dist` itself, so UI and API share one origin and one token.

Development, two processes:

```bash
node apps/desktop/bin/living-terminal.mjs --port 8791 --allow-origin http://localhost:5173
npm --prefix apps/desktop run dev         # vite on :5173, proxies /api to :8791
```

then open `http://localhost:5173/#token=<token>`.

---

### Cascade close is declared at creation, not at close

`terminal.create { parent, closeChildren: true }` is what registers "when this parent closes, close
my children": the runtime keeps that in `childCascade`, keyed by the parent. There is **no close-time
flag**, and a `?closeChildren=1` on `DELETE` would have nothing to read.

That cost a round. The first attempt passed the flag on close, so the DELETE returned `200
{"closed":true}` while the child's process stayed alive — the parent closed, the cascade was never
registered. `E2E-11` now declares it at creation and asserts the **pid** is gone, which is the only
assertion that cannot be satisfied by a bookkeeping change.

Two traps in that test worth knowing:

- the app opens its own first tab on boot, so **row counts are not stable** — the assertions are by
  session id, not by count;
- a `locator.filter({ has })` looks for a **descendant**; a row carrying the attribute itself is
  matched with a plain attribute selector.
### The log after a reload

Reopening the app replays the log from the mailbox, because the viewer starts at cursor 0 on every
load and the ring still holds the messages. There is no page-level cache to go stale, and nothing to
migrate.

A **reload** is not the same thing: `bootstrapFromLocation` strips the token from the URL with
`history.replaceState`, deliberately, so a bare reload lands on the no-token gate. The test therefore
re-enters with the launch URL, which is what a user does, rather than calling `page.reload()` and
asserting on a page that has no credential by design.

`E2E-12` proves both halves of the ordinary case: three messages posted before the reopen are all
present afterwards, in order, and **no gap marker appears** — claiming a gap that did not happen would
be its own kind of wrong.
### The exchange view, and who sent what

A mailbox belongs to its **recipient**, so "what the parent said to the child" only exists in the
child's inbox. Two additions make the exchange legible without inventing a timeline:

- `terminal.post` now records **`from`** when the post used an *edge* capability. That is
  attribution by construction rather than by trust: only the two ends of an edge hold it, so a post
  into the child can only be the parent. A post made with a session's own mailbox capability is the
  host speaking and stays `null` rather than being guessed at (`PE-15`).
- `SessionBridge.post(sessionId, payload, { from })` resolves that pair's edge, and
  `SessionBridge.mailbox` **translates the runtime's sender id back to a bridge id** — the UI must
  never see a runtime id, for the same reason it never sees one anywhere else.

The viewer then shows two lists, deliberately not merged: **Received** (this session's inbox, each
entry labelled with its sender) and **Sent to children** (gathered from their inboxes and filtered by
`from`). Sequence numbers belong to a mailbox, so a single merged timeline across two inboxes would
be an invented order; two lists in their own orders is what can be stated truthfully.

`E2E-10` covers it end to end against a **real runtime**: a parent sends a task, the child answers,
both appear in the parent's view, and a third session with no edge is refused rather than delivered.
### The viewer is mounted

The workspace now renders the session viewer beside the terminal: `aside.viewer` holds
`SessionTree`, fed by `useSessionTree`, which polls `GET /api/sessions` and the selected session's
mailbox on **one timer** so a node cannot appear in the list with a log from the previous selection.
Selecting a row switches the log and resets its cursor — a mailbox cursor belongs to one session and
carrying it across would silently drop the first messages of the next.

Two things the mounting forced out:

- **The hook must be called above `App`'s early returns.** Placing it where the workspace renders
  meant the hook count changed between the gate/onboarding renders and the final one, and React
  threw as soon as the app reached the workspace — which failed *every* browser test, not just the
  viewer's.
- **The tree is read-only.** Input still goes to the focused pane; the viewer renders state and
  relays messages, and never holds a capability (`docs/security/trust-boundaries.md`).

`E2E-08` covers the tree, selection and a message arriving from the bridge into the log; `E2E-09`
covers a parent with two children, asserting the parent is drawn first and both children at depth 1.
### The tree and messages over HTTP

The viewer's two data needs are served by the loopback API, and the capability never crosses into
the webview:

- `GET /api/sessions` — every session with its **`parent`** (or `null`), which is what `buildSessionTree`
  consumes. `parent` also rides in every stream frame, so a viewer does not need a second call to keep
  its tree current.
- `POST /api/sessions/:id/messages` — body `{payload}` (or the message itself); answers `{posted}`.
  Rate-limited like input, because a message is a write.
- `GET /api/sessions/:id/messages?after=N&timeoutMs=…` — the mailbox frame; `after` must be a
  non-negative number and a bad cursor is a `400 invalid-request`, not a silent `after=0`.

`SessionBridge.post`/`mailbox` hold the mailbox capability internally, exactly as `type` holds the
owner token: the UI asks the bridge to relay, and cannot address the runtime directly.
### The viewer's models are testable without a browser

`apps/desktop/ui/lib/tree.ts` holds the two shapes the session viewer needs — the tree built from the
`parent` links `terminal.list` reports, and the per-edge mailbox log — as pure functions. They are
tested in `test/desktop-tree.test.js` (`TREE-01..06`), which runs as part of `test:desktop` on every
CI cell: Node strips the types natively from v24, and `test:desktop` passes
`--experimental-strip-types` for the node-22 cells.

That is deliberate: the part of the viewer that can be *wrong* is covered while the interaction-test
tooling (#19) is still undecided, and the components that remain are the parts a screenshot cannot
verify anyway.
## 8. BLOCKED: Tauri 2 packaging

Issue #7 asks to "validate platform webview latency and packaging, document fallback if unsuitable".
**Packaging could not be validated: the Rust toolchain is not installed on this machine.**

Machine: Windows 11 ARM64 build 26200, Snapdragon X Elite, Node v24.18.1 arm64, npm 11.16.0.

Verified absent:

| Prerequisite | Check | Result |
| --- | --- | --- |
| `rustc` | `rustc --version`, `where rustc` | **not found** |
| `cargo` | `cargo --version`, `where cargo` | **not found** |
| `rustup` | `rustup target list --installed` | **not found** |
| `%USERPROFILE%\.cargo\bin\rustc.exe` | file exists | **absent** |
| `%USERPROFILE%\.rustup` | directory exists | **absent** |
| MSVC compiler/linker | `where cl.exe`, `where link.exe` | **not found** |
| WebView2 Runtime | `HKLM\...\EdgeUpdate\Clients\{F3017226-...}` `pv` | **present**, 152.0.4191.62 |
| winget | `where winget.exe` | present |

So WebView2 — the part Tauri needs at *runtime* — is available, but nothing that can *compile* a
Tauri app is. npm 11 also blocks dependency install scripts by default, and there is no MSVC
toolchain, so a source-built native dependency would fail regardless.

**No `src-tauri` scaffold was committed.** A Cargo project that has never been compiled is a
liability, not a deliverable; the packaging plan below is documented instead of half-built.

### To unblock

```powershell
winget install Rustlang.Rustup
rustup default stable
rustup target add aarch64-pc-windows-msvc

# MSVC build tools with the ARM64 components and the Windows 11 SDK
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

npm install -g @tauri-apps/cli@^2
```

Then, from `apps/desktop/`:

```powershell
npm run tauri init    # or hand-write src-tauri/{Cargo.toml,tauri.conf.json,src/lib.rs,build.rs}
npm run tauri dev
npm run tauri build   # -> src-tauri/target/release/bundle/{msi,nsis}
```

`tauri.conf.json` should set `build.frontendDist` to `../dist`, `build.devUrl` to
`http://localhost:5173`, and run `bin/living-terminal.mjs` as a **sidecar** so the Node bridge keeps
holding owner tokens in its own process. With a sidecar the loopback HTTP server can be replaced by
Tauri commands, which removes the network listener entirely and allows per-window capability grants —
strictly better than the fallback boundary in section 6.

Also unvalidated for the same reason, and therefore **NOT TESTED**: webview input latency, the p95
added-input-latency target from issue #7, MSI/NSIS packaging, code signing, and Linux/macOS bundles.

### The fallback that does run

The browser/dev-server path above is fully functional against the real runtime and is what every
test in this PR exercises. It is a genuine fallback, not a stub — with the caveat that a browser can
steal reserved key chords, which is why the shortcut set is Alt-based and every action also has a
button.

---

## 9. Proposed runtime protocol changes (NOT implemented)

The runtime was deliberately left untouched. These are proposals for coordination with the runtime
PRs, per issue #7's "coordinate schema changes with existing runtime PRs". Nothing in PR1 depends on
them being accepted; each has a working fallback today.

1. **Raw output notifications** — *half done by issue #27; the transport half is still open.*
   The raw-byte channel now exists: `terminal.stream {sessionId, afterSequence, timeoutMs}` returns
   the child's original chunks base64-encoded with monotonic sequence numbers from a bounded
   server-side ring, with a snapshot on first attach and a `resync` flag plus a fresh snapshot when a
   consumer falls behind. That is functionally the `subscribe`/`replay` pair described here, so ANSI
   colour and exact byte framing are now available to a consumer that polls it. "No lost bytes" needs
   care: within the ring's bound nothing is lost, and beyond it the stream says so (`resync: true`,
   `truncated`, `droppedEvents`) rather than silently gapping — so what is on offer is *detection*,
   not preservation, and preservation costs sizing `recordBytes` for the session. See [streaming and recording](../streaming-and-recording.md).
   What remains unimplemented is the **push** half: a server-initiated
   `{"jsonrpc":"2.0","method":"terminal.output",…}` line per chunk. It still requires the runtime to
   emit unsolicited lines on stdout, which WIN-15 proves it never does, so it still needs a
   deliberate framing decision rather than a drive-by change — every current client parses stdout as
   responses to what it sent. `initialize` advertises `stream: 1`, which is where a `push: 1`
   capability would go once that decision is made.
   The bridge has **not** been migrated: it still long-polls `terminal.wait` and publishes rendered
   snapshots, so colour still does not reach the UI. It already negotiates `outputModes`, so
   switching is a capability check rather than a rewrite.

2. **Distinct JSON-RPC error codes.** Every error is `-32000` and only the message string
   distinguishes it. Already recommended in telekinesis.md §10. `bridge/errors.js` is the single
   place that would change.

3. ~~**Scoped environment for `terminal.create`.**~~ **Done (issue #26).** Children no longer
   inherit the host's full environment: the runtime defaults a session to a small allowlist and
   accepts an optional `env` object. This bridge opts into its own environment explicitly, and
   `POST /api/sessions` forwards a caller-supplied `env` through `SessionBridge.create` — so the
   narrowing described in §8 is reachable from the HTTP API, not only from in-process callers.

4. **Cancellation for `terminal.wait`.** There is no request-id cancellation, so an in-flight wait
   can only be outlasted. The bridge polls at 250 ms to keep responsiveness, which means
   cancellation granularity equals the timeout.

5. **An optional `cursor`-plus-dirty-rows observation.** A cheaper `terminal.observe` variant
   returning only changed rows would cut snapshot payload for large terminals. Low priority.

6. **Shell integration markers** (PR3 territory). Command boundaries cannot be derived from screen
   text without guessing. OSC 133 or equivalent would make command blocks honest.

---

## 10. Test coverage against issue #7's plan

`npm test` runs everything. The desktop suites are:

| File | Runtime | Platform |
| --- | --- | --- |
| `test/desktop-bridge.test.js` | scriptable fake runtime (`test/fixtures/fake-runtime.mjs`) | all |
| `test/desktop-settings.test.js` | none | all |
| `test/desktop-ipc.test.js` | fake runtime over real HTTP/SSE | all |
| `test/desktop-native.test.js` | **real `src/server.js`, real PTY** | all (ConPTY on Windows) |

The fake runtime reproduces the revision guard, lifecycle states, error strings, the session limit,
the descriptor ceiling and host death. It exists so the bridge's own logic can be pinned
deterministically on every CI platform without spending a PTY. It does not replace the native suites
and does not pretend to: `test/desktop-native.test.js` drives the real runtime.

| # | Item | Status |
| --- | --- | --- |
| U01 | Launch a real shell and execute a command | **PASS** — the catalog's default shell (PowerShell 7 here) is launched and a probe is asserted as *output*, not as an echoed command line. Plus a deterministic fixture variant. |
| U02 | ANSI / Unicode / IME and alternate-screen TUI | **PARTIAL — ANSI layout, Unicode and alternate screen PASS** against the real runtime. **Colour NOT TESTED** (the snapshot pipeline cannot carry it; section 2). **IME NOT TESTED** — needs a real IME and a human or an OS-level harness. |
| U03 | Tabs/splits resize independently | **PASS** — two real sessions resized independently, each child confirming its own geometry via the fixture's `size` command, plus clamping. The *browser* rendering of a drag is **NOT TESTED** (no browser harness). |
| U04 | Reconnect to a live session, ordered output | **PASS** — bridge level (two concurrent consumers converge byte-identically) and over HTTP/SSE. |
| U05 | Human takeover prevents stale agent input | **NOT TESTED — PR3 scope** (ownership leases). |
| U06 | Shell integration success/failure and fallback | **NOT IMPLEMENTED — PR3 scope.** |
| U07 | Keyboard-only navigation and accessibility | **PARTIAL.** Shortcut definitions, the ARIA structure and the focusable separators are implemented and typecheck. **No automated assertion** — there is no browser test harness in this repo, and adding Playwright was out of PR1 scope. Manual verification only. |
| U08 | Reduced motion / disabled animations | **PASS at the settings level** — the off switch beats every preset, and the OS preference beats an enabled preset, both asserted. No animation exists yet to disable visually. |
| U09 | Animation state transitions from typed events | **NOT IMPLEMENTED — PR2 scope.** |
| U10 | Pack rejection (malformed/oversized/traversal) | **NOT IMPLEMENTED — PR2 scope.** The analogous settings and static-serving hardening *is* tested. |
| U11 | Burst output, no lost bytes | **PASS within its stated meaning** — a viewport-sized burst loses nothing; a 400-line flood stays ordered, bounded, de-duplicated and byte-faithful to the runtime's own screen. Recovered *history* from that flood is only 7 lines, because ConPTY batches output (section 2). A byte-level "no lost bytes" guarantee is now reachable via `terminal.stream` (issue #27), which retains the child's actual bytes rather than screen samples; the push transport in proposal 9.1 would additionally remove the polling interval. This bridge uses neither yet. |
| U12 | Renderer crash / reconnect | **PARTIAL.** Backend death is tested end to end (`backend-lost`, no blind retry). A *webview* crash is **NOT TESTED** — needs Tauri, section 8. |
| U13 | Persistent settings and theme contrast | **PASS** — round-trip, atomic write, corrupt-file quarantine, invalid/unknown value handling, patch semantics, plus 23 contrast pairs × 2 themes and the ANSI palette. |
| U14 | 60-minute idle and workload memory/CPU | **NOT TESTED** — long-running by design; the existing stress harnesses cover the runtime side. |
| U15 | Native Windows/Linux/macOS build and smoke tests, x64 vs ARM64 | **BLOCKED for the desktop bundle** (section 8). The runtime's own 8-job matrix is untouched. |

Performance targets from issue #7 (p95 added input latency <10 ms, 60 Hz, no queue growth under
1 MB/s for 30 s): **NOT TESTED as written**, and the first two are not meaningful for a
snapshot-protocol UI. The owner's decision (2026-11-25) is to **re-baseline** them rather than
report them as a UI failure. The replacement targets are below.

#### Re-baselined performance targets

The original "p95 added input latency under 10 ms" assumes per-frame delivery of terminal output.
This **bridge** does not use a raw-output channel: it long-polls `terminal.wait(afterRevision, 250ms)`
and publishes whole rendered screens, so observation freshness is bounded by the poll interval and
no implementation of the bridge can beat it. A sub-10 ms target is therefore unreachable by
construction, not by poor engineering. It is decomposed into components that can each be measured:

The runtime *has* grown a raw-output channel since this was written — `terminal.stream`, issue #27 —
but the bridge has not been migrated to it, so the budgets below still describe the bridge as built.
Migrating would replace one poll interval with another of the same shape; only the server-initiated
push variant in §9.1 would remove the interval entirely.

| # | Target | Budget (p95) | Basis | Status |
| --- | --- | --- | --- | --- |
| P1 | **Input acceptance** — keystroke to `terminal.type` result | ≤ 50 ms | **Measured: median 16 ms, p95 32 ms, max 60 ms** over 200 sequential inputs (stress phase F) | **MET** |
| P2 | **Observation freshness** — child writes to appearing in a snapshot | ≤ poll interval + 50 ms (≤ 300 ms at the 250 ms poll) | Derived from the long-poll design; the runtime-side round trip is measured at median 31 ms | Not measured end to end |
| P3 | **Keystroke to rendered echo** for a local child — what a user perceives | ≤ 400 ms | Derived: P1 (~32 ms) + child processing + P2 (≤300 ms) + repaint | Not measured end to end |
| P4 | **No queue growth** under 1 MB/s for 30 s | unchanged from issue #7 | Retained verbatim: it *is* testable on snapshots | **MET** (U11, bounded coalescing) |
| P5 | **60 Hz smoothness** | Not applicable to terminal content | A snapshot UI repaints per observation, not per frame. Retain only for UI chrome transitions, which is PR2 scope | Deferred to PR2 |

P2 and P3 are **derived from measured components, not measured end to end** — there is no browser
harness in this repository (§8), so nothing here has been observed in a real webview. They should be
confirmed during U15 rather than treated as verified.

Two supporting measurements that bound how honest these numbers can be, both from the runtime
validation work: resize takes ~170 ms to propagate to the child, and a child's exit takes ~1025 ms
to become observable (node-pty's 1000 ms flush interval). Any target below roughly 50 ms is
therefore measuring the bridge, not the terminal.

**The original <10 ms target is deferred to proposal 9.1** (raw-output push with
`subscribe`/`replay`), not abandoned. Only with a push channel is per-frame delivery decoupled from
the poll interval, and only then does "added latency versus animation-off" become a measurable
quantity — the animation half of that comparison does not exist until PR2 anyway.

Issue #7 also asks for "actual screenshots and a short recording of transitions": **NOT DELIVERED.**
There is no browser in this environment and no browser-automation harness in this repository, so
there is nothing to capture from. Adding Playwright plus a browser download was out of PR1 scope. The
UI is verified as far as this environment allows — it typechecks under `strict`, produces a
production bundle, and that bundle is served and driven end to end against a real PowerShell session
over the real runtime (snapshot event, cursor position, echoed output, clamped resize, clean close).
Interactive browser behaviour — actual painting, focus traversal, drag-to-resize — is **NOT TESTED**.

### What the real-runtime tests measured here

Windows 11 ARM64 build 26200, Snapdragon X Elite, Node v24.18.1 arm64, OS ConPTY provider:

| Measurement | Result |
| --- | --- |
| Default shell launched and a probe asserted as *output*, not as an echoed command line | Windows PowerShell, pass |
| 400-line flood through a 20-row viewport | 1 frame delivered to a slow consumer, **14 coalesced**, final screen byte-identical to the runtime's own observation |
| Scrollback recovered from that flood | **7 distinct lines, 0 duplicates** — ConPTY batched the flood into a few large screen jumps |
| 20 lines one at a time through an 8-row viewport (real console) | **6 recovered, 0 duplicates, in emission order** |
| 400 lines one at a time (runtime that changes one line per observation) | **380 recovered, 0 duplicates, in emission order** |
| 25 rapid writes to a streaming session | all landed, `writeErrors` 0, no `Stale observation` surfaced to the caller |
| Ctrl+C to a raw-mode child after an observed readiness marker | byte `0x03` received, child still running |
| Two sessions resized independently | each child confirmed its own geometry; the other pane unchanged |

The two scrollback rows are the same code on two different output profiles, and the difference is the
point: recovery is exact when the screen moves a line at a time and largely declines when a real
console jumps several rows between observations. Reporting only one of those numbers would be
misleading.

### Three bridge defects the real-runtime tests caught

Both were found by driving the real runtime, not the mock, and both are worth recording because they
are the kind of thing a snapshot-based design hides.

**1. A vacuous shift match swallowed the whole screen.** The recovery loop tried shifts `1..rows`.
At `shift === rows` there are zero rows left to compare, so the match succeeds for *any* pair of
screens and all `rows` lines of the previous screen get appended to history — on every frame. Against
the mock runtime a small shift always matched first, so the defect was invisible; against a real
console it fired on essentially every frame, because ConPTY delivers output in batches roughly a
second apart and the screen frequently advances by more than a full viewport between two
observations. When that happens no genuine shift relationship exists at all, so shifts `1..rows-1`
fail and the loop falls through to the vacuous one. Measured: an 8-row viewport grew history by
exactly 8 lines per command, with cumulative duplicates. Fixed by requiring at least two overlapping
rows (one on a viewport smaller than four) and at least one non-blank row among them, so a match has
to be evidence.

**2. Out-of-order observations rewound the revision.** The pump's `terminal.wait` and an explicit
`observe()` are separate RPCs correlated by id, so a response issued first can land second. Applying
the older screen moved the revision backwards and re-ran the shift match against a stale base,
recovering the same lines twice. Fixed by dropping any observation older than what has already been
applied. Caught by the U11 flood test and now pinned by a dedicated regression test.

**3. A parked waiter could swallow the frame it was waiting for.** This one took two passes to fix
properly. `next()` minted a fresh promise on every call and overwrote the subscriber's wake callback.
A consumer that races `next()` against a deadline — which is what any consumer with a timeout does —
leaves the losing promise registered as the wake callback. The next delivery then shifted a frame off
the queue into that already-abandoned promise, and the frame vanished without reaching anyone.

The first fix cleared the callback in `#deliver` before invoking it. That was necessary but **not
sufficient**: `next()` could still overwrite a live waiter, and a `next()` call that found the queue
non-empty returned without clearing a previously registered callback at all. The real fix is at the
API level — a subscriber parks **one shared waiter**, and a repeat `next()` returns the same promise.
An abandoned call therefore keeps ownership of its frame, and a consumer can time out and re-await
without losing output. `test/desktop-bridge.test.js` pins this, and the test was verified to fail
against the unfixed code rather than merely passing against the fixed one.

All three defects were found by driving the real runtime, or by driving the mock under a consumer
pattern the mock alone did not exercise. None were visible from reading the code.

### Three intermittent test failures, and the primitive that caused them

A first pass at this suite reported 108/108 from a single run. Re-running it showed that was **one
green run out of four** — three different tests failed across three runs. All three were the same
mistake in different clothes: *waiting for silence instead of waiting for a signal*.

On a real console output arrives in batches roughly a second apart, so any test that samples the
session, sees no change, and concludes the session has settled will be wrong often enough to be
worthless.

| Failure | Real cause | Fix |
| --- | --- | --- |
| `U11 … ordered, bounded and faithful` — `33 !== 34` on "the session must have stopped changing" | The test waited for the last *payload* line, but the fixture prints `BYTES-DONE` after the payload, so the revision moved once more | Wait for a terminator the child itself prints (`echo FLOOD-END` → `ECHO:FLOOD-END`), and compare frame to observation **at a matching revision** rather than asserting the revision stopped |
| `U03 panes resize independently` — failed after ~35 s | `terminal.resize` returns before ConPTY applies it (~170 ms), and the fixture reports `process.stdout.columns` only when asked, so a single `size` probe was answered with the pre-resize geometry and the screen never changed again | Re-probe: ask again until the child itself reports the new geometry |
| `frames arrive in strictly increasing revision order` — "only 2 of 3 frames arrived" | A test bug that also exposed a product bug. It wrote 12 lines, let them settle, then demanded 3 frames — but backpressure had legitimately coalesced the burst into fewer, and a quiet child produces no more, so the count could never be reached | Produce output *while* draining. The frame-loss defect (defect 3 above) was found in the same investigation and is now pinned by its own test |

Two rules came out of this and are now applied throughout the native suite:

1. **Wait for something the child signals**, never for the absence of change. The fixture's one-line
   `echo` reply and its `BYTES-DONE` terminator exist for exactly this.
2. **Compare a frame against an observation only at a matching revision.** `frameAtRevision()` drains
   until a frame carrying the observed revision arrives, which removes any assumption that output has
   stopped.

### Stability evidence

Eight consecutive runs on Windows 11 ARM64 build 26200, Node v24.18.1, after the fixes:

| Run | Tests | Pass | Fail | Time |
| --- | --- | --- | --- | --- |
| desktop suites in isolation #1 | 72 | 72 | 0 | 74.0 s |
| desktop suites in isolation #2 | 72 | 72 | 0 | 73.2 s |
| desktop suites in isolation #3 | 72 | 72 | 0 | 72.7 s |
| `npm test` #1 | 109 | 109 | 0 | 71.6 s |
| `npm test` #2 | 109 | 109 | 0 | 73.5 s |
| `npm test` #3 | 109 | 109 | 0 | 78.9 s |
| `npm test` #4 | 109 | 109 | 0 | 73.4 s |
| `npm test` #5 | 109 | 109 | 0 | 74.3 s |

109 = the 37 pre-existing runtime tests plus 72 desktop tests, 0 skipped. The two new CI jobs have
**never run on GitHub Actions** — this table is local evidence only and does not imply CI validation.

### Interaction tests in a real browser (E2E-01..07)

`npm --prefix apps/desktop run test:e2e` builds the UI, boots the real loopback IPC server with a
**scriptable fake runtime** standing in for a shell, and drives the built page in Chromium. The fake is
deliberate: the question is what the UI does with a session, not whether ConPTY works — that is
`test:native`'s job on the Windows cells.

| test | what it proves |
| --- | --- |
| E2E-01 | an unlaunched page makes **no API call at all**: the token gate is not a UI suggestion |
| E2E-02 | a fragment token opens the shell picker, with the detected shells selectable |
| E2E-03 | launching from onboarding opens a tab, the status bar reports the session state, and the onboarding dialog is gone |
| E2E-04 | a wrong token shows the refusal instead of falling through to a picker it cannot use |

It runs as its own `desktop-e2e` CI job on Ubuntu only: the behaviour under test is the UI's, and a
browser is the same everywhere. A failure uploads the Playwright traces and screenshots, because "it
failed on CI" without an artifact is not a bug report.

The token is delivered in the URL **fragment**, exactly as the real launcher does, so the tests walk
the bootstrap path a user walks rather than a test-only shortcut.
Two runtimes, on purpose. `E2E-01..04` drive the **scriptable fake** runtime: they are about the UI's own
behaviour (token gate, shell picker, tabs, status bar), and a failure there must not be caused by ConPTY.
`E2E-05..07` drive **`src/server.js` with actual shells**, which is what issue #19 asks for:

| test | what it proves |
| --- | --- |
| E2E-05 | typed characters reach a real child process and its output comes back — `echo SENTIORA_E2E_OK` is only visible if both halves worked |
| E2E-06 | a viewport change travels fit → bridge → runtime → the child's PTY size, and the status bar reports the new geometry |
| E2E-07 | `Alt+T` opens a second tab with its own session, and the new tab takes focus |

**Reading terminal text in a browser.** xterm paints into a canvas, so there is no DOM text to select.
The tests enable xterm's `screenReaderMode`, which the app now exposes as a **setting**
(`accessibility.screenReaderMode`, off by default because it costs a DOM row per line). That is a real
accessibility feature rather than a test-only hook: a screen-reader user turns it on for the same
reason the test does. Toggling it applies to panes opened afterwards, not to a live one.
### Scrollback recovery on a real console is partial, and that is expected

After those fixes the invariant that always holds is: **nothing is invented, nothing is recovered
twice, nothing arrives out of order.** All three are asserted against the real runtime. The *amount*
recovered is not asserted, because it depends on how ConPTY batches output: when more rows scroll
past between two observations than there is overlap left to verify, the heuristic declines rather
than guessing. A duplicated or fabricated history line would be a defect; an incomplete one is the
documented cost of *this bridge* consuming a rendered screen. The runtime now also exposes a byte
stream (`terminal.stream`, issue #27), from which nothing scrolls past unobserved within the ring's
bound; the bridge does not use it yet.

---

## 11. Known limitations

1. No colour in terminal output — a **bridge** limitation, not a protocol one. `terminal.stream`
   (issue #27) carries the child's original bytes with their SGR sequences intact; this bridge still
   consumes `terminal.observe`, which is text-only by design and pinned that way by test.
2. Scrollback is a best-effort reconstruction and on a real console it recovers very little: measured
   7 distinct lines from a 400-line flood and 6 from 20 line-at-a-time echoes through an 8-row
   viewport. It never invents, duplicates or reorders — but it is not a transcript, and the history
   panel says so.
3. No mouse reporting to the child.
4. Input latency is one RPC round trip per keystroke minimum.
5. Sessions survive a UI reload but not a bridge restart. Issue #7 is explicit that process
   resurrection is not promised.
6. Shortcut chords may be captured by a browser; every action also has a button.
7. Prompt patterns used to gate Ctrl+C are heuristics. A false negative is safe (the interrupt is
   refused); a false positive is not. PR3's shell integration should replace them.
8. Only one runtime handshake result is reported in the status bar even when several hosts are live.
