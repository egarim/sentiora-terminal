# Windows native validation — Sentiora Terminal

Validation of Sentiora Terminal against a real Windows ConPTY pseudoterminal, using
native integration tests rather than mocks.

Method: **Hypothesis → Experiment → Evidence → Decision.** Every claim below is tied to
a command that was run and an observation that was recorded. Where a first experiment
produced a misleading result, the misleading result and its correction are both recorded.

## 1. Environment

| Item | Value |
| --- | --- |
| Machine | Surface, Snapdragon(R) X 12-core X1E80100 @ 3.40 GHz |
| CPU architecture | ARM64 (`Win32_Processor.Architecture = 12`) |
| OS | Microsoft Windows 11 Pro |
| OS version / build | 10.0.26200, build 26200 (`ver` reports 10.0.26200.9974) |
| Memory | 33,888,956,416 bytes (~31.6 GiB) |
| Node.js | v24.18.1, `process.arch = arm64`, `process.platform = win32` |
| npm | 11.16.0 |
| git | 2.55.0.windows.3 |
| PowerShell | 5.1.26100.9974, Desktop edition. **No PowerShell 7 (`pwsh`) installed.** |
| Native build tools | **None.** No `cl.exe`, `msbuild.exe`, `ninja` or `cmake` on PATH. Python 3.14 and 3.12-arm64 present. |
| GitHub CLI | 2.98.0 |
| Repository commit tested | `96235ca128d6f9c614421025227d5de605e4dce0` (`main`) |
| Branch for fixes/tests | `fix/windows-native-validation` |

`package.json` declares `engines.node >= 22`; CI pins Node 22. This machine has Node
24.18.1 ARM64, which satisfies the range. Node 22 ARM64 is not installed locally, so the
exact CI-pinned version was **not** reproduced here (see §8).

### 1.1 Native components are genuinely ARM64, not emulated

Node itself reports `arm64`. The PE COFF `Machine` field of every native binary was read
directly to prove none of them is an x64 image running under emulation:

```
prebuilds/win32-arm64/pty.node                 ARM64
prebuilds/win32-arm64/conpty.node              ARM64
prebuilds/win32-arm64/conpty/conpty.dll        ARM64
prebuilds/win32-arm64/conpty/OpenConsole.exe   ARM64
build/Release/conpty/conpty.dll                ARM64
build/Release/conpty/OpenConsole.exe           ARM64
prebuilds/win32-x64/conpty/OpenConsole.exe     x64 (AMD64)   <- control, proves the check discriminates
```

Resolved dependency versions: `node-pty@1.1.0`, `@xterm/headless@5.5.0`.

### 1.2 node-pty 1.0.0 would not have installed on this machine

`npm install` on npm 11.16.0 blocks install scripts by default:

```
npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn allow-scripts   node-pty@1.1.0 (install: node scripts/prebuild.js || node-gyp rebuild;
                                         postinstall: node scripts/post-install.js)
```

Despite that, `import('node-pty')` succeeds, because **node-pty 1.1.0 vendors its
prebuilds inside the npm tarball** (`prebuilds/` for darwin-arm64, darwin-x64,
win32-arm64, win32-x64, plus `third_party/conpty/1.23.251008001/win10-{arm64,x64}`).

node-pty **1.0.0 does not**. Its tarball was inspected directly:

```
name node-pty version 1.0.0 files 251
top-level: LICENSE, README.md, binding.gyp, deps, lib, package.json, scripts, src, typings
any prebuild? false
```

With no prebuilds and no MSVC toolchain on this machine, `^1.0.0` resolving to 1.0.0 would
have meant `node-gyp rebuild` and a hard failure. The declared range was therefore raised
to `^1.1.0` (§6). This is the single most important Windows ARM64 packaging fact for this
project: ARM64 support depends on 1.1.0's vendored prebuilds, not on a local compiler.

### 1.3 ConPTY configuration actually in effect

From `node_modules/node-pty/lib/windowsPtyAgent.js`:

- `_useConpty = _getWindowsBuildNumber() >= 18309` → **true** on build 26200, so the
  ConPTY path is used and winpty is not.
- `useConptyDll` defaults to **false**, so the **OS** ConPTY is used rather than the
  bundled `conpty.dll`. Observable consequence: sessions are hosted by `conhost.exe`, not
  by the bundled `OpenConsole.exe`. Measured: 3 concurrent sessions produced exactly 3 new
  `conhost.exe` processes.
- Native module resolution order is `build/Release`, `build/Debug`,
  `prebuilds/<platform>-<arch>`. `conpty_console_list` resolved from
  `../prebuilds/win32-arm64/`.

## 2. Baseline: what the repository did before any change

| Check | Command | Result |
| --- | --- | --- |
| Syntax | `node --check src/server.js` | PASS |
| Mocked unit tests | `node --test test/session.test.js` | PASS 4/4, 167 ms, exit 0 |
| Native test | `node --test test/native.test.js` | test PASS (1426 ms) but **the process never exits**; killed after 90 s |
| Full suite | `npm test` | **HANG.** Killed after 300 s with `real PTY redraw, input and exit` reported passing and no summary printed |

GitHub Actions run [`45425951649`](https://github.com/egarim/sentiora-terminal/actions/runs/45425951649)
on `main` at `96235ca` corroborates this independently:

```
✓ test (ubuntu-latest) in 22s
* test (windows-latest)          <- still in progress after 1h51m
X test (macos-latest) in 9s      <- failed at `npm test`
```

So the hang is **Windows-specific and reproduces on GitHub's x64 Windows runner**, not only
on this ARM64 machine. The macOS failure is separate and out of scope here; its logs were
unavailable because the run was still in progress. The suite had therefore never been green
on Windows, and CI was burning runner hours up to the 6 h job limit.

### 2.1 CI confirmation after the fix

Run [`45460762032`](https://github.com/egarim/sentiora-terminal/actions/runs/45460762032) on
`fix/windows-native-validation`, pull request #6:

```
✓ test (windows-latest) in 1m20s   <- was still running after 1h51m on main
✓ test (ubuntu-latest)  in 10s
X test (macos-latest)   in 10s     <- pre-existing, see below
```

**The Windows job now completes in 1 m 20 s instead of never finishing.** That is independent,
x64, GitHub-hosted confirmation of the §4 fix, on a different machine and architecture from the
one used for every other measurement in this report.

The macOS job fails identically to `main` (same step, ~9–10 s), in the **pre-existing**
`test/native.test.js`:

```
not ok 1 - real PTY redraw, input and exit
  failureType: 'testCodeFailure'
  error: 'posix_spawnp failed.'
```

This is not a regression from this change:

- `posix_spawnp failed.` is raised by `pty.spawn()`, which happens before any `close()`; the
  only source change here is inside `close()`.
- `node-pty` `^1.0.0` and `^1.1.0` resolve to the **same** 1.1.0 tarball, so the darwin native
  binary is byte-identical either way.
- All 24 new tests report `ok ... # SKIP native ConPTY scenario: Windows only`, and the run
  summary is `# fail 1` — the single pre-existing failure, unchanged.

Note that the exact `main` log line could not be diffed directly: GitHub only exposes job logs
once the whole run completes, and the `main` run is **still blocked by the Windows hang this PR
fixes**. Fixing Windows is therefore a prerequisite for triaging macOS.

## 3. Root cause of the hang

`src/session.js` guarded the kill:

```js
async close(){ ... try{ if(!this.exit) this.pty.kill(); } finally{ ... } }
```

When the child exits on its own, `this.exit` is already set, so `kill()` was skipped. On
Windows that matters, because in `node-pty`:

- `WindowsPtyAgent._$onProcessExit` → `_flushDataAndCleanUp()` → after 1000 ms
  `_cleanUpProcess()` sets `_inSocket.readable = false`, `_outSocket.readable = false` and
  calls `_outSocket.destroy()`. **It never disposes `_conoutSocketWorker`.**
- `_conoutSocketWorker` is a `ConoutConnection` that owns a `worker_threads.Worker`
  (`lib/worker/conoutSocketWorker.js`). Only `WindowsPtyAgent.kill()` calls
  `_conoutSocketWorker.dispose()`, which terminates the worker after a 1000 ms drain.
- A live Worker keeps a `MessagePort` in the event loop, so **the host process never exits.**

On Linux/macOS `UnixTerminal` has no such worker, which is exactly why ubuntu passed in 22 s
while Windows hung.

### 3.1 Experimental proof

Probes were run with **`unref()`'d watchdog timers**, so survival past the deadline can only
be caused by the pty and not by the probe itself.

| Mode | Scenario | Result |
| --- | --- | --- |
| C | child writes output, exits by itself, `kill()` never called | handles stay `{"WriteStream":2,"MessagePort":1,"Socket":1}` → **HANG** at 12 s |
| D | child writes output, exits by itself, `kill()` called from `onExit` | `MessagePort` gone by ~4 s, **natural exit code 0 at 6251 ms** |
| E | child stays silent, exits by itself, `kill()` called from `onExit` | **natural exit code 0 at 6335 ms** |

Correction recorded for honesty: an earlier probe reported that `kill()` did *not* help. That
probe used a **ref'd** 8 s watchdog, which itself held the event loop open, and it printed a
stale `%ERRORLEVEL%`. Its verdict was a false positive. Modes D and E above supersede it.

## 4. Fix

One line in `src/session.js` — call `kill()` unconditionally:

```js
// kill() is required even after a natural exit: on Windows node-pty only
// disposes its ConPTY conout worker thread from kill(), and a live worker
// keeps the host event loop alive forever.
async close(){if(this.closed)return;this.closed=true;try{this.pty.kill();}catch{}finally{this.changed();await this.pending;for(const s of this.subscriptions)s.dispose();this.terminal.dispose();}}
```

Cross-platform safety was checked rather than assumed. `UnixTerminal.kill()` is:

```js
try { process.kill(this.pid, signal || 'SIGHUP'); } catch (e) { /* swallow */ }
```

so an unconditional kill is a no-op for an already-dead process on Unix. `kill()` is also
idempotent on Windows — a second call 50 ms later was verified to succeed without throwing.

Result after the fix, on the unmodified pre-existing tests:

```
npm test -> tests 5, pass 5, fail 0, duration_ms 8111, exit 0
```

The suite went from *never completing* to completing in ~8 s.

## 5. Windows-specific investigation

### 5.1 Close latency: a ~5 s tail caused by a crashing helper

`kill()` costs ~5.0 s of event-loop tail, measured for both a live child and an
already-exited child:

```
mode=live   +1583ms calling kill() -> +6668ms EVENT LOOP DRAINED exit=0   (5085 ms)
mode=exited +2734ms calling kill() -> +7832ms EVENT LOOP DRAINED exit=0   (5098 ms)
```

Exactly 5000 ms points at `WindowsPtyAgent._getConsoleProcessList()`, which forks
`lib/conpty_console_list_agent.js` and resolves via a 5000 ms timeout if the agent does not
reply. The agent was run directly:

```
nonexistent-pid: agent exited code=1 ... NO REPLY in 6000ms
own-pid:         replied in 102ms -> {"consoleProcessList":[28168,41964,39636]}
```

and it fails with:

```
Error: AttachConsole failed
    at Object.<anonymous> (.../node-pty/lib/conpty_console_list_agent.js:13:26)
```

So: the helper works for a process that still owns a console, and **crashes for one that is
already gone** — which is the normal case at close time. `AttachConsole` also fails outright
when the host process already has a console, since a process may only attach to one.

Consequences, all measured:

- `terminal.close` is **not** blocked: `close()` does not await the drain, so the RPC reply
  is immediate. Only final host shutdown is delayed. Measured server exit after stdin close:
  5051 / 5058 / 5063 / 5070 / 5208 ms across five runs.
- Every close forks a short-lived `node.exe` that prints a stack trace to **stderr**
  (~49 occurrences in one full suite run). **stdout stays clean** — see WIN-15.

### 5.2 File-descriptor leak in node-pty (upstream, not Sentiora)

Handle census across 20 create/close cycles, identical in three consecutive runs:

```
handles {"Socket":31,"ChildProcess":1} -> {"Socket":51,"ChildProcess":1}
conin sockets leaked 20        (= exactly one per session)
MessagePort -> 0               (every conout worker terminated)
rss +23.6MB / -10.1MB / -10.9MB / -10.0MB   (no sustained growth)
```

Root cause: `WindowsPtyAgent` opens `inSocketFD = fs.openSync(term.conin, 'w')` and wraps it
in `_inSocket`. Neither `_cleanUpProcess()` nor `kill()` ever destroys `_inSocket` — they only
set `readable = false`, which does not close the fd. `_outSocket` *is* destroyed, which is why
exactly one handle per session survives.

`MessagePort → 0` is the part Sentiora controls, and it is the direct evidence that the §4
fix works: without it, 20 workers would have survived and the process would have hung.

Sentiora cannot close `_inSocket` through node-pty's public API — `IPty` exposes only
`kill`/`destroy`, and `WindowsTerminal.destroy()` simply calls `kill()`. Reaching into
`pty._agent._inSocket` would be private, version-fragile API, so this is **documented and
pinned by a test bound** (`leakedSockets <= iterations`) rather than patched. At one fd per
session, a long-running server would approach typical CRT descriptor limits after on the
order of a thousand sessions.

### 5.3 Child processes do not attach to the parent console

This is the failure mode reported in Telekinesis #49, and it was tested directly rather than
assumed absent. WIN-15 makes the child print a byte-perfect forged JSON-RPC response plus
hostile binary (embedded newlines, braces, ESC, `0x7f`, `0xff 0xfe 0x00 0x1a`). Every line on
the server's stdout still parsed as JSON-RPC 2.0 with an id the client had sent, and neither
forged id (`424242`, `424243`) nor the string `"INJECTED"` ever appeared there. ConPTY keeps
child output on the pseudoconsole.

### 5.4 Unicode and encoding

`chcp` was not needed. Through the pty, Spanish, Russian and Chinese all round-trip exactly
(WIN-09), including a byte-level check that sends the raw UTF-8 for `ñ漢` and requires it back
intact. Box-drawing glyphs (`┌ ─ ┐ │ └ ┘`) survive too (WIN-18). SGR colour is preserved into
cell attributes, not merely stripped (WIN-05).

### 5.5 Ctrl+C has three different behaviours

`0x03` is not one thing on Windows; what happens depends on the child's console mode at the
instant the byte arrives:

| Child state | Observed behaviour | Test |
| --- | --- | --- |
| raw mode enabled | delivered as data byte `0x03`; child keeps running | WIN-04 |
| cooked mode, `SIGINT` handler installed | real `CTRL_C_EVENT` → handler runs → exit code **130** | WIN-17 |
| cooked mode, no handler | console terminates the child → exit code **-1073741510** = `0xC000013A` `STATUS_CONTROL_C_EXIT` | WIN-17 |

**Startup race.** `terminal.create` returns as soon as the pty exists, well before the child
has configured its console mode. This was found the hard way: a test sent `CtrlC` immediately
after `create`, and the child died with `0xC000013A` having produced *zero* output. An agent
that sends Ctrl+C too early kills the process instead of interrupting it. Callers must wait
for an observable readiness marker first.

### 5.6 Input chunk coalescing

Separate `write()` calls can reach the child as **one** input chunk. WIN-04 originally
expected one echoed line per key press and saw `RAW:1b7f` — Escape and Backspace coalesced.
Assertions were changed to compare the *ordered byte stream* the child received, which is both
coalescing-proof and stricter: the final check is an exact equality against the concatenation
of every byte sent.

### 5.7 Resize is eventually consistent

`resize()` resolves once the emulator and the pty have been told the new geometry; the child's
`process.stdout.columns` follows later. Measured convergence:

```
shrink 80x24 -> 60x10 : child reports SIZE:60x10 after 168 ms   CONVERGED
grow   60x10 -> 100x30: child reports SIZE:100x30 after 172 ms  CONVERGED
```

WIN-07 originally failed by asking the child for its size immediately after `resize()` and
getting the stale `SIZE:80x24`. It now polls with a deadline, so a genuine propagation failure
would still fail the test. Both directions are checked, so the propagation is not a one-way
latch.

### 5.8 Revision semantics an agent must respect

- `input()` bumps the revision itself, so `wait(preInputRevision)` returns immediately, before
  the child has replied. A caller must arm `wait()` with the revision **returned by the write**.
- Every write needs a fresh observation. Two server-level tests failed with
  `{"code":-32000,"message":"Stale observation"}` before a retry-on-stale helper was added —
  which is exactly what a real agent has to do.

### 5.9 A measurement artifact that produced a false failure

WIN-19 first timed out after 30 s waiting for the `conhost.exe` count to return to baseline,
reporting 2 "orphans". This was investigated rather than papered over:

```
PART1 tasklist x20 (no sessions): conhost 32 -> 32; new pids still alive: 0    <- parent HAD a console
PART2 20 create/close cycles:     conhost 32 -> 32; new = 0; children alive: 0
```

and under console-less harness conditions:

```
conhost baseline = 32
after 15 tasklist calls: conhost = 32, new = 1 -> 42936     <- created by measurement itself
with 3 sessions open:    conhost = 35, new vs baseline = 4  <- 3 sessions + 1 artifact
10s after closing all 3: conhost = 32, new vs baseline = 1  <- all 3 session hosts reaped
```

Longer observation of the same churn run:

```
+~8s : new conhosts = 0
+~15s: new conhosts = 0
+~30s: new conhosts = 8   (transient; parent=40832, not our pid 31340)
+~60s: new conhosts = 1   (parent=40832)
   (any of our fixture children? 0)
```

Cause: under `node --test` the test process has **no console**, so Windows hands every
subprocess it spawns a transient `conhost.exe`. Polling `tasklist` therefore manufactures the
very thing being measured. **Sentiora leaves no orphaned console hosts.**

Attribution by `ParentProcessId` was implemented as a sharper filter and then **abandoned**:
session conhosts did carry our pid as parent (3 of 4 new hosts), but the helper reported 1
conhost at idle instead of 0 — the PowerShell measurement call is attributed to us too — and
one run hung. Recorded here because it explains the final method.

Final method, used by WIN-14 and WIN-19: warmed-up baseline (`conhostBaseline`), one batched
pid check for all children (`alivePidsAmong`, a single `tasklist` instead of one per pid), a
quiet 10 s settle with no subprocess spawning, then **one** measurement, tolerating at most
one host and logging the exact count. Observed across the four runs: `1, 1, 0, 0`. The strict,
artifact-free guarantees are that every child pid Sentiora spawned is gone and that
`MessagePort` returns to 0.

## 6. Changes made

| File | Change | Why |
| --- | --- | --- |
| `src/session.js` | `close()` calls `pty.kill()` unconditionally | §3/§4 — without it the host process never exits on Windows |
| `package.json` | `node-pty` `^1.0.0` → `^1.1.0` | §1.2 — 1.1.0 vendors the win32-arm64 prebuild; 1.0.0 needs a compiler |
| `test/fixtures/interactive.mjs` | new | deterministic interactive fixture (§7) |
| `test/fixtures/sigint.mjs` | new | cooked-mode child with a SIGINT handler, for Ctrl+C |
| `test/helpers/native.mjs` | new | session/poll/process-introspection helpers |
| `test/windows-native.test.js` | new | WIN-01…WIN-14, WIN-16…WIN-20 |
| `test/windows-server.test.js` | new | WIN-15 plus JSON-RPC end-to-end coverage |
| `.gitignore` | new | the repo had none; `node_modules/` was untracked |
| `docs/validation/windows-native-validation.md` | new | this report |

The fix is one line of logic. No architectural change was made, and nothing was changed to
make a test pass: where a test encoded a wrong assumption (§5.6, §5.7, §5.8, §5.9) the test was
corrected and the real behaviour documented.

## 7. Test design

Two new suites, both skipped on non-Windows so the existing cross-platform meaning of
`npm test` is preserved.

`test/fixtures/interactive.mjs` is a deterministic interactive application rather than inline
`node -e` strings. It runs in raw mode and answers a small line protocol with uniquely framed
markers (`ECHO:`, `SIZE:`, `ANSI-DONE`, `UNICODE-DONE`, `REDRAW-n`, `CURSOR-n`, `ALT-SCREEN`,
`BYTES-DONE`). Two design rules came from measurement:

- Commands that must be asserted precisely emit their marker and their effect in a **single
  `write()`**. `Session` flushes the emulator one pty chunk at a time, so a snapshot showing
  the marker proves the whole chunk — including a trailing cursor move — was applied. Splitting
  them produced a genuine race in which the reported cursor was one command behind.
- In-place commands carry a **sequence number** (`REDRAW-n`, `CURSOR-n`). Waiting for a fixed
  marker like `CURSOR-SET` matched the *previous* command's marker that was still on screen,
  and the test silently asserted a stale cursor position.

A `--raw-echo` mode reports every received chunk as `RAW:<hex>`, which makes individual key
presses directly observable and, combined with §5.6, lets the exact byte stream be asserted.

Tests wire a real `node-pty` child to a real `@xterm/headless` emulator through the production
`Session` class — the same wiring as `src/server.js`. Nothing is mocked. `getCell()` on the
headless buffer exposes SGR attributes, so colour assertions check real rendering:

```
\x1b[31mR\x1b[32mG\x1b[1;34mB\x1b[0mN
  cell 0 "R" fgMode 16777216 fg 1        (red)
  cell 1 "G" fgMode 16777216 fg 2        (green)
  cell 2 "B" fgMode 16777216 fg 4 bold   (blue, bold)
  cell 3 "N" fgMode 0        fg -1       (reset)
```

## 8. Result matrix

Four consecutive full runs after the fix, the last on the exact committed tree: **28/28 pass**
each (`duration_ms` 51318 / 50760 / 50561 / 49996). Durations below are from the second run.

| ID | Scenario | Result | ms | Evidence |
| --- | --- | --- | --- | --- |
| WIN-01 | Create a native PTY session | **PASS** | 437 | child reports `ttyIn=true ttyOut=true`; a pipe-backed child reports false. pid alive in the OS process table |
| WIN-02 | PowerShell commands and output | **PASS** | 1593 | one-shot `PS-ONE-SHOT-OK`, exit 0; interactive `$sentiora = 6*7` → `PS-INTERACTIVE=42`, proving persistent shell state |
| WIN-03 | CMD commands and output | **PASS** | 1245 | `cmd /c echo CMD-ONE-SHOT-OK`, exit 0; interactive `set` then `echo %VAR%` → `cmd-state-ok` |
| WIN-04 | Interactive keyboard input | **PASS** | 320 | Enter/Tab/Up/Down/Escape/Backspace/Ctrl+C; exact ordered byte stream `0d091b5b411b5b421b7f03`; raw-mode Ctrl+C does not kill the child |
| WIN-05 | ANSI escape rendering | **PASS** | 193 | per-cell fg colours 1/2/4 + bold; no raw `ESC` or `[31m` in the rendered screen |
| WIN-06 | Cursor movement and position | **PASS** | 277 | CUP 5;10 → `{x:9,y:4}`; CUP 12;40 → `{x:39,y:11}`; CUP 3;1 → `{x:0,y:2}`; writing a line → `{x:0,y:3}` |
| WIN-07 | Resize and dimensions | **PASS** | 325 | emulator + observation 60×10 and 100×30; **child** reports `SIZE:60x10` / `SIZE:100x30`; wrong owner and out-of-range rejected without state change |
| WIN-08 | Interactive screen redraw | **PASS** | 252 | `\x1b[2J` erases prior content; `REDRAW-2` replaces `REDRAW-1` |
| WIN-09 | Spanish / Russian / Chinese | **PASS** | 229 | `cañón Ñandú ÄÖÜß`, `Съешь ещё этих булок`, `汉字终端测试` exact; raw UTF-8 bytes for `ñ漢` round-trip |
| WIN-10 | Concurrent session isolation | **PASS** | 369 | 3 sessions, distinct ids and pids; each screen holds only its own token, never another's |
| WIN-11 | Stale revision rejected | **PASS** | 208 | `Stale observation`; text never reaches the pty; current revision still accepted |
| WIN-12 | Unauthorised owner rejected | **PASS** | 153 | `Input ownership required` for a wrong and an undefined owner; revision unchanged |
| WIN-13 | Process exit status | **PASS** | 5157 | fixture exit 0 / 3 / 42 reported exactly; `cmd /c exit 7` → 7; input after exit → `Session not running` |
| WIN-14 | Cleanup, no orphaned processes | **PASS** | 13771 | 3 sessions → 3 new `conhost.exe`; after close all child pids gone and hosts reaped (logged: 0 or 1, §5.9) |
| WIN-15 | JSON-RPC stdout not corrupted | **PASS** | 5411 | child prints a forged JSON-RPC response + hostile binary; **every** stdout line still valid JSON-RPC 2.0, no forged id, no `"INJECTED"` (§5.3) |
| WIN-16 | Wait operations and timeouts | **PASS** | 618 | quiescent wait returns in ≥350 ms and <5 s with a stable revision; write-armed wait wakes on output; `-1`, `-1`, `NaN` all rejected |
| WIN-17 | Ctrl+C targets the right process | **PASS** | 2429 | `GOT-SIGINT` + exit 130 in the target; concurrent bystander still running and still answering; cooked child with no handler → `0xC000013A` (§5.5) |
| WIN-18 | Full-screen application | **PASS** | 326 | `buffer.active.type` `normal` → `alternate` → `normal`; box glyphs survive; primary screen content restored intact |
| WIN-19 | Repeated create/close, leaks | **PASS** | 16469 | 20 cycles; `MessagePort → 0`; all child pids gone; no sustained rss growth; **+20 conin sockets = 1 per session** (upstream, §5.2) |
| WIN-20 | Recovery after unexpected exit | **PASS** | 1739 | child killed externally with `taskkill /F /T`; session reports `running:false` with exit info; input rejected; a concurrent session still works; a new session can be created; double `close()` safe |

Additional non-scenario coverage in the same suites:

| Test | Result | ms | Evidence |
| --- | --- | --- | --- |
| Protocol surface over stdio | **PASS** | 5726 | all 9 key mappings verified as exact bytes through ConPTY; resize; wrong-owner type and close; unknown session; unknown method; empty command; out-of-range dimensions; closed session leaves the registry |
| Non-JSON stdin line | **PASS** | 164 | garbage in → `-32000` errors out; stdout stays valid JSON-RPC |
| Server shuts down on stdin close | **PASS** | 5687 | 3 unclosed sessions reaped by the `rl.on('close')` handler; exits in ~5.06 s (§5.1) |
| Pre-existing `native.test.js` | **PASS** | 1413 | was the hanging test; now completes and the runner exits |
| Pre-existing `session.test.js` | **PASS** 4/4 | ~5 | unchanged |

### 8.1 Reproduction

```bash
git clone https://github.com/egarim/sentiora-terminal.git
cd sentiora-terminal
git checkout 96235ca128d6f9c614421025227d5de605e4dce0   # baseline, pre-fix
npm install
npm test                          # HANGS on Windows: first test passes, no summary, never exits

git checkout fix/windows-native-validation
npm install
node --check src/server.js
npm test                          # 28/28 pass, ~50 s on this machine
node --test test/windows-native.test.js    # WIN-01..WIN-14, WIN-16..WIN-20
node --test test/windows-server.test.js    # WIN-15 + protocol end-to-end
node --test --test-name-pattern="WIN-19" test/windows-native.test.js   # single scenario
```

The `AttachConsole failed` stack traces on stderr during any of these runs are expected; they
come from node-pty's helper process (§5.1) and do not affect results.

## 9. Telekinesis cross-check

[Telekinesis #49](https://github.com/egarim/telekinesis/issues/49) (open) reports that on a
Surface, Snapdragon X Elite, **Windows 11 ARM64 build 26200.9168** — the same class of machine
and the same build as this validation — its own C# `ConPtyConsoleSession` starts conhost and
receives conhost's control stream, but the child never binds to the pseudoconsole: it produces
zero bytes into the pipe and renders to the *parent* console instead. Every `CreatePseudoConsole`
/ `InitializeProcThreadAttributeList` / `UpdateProcThreadAttribute` / `CreateProcess` call
returns success. [#46](https://github.com/egarim/telekinesis/issues/46) shipped with the
Windows path gated behind `TELEKINESIS_CONPTY=1` as a result.

**Sentiora does not reproduce this.** It was tested rather than assumed:

| #49 symptom | Sentiora observation |
| --- | --- |
| child never binds to the pseudoconsole | WIN-01: child reports `isTTY` **true** on both stdin and stdout — a real console, not a pipe |
| child produces zero bytes into the pipe | WIN-02/03: real PowerShell and cmd.exe produce output through the pty, including stateful interactive sessions |
| child renders to the parent console | WIN-15: a child deliberately printing a forged JSON-RPC response and hostile binary puts **zero** bytes on the host's stdout |

Decision this supports: on build 26200 ARM64 the **OS ConPTY binds children correctly**, so #49
is specific to Telekinesis's managed ConPTY layer rather than an OS, conhost or hardware
limitation. #49's own next step — comparing against a minimal native EchoCon build — now has a
cheaper reference: node-pty's ConPTY path demonstrably works on this exact OS build and
architecture, and `WindowsPtyAgent` shows the call sequence that works (`useConptyDll: false`,
OS ConPTY, conhost-hosted). One detail worth checking in Telekinesis against node-pty: the
conout pipe must be drained on a **separate thread** (`ConoutConnection` exists precisely to
avoid `ClosePseudoConsole` deadlocks), and #49 notes this build EOFs the output pipe
immediately if the parent closes its output-write copy.

## 10. Known limitations

1. **~5 s shutdown tail on Windows** per host process exit, from node-pty's console-list helper
   timing out (§5.1). `terminal.close` replies immediately; only final process exit is delayed.
2. **One leaked fd per session** from node-pty's `_inSocket` (§5.2). Not fixable through public
   API. Bounded by a test, not eliminated.
3. **stderr noise**: a node stack trace per session close. stdout is unaffected.
4. **PowerShell 5.1 only.** No `pwsh` on this machine, so PowerShell 7 behaviour is untested.
5. **Node 24.18.1, not the CI-pinned 22.** Both satisfy `engines >= 22`; Node 22 ARM64 is not
   installed locally.
6. **No source-compilation path tested.** With no MSVC toolchain, only the vendored ARM64
   prebuild route was validated. A machine without prebuilds would fail at `node-gyp rebuild`.
7. **x64 Windows validated only indirectly**, via GitHub Actions `windows-latest`, which was
   hanging pre-fix. The fix is architecture-independent (it is JavaScript), but an x64 native
   run is still outstanding.
8. **WIN-18 uses a deterministic fixture** exercising the alternate screen buffer. No
   third-party full-screen TUI was driven.
9. **`terminal.observe` exposes no child pid**, so an agent cannot independently verify process
   identity or reap orphans without going outside the protocol.

## 11. Recommendations

1. Keep the unconditional `kill()` in `close()`. It is the difference between a server that
   shuts down and one that never does.
2. File upstream node-pty issues for: `_conoutSocketWorker` not disposed on natural child exit;
   the `_inSocket` fd leak; and `conpty_console_list_agent` crashing instead of replying, which
   converts every close into a 5 s wait.
3. Add a job-level `timeout-minutes` to `.github/workflows/ci.yml`. Without it the pre-fix hang
   consumed 1 h 51 m and would have run to the 6 h limit.
4. Evaluate `useConptyDll: true`. That branch calls `_inSocket.destroy()` and skips
   `_getConsoleProcessList()` entirely, so it may remove **both** the fd leak and the 5 s tail.
   It needs its own validation run before adoption; deliberately not changed here.
5. Add the child pid to `terminal.create`'s result (limitation 9).
6. Document the readiness requirement: wait for observable output before sending keys, and
   especially before sending Ctrl+C (§5.5).
7. Document for integrators that writes must be armed with a fresh observation and that `wait()`
   must use the revision returned by the write (§5.8).
8. Add `windows-11-arm` to the CI matrix once the runner label is confirmed available for this
   repository, so ARM64 stays covered rather than being validated once by hand.
9. Triage the macOS failure in run 45425951649 — it fails in 9 s at `npm test`, which is a
   different and much faster failure than the Windows hang.

## 12. Remaining work

- [ ] Re-run this suite on x64 Windows natively. CI has now confirmed x64 passes
      (`windows-latest` ✓ 1 m 20 s), but the per-scenario evidence in §8 is ARM64-only.
- [ ] Re-run on Node 22 (the CI-pinned version).
- [ ] Triage the macOS `posix_spawnp failed.` in `test/native.test.js`. Now unblocked, since
      its logs were only inaccessible while the Windows job hung. The usual cause on macOS is
      `prebuilds/darwin-arm64/spawn-helper` missing its executable bit or a valid signature.
- [ ] Evaluate `useConptyDll: true` for the fd leak and the 5 s tail.
- [ ] Drive a real full-screen TUI for WIN-18 rather than the fixture.
- [ ] Extend the matrix to Linux and macOS ARM64 so the platform table in the README can be
      marked verified rather than targeted.
- [ ] Upstream the three node-pty issues and track them.

## 13. Conclusion

Sentiora Terminal works on Windows 11 ARM64 build 26200 through native ConPTY. All 20 required
scenarios were executed against real pseudoterminals and real child processes, with no mocks,
and all 20 pass. Native components were verified as ARM64 by reading their PE headers, so no
emulation is involved and ARM64 support can be claimed for this configuration.

One blocking bug was found and fixed: `Session.close()` skipped `pty.kill()` for children that
had exited normally, which on Windows left node-pty's ConPTY conout worker thread alive and made
the host process **unexitable**. This affected every normal command execution, hung `npm test`
indefinitely, and was independently reproducing on GitHub's Windows runner for 1 h 51 m. The fix
is one line, is safe on Unix by inspection of `UnixTerminal.kill()`, and takes the suite from
never completing to 28/28 in ~50 s across four consecutive runs. CI independently confirms it on
x64: `windows-latest` went from still-running-after-1h51m to **passing in 1 m 20 s**.

Two real defects remain, both in node-pty rather than Sentiora, both measured and documented
rather than assumed away: a ~5 s shutdown tail from a helper that crashes on already-exited
processes, and one leaked file descriptor per session. Neither blocks correctness; both matter
for long-running servers.

The Telekinesis ConPTY failure (#49) does **not** reproduce here, on the same OS build and
architecture, which narrows it to Telekinesis's managed layer.
