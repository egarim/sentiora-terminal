# ConPTY provider comparison and Windows stabilization

Follow-up to [`windows-native-validation.md`](windows-native-validation.md), which established
that Sentiora works on Windows through native ConPTY and fixed the session-teardown hang. This
document covers the three experiments run afterwards: the alternative ConPTY provider
(A), terminal lifecycle semantics (B) and long-running reliability (C).

Method: **Hypothesis → Experiment → Evidence → Architectural decision.** Negative results are
recorded with the same detail as positive ones, and every measurement names the command that
produced it.

## 1. Environment

| Item | Value |
| --- | --- |
| Machine | Surface, Snapdragon(R) X 12-core X1E80100 @ 3.40 GHz, ARM64 |
| OS | Microsoft Windows 11 Pro, build 26200 (10.0.26200.9974) |
| Memory | 33,888,956,416 bytes (~31.6 GiB) |
| Node.js (primary) | v24.18.1, arm64, ABI 137 |
| Node.js (compatibility) | v22.23.5, arm64, ABI 127 — portable build from nodejs.org |
| npm | 11.16.0 |
| PowerShell | 5.1.26100.9974 (Desktop). No `pwsh`. |
| Native build tools | None (no `cl.exe`, `msbuild`, `ninja`, `cmake`) |
| node-pty | 1.1.0 (N-API) |
| @xterm/headless | 5.5.0 |
| Base commit | `3640695e4b67592242d1a4fde7597fdbcb6b9e2e` (`main`, after PR #6) |
| Branch | `chore/windows-stabilization` |

`scripts/report-native-arch.mjs` reads each native binary's container header (PE COFF `Machine`,
Mach-O `cputype`, ELF `e_machine`) and fails the build on any mismatch with the runtime. On this
machine it reports all 9 node-pty binaries as `arm64` against an `arm64` runtime, so **no
component is running under x64 emulation**:

```
runtime: node v24.18.1 arch=arm64 platform=win32 abi=137
node-pty: 1.1.0
  build\Release\conpty\conpty.dll: arm64
  build\Release\conpty\OpenConsole.exe: arm64
  prebuilds\win32-arm64\conpty.node: arm64
  prebuilds\win32-arm64\conpty_console_list.node: arm64
  prebuilds\win32-arm64\pty.node: arm64
  prebuilds\win32-arm64\winpty-agent.exe: arm64
  prebuilds\win32-arm64\winpty.dll: arm64
  prebuilds\win32-arm64\conpty\conpty.dll: arm64
  prebuilds\win32-arm64\conpty\OpenConsole.exe: arm64
native architecture check: OK (9 binaries, all consistent with arm64)
```

## 2. Experiment A — alternative ConPTY implementation

### 2.1 Hypotheses

node-pty exposes `useConptyDll`. The default (`false`) uses the **OS** ConPTY exported from
`kernel32.dll`; `true` loads node-pty's **bundled** `conpty.dll` and its own `OpenConsole.exe`.
Reading `windowsPtyAgent.js` and `src/win/conpty.cc` produced four testable hypotheses:

| # | Hypothesis | Basis |
| --- | --- | --- |
| H1 | `useConptyDll:true` removes the ~5000 ms shutdown tail | that tail comes from `_getConsoleProcessList()`, which the DLL branch of `kill()` never calls |
| H2 | `useConptyDll:true` removes the 1 fd/session leak | the DLL branch calls `_inSocket.destroy()`; the OS branch only sets `readable = false` |
| H3 | `useConptyDll:true` removes the `conpty_console_list_agent` fork and its stderr noise | same branch difference |
| H4 | `useConptyDll:true` is safe to adopt | **the null hypothesis — expected to fail**, because the DLL branch defers `_conoutSocketWorker.dispose()` to a future `_outSocket.on('data')` event |

The relevant source, verbatim:

```js
// node-pty/lib/windowsPtyAgent.js — kill()
if (!this._useConptyDll) {
  this._inSocket.readable = false;
  this._outSocket.readable = false;
  this._getConsoleProcessList().then(...);   // forks a helper; 5000 ms timeout
  this._ptyNative.kill(this._pty, this._useConptyDll);
  this._conoutSocketWorker.dispose();        // disposes the worker unconditionally
} else {
  this._inSocket.destroy();                  // <- closes the leaked fd
  this._ptyNative.kill(this._pty, this._useConptyDll);
  this._outSocket.on('data', () => { this._conoutSocketWorker.dispose(); });  // <- only if more data arrives
}
```

```js
// node-pty/lib/windowsPtyAgent.js — _$onProcessExit()
this._exitCode = exitCode;
if (!this._useConptyDll) { this._flushDataAndCleanUp(); ... }   // DLL path: no exit-time cleanup at all
```

```cpp
// node-pty/src/win/conpty.cc — PtyKill()
if (useConptyDll) { TerminateProcess(handle->hShell, 1); }
```

### 2.2 Methodology

`test/bench/conpty-provider-bench.mjs <os|dll> [trials] [guardMs]`, one **separate process per
configuration** so a hang in one cannot mask the other. 30 trials each, as required.

Measurement rules, all inherited from lessons in the previous validation:

- watchdog timers are `unref()`'d, so survival past the deadline can only be caused by the pty;
- **no `conhost.exe` counting** — a console-less runner is handed a transient conhost for every
  subprocess it spawns, so that metric measures the harness (see
  `windows-native-validation.md` §5.9 for the measurements that proved this);
- child cleanup is verified by **exact pid** in one batched `tasklist` call;
- Win32 handle/thread counts come from `Get-Process` at phase boundaries only, never per trial;
- readiness is an **observable terminal condition** (the fixture's banner rendered in the
  emulator), never a sleep.

Reproduction:

```bash
npm ci
node scripts/report-native-arch.mjs
node test/bench/conpty-provider-bench.mjs os  30 90000
node test/bench/conpty-provider-bench.mjs dll 30 90000
node test/fixtures/conpty-dll-probe.mjs os      # single-session detail, exits 0 when it drains
node test/fixtures/conpty-dll-probe.mjs dll     # exits 98 when it does not
```

### 2.3 Raw measurements — 30 trials per configuration

| Metric | OS ConPTY (`useConptyDll:false`) | Bundled DLL (`useConptyDll:true`) |
| --- | --- | --- |
| spawn errors | 0 | 0 |
| interactive round trips OK | 30 / 30 | 30 / 30 |
| startup ms — min / median / p95 / max | 130 / **147** / 159 / 161 | 137 / **169** / 193 / 205 |
| round trip ms — min / median / p95 / max | 16 / **31** / 32 / 32 | 1 / **16** / 16 / 16 |
| `close()` ms — min / median / p95 / max | 7 / **9** / 10 / 13 | 0 / **0** / 1 / 1 |
| libuv `Socket` handles, baseline → final | 1 → **32** (+29) | 1 → **2** (+1) |
| libuv `MessagePort` handles, peak → final | 6 → **0** | 30 → **30** |
| Win32 handles, baseline → peak → final | 188 → 268 → **228** | 188 → 438 → **438** |
| Win32 threads, baseline → peak → final | 13 → 19 → **14** | 13 → 44 → **44** |
| rss MB, baseline → peak → final | 56.3 → 136.9 → **63.8** | 56.2 → 299.7 → **250.8** |
| children surviving close | 0 / 30 | 0 / 30 |
| **time to natural process exit** | **17375 ms, exit code 0** | **never — guard fired at 107312 ms, exit code 99** |

`MessagePort` growth on the DLL path was exactly linear, one per session:
`1, 6, 11, 16, 21, 26, 30` sampled at trials 0, 5, 10, 15, 20, 25, 29.

Single-session detail from `conpty-dll-probe.mjs`, which also confirms the bundled **ARM64**
`conpty.dll` and `OpenConsole.exe` genuinely load and drive a session on this architecture:

```
dll: spawned {arch:"arm64", pid:34624}  ready {ok:true, state:"operational", ms:182}
     roundTrip {echoed:true}  closed {state:"released", messagePorts:1}
     didNotDrain {messagePorts:1, ms:12215}  exit code 98
os : spawned {arch:"arm64", pid:42268}  ready {ok:true, state:"operational", ms:167}
     roundTrip {echoed:true}  closed {state:"released", messagePorts:1}
     exit code 0 at 5198 ms
```

### 2.4 Hypothesis verdicts

| # | Verdict | Evidence |
| --- | --- | --- |
| H1 — removes the ~5 s tail | **CONFIRMED** | `close()` median 0 ms vs 9 ms; no `Pipe`/`ChildProcess` handles appear, so no helper is forked; no `AttachConsole failed` stderr noise |
| H2 — removes the 1 fd/session leak | **CONFIRMED** | `Socket` stays flat at 3 across 30 trials (OS path: 3 → 32) |
| H3 — removes the `conpty_console_list_agent` dependency | **CONFIRMED** | that call exists only in the `!useConptyDll` branch |
| H4 — safe to adopt | **REFUTED, decisively** | `MessagePort` 1 → 30 and never released; threads 13 → 44; Win32 handles 188 → 438; rss 56 → 250 MB unreclaimed; **the host process never exits** |

### 2.5 Architectural decision

**Keep OS ConPTY (`useConptyDll:false`) as the default. Do not switch.**

The DLL path trades a *bounded, small* defect for an *unbounded, fatal* one:

| | OS ConPTY | Bundled DLL |
| --- | --- | --- |
| leak per session | 1 file descriptor | 1 worker thread + 1 MessagePort + ~8 Win32 handles + ~6.5 MB |
| host can exit | yes (~5 s tail) | **no — never** |
| startup | faster (147 ms) | slower (169 ms) |
| round trip | slower (31 ms) | faster (16 ms) |

The DLL path's faster round trip and instant `close()` are real but irrelevant: a runtime that
cannot shut down is not usable for an agent host. The OS path's ~5 s tail delays only *final
process exit* — `terminal.close` replies immediately, measured at 9 ms median.

Because the differences are meaningful in both directions, the provider is **exposed as a
documented runtime option** rather than removed, so the comparison stays reproducible:

- `terminal.create` accepts `"conptyDll": true|false` (default `false`);
- the default can be set for the whole host with `SENTIORA_CONPTY_DLL=1`;
- `initialize` reports the effective default, so a client can discover it;
- a non-boolean value is rejected with `Invalid conptyDll`.

This uses only node-pty's **public** `IPtySpawnOptions.useConptyDll`. No private API is involved
in the provider switch.

One further difference, read from source and **not** measured: on the DLL path `PtyKill` calls
`TerminateProcess(handle->hShell, 1)`, so a killed child reports exit code 1 rather than a
termination status derived from the console. Any caller comparing exit codes across providers
must account for this.

### 2.6 Re-evaluation on node-pty 1.2.0-beta.18 — the ranking inverts

The §2.5 decision is correct **for node-pty 1.1.0**, which is what this project ships. It was
re-tested against `1.2.0-beta.18` (the `beta` dist-tag; `latest` is still 1.1.0) because every
defect found here is already reported upstream (§5.3), which makes "is it fixed in a newer
release?" the actionable question. Same machine, same harness, 30 trials per provider.

| Metric | 1.1.0 OS | 1.1.0 DLL | **beta.18 OS** | **beta.18 DLL** |
| --- | --- | --- | --- | --- |
| startup median | 147 ms | 169 ms | 147 ms | 171 ms |
| round trip median | 31 ms | 16 ms | 31 ms | **15 ms** |
| `close()` median | 9 ms | 0 ms | 10 ms | **1 ms** |
| libuv `Socket`, final | 32 | **2** | 32 | **2** |
| Win32 handles, final | 228 | 438 | 228 | **198** |
| Win32 threads, final | 14 | 44 | 14 | **14** |
| rss final | 63.8 MB | 250.8 MB | 62.9 MB | **62.6 MB** |
| children surviving | 0/30 | 0/30 | 0/30 | 0/30 |
| natural process exit | 17.4 s, code 0 | **never (code 99)** | 17.4 s, code 0 | **17.5 s, code 0** |

**beta.18 fixes the defect that made the DLL provider unusable.** The single-session probe that
reported `didNotDrain` / exit 98 on 1.1.0 now reports `exit {code: 0, ms: 1219}` — the conout
worker is disposed. With that gone, the DLL path is better on every resource metric: no fd leak
(`Socket` 2 vs 32), a quarter of the Win32 handle growth (+10 vs +40), no thread growth, memory
fully reclaimed, `close()` at 1 ms and a round trip twice as fast. The only cost is ~24 ms of
extra startup.

beta.18 also fixes, on **both** providers:

- the ~500-session ceiling — **1200/1200 create/close cycles with zero failures** versus 1.1.0
  failing at 495 (`g_ptyHandlesMutex` now guards the table that 1.1.0 mutates from two threads);
- the ~5 s shutdown tail — **1 ms** measured after the last `kill()`;
- the stderr noise — **0 bytes**, versus ~49 `AttachConsole failed` stack traces per 50 sessions;
- and the macOS `spawn-helper` packaging defect (§7.2), published as mode 755.

The fd leak on the **OS** path is *not* fixed: still exactly one `Socket` per session
(1201 after 1200 cycles).

**But beta.18 introduces a breaking change.** `pty.pid` is `0` for roughly 500 ms after spawn,
because the pty connection is deferred until the conout worker is ready:

```
pid immediately after spawn : 0     (typeof number)
pid after 500ms             : 35664
```

`Session` captured the pid once in its constructor, so it stored `0` for the session's whole life.
Running the suite against beta.18 gave **33/37**, with all four failures tracing to that one
change. `Session.pid` is now a **lazy getter** (`this.pty?.pid || null`), which is correct on both
versions and takes beta.18 to **35/37**.

The two remaining beta.18 failures are expectations that encode 1.1.0 behaviour, not defects:

| Test | beta.18 behaviour | Status |
| --- | --- | --- |
| provider comparison asserts the DLL path never drains | it now drains, exit 0 at 1219 ms | assertion is 1.1.0-specific by design |
| protocol test asserts `terminal.create` returns a pid | returns `null`; the pid appears on a later `terminal.observe` | **protocol-visible consequence** of the deferred connection |

The second one matters for consumers: on beta.18, `terminal.create` **cannot** return a pid, so
`pid` must be read from a subsequent observation. Any integration that treats the create result's
`pid` as authoritative — including the Telekinesis adapter in
[`../integrations/telekinesis.md`](../integrations/telekinesis.md) — would need to poll.

**Decision: stay on 1.1.0.** The dependency is unchanged; `Session.pid` is now lazy purely so the
codebase is forward-compatible. Upgrading to a beta is not warranted while 1.1.0 is the `latest`
dist-tag, and the DLL-provider default should **not** be flipped on 1.1.0, where it hangs. When
1.2.0 reaches `latest`, the provider decision should be reopened with the numbers above — on that
release the evidence favours `useConptyDll: true`, which is the opposite of the 1.1.0 conclusion.

Reproduce with:

```bash
npm install node-pty@1.2.0-beta.18            # in a scratch project, not this repo
node test/bench/conpty-provider-bench.mjs os  30 90000
node test/bench/conpty-provider-bench.mjs dll 30 90000
node test/bench/fd-exhaustion.mjs 1200        # 1200/1200 on beta.18; fails at 495 on 1.1.0
node test/fixtures/conpty-dll-probe.mjs dll   # exit 0 on beta.18; exit 98 (didNotDrain) on 1.1.0
```

A measurement caveat worth recording: the first beta.18 benchmark run reported
`aliveImmediatelyAfterClose: 30` — apparently every child orphaned. That was **false**, and the
bug was in the bench: it captured `child.pid` at spawn, which is `0` on beta.18, and **PID 0 is the
System Idle Process**, always present in `tasklist`. Every child "matched". The bench now records
the pid from the post-readiness observation and rejects non-positive pids outright; the corrected
run reports `0` survivors for both providers. `kill()` was verified separately and does terminate a
child within 500 ms on beta.18.

## 3. Experiment B — terminal lifecycle

### 3.1 The problem

`terminal.create` returned as soon as `pty.spawn` had returned. A caller could not distinguish
"a process exists" from "the application has rendered something and can take input". The
previous validation hit this directly: a test sent Ctrl+C immediately after `create` and the
child died with `STATUS_CONTROL_C_EXIT` having produced zero output.

### 3.2 States implemented

`Session` now carries an explicit `state`, exposed on every observation:

| State | Meaning | Transition |
| --- | --- | --- |
| `spawned` | child pid exists; nothing rendered yet | on construction |
| `operational` | the emulator has rendered at least one output chunk | first `onData` chunk flushed |
| `exited` | child process is gone; resources still held | `onExit` |
| `released` | `close()` completed; pty killed, subscriptions and terminal disposed | end of `close()` |

`exited` may follow `spawned` directly (a child that dies before writing anything), which is
tested explicitly. `released` is sticky — a late `onExit` cannot move a released session
backwards.

**There is deliberately no `ready` state.** Whether an *application* is ready to accept input is
not observable from the terminal alone; only the caller knows what its prompt looks like. The
task's requirement — "application ready, when independently observable" — is therefore met by
keeping `spawned` distinct from `operational` and documenting that readiness is a caller-defined
observable condition, reached by waiting for a marker on screen:

```js
// readiness = an observable condition, never a sleep
let snap = await session.observe();
while (!snap.screen.includes('Press any key')) {
  snap = await session.wait(snap.revision, 250);   // revision-based, wakes on change
}
```

`spawned` is **not** readiness, and `operational` only means bytes have been rendered.

### 3.3 Child PID exposure

`observe()` now returns `pid`, taken from `pty.pid`. Because `terminal.create` spreads the first
observation, the create result carries it too. Verified against the OS process table
(`isPidAlive`) and confirmed stable across observations and after exit — a caller can
independently confirm process identity and detect orphans without leaving the protocol.

Both changes are **additive**: no field was renamed or removed, so existing clients are
unaffected. `protocolVersion` stays at 1.

### 3.4 Documented and tested Windows behaviours

Each of these was found experimentally, and each now has a test:

| Behaviour | Finding | Test |
| --- | --- | --- |
| Ctrl+C, raw mode | delivered as data byte `0x03`; child survives | WIN-04 |
| Ctrl+C, cooked + handler | real `CTRL_C_EVENT` → handler runs → exit 130 | WIN-17 |
| Ctrl+C, cooked, no handler | console terminates it → `-1073741510` = `0xC000013A` `STATUS_CONTROL_C_EXIT` | WIN-17 |
| Ctrl+C before readiness | kills the child, because it is still in cooked mode during start-up | WIN-17, §3.1 |
| Input chunk coalescing | separate `write()` calls can arrive as **one** chunk; `RAW:1b7f` = Escape+Backspace together. Assertions must compare the ordered byte stream, not one line per key | WIN-04 |
| Resize is eventually consistent | `resize()` resolves before the child knows; convergence measured at 168 ms (shrink 80×24→60×10) and 172 ms (grow →100×30) | WIN-07 |
| Revision semantics | `input()` bumps the revision itself, so `wait()` must be armed with the revision the **write** returned; every write needs a fresh observation or it is rejected as `Stale observation` | WIN-16, server suite |
| Unexpected termination | external `taskkill /F /T` is detected, input is then rejected, other sessions keep working, and a new session can be created | WIN-20 |
| Exit detection latency | ~1025 ms (min 1014, max 1038 over 20 cancellations) between the child dying and `running:false` being observable — consistent with node-pty's `FLUSH_DATA_INTERVAL` of 1000 ms | stress phase C |
| Observation after close | `observe()` still works once `released` and returns the final screen, so a caller can read what the application showed without holding the session open | lifecycle test |

**One input operation is not one child input event.** Two separate facts break that assumption:
writes can coalesce into a single chunk (above), and a single `write()` can be split across
chunks by the pipe. The fixture's `--raw-echo` mode exists so tests can assert the exact ordered
byte stream the child received instead of assuming framing.

## 4. A host-killing defect found by the stress harness

### 4.1 Symptom

`test/bench/lifecycle-stress.mjs` at scale 0.1 died **deterministically** in Phase E:

```
node:events:487
      throw er; // Unhandled 'error' event
Error: write EAGAIN
    at WriteWrap.onWriteComplete [as oncomplete] (node:internal/stream_base_commons:87:19)
Emitted 'error' event on Socket instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
  errno: -4088, code: 'EAGAIN', syscall: 'write'
```

Re-run confirmed the identical failure at the identical point.

### 4.2 Diagnosis

`syscall: 'write'` identifies the **input** socket (the output socket is only read). Measured
directly:

```
inSocket  (node-pty _agent.inSocket)   : Socket, error listeners = 0
outSocket (node-pty _agent.outSocket)  : Socket, error listeners = 1
```

node-pty guards its ConPTY **output** socket but attaches **no** `'error'` listener to the
**input** socket. Any asynchronous write failure there — `EAGAIN` when the input pipe is full,
`EINVAL` once the child is gone — becomes an unhandled `'error'` event, which in Node is fatal:
**the entire host process dies, taking every concurrent session with it.**

Isolation attempts, recorded because two plausible hypotheses were **wrong**:

| Hypothesis | Probe | Result |
| --- | --- | --- |
| write to a child killed externally, racing the exit notification | 40 attempts, all 40 writes reached the socket | **0 crashes — not the trigger** |
| backpressure: 40 × 32 KB to a child that never reads stdin | 1.28 MB written | **0 crashes — not the trigger** |
| resize interleaved with a tight write loop | 1,254,780 writes | **1 uncaught `write EINVAL`** |

So the trigger is sustained write *rate*, not child death or volume alone. ConPTY's `conhost`
drains the input pipe continuously, so only a very high rate overflows it.

An important honesty note: the 1.25 M-write rate came from a **bug in my own probe** — it waited
on a `SIZE:` marker that was already on screen, so it spun hot instead of blocking. That bug is
fixed in the harness (samples now clear the screen and wait on a numbered marker, cutting Phase E
from ~1.25 M writes to 50). The defect it exposed is real and independent of the harness bug.

### 4.3 Fix

`Session.guardInputSocket()` attaches an `'error'` listener to the input socket, records the
failure as `writeErrors` / `lastWriteError`, and exposes the count on every observation so a
caller can see that input was lost rather than silently believing it landed.

This is the one place the work reaches into node-pty internals (`pty._agent.inSocket`), and it is
justified: the alternative is that a single failed `terminal.type` — public API, normal usage —
terminates the runtime and every other session. It is written defensively with optional
chaining, so if node-pty renames these internals it becomes a **no-op rather than a crash**, and
it is inert on Unix where `_agent` does not exist (covered by a mocked test).

Verification: the same probe that produced `write EINVAL` at 1,254,780 writes now completes with
**0 crashes**. A deterministic regression test emits the failure directly and asserts the host
survives, the session stays usable, the error is counted, and a concurrent session is unaffected.

## 5. Experiment C — long-running reliability

`test/bench/lifecycle-stress.mjs 1`, 149.9 s total, exit code 0, **no crash**.

| Phase | Load | Result |
| --- | --- | --- |
| A | 100 sequential sessions | 0 ready failures, 0 echo failures, **0 children surviving** |
| B | 10 concurrent sessions | 10/10 became ready in 699 ms, **0 cross-talk**, all closed in 99 ms, 0 surviving |
| C | 20 Ctrl+C cancellations | **20/20 interrupted**, 0 wrong exit codes (all 130), latency median 1025 ms, 0 surviving |
| D | 20 unexpected child terminations | **20/20 exit detected**, 20/20 subsequent input rejected, **20/20 recovered with a new session**, 0 surviving |
| E | 25 repeated resizes | **0 child disagreements** (the child agreed with the requested geometry every time), 0 write errors |
| F | 200 interactive inputs | **0 failures**, round trip min 2 / median 16 / p95 32 / max 60 ms |
| G | runtime shutdown with 5 active sessions | server exit code **0** in **5079 ms**, **0 children surviving** |

Latency, phase A (100 sessions): startup min 78 / median 91 / p95 103 / max 109 ms;
`close()` min 8 / median 12 / p95 23 / max 27 ms.

Resource consumption, baseline → peak → final:

| Resource | Baseline | Peak | Final | Grows with sessions? |
| --- | --- | --- | --- | --- |
| libuv `Socket` handles | 0 | 173 | **172** | **YES — ~1.0 per session** |
| libuv `MessagePort` | 0 | 10 | **0** | no — all workers terminated |
| Win32 handles | 188 | 497 | **489** | **YES — ~1.75 per session** |
| Win32 threads | 13 | 34 | **11** | no — returns to baseline |
| rss | 56.7 MB | 156.9 MB | **73.7 MB** | no — plateaus and is reclaimed |
| heapUsed | 6.3 MB | 12.9 MB | 10.0 MB | no |

Phase A's trail shows the linearity exactly: `Socket` = 2, 12, 22, 32, 42, 52, 62, 72, 82, 92, 101
at sessions 0, 10, 20 … 90, 99.

**Answer to "do resources grow proportionally with completed sessions?"** Yes for file
descriptors and Win32 handles — one leaked conin fd per session, ~1.75 Win32 handles. No for
threads and memory, which return to baseline. So the leak is a *descriptor* leak, not a memory or
thread leak, and it is unbounded.

### 5.1 The descriptor leak has a hard ceiling

Because the leak is unbounded, `test/bench/fd-exhaustion.mjs` was run to find where it breaks
(1200 sessions requested):

```
session 0   : Socket 2    rss  66.3 MB   elapsed   0 s
session 100 : Socket 102  rss 143.4 MB   elapsed  17 s
session 200 : Socket 202  rss 155.5 MB   elapsed  34 s
session 300 : Socket 302  rss 173.3 MB   elapsed  51 s
READY TIMEOUT at session 363
session 400 : Socket 402  rss 217.2 MB   elapsed  77 s
SPAWN FAILED at session 495: Invalid pty handle
RESULT {"completedSessions":495,"elapsedMs":92957,"finalHandles":{"Socket":497,"MessagePort":8,"Pipe":1,"ChildProcess":1},"rssMb":217.8}
```

Three distinct findings:

1. **Degradation from ~session 363** (a session spawned but never became ready) and **hard failure
   at ~session 495**. A long-lived Sentiora host on Windows can therefore create on the order of
   **500 sessions before it can create no more.**
2. The error is `Invalid pty handle`, thrown by `PtyConnect` when `get_pty_baton(id)` returns
   null. It is **not** `EMFILE`, so this is *not* simple descriptor exhaustion — the pty handle
   table lookup itself failed.
3. After printing `RESULT` and calling `process.exit(0)`, **the process did not terminate.** It was
   still alive 13 minutes later holding 720 handles and 189.9 MB, and had to be killed externally.
   Mechanism not determined; recorded as an observation, not a diagnosis.

### 5.2 Root cause of `Invalid pty handle`: an unsynchronised native data race

`node-pty/src/win/conpty.cc` keeps every session in a **global, mutex-free** vector:

```cpp
static std::vector<std::unique_ptr<pty_baton>> ptyHandles;

static pty_baton* get_pty_baton(int id) {           // main thread: find_if over ptyHandles
  auto it = std::find_if(ptyHandles.begin(), ptyHandles.end(), ...);
  ...
}
static bool remove_pty_baton(int id) {              // std::remove_if + ptyHandles.erase(it)
  ...
}
```

`PtyStartProcess` (main thread) does `ptyHandles.emplace_back(...)`, which can reallocate the
vector. `remove_pty_baton` is called from the **exit-callback `std::thread`**, not the main
thread:

```cpp
*th = std::thread([tsfn = std::move(tsfn), baton] {
  ...
  WaitForSingleObject(baton->hShell, INFINITE);
  GetExitCodeProcess(baton->hShell, ...);
  CloseHandle(baton->hShell);
  assert(remove_pty_baton(baton->id));     // <-- mutates the global vector off the main thread
  ...
});
```

There is no lock anywhere on `ptyHandles`. So `erase` on the exit thread races with `emplace_back`
and `find_if` on the main thread — undefined behaviour. Under sustained churn the race eventually
makes `get_pty_baton` miss a baton that `PtyStartProcess` had just registered, which is exactly the
observed `Invalid pty handle`. (`assert` is compiled out in release builds, but
`remove_pty_baton` is its argument, so the mutation always happens.)

Status of this claim: the race is **identified by code inspection** and is consistent with the
measured failure — including the failure being a lookup miss rather than `EMFILE`. It was **not**
proven with a thread sanitizer, because no C++ toolchain is available on this machine. It is
reported as strongly-supported inference, not as instrumented proof.

### 5.3 What was fixed and what was not

| Defect | Layer | Action |
| --- | --- | --- |
| Host process crashes on an async input-socket write error | node-pty | **Fixed in Sentiora** — guarded, counted, exposed as `writeErrors` (§4.3) |
| Host process never exits after a natural child exit | node-pty | **Fixed in PR #6** — unconditional `kill()` |
| 1 fd leaked per session (`_inSocket` never destroyed) | node-pty | **Not fixed** — no public API reaches it; measured, bounded by a test, documented |
| Unsynchronised `ptyHandles` race → `Invalid pty handle` | node-pty | **Not fixed** — native code, needs a mutex upstream; measured ceiling documented |
| ~5 s shutdown tail from `conpty_console_list_agent` crashing | node-pty | **Not fixed** — does not block `terminal.close`; documented |
| `spawn-helper` published without the executable bit | node-pty | **Worked around** — `scripts/fix-native-permissions.mjs` (§7.2) |

Patching the fd leak or the race from Sentiora would mean reaching further into node-pty's private
JS internals or shipping a patched native binary. Both were judged out of scope for a
stabilization change and are recorded as upstream work instead.

## 6. Regression testing

All tests were run on the final committed tree. **Mocked and native suites are separate npm
scripts**, so a native-only failure is visible rather than hiding inside one `npm test`:

```bash
npm ci
node scripts/report-native-arch.mjs     # fails on any arch mismatch with the runtime
npm run test:unit                       # mocked, no native dependency, all platforms
npm run test:native                     # real PTY: cross-platform + Windows ConPTY
npm test                                # both
```

| Runtime | Result | Duration |
| --- | --- | --- |
| Node v24.18.1 arm64 (ABI 137) | **37 / 37 pass, 0 fail** | 69.7 s |
| Node v22.23.5 arm64 (ABI 127) | **37 / 37 pass, 0 fail** | 69.9 s |

Node 22 vs Node 24 was investigated rather than assumed. `--test-timeout` (used by the npm
scripts) exists in both — verified with `node --help` on 22.23.5. node-pty's N-API binary loads
and spawns under both ABIs (127 and 137), which is the point of N-API. Results are identical.

All 20 original Windows scenarios were re-run and still pass, unmodified:

WIN-01 ✔ · WIN-02 ✔ · WIN-03 ✔ · WIN-04 ✔ · WIN-05 ✔ · WIN-06 ✔ · WIN-07 ✔ · WIN-08 ✔ ·
WIN-09 ✔ · WIN-10 ✔ · WIN-11 ✔ · WIN-12 ✔ · WIN-13 ✔ · WIN-14 ✔ · WIN-15 ✔ · WIN-16 ✔ ·
WIN-17 ✔ · WIN-18 ✔ · WIN-19 ✔ · WIN-20 ✔

New tests added by this work (9):

| Test | Covers |
| --- | --- |
| lifecycle states advance spawned → operational → exited → released | §3.2, mocked |
| a child that exits before any output never reports operational | §3.2 edge case, mocked |
| child pid is exposed on every observation | §3.3, mocked |
| the input-socket guard no-ops when node-pty internals are absent | §4.3 cross-platform safety, mocked |
| lifecycle states and child pid are observable through a real ConPTY session | §3.2/§3.3 native |
| ConPTY provider comparison: bundled DLL path works but never releases its worker | Experiment A, pinned as a regression test |
| an asynchronous ConPTY input-socket failure cannot crash the host | §4 regression |
| lifecycle state, child pid and provider default are exposed over the protocol | §3 over JSON-RPC |
| the bundled-DLL ConPTY provider can be selected over the protocol | §2.5 option wiring |

JSON-RPC integrity was re-verified, not assumed from the earlier run: WIN-15 still drives a child
that prints a byte-perfect forged JSON-RPC response plus hostile binary (embedded newlines,
braces, `ESC`, `0x7f`, `0xff 0xfe 0x00 0x1a`) and asserts that **every** line on the server's
stdout is still valid JSON-RPC 2.0 with an id the client actually sent, and that neither forged id
nor the injected marker ever appears there.

## 7. CI and reproducible builds

### 7.1 Changes

| Change | Reason |
| --- | --- |
| `timeout-minutes: 15` on the job | The pre-fix Windows hang ran **3 h 40 m** before it was cancelled, against a 6 h account limit. A hang must fail fast. |
| `package-lock.json` committed + `npm ci` | `npm ci` refuses to run unless the lockfile matches `package.json`, so dependency drift fails the build instead of silently testing something else. It also pins the exact `node-pty@1.1.0` tree this validation ran against. |
| Matrix extended to `node: [22, 24]` | `engines` says `>=22` but CI only tested 22; §6 shows both pass. |
| Matrix extended to `windows-11-arm` | x64 and ARM64 Windows are now **separately visible** instead of assuming the x64 result speaks for ARM64. Label confirmed GA for public repos. |
| `node scripts/report-native-arch.mjs` step | Fails the job if any native binary's architecture differs from the runtime, so an emulated x64 image can never be reported as ARM64. |
| `node scripts/fix-native-permissions.mjs` step | See §7.2. |
| Unit and native suites as separate steps | A native-only failure on one platform is obvious instead of hiding inside one `npm test`. |
| `--test-timeout` in the npm scripts | A single hanging test fails instead of stalling the job until `timeout-minutes`. |
| `Diagnostics after failure` step | Preserves node/arch/platform/OS-release/CPU context when a job fails. |

`fail-fast: false` was already set and is kept, so one bad matrix entry does not cancel the others.

### 7.2 The macOS failure — root cause

`macos-latest` failed in ~10 s at `npm test` with:

```
not ok 1 - real PTY redraw, input and exit
  failureType: 'testCodeFailure'
  error: 'posix_spawnp failed.'
```

This is in the **pre-existing** `test/native.test.js`, not in any test added here, and it failed
identically on `main` before this work.

Root cause, established from the published artifact rather than guessed. `node-pty/src/unix/pty.cc`
uses `posix_spawnp` on a helper binary **only** inside `#if defined(__APPLE__)`:

```cpp
#if defined(__APPLE__)
  argv[0] = strdup(helper_path.c_str());   // prebuilds/darwin-*/spawn-helper
  ...
  pty_posix_spawn(argv, env, term, &winp, &master, &pid, &err);
  if (err != 0) { throw Napi::Error::New(napiEnv, "posix_spawnp failed."); }
#else
  ... forkpty path ...
#endif
```

and `lib/unixTerminal.js` resolves it to `native.dir + '/spawn-helper'`, i.e.
`prebuilds/darwin-arm64/spawn-helper`. Inspecting the actual published tarball:

```
$ npm pack node-pty@1.1.0 && tar -tvf node-pty-1.1.0.tgz | grep prebuilds
-rw-r--r--  package/prebuilds/darwin-arm64/spawn-helper     <- 644, NOT executable
-rw-r--r--  package/prebuilds/darwin-x64/spawn-helper       <- 644, NOT executable
-rw-r--r--  package/prebuilds/darwin-arm64/pty.node
-rw-r--r--  package/prebuilds/win32-arm64/conpty/OpenConsole.exe
... every entry under prebuilds/ is 644 ...
```

**Every file in `prebuilds/` is published as mode 644.** `posix_spawnp` on a non-executable file
fails with `EACCES`, which node-pty reports as the bare string `"posix_spawnp failed."`. Nothing in
node-pty restores the bit — `scripts/post-install.js` only lists `spawn-helper` among the files to
*preserve* while cleaning `build/Release`, and never `chmod`s it.

This explains the whole platform pattern with no leftover: **macOS fails** (it executes the
helper), **Linux passes** (it uses `forkpty`, never touching the helper), **Windows passes**
(ConPTY, no helper).

So the cause is **permissions in node-pty's published package** — not executable resolution, not
runner configuration, not Sentiora's code.

Workaround: `scripts/fix-native-permissions.mjs` restores mode 755 on any
`prebuilds/*/spawn-helper`. It is a no-op when node-pty is absent or has no helper (Windows), and
is invoked as an explicit **CI step** and as `npm run fix:native-permissions`.

It was deliberately **not** wired as a `postinstall` lifecycle script: auto-executing code on every
`npm install` is a supply-chain surface that should be an explicit opt-in. The trade-off is that a
local macOS developer must run `npm run fix:native-permissions` once after installing; this is
documented in the README.

**Confirmed by CI.** No macOS execution was possible locally — this machine is Windows ARM64 — so
the fix was verified through GitHub Actions on the commit that contains it, run
[`45479968125`](https://github.com/egarim/sentiora-terminal/actions/runs/45479968125):

```
✓ test (macos-latest, 22)       in 9s
✓ test (macos-latest, 24)       in 17s
```

Both macOS jobs pass, where they previously failed in ~10 s with `posix_spawnp failed.`. That
closes the diagnosis: the cause was the missing executable bit, and restoring it is sufficient.
`macos-latest` is Apple Silicon, so this validates macOS **ARM64**; Intel is not covered and would
need `macos-15-intel`.

The same run validated the rest of the matrix, all 8 jobs green:

```
✓ test (ubuntu-latest, 22)    in 11s     ✓ test (windows-latest, 22)     in 1m27s
✓ test (ubuntu-latest, 24)    in 18s     ✓ test (windows-latest, 24)     in 1m37s
✓ test (macos-latest, 22)     in 9s      ✓ test (windows-11-arm, 22)     in 1m52s
✓ test (macos-latest, 24)     in 17s     ✓ test (windows-11-arm, 24)     in 1m43s
```

Two things this establishes independently of the local machine: `windows-11-arm` is a working
runner label and the suite passes on **GitHub-hosted Windows ARM64**, not only on this physical
Surface; and Node 22 and Node 24 both pass on all four platforms, matching the local Node 22 /
Node 24 result in §6.

## 8. Known limitations

1. **~500-session ceiling per host process on Windows** (§5.1), from the upstream fd leak and the
   `ptyHandles` race. A long-lived host must recycle periodically, or the leak must be fixed
   upstream.
2. **1 leaked fd and ~1.75 leaked Win32 handles per session** (§5). Bounded by a test, not fixed.
3. **~5 s shutdown tail** per host process exit on the default provider. `terminal.close` is
   unaffected (median 9 ms); only final process exit is delayed.
4. **~1 s exit-detection latency**: a child's death becomes observable roughly 1025 ms later.
   Pollers must tolerate this.
5. **A failed process exit was observed once** after ~495 sessions: the process printed its final
   result, called `process.exit(0)`, and was still alive 13 minutes later. Not diagnosed.
6. **stderr noise**: one `AttachConsole failed` stack trace per session close on the default
   provider. stdout is never affected (WIN-15).
7. **No source-compilation path tested** — no MSVC on this machine. Only the vendored ARM64
   prebuild route is validated.
8. **PowerShell 5.1 only**; no `pwsh` installed, so PowerShell 7 behaviour is untested.
9. **Only Windows ARM64 has physical-machine coverage.** Windows x64, Linux x64, Linux ARM64 and
   macOS ARM64 are verified by CI alone; macOS Intel has no coverage at all. Linux ARM64 was added
   for issue #28 and now runs on `ubuntu-24.04-arm` for Node 22 and 24, and inside a plain
   `debian:bookworm-slim` container as a non-root user with no controlling terminal — see
   [Linux containers](linux-containers.md). The
   per-scenario evidence in §6 and the stress results in §5 are Windows ARM64 measurements and
   should not be assumed to hold elsewhere — in particular the descriptor leak and the
   ~500-session ceiling are ConPTY-specific and untested against Unix PTY.
10. **`useConptyDll:true` is exposed but not recommended** and is not covered by the long-running
    stress phases, since it cannot shut down.
11. **Environment inheritance — fixed for the environment half (issue #26); the screen half is
    still open.** `src/server.js` used to spawn children with `env: process.env`, so every child
    inherited the host's full environment including any secrets in it. It now defaults a session to
    a small allowlist and accepts an optional `env` object (see `src/env.js` and
    [`../integrations/telekinesis.md`](../integrations/telekinesis.md) §11.1). Screen content,
    however, is still returned verbatim with no redaction, so a child that *prints* a credential
    still puts it into an observation. That matters for any integration that logs observations, and
    it is the subject of issue #27 rather than #26 — scoping the environment stops a child reading
    the host's secrets, not a child echoing its own.

## 9. Recommendations

1. **Keep OS ConPTY as the default.** The evidence in §2.4 is decisive; do not revisit without a
   node-pty release that disposes the conout worker on the DLL path.
2. **File three upstream node-pty issues**, in priority order: the unsynchronised `ptyHandles`
   race (§5.2, causes total loss of session-creation ability); the missing `'error'` listener on
   `_inSocket` (§4.2, causes host crashes); the `_inSocket` fd leak (§5, causes the ~500 ceiling).
   The `spawn-helper` mode-644 packaging bug (§7.2) is a fourth, and is the cheapest to fix.
3. **Recycle long-lived hosts** before ~400 sessions until the upstream leak is fixed. A supervisor
   that restarts the Sentiora host on a session counter is a cheap mitigation.
4. **Add a session-count guard** in `src/server.js` that refuses `terminal.create` past a
   configurable threshold and reports a clear error, rather than letting the host reach the
   `Invalid pty handle` state. Not implemented here to keep the change reviewable.
5. **Add `timeout-minutes` to any future workflow** — already done for this one.
6. **Extend the matrix to the one architecture still uncovered** — `macos-15-intel`. Linux ARM64
   was added for issue #28: `ubuntu-24.04-arm` on Node 22 and 24, plus a plain
   `debian:bookworm-slim` container as a non-root user with no controlling terminal, both in
   [Linux containers](linux-containers.md). macOS ARM64, Windows x64 and Windows ARM64 were already
   CI-verified. Intel macOS still cannot be claimed.

## 10. Remaining work

- [x] Confirm `macos-latest` turns green with the permissions fix — **done**, run 45479968125,
      macOS 22 in 9 s and macOS 24 in 17 s.
- [x] Confirm `windows-11-arm` queues and passes on GitHub-hosted ARM64 runners — **done**, same
      run, 1 m 52 s (Node 22) and 1 m 43 s (Node 24).
- [ ] Extend the matrix to `macos-15-intel` and `ubuntu-24.04-arm`.
- [ ] Upstream the four node-pty issues and track them.
- [ ] Add a session-count guard to `src/server.js`.
- [ ] Decide whether the ~500-session ceiling warrants a host-recycling supervisor in Sentiora
      itself or belongs in the caller.
- [ ] Investigate the post-`process.exit(0)` non-termination observed at ~495 sessions (§5.1 item 3).
- [ ] Protocol-level control over child environment inheritance, and a screen-redaction policy
      (§8 item 11).
- [ ] Run the stress harness on Linux and macOS to compare leak behaviour against Unix PTY.

## 11. Conclusion

The alternative ConPTY provider was evaluated and **rejected on evidence**, not preference:
`useConptyDll:true` does remove the 5 s tail, the fd leak and the console-list helper fork — all
three hypotheses confirmed — but it leaks a worker thread, eight Win32 handles and about 6.5 MB per
session and leaves the host process **unable to exit at all**. It is retained as an opt-in,
documented runtime option so the comparison stays reproducible.

Two defects were found that the previous validation did not surface, both by stress rather than by
scenario testing: an unhandled input-socket write error that **killed the host process** (fixed,
with a regression test), and an unsynchronised native data race in node-pty that caps a Windows
host at roughly **500 sessions** (measured, root-caused by inspection, not fixable from here).

Lifecycle semantics are now explicit — `spawned`, `operational`, `exited`, `released`, with no
pretence that Sentiora can know when an *application* is ready — and the child pid is exposed so a
caller can verify process identity independently. Builds are reproducible via a committed lockfile
and `npm ci`, CI can no longer hang silently, and the macOS failure is root-caused to a mode-644
`spawn-helper` in node-pty's published tarball and **fixed**: `macos-latest` now passes.

37/37 tests pass locally on both Node 22.23.5 and Node 24.18.1, ARM64, with every native binary
verified ARM64 by its container header — and all 8 CI matrix jobs pass, covering ubuntu,
windows x64, windows ARM64 and macOS ARM64 against Node 22 and Node 24.
