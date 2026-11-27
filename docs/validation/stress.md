# Stress testing and acceptance thresholds

Issue #16. Concurrent sessions, lifecycle churn, resource exhaustion, recovery, and the numbers
that decide whether a run passed.

`test/bench/lifecycle-stress.mjs` had seven phases and printed a `RESULT` line nobody could fail.
This adds `--assert`: documented limits, checked against the measurements, with a non-zero exit on
breach.

```
npm run stress            # measure only, exit 0 regardless
npm run stress:assert     # scale 1   — ~155 sessions, ~2.5 min, asserts
npm run stress:quick      # scale 0.25 — ~39 sessions, ~1.5 min, asserts
npm run bench:fd          # find the descriptor ceiling (separate harness)
```

The scale argument multiplies every phase count. Flags are filtered out before it is parsed, so
`--assert` on its own cannot be mistaken for a scale and silently reduce every phase to one
iteration.

## Phases

| Phase | What it does | Scale 1 |
| --- | --- | --- |
| A | Sequential create → ready → round-trip → close | 100 sessions |
| B | Concurrent sessions, all opened at once, checked for cross-talk | 10 sessions |
| C | Ctrl-C cancellation: the child must be interrupted and report its real exit code | 20 attempts |
| D | Child killed externally: the runtime must notice, refuse further input, and recover with a new session | 20 attempts |
| E | Repeated resize, verifying the child's own view of the geometry agrees with the runtime's | 25 cycles |
| F | Interactive input round trips | 200 inputs |
| G | Runtime shutdown with sessions still active | 5 sessions |

Resource exhaustion proper is in `test/bench/fd-exhaustion.mjs` (walks toward the descriptor
ceiling) and `test/bench/conpty-external-kill.mjs` (measures the #21 host crash). Bounded capacity
and recovery are asserted in `test/server.test.js` ST14-05 and ST14-12, which run in CI on every
platform; `test/fault-injection.test.js` FI-09 and FI-10 also cover it but are gated off on
`windows-latest` + node 22 because of #21.

## Thresholds

Every number has a stated reason, so a breach reads as a regression and raising a limit later has to
confront the reason. The table below is the complete `THRESHOLDS` object — 20 entries, matching the
"20 declared limits" the run prints — followed by the checks whose limit is derived from the
measurement rather than declared.

### Declared limits

| Threshold | Limit | Reason |
| --- | --- | --- |
| `childrenSurvivingPerPhase` | 0 | A surviving child is a leaked shell process. No tolerance. Applied to every phase, using the late (38 s) figure where a phase takes one. |
| `readyFailures` | 0 | A session that never became operational |
| `echoFailures` | 0 | A round trip that did not come back |
| `inputFailures` | 0 | An accepted write that failed |
| `crossTalk` | 0 | Output appearing in the wrong session |
| `childDisagreements` | 0 | Runtime geometry differing from the child's own report |
| `writeErrors` | 0 | Asynchronous writes lost |
| `wrongExitCode` | 0 | Ctrl-C must produce 130/1, not a fabricated code |
| `closeErrors` | 0 | A `close()` that had to absorb a cleanup failure — invisible to every other check, since `close()` absorbs by design |
| `maxShutdownMs` | 30000 | Phase G, stdin EOF to host exit; measured 5083 ms |
| `runtimeExitCode` | 0 | Phase G's host must exit cleanly; the comparison is `!==`, so the string `'TIMEOUT'` breaches too |
| `maxSocketLeakPerSession` | 1.5 | **Per session, not absolute** — see below. Measured 1.00. |
| `maxWin32HandleLeakPerSession` | 3 | **Per session, not absolute** — see below. Measured 1.75. |
| `maxMessagePortGrowth` | 2 | ConPTY conout workers; `kill()` disposes them |
| `maxThreadGrowth` | 5 | Threads return to baseline |
| `maxRssGrowthMb` | 250 | Absolute working-set growth over the whole run |
| `maxStartupP95Ms` | 10000 | Catches a hang, not a busy machine |
| `maxCloseP95Ms` | 5000 | `close()` returns immediately; the ~5 s tail is process *exit* |
| `maxInputRoundTripP95Ms` | 5000 | |
| `maxInterruptP95Ms` | 5000 | |

Two earlier entries, `cancellationRate` and `exitDetectionRate`, were **removed**. They were
declared, documented and counted in the summary, but nothing ever read them — the intent they
expressed is enforced more strongly by the derived count checks below, which compare against each
phase's own attempt count and so cannot go stale when a phase is resized.

### Derived count checks

These take their limit from the measurement, so a phase that shrank or silently did nothing cannot
pass by comparing a small number against a smaller one. **A missing limit is a breach, not a skip**:
`v < undefined` is `false`, so a phase that never reported used to sail through.

| Check | Must equal |
| --- | --- |
| `B.becameReady` | `B.sessions` |
| `C.interrupted` | `C.attempts` |
| `D.exitDetected` | `D.attempts` |
| `D.inputRejected` | `D.attempts` |
| `D.recoveredWithNewSession` | `D.attempts` — it is a count of successful recoveries, not a boolean |
| `G.sessionsCreated` | the requested 5 (× scale) |
| `G.protocolErrors` | 0 |
| `phaseCompleted:<phase>` | emitted as a breach for any phase that threw, so an abort cannot read as a pass |

Checks whose value could not be measured are reported under `SKIPPED` with their names, and counted
in the summary line — a skip is not a pass.

The two per-session leak thresholds encode a **known upstream cost**, not a target. node-pty 1.1.0
leaks exactly one libuv `Socket` per create/close cycle (`WindowsPtyAgent._inSocket` is never
destroyed, only marked unreadable) plus roughly 1.75 Win32 handles, and neither is reclaimable
through its public API. An absolute bound would therefore either fail every run or be so loose it
caught nothing. Expressed per session, the thresholds accept the documented leak and fail anything
materially worse.

## Measured — scale 1, win32 arm64, node v24.18.1

Three full-scale runs were performed while developing the thresholds. The final one, on the
committed code:

```
THRESHOLDS 0 breach(es), 0 skipped, 20 declared limits, 172 in-process sessions
exit code 0, totalMs 147723

A  100 sequential: 0 ready failures, 0 echo failures, 0 close errors
   startup  median 93ms  p95 113ms  max 120ms
   close    median 11ms  p95  19ms  max  25ms
   childrenSurviving 0 (8s)   childrenSurvivingLate 0 (38s)
   exitedReported 0   orphanCandidates 100   unprobeablePids 0
B  10 concurrent, 10 ready in 739ms, crossTalk 0, closeAll 122ms
   peak: Socket 120, MessagePort 10, rss 164.4MB, win32 handles 501, threads 34
C  20/20 interrupted, wrongExitCode 0, interrupt latency median 1027ms p95 1034ms
D  20/20 exitDetected, 20/20 inputRejected, 20/20 recoveredWithNewSession
E  25 cycles, 25 checked, childDisagreements 0, writes 50, writeErrors 0
F  200 inputs, 0 failures, round trip median 16ms p95 46ms max 48ms
G  5 sessions, 0 protocol errors, runtime exitCode 0, shutdown 5083ms, 0 survivors

resource growth (baseline -> final)
   rss        56.8MB -> 72.6MB   (+15.8MB)
   Socket     0      -> 172      = 1.00 per in-process session
   win32 hdl  192    -> 493      (+301) = 1.75 per in-process session
   MessagePort 0     -> 0
   threads    13     -> 11
```

The two per-session rates land on **exactly 1.00 and 1.75** — the figures node-pty 1.1.0's leak is
documented at, and the figures the thresholds were chosen against. That agreement is the reason to
trust the divisor, which is now counted at the source in `openSession()` rather than reconstructed
from phase totals. The reconstruction was wrong in both directions: it omitted the replacement
session phase D spawns per attempt and the single session each of E and F uses (22 cycles at scale
1), and it added phase G's 5 sessions, which live in the *server child process* and leak nothing
here. That gave 155 against a true 172, published 1.11/1.94 per session, and enforced a limit ~11%
stricter than the reasoning that chose it.

### The survivor that started #24, and what three runs actually say

The first full-scale run breached:

```
BREACH {"threshold":"A_sequential.childrenSurviving","value":1,"limit":0}
```

One child out of 100 was still alive 8 s after its `close()`. Issue #24 was filed on that single
observation and said so. Two more runs followed:

| Run | Survivors at 8 s | Survivors at 38 s | `closeErrors` |
| --- | --- | --- | --- |
| 1 | 1 (pid 8284) | not measured | not measured |
| 2 | 1 (pid 30292) | 1 (**pid 5692**) | 0 |
| 3 | 0 | 0 | 0 |

Run 2 is the informative one and it argues **against** a simple leak: the survivor at 8 s and the
survivor at 38 s have **different pids**. A process cannot die and return, so either two different
children lingered, or — far more likely — the first was gone by 38 s and Windows had recycled that
pid to an unrelated process. `closeErrors` was 0 in both runs that measured it, so `close()` never
reported absorbing a failure.

Two changes came out of this, rather than a conclusion:

- **Orphan detection now excludes any pid whose session already reported an exit.** A live pid whose
  session exited is somebody else's process. Without this, pid reuse turns a clean run red — the
  exact false positive `docs/validation/endurance.md` predicts.
- **The breach threshold is the 38 s figure**, not the 8 s one. `Session.close()` on Windows forks
  `conpty_console_list_agent`, which dies with `AttachConsole failed` for an already-exited child,
  so node-pty resolves via a 5 s timeout; a child mid-write when the pseudoconsole closes can take
  longer. A pid alive at 8 s and gone at 38 s is slow teardown, not an orphan. The 8 s count is
  still reported.

**So #24 is not confirmed.** The honest state: 2 of 3 runs showed one pid alive at 8 s, one of those
two is explained by pid reuse, the third run was clean, and `close()` reported no failure in any of
them. Whether a true orphan ever occurs is unresolved, and #24 has been updated to say so rather
than left asserting a leak. The threshold stays at 0 — one clean run is not a reason to allow one.

## What this does not cover

- **It does not run in CI at all.** The harness is not wired into `npm test` or `ci.yml`, because a
  per-commit job spawning 172 real PTYs over ~2.5 minutes would dominate the matrix. It is run
  manually and before release. That has a consequence worth stating plainly: **nothing in CI
  measures descriptors, handles, threads, RSS, or a few hundred create/close cycles.** What CI does
  cover is narrower — `test/server.test.js` ST14-05 fills the registry to its 16-session limit,
  asserts refusal, drains and re-creates, and ST14-12 pipelines `limit + 8` creates in one write and
  asserts at most 16 are accepted. Between them those cover *bounded capacity and recovery*, not
  resource exhaustion and not hundreds of cycles.
- **Resource exhaustion at the ceiling.** `test/bench/fd-exhaustion.mjs` walks toward the ~495
  session limit deliberately; this harness stays well under it so that a breach means something.
- **The external-kill crash.** `test/bench/conpty-external-kill.mjs` measures the
  `STATUS_ACCESS_VIOLATION` host crash documented in #21. It is a measuring bench, not a test, and
  is not part of this harness's verdict.
- **Win32 handles and threads are Windows-only.** They are sampled with PowerShell. On Linux and
  macOS those two thresholds are *skipped*, not satisfied, and `thresholdInputs` records
  `win32: 'unavailable'` so the omission is visible in the result. Everything else — including
  child-liveness, which now uses a portable `process.kill(pid, 0)` probe rather than `tasklist` —
  runs on all three platforms. (It did not always: the earlier `tasklist` shell-out returned *every*
  pid when the command was missing, which would have produced seven false `childrenSurviving`
  breaches on Linux and macOS.)
- **Concurrency above 10.** Phase B's count scales, but a 10-way burst is not a load test; the
  capacity ceiling is 16 sessions by design, and filling it repeatedly is #17's FI-09 — which is
  itself gated off on `windows-latest` + node 22 because of #21.
