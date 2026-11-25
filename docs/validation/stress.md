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

Resource exhaustion proper is in `test/bench/fd-exhaustion.mjs` (finds the descriptor ceiling) and
`test/bench/conpty-external-kill.mjs` (issue #21). Bounded capacity and recovery after exhaustion
are asserted in `test/fault-injection.test.js` FI-09 and `test/server.test.js` ST14-05/ST14-12,
which run in CI; this harness is too long for a per-commit job.

## Thresholds

Every number has a stated reason, so a breach reads as a regression and raising a limit later has
to confront the reason.

| Threshold | Limit | Reason |
| --- | --- | --- |
| `childrenSurvivingPerPhase` | 0 | A surviving child is a leaked shell process. No tolerance. |
| `readyFailures`, `echoFailures` | 0 | A session that never became operational, or a round trip that never returned |
| `inputFailures`, `writeErrors` | 0 | Accepted input must not be lost |
| `crossTalk` | 0 | Output appearing in the wrong session |
| `childDisagreements` | 0 | Runtime geometry differing from the child's own report |
| `wrongExitCode` | 0 | Ctrl-C must produce 130/1, not a fabricated code |
| `cancellationRate`, `exitDetectionRate` | 1 | Every Ctrl-C reaches the child; every external death is noticed |
| `D.recoveredWithNewSession` | = attempts | A crash must not poison the next session |
| `maxSocketLeakPerSession` | 1.5 | **Per session, not absolute** — see below |
| `maxWin32HandleLeakPerSession` | 3 | **Per session, not absolute** — see below |
| `maxMessagePortGrowth` | 2 | ConPTY conout workers; `kill()` disposes them |
| `maxThreadGrowth` | 5 | Threads return to baseline |
| `maxRssGrowthMb` | 250 | Absolute working-set growth over the whole run |
| `maxStartupP95Ms` | 10000 | Catches a hang, not a busy machine |
| `maxCloseP95Ms` | 5000 | `close()` returns immediately; the ~5 s tail is process *exit* |
| `maxInputRoundTripP95Ms` | 5000 | |
| `maxInterruptP95Ms` | 5000 | |

The two per-session leak thresholds encode a **known upstream cost**, not a target. node-pty 1.1.0
leaks exactly one libuv `Socket` per create/close cycle (`WindowsPtyAgent._inSocket` is never
destroyed, only marked unreadable) plus roughly 1.75 Win32 handles, and neither is reclaimable
through its public API. An absolute bound would therefore either fail every run or be so loose it
caught nothing. Expressed per session, the thresholds accept the documented leak and fail anything
materially worse.

## Measured — scale 1, win32 arm64, node v24.18.1, main @ `3fbbcb2`

```
total 152046ms   sessionsCreated 155
A  100 sessions  readyFailures 0  echoFailures 0
   startup  median 96ms  p95 106ms  max 120ms
   close    median  9ms  p95  12ms  max  16ms
   childrenSurviving 1   <-- BREACH
B  10 concurrent, 10 ready in 704ms, crossTalk 0, closeAll 110ms
   peak: Socket 120, MessagePort 10, rss 154.9MB, win32 handles 501, threads 34
C  20/20 interrupted, wrongExitCode 0, interrupt latency median 1023ms p95 1032ms
D  20/20 exitDetected, 20/20 inputRejected, 20/20 recoveredWithNewSession
E  25 cycles, 25 checked, childDisagreements 0, writes 50, writeErrors 0
F  200 inputs, 0 failures, round trip median 16ms p95 47ms max 48ms
G  5 sessions, 0 framing errors, runtime exitCode 0, shutdown 5082ms, 0 survivors

resource growth (baseline -> final)
   rss        56.5MB -> 73.4MB   (+16.9MB)
   Socket     0      -> 172      (+172 over 155 sessions = 1.11/session)
   win32 hdl  192    -> 493      (+301 over 155 sessions = 1.94/session)
   MessagePort 0     -> 0
   threads    13     -> 11

BREACH {"threshold":"A_sequential.childrenSurviving","value":1,"limit":0}
THRESHOLDS 1 breach of 19 documented limits
exit code 1
```

Everything passed except one thing, and the one thing that failed is real.

### The leak the thresholds found

Phase A opened and closed 100 sessions sequentially, waited 8 s, then checked all 100 child pids.
**One was still alive** (pid 8284). The other six phases, covering 55 more sessions, leaked nothing.

This is not a regression from anything in this change: phase A drives `Session` directly and the
harness is unmodified apart from the threshold block. It was simply never *detected* before, because
the harness reported `childrenSurviving` and nothing asserted on it. That is the argument for
`--assert` in one line.

It is intermittent and it is not yet root-caused. The leading candidate is the same node-pty 1.1.0
ConPTY teardown path implicated in issue #21, where `kill()` forks `conpty_console_list_agent` and
only resolves via a 5 s timeout; a child that is mid-write when the pseudoconsole closes may
outlive the 8 s settle. **The threshold stays at 0.** Weakening it to 1 to make the run green would
discard the only signal that found this.

Tracked as issue #24.

## What this does not cover

- **Hundreds of lifecycle iterations in CI.** Scale 1 is 155 sessions and ~2.5 minutes; the harness
  is not wired into `npm test` or `ci.yml`, because a per-commit job that spawns 155 real PTYs would
  dominate the matrix. It is run manually and before release.
- **The ~495 session ceiling.** `fd-exhaustion.mjs` walks toward it deliberately; this harness stays
  well under it so a breach means something.
- **Non-Windows resource metrics.** Win32 handles and threads are PowerShell-only. On Linux and
  macOS those thresholds are skipped rather than satisfied, and the result says so.
- **Concurrency above 10.** Phase B's count scales, but a 10-way burst is not a load test; the
  capacity ceiling is 16 sessions by design and FI-09 covers filling it.
