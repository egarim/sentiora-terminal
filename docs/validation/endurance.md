# Endurance testing

Issue #18. How long the runtime can serve sessions before it degrades, what it costs, and what
count as acceptable limits.

`test/bench/endurance.mjs` drives **one long-lived `src/server.js` host** over its real stdio
transport for the whole requested duration. Restarting the host would defeat the point: this
measures whether a single runtime process degrades over hours, not whether a fresh one works.

```
npm run endurance:smoke     #  2 minutes — shakedown, not evidence
npm run endurance:1h        #  1 hour
npm run endurance:8h        #  8 hours
npm run endurance:24h       # 24 hours

node test/bench/endurance.mjs --minutes=90 --pool=6 --sample-seconds=20 --out=series.jsonl
```

## Two workloads, because they measure different things

| Workload | What it does | What it proves |
| --- | --- | --- |
| **pool** | `--pool` sessions (default 4) opened once and exercised continuously — type a command, wait for the child to echo it, observe, resize every 20th cycle | Sustained use must be **flat**. Growth here is a defect in this runtime. |
| **churn** | One create → ready → write → close cycle every `churnIntervalMs` | Measures the **per-session leak rate**, which on node-pty 1.1.0 is a known upstream cost, not a defect here. |

Separating them matters. A single loop that only creates and closes would spend the whole run
measuring node-pty's descriptor leak and tell you nothing about whether the runtime itself is
stable; a single loop that only reuses sessions would never exercise teardown at all.

### Why churn is capped

node-pty 1.1.0 leaks one libuv `Socket` and roughly 1.75 Win32 handles per create/close cycle and
reclaims neither, and stops creating sessions near **495** with `Invalid pty handle` (an
unsynchronised global `std::vector` in `src/win/conpty.cc`; see issue #21 for a related fault in
the same table). Total churn is therefore capped by `--max-churn` (default 250) and the interval is
derived from the duration:

| Tier | Duration | Churn interval | Total churn |
| --- | --- | --- | --- |
| `smoke` | 2 min | 30 s (floor) | ~4 |
| `1h` | 60 min | 30 s (floor) | ~120 |
| `8h` | 480 min | ~115 s | ~250 |
| `24h` | 1440 min | ~346 s | ~250 |

Exceeding the cap would measure node-pty's ceiling rather than this runtime's endurance, and would
produce a "failure" that no change to `src/` could fix. The cap is a deliberate, documented
boundary — not a way of avoiding one.

## Exit codes: completed is not the same as passed

| Code | Meaning |
| --- | --- |
| 0 | Ran the **full** requested duration and met every threshold |
| 1 | Ran the full duration but breached at least one threshold |
| 2 | The host process died during the run |
| 3 | A stall was detected — a worker made no progress within `--stall-timeout-ms` |
| 4 | Interrupted before the requested duration |

The `RESULT` JSON always carries `requestedMinutes`, `actualMinutes` and a boolean **`completed`**.
A run that was cut short is exit 4, never exit 0. **Never report an endurance tier as passing
unless `completed` is `true` and the code was 0** — a truncated run is an unrun test, and reporting
it either way would be a false claim in one direction or the other.

## Thresholds

Defaults, all overridable on the command line. Growth thresholds compare the **median of the final
quartile against the median of the second quartile**, skipping the first quartile as warm-up, so a
one-off spike neither passes nor fails a run on its own. Fewer than 8 samples reports `null` rather
than a number, and a `null` is not checked — an unmeasurable platform must not silently pass.

| Threshold | Default | Reason |
| --- | --- | --- |
| `maxRssGrowthMb` | 150 | Host working set must be flat under sustained use |
| `maxHandleGrowthPerChurn` | 4 | **Per cycle, not absolute.** node-pty 1.1.0 measures ~1.75 and cannot be fixed from here, so an absolute bound would either fail every long run or be too loose to catch anything. A rate catches a regression that makes the leak worse. |
| `maxThreadGrowth` | 20 | `kill()` disposes the ConPTY conout worker; threads must return to baseline |
| `maxErrorRate` | 0.001 | Failed operations over total operations |
| `maxStalls` | 0 | Any stall is a deadlock candidate |
| `maxP95LatencyMs` | 2000 | Responsiveness must not degrade over hours |
| `maxOrphans` | 0 | Every child pid ever spawned must be gone once the host exits |

Orphan detection covers **every pid the host ever reported**, not just those a sample happened to
catch — a check over sampled pids would miss short-lived churn sessions, which are the ones most
likely to be dropped.

## What is sampled, and where it is not available

The host is a subprocess, so its resources are read from outside:

| Platform | RSS | Handles | Threads |
| --- | --- | --- | --- |
| Windows | `Get-Process.WorkingSet64` | `HandleCount` | `Threads.Count` |
| Linux | `/proc/<pid>/status` `VmRSS` | `/proc/<pid>/fd` count | `/proc/<pid>/status` `Threads` |
| macOS | `ps -o rss=` | **not available** → `null` | **not available** → `null` |

`null` is reported rather than approximated, and a `null` threshold is skipped. macOS endurance
runs therefore check memory, errors, stalls, latency and orphans, but not handles or threads. That
gap is stated here so a macOS result is not read as full coverage.

The full time series is written as JSON Lines to `--out` (default
`artifacts/endurance-<tier>-<timestamp>.jsonl`; `artifacts/` is gitignored). One line per sample
with host and bench memory, handle and thread counts, live session count and pids, cumulative
counters, error rate and stall count. **The series is the evidence**; the summary is a digest of it.

## CI

`.github/workflows/endurance.yml` is **`workflow_dispatch` only**. It never runs on push or
pull_request: an endurance run occupies a runner for its whole duration, and triggering it per
commit would bill hours of CI to every review round. Issue #18 requires this separation.

GitHub-hosted jobs are capped at **6 hours**, so the `8h` and `24h` tiers cannot run there. The
workflow's preflight step refuses them unless `self_hosted` is set, rather than letting the job be
killed at the cap — which would report a truncated run as a failure instead of as "never
completed". `cancel-in-progress: false` for the same reason: a partial run is worthless as
evidence.

The run step uses `continue-on-error` so the time series and `RESULT` line are still uploaded when
a threshold is breached. A breach is the interesting outcome; losing its evidence would be worse
than the red X. A separate reporting step then fails the job on `completed=false` or on any breach,
printing both.

## Recorded runs

| Date | Tier | Platform | Node | Completed | Exit | Breaches | Series |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-25 | `1h` | win32 **arm64** (local) | v24.18.1 | **true** (60.07 / 60 min) | **0** | **0** | `endurance-1h-2026-11-25T10-50-11-246Z.jsonl`, 118 samples |
| — | `8h` | — | — | **never executed** | — | — | — |
| — | `24h` | — | — | **never executed** | — | — | — |

The 8h and 24h tiers are implemented and runnable but **have not been executed**. They are not
claimed as passing, and no result should be inferred for them from the 1h row.

### 1h run, 2026-11-25, win32 arm64, node v24.18.1

One host process, 4 pooled sessions exercised continuously plus one create/close churn every 30 s.

```
counters   cycles 50824   creates 124   closes 124   writes 50824
           observes 152758   waits 50986   resizes 2532   churnCycles 120
           errors 0   timeouts 0   rpcErrors 0   hostDeaths 0
latency    create  median 67ms  p95 89ms   max 251ms
           ready   median 16ms  p95 32ms   max 499ms
           write   median  0ms  p95  1ms   max  77ms
           resize  median  1ms  p95  2ms   max  14ms
           close   median 10ms  p95 13ms   max  16ms
           churn cycle (create→ready→write→close) median 208ms p95 230ms max 374ms
measurement rssGrowthMb -14.7   handleGrowth 59   threadGrowth 1
            handleGrowthPerChurn 1.00   errorRate 0   stalls 0   orphans 0
host exit  code 0 (clean shutdown)   corruptResponseLines 0
```

Read against the thresholds:

- **Memory flat.** RSS went *down* 14.7 MB between the second and final quartiles. The absolute
  level settled around 190–210 MB after roughly 20 minutes of warm-up and did not trend upward
  over the remaining 40.
- **Handle leak measured at exactly 1.00 Win32 handles per create/close cycle**, against a
  threshold of 4. This is node-pty 1.1.0's documented leak, reproduced at scale, and it is the
  reason the threshold is a rate rather than an absolute.
- **Threads flat** (+1), confirming `kill()` really does dispose the ConPTY conout worker.
- **Zero errors** across 50,824 cycles and 152,758 observations; zero timeouts; zero RPC errors;
  zero corrupt response lines; zero stalls.
- **Zero orphans** out of 124 spawned children — nothing survived the host's clean exit.
- **Latency did not degrade.** A full churn cycle stayed at ~208 ms median with a 374 ms worst
  case, in the last quartile as well as the first.

`write` latency reports a minimum of −3 ms. That is `Date.now()` resolution around a sub-millisecond
operation, not a negative duration; it is recorded rather than silently clamped so the number is
not mistaken for a measurement of something that took no time at all.

### Known measurement limitation

Orphan detection is by pid, and **Windows recycles pids**: this run recorded 124 creates but only
120 distinct pids, so four pids were reused within the hour. A leaked child whose pid was later
reassigned to a new child would be counted as alive-but-expected rather than as an orphan, and a
dead child whose pid was reused would look alive. Over one hour at this churn rate the exposure is
small and the count was zero either way, but a 24 h run at higher churn should treat a non-zero
orphan count as a lower bound, not an exact figure.

## Known limitations

- **The churn workload is capped by node-pty, not by this runtime.** A 24 h run performs ~250
  create/close cycles, which is far below what a busy multi-user deployment would do. Raising it
  requires either a node-pty upgrade (deferred until 1.2.0 is stable latest) or the host recycling
  described in issue #21.
- **Single host process.** This measures one runtime, not a fleet, and not the desktop bridge's
  host pool.
- **No fault injection.** Endurance runs the happy path for hours. Crashes, transport loss and
  ownership violations are `test/fault-injection.test.js` (issue #17); capacity exhaustion and
  recovery are `test/bench/lifecycle-stress.mjs --assert` (issue #16).
- **The stall detector is only as good as its timeout.** `--stall-timeout-ms` defaults to 120 s; a
  hang shorter than that shows up as latency, not as a stall.
