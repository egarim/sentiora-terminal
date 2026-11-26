# Telekinesis integration — contract

**Status: implemented on the Telekinesis side, open as
[telekinesis#70](https://github.com/egarim/telekinesis/pull/70).** This document was written as a
proposal; the adapter described here has since been built as `Telekinesis.Sentiora` and that PR
should be read as the authoritative implementation. **Sentiora itself still contains no
Telekinesis-specific code** and does not need any — the coupling is this JSON-RPC contract plus a
discovered executable, so Sentiora remains independently usable.

The contract was derived from the actual Telekinesis console tier on `origin/main` at `57bfa79` and
from measured Sentiora behaviour. Where telekinesis#70 diverges from or corrects this document, the
implementation wins; two such corrections are noted inline in §10 and §11.

Everything asserted about Sentiora below is backed by
[`../validation/windows-native-validation.md`](../validation/windows-native-validation.md) or
[`../validation/conpty-provider-comparison.md`](../validation/conpty-provider-comparison.md).
Where a claim comes from reading source rather than from an experiment, it says so.

## 1. Why an adapter, and why out of process

Telekinesis already has a console tier: `IConsoleSession` plus the `console_*` MCP tools, backed
by `UnixPtyConsoleSession` on Linux/macOS and `ConPtyConsoleSession` on Windows. The Windows
backend is **off by default** behind `TELEKINESIS_CONPTY=1` because of
[telekinesis#49](https://github.com/egarim/telekinesis/issues/49): on Windows 11 ARM64 build
26200 the child never binds to the pseudoconsole and renders to the *parent* console instead,
which corrupts the MCP stdio stream.

Sentiora was tested against exactly that failure mode on exactly that OS build and architecture,
and **does not reproduce it**:

| #49 symptom | Sentiora, measured |
| --- | --- |
| child never binds to the pseudoconsole | child reports `isTTY` **true** on stdin and stdout (WIN-01) |
| child produces zero bytes into the pipe | real PowerShell and cmd.exe produce output, including stateful interactive sessions (WIN-02, WIN-03) |
| child renders to the parent console | a child deliberately printing a forged JSON-RPC response and hostile binary puts **zero** bytes on the host's stdout (WIN-15) |

So an out-of-process Sentiora backend would give Telekinesis a working Windows console tier
without waiting on #49, and — because it is a separate process with its own stdio — a child that
misbehaves cannot corrupt Telekinesis's MCP stream. That isolation is measured, not assumed.

**The existing Telekinesis backend is not replaced.** Per #67, both must coexist so they can be
compared experimentally. The adapter is opt-in, selected the same way as the existing Windows
gate.

## 2. Surface being mapped

Telekinesis (`src/Telekinesis.Abstractions/ConsoleSession.cs`, `docs/CONSOLE.md`):

```csharp
public interface IConsoleSession : IDisposable
{
    string Shell { get; }
    bool IsAlive { get; }
    void Write(string text);     // "\r" for Enter, "\x03" for Ctrl-C
    void Resize(int cols, int rows);
}
```

Tools: `console_open`, `console_write`, `console_read`, `console_resize`, `console_close`,
`console_list`. Session ids are `con1`, `con2`, …; `console_resize` clamps cols/rows to 2–1000.

Sentiora: newline-delimited JSON-RPC 2.0 over stdio — `initialize`, `terminal.create`,
`terminal.list`, `terminal.observe`, `terminal.stream`, `terminal.recording`, `terminal.type`,
`terminal.key`, `terminal.wait`, `terminal.resize`, `terminal.close`.

The Telekinesis console surface maps onto the snapshot methods only. `terminal.stream` and
`terminal.recording` (issue #27) have no Telekinesis counterpart and this adapter does not need them;
they are documented in [streaming and recording](../streaming-and-recording.md). An adapter that did
want colour-preserving output would use `terminal.stream` in place of the `terminal.wait` polling loop
described in §4.

## 3. Operation mapping

| Telekinesis | Sentiora | Notes |
| --- | --- | --- |
| `console_open(shell, cols, rows)` | `terminal.create {command, args, cols, rows}` | Sentiora splits command and argv; Telekinesis takes one `shell` string. The adapter must split it, or pass `cmd.exe /c <shell>`. |
| `console_write(sessionId, text, sendEnter)` | `terminal.type {sessionId, owner, revision, text}` | Append `\r` when `sendEnter`. **Requires a fresh `revision`** — see §5. |
| `console_read(sessionId, lines)` | `terminal.observe {sessionId}` → `screen` | Both are rendered-screen snapshots, so this maps cleanly. `lines` must be applied adapter-side. |
| `console_resize(sessionId, cols, rows)` | `terminal.resize {sessionId, owner, cols, rows}` | **Range mismatch** — see §7. |
| `console_close(sessionId)` | `terminal.close {sessionId, owner}` | Requires the owner token. |
| `console_list()` | `terminal.list {}` | Returns full observations, not summaries. |
| `IConsoleSession.IsAlive` | `observe().running`, or `state` | `state` distinguishes `exited` from `released`, which `running` alone does not. |
| `IConsoleSession.Shell` | *(not exposed)* | Sentiora does not echo the command back. The adapter must remember what it asked for. |
| raw-output callback (constructor) | `terminal.stream {sessionId, afterSequence}` | **Poll, not push** — the bytes are available (issue #27) but the adapter must run a loop per session; see §4. |
| Ctrl-C | `terminal.key {key:"CtrlC"}` or `terminal.type {text:"\x03"}` | Same byte; mode-dependent outcome — see §6. |

`terminal.create` returns `{sessionId, owner, pid, state, revision, running, exit, cols, rows,
cursor, screen, writeErrors, renderErrors, idleMilliseconds}`.

The `owner` token travels **only** in that create response — `terminal.list` and
`terminal.observe` deliberately omit it — so an adapter must persist it the moment it arrives and
cannot recover it later. Correspondingly, the runtime registers a session only once its create
response has been accepted by the transport: a create whose response could not be delivered is
rolled back and its child killed, rather than leaving a session nobody can close. An adapter that
loses the response therefore has no orphan to clean up, but it also has no session — it must issue
a fresh `terminal.create` rather than retry `terminal.observe` against an id it never received.

The same rule has a consequence for pipelining: because registration waits on delivery
confirmation, a `terminal.list` written in the same batch *behind* a `terminal.create` can be
answered before that create is registered, and will not include it. A caller that needs to see a
session it just created must wait for the create response instead of pipelining a list behind it.
The session id and owner token are in that response, so there is normally no reason to list.

`terminal.close` **always answers `true`** once the session is deregistered, even if teardown
itself failed: `Session.close()` absorbs a `kill()` that throws, a write chain that rejects or
never settles (bounded at 2s), and an emulator that refuses to dispose. A teardown failure
previously surfaced as a `-32000` error, so an adapter that mapped a close error to "session
still alive" will now never see one. That is deliberate — the session is gone from the registry
either way, and reporting failure invited callers to retry a close against an id the runtime no
longer knows. A failed teardown is reported on the runtime's **stderr** as
`sentiora: cleanup failed for session <id>: <reason>`. An adapter that must know whether the
child actually died has to watch stderr or check the pid itself; the close result no longer
carries that distinction.

## 4. The mapping that used not to work: push vs pull

`IConsoleSession` implementations **push raw output bytes** to a callback from a background reader.
Sentiora still has no push channel — it never emits unsolicited lines on stdout, because WIN-15 pins
that a child must never be able to put a line on the RPC channel. That half is unchanged, and an
adapter still has to poll.

What *has* changed (issue #27) is the other half of the old claim. The runtime now exposes the raw
bytes: `terminal.stream {sessionId, afterSequence, timeoutMs}` returns the child's original output
chunks, base64-encoded, each with a monotonic sequence number, from a bounded server-side ring.
Colour, byte-level framing and escape sequences that produced no visible change are all preserved,
because nothing is re-rendered — it is the original stream.

Consequences for an adapter:

- A faithful raw-byte stream **can** now be reconstructed: poll `terminal.stream`, concatenate the
  `output` events in sequence order. Delivery granularity is the poll timeout, not the child's write
  boundaries.
- The stream is **live from the point of attach**. A cursor of 0 returns a snapshot of the current
  screen and *no* events, and resumes from there; it does not replay history, because the snapshot
  already accounts for it and returning both would make a consumer apply that output twice. If the
  cursor falls behind the ring the response sets `resync: true` with a fresh snapshot — treat that as
  a re-attach, not a continuation, and do not assume the missed bytes are recoverable from the stream.
- History is a different call: `terminal.recording {sessionId, owner}`, owner-gated and replayable.
  See [streaming and recording](../streaming-and-recording.md).
- Screen-diffing `terminal.observe` is still available and still lossy in exactly the ways it always
  was: it cannot recover scrollback that left the viewport, byte-level framing, or colour.
- **Recommendation:** an adapter that needs Telekinesis's raw-output callback should drive it from
  `terminal.stream` rather than from screen diffs. One that only needs `console_read` semantics can
  keep using `terminal.observe`, which is unchanged.

## 5. Revision and ownership: the adapter's job, not the caller's

Sentiora rejects a write whose `revision` does not match the current one (`Stale observation`) or
whose `owner` does not match (`Input ownership required`). Telekinesis's `Write(text)` has neither
concept. The adapter must own both:

- Hold the `owner` token from `terminal.create` for the session's lifetime. It is a bearer
  credential: anyone holding it can type into that session. Keep it out of logs.
- Before each write, `terminal.observe` for a fresh `revision`, then retry on `Stale observation`.
  Measured: two of the first server-level test runs failed with `Stale observation` before a retry
  loop was added, so this is not theoretical.
- `input()` **bumps the revision itself**, so a subsequent `terminal.wait` must be armed with the
  revision returned by the *write*, not the one read before it. Waiting on the pre-write revision
  returns immediately, before the child has replied.

Because the adapter is the single owner, Telekinesis-level concurrency must serialise writes per
session; Sentiora will not arbitrate between two Telekinesis callers.

## 6. Cancellation, waiting and Ctrl+C

**Waiting for an observable condition** is `observe` → `wait(afterRevision, timeoutMs)` → re-check.
`timeoutMs` is clamped to 30000 ms server-side. Readiness must be an observable condition such as
a prompt string on screen — **not a sleep**, and not the `spawned` state, which only means a
process exists.

**Cancellation has no protocol primitive.** There is no request-id cancellation, so an in-flight
`terminal.wait` cannot be aborted; it completes or times out. An adapter that needs responsive
cancellation must use short timeouts (≈250 ms) and poll, accepting that cancellation granularity
equals the timeout.

**Ctrl+C is three different things**, depending on the child's console mode when byte `0x03`
arrives — all measured:

| Child state | Outcome |
| --- | --- |
| raw mode enabled | delivered as data byte `0x03`; the child keeps running |
| cooked mode with a `SIGINT` handler | real `CTRL_C_EVENT` → handler runs → exit code 130 |
| cooked mode, no handler | the console terminates it → `-1073741510` = `0xC000013A` `STATUS_CONTROL_C_EXIT` |

The third row is a trap: `terminal.create` returns **before** the child has configured its console
mode, so Ctrl+C sent too early kills the process instead of interrupting it. Telekinesis's docs
already say to send `"\x03"` for Ctrl-C; the adapter must additionally wait for an observable
readiness marker before allowing it, or document that an early Ctrl+C is fatal.

Ctrl+C is delivered to the targeted session only: a concurrent session was verified to keep
running and keep answering input (WIN-17).

**Exit detection is not instant.** Between a child dying and `running:false` becoming observable,
20 cancellations measured a median of **1025 ms** (min 1014, max 1038), consistent with node-pty's
1000 ms flush interval. Telekinesis must not treat `IsAlive` as immediate.

## 7. Compatibility constraints, with numbers

These are hard limits measured on Windows ARM64; an adapter must be designed around them.

| Constraint | Value | Consequence |
| --- | --- | --- |
| Concurrent session cap | **16** per host (`Session limit` error) | `console_open` must fail cleanly past 16, or the adapter must pool multiple Sentiora hosts |
| Session ceiling per host process | **~495 create/close cycles**, then `Invalid pty handle`; degradation observed from ~363 | The adapter must **recycle the Sentiora host process** on a session counter. Do not treat a Sentiora host as immortal. |
| Leaked descriptors | **1 fd and ~1.75 Win32 handles per session**, never reclaimed | The mechanism behind the ceiling above |
| Dimension range | cols **2–300**, rows **2–150** | **Telekinesis clamps to 2–1000.** A `console_resize` to 500 cols would be rejected as `Invalid dimensions`. The adapter must clamp to Sentiora's range and report the applied size. |
| Input size | ≤ 65536 characters per `terminal.type` | Large pastes must be chunked, and chunking interacts with coalescing (§8) |
| `close()` latency | median **9 ms** | Cheap; safe to close eagerly |
| Host shutdown | ~**5.1 s** after stdin closes, with active sessions reaped and exit code 0 | Shutdown must allow ≥6 s before force-killing |
| Resize propagation | child sees the new geometry ~**170 ms** later | Do not assert on child-side size immediately after resize |
| Startup to first output | median **91 ms**, p95 103 ms (100 sessions) | Fast enough that a readiness poll, not a sleep, is the right pattern |

## 8. Input framing

Do not assume one `console_write` equals one child input event. Measured: consecutive writes can be
**coalesced** into a single chunk by ConPTY (Escape followed by Backspace arrived as one `1b7f`),
and a single large write can be **split**. An adapter that maps Telekinesis writes to expected
child-side events must compare the ordered byte stream, not count writes.

## 9. Runtime discovery, startup and shutdown

Proposed, all adapter-side:

1. **Discovery.** Resolve the runtime from `SENTIORA_TERMINAL_CMD` (an explicit command line), else
   `sentiora-terminal` on `PATH`, else a configured absolute path to `src/server.js` plus a Node
   executable. Fail with a clear error rather than silently falling back to the native backend —
   #67 requires both to be comparable, so which one is active must be unambiguous.
2. **Startup.** Spawn the runtime with **piped** stdio and no shared console. Then handshake:

   ```json
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
   {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"platform":"win32","arch":"arm64","conptyDll":false}}
   ```

   Verify `protocolVersion` before use. `platform`, `arch` and `conptyDll` should be recorded in
   the startup log so a run is attributable to a specific configuration.
3. **Transport.** Newline-delimited JSON-RPC 2.0. Read stdout **line by line** and parse every
   line. This was adversarially verified: a child printing a byte-perfect forged JSON-RPC response
   plus hostile binary (embedded newlines, braces, `ESC`, `0x7f`, invalid UTF-8) produced **zero**
   non-conforming lines on the host's stdout (WIN-15). The adapter should still treat a
   non-parsing line as a fatal transport error rather than skipping it silently.
4. **Shutdown.** Close the runtime's stdin. The server reaps all sessions and exits — measured at
   5079 ms with 5 active sessions, exit code 0, no surviving children. Allow ≥6 s, then
   force-kill the process tree.
5. **Crash handling.** If the runtime dies, every session id becomes invalid. Surface
   `Unknown session` as "backend lost" and re-create sessions rather than retrying blindly.

## 10. Error mapping

Sentiora reports errors as JSON-RPC `error` with `code: -32000` and a message. Proposed mapping:

| Sentiora message | Meaning | Telekinesis mapping |
| --- | --- | --- |
| `Stale observation` | revision mismatch | retry with a fresh observation (bounded) |
| `Input ownership required` | wrong owner token on `terminal.type` / `terminal.key` | programming error — fail loudly |
| `Ownership required` | wrong owner token on `terminal.close` — **a different string for the same failure**, thrown at `src/server.js`'s close branch rather than in `Session.input` | map to the same case as `Input ownership required` |
| `Session not running` | child exited or session closed | `IsAlive == false`; stop writing |
| `Unknown session` | bad id, or backend restarted | backend-lost path (§9.5) |
| `Unknown key` | key name not in the map | argument error |
| `Invalid dimensions` | outside cols 2–300 / rows 2–150 | clamp instead (§7) |
| `Invalid command` | empty/non-string command or non-string argv | argument error |
| `Invalid conptyDll` | provider flag not boolean | argument error |
| `Resize denied` | wrong owner, or session closed/exited | as above |
| `Session limit` | 16 concurrent sessions | backpressure or pool hosts |
| `Invalid wait` | bad `afterRevision`/`timeoutMs` | argument error |

The message strings are the only machine-readable discriminator today, since every error shares
code `-32000`. That is brittle. **Recommendation:** add distinct JSON-RPC error codes before an
adapter depends on them.

## 11. Security and secret-handling audit (required by #67)

Three findings, all from reading `src/server.js` and from measurement:

1. **Environment inheritance is now scoped (issue #26).** The server used to spawn children with
   `env: process.env`, so **every child inherited the Sentiora host's full environment**, including
   any credential in it, and the protocol offered no way to narrow it. It no longer does:
   `terminal.create` accepts an optional `env` object of string values, and the default is a small
   fixed allowlist rather than the host environment — `PATH`, `HOME`/`USERPROFILE`, `TERM`, `LANG`
   and the temp/locale variables, plus on Windows the essentials without which a session spawns and
   then cannot run anything (`SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `PATHEXT`, `TEMP`,
   `TMP`, `HOMEDRIVE`, `HOMEPATH`, `USERNAME`). Nothing else is inherited unless the caller names
   it. Windows names are matched case-insensitively, so a caller's `Path` and an inherited `PATH`
   collapse to one variable rather than being emitted twice. An `env` that is not an object of
   strings is rejected as `Invalid env`, and **the error never quotes a value or a name** — an
   error that echoed the offending entry would leak the secret it was rejecting into a JSON-RPC
   response and every log downstream of it. An adapter that needs a variable in a session must pass
   it explicitly; it can no longer rely on the host's environment reaching the child, and an
   adapter that *was* relying on that will see sessions lose those variables.
2. **Observations are unredacted, and typed input is audit-logged verbatim.** `screen` is
   returned verbatim, so a child that echoes a password, token or API key puts it into an
   observation. Checked against `ConsoleTools.cs` at telekinesis `57bfa79`: `AuditLog.Append` is
   called for `console_open` (the shell command line), `console_write` (**the verbatim text
   typed**), `console_resize` and `console_close` — but **not** for `console_read`. So the sharper
   leakage path is not screen capture but write logging: an agent that types a password into a
   prompt has it recorded verbatim in the audit log, and a `console_open` command line carrying an
   inline secret is recorded too. Redaction must live in the adapter or in Telekinesis's logging
   layer; Sentiora does none.
   *(An earlier revision of this document claimed `console_read` results were audit-logged. That
   was wrong and is corrected here — `console_read` is not a mutating call and is not audited.)*
3. **The owner token is a bearer credential.** It is returned by `terminal.create` and is the only
   thing standing between a caller and typing into that session. It must not be logged, and it
   should not cross a trust boundary — which is another reason the adapter, not Telekinesis
   callers, should hold it.

Also relevant: Sentiora's own README states that terminal output is **untrusted data, not
instructions**. An adapter must not let screen content be interpreted as commands, which matters
because Telekinesis feeds screens to a model.

## 12. Proposed shape

Smallest contract that satisfies #67 — an opt-in backend behind the existing
`TelekinesisConsoleSession` abstraction, no change to the public console API:

```csharp
// PROPOSED — not implemented.
internal sealed class SentioraConsoleSession : IConsoleSession
{
    // One shared host per backend instance; sessions multiplex over one stdio pipe.
    // Recycled after N create/close cycles because the host leaks one fd per session
    // and stops accepting new ones at roughly 500 (see §7).
    public string Shell { get; }          // remembered locally; Sentiora does not echo it
    public bool IsAlive => _state is "spawned" or "operational";
    public void Write(string text);       // observe -> type -> retry on "Stale observation"
    public void Resize(int cols, int rows); // clamped to 2..300 / 2..150
    public void Dispose();                // terminal.close with the owner token
}
```

Deliberately excluded from the smallest contract: the raw-output callback (§4 — reachable via
`terminal.stream` since issue #27, but not needed for `console_read` semantics), a Sentiora-side
redaction policy (§11), and host pooling past the 16-session cap (§7). Each is a separate decision.

## 13. What must be true before this is built

- [x] Confirm `macos-latest` and `windows-11-arm` CI results for the current Sentiora commit —
      **done**, run [`45479968125`](https://github.com/egarim/sentiora-terminal/actions/runs/45479968125):
      all 8 matrix jobs green (ubuntu, windows x64, windows ARM64, macOS ARM64 × Node 22 and 24).
      #67's precondition "only after native CI is verified" is satisfied.
      *Now historical:* the matrix has since grown to 17 jobs, adding Linux ARM64 and a Debian
      container — see [Linux containers](../validation/linux-containers.md) for current counts.
- [ ] Decide whether the adapter should drive Telekinesis's raw-output callback from
      `terminal.stream` (§4). No longer a semantic mismatch — the bytes are available as of issue #27
      — but still a design choice: it means one polling loop per session instead of screen diffs.
- [ ] Decide where redaction lives (§11.2).
- [ ] Confirm the 16-session cap and the ~495-session ceiling are acceptable, or add host pooling
      and recycling.
- [ ] Add distinct JSON-RPC error codes (§10) so mapping is not string matching.
- [ ] Re-test [telekinesis#49](https://github.com/egarim/telekinesis/issues/49) against
      node-pty's ConPTY sequence as a working reference on the same OS build. node-pty drains the
      conout pipe on a **separate thread** specifically to avoid `ClosePseudoConsole` deadlocks,
      and #49 notes this build EOFs the output pipe if the parent closes its output-write copy —
      both are concrete leads. This is independent of whether the adapter is ever built.

## 14. Licensing and dependency boundaries

Sentiora is a separate repository and a separate process. An adapter creates **no build-time
dependency** from Telekinesis on Sentiora: the coupling is a JSON-RPC contract over stdio plus a
discovered executable. Telekinesis must keep working with Sentiora entirely absent, which is what
makes the two backends comparable as #67 requires.

Sentiora likewise gains no dependency on Telekinesis. Both remain independently usable, and
neither requires Vivarium, Creatura or Custodia at runtime.
