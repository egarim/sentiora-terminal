# Endurance testing

Issue #18. How long the runtime can serve sessions before it degrades, what it costs, and what
counts as acceptable.

`test/bench/endurance.mjs` drives **one long-lived `src/server.js` host** over its real stdio
transport for the whole duration. Restarting the host would defeat the point: this measures
whether a single runtime process degrades over hours, not whether a fresh one works.

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
| **churn** | One create → ready → write → close cycle on an interval | The **per-session leak rate**, which on node-pty 1.1.0 is a known upstream cost, not a defect here. |

A single loop doing only one of these would either spend the whole run measuring node-pty's
descriptor leak, or never exercise teardown at all.

### Why churn is capped

node-pty 1.1.0 leaks one libuv `Socket` and roughly 1.75 Win32 handles per create/close cycle and
reclaims neither, and stops creating sessions near **495** with `Invalid pty handle` (an
unsynchronised global `std::vector` in `src/win/conpty.cc`; see issue #21 for a related fault in
the same table). Total churn is therefore capped by `--max-churn` (default 250, hard-limited to
495) and the interval is derived from the duration:

| Tier | Duration | Churn interval | Total churn |
| --- | --- | --- | --- |
| `smoke` | 2 min | 30 s (floor) | ~4 |
| `1h` | 60 min | 30 s (floor) | ~120 |
| `8h` | 480 min | ~115 s | ~250 |
| `24h` | 1440 min | ~346 s | ~250 |

The budget is spread across *elapsed* time rather than run flat-out, so a slow run cannot exhaust
it early and then spend the remaining hours measuring nothing. Exceeding the cap would measure
node-pty's ceiling and report it as this runtime's failure, which is why the flag is range-checked
rather than merely documented.

## What `completed` requires

A run reports `completed: true` only when **all** of these hold:

1. The workload loops ran for the full requested duration on a **monotonic** clock
   (`performance.now()`). Wall-clock time is not used for the budget, so a clock step forward or a
   laptop suspending mid-run cannot consume the duration without the work happening.
2. **Every** workload ran to its natural end. A pool worker that died in minute one and left the
   host running is a failure, not a pass — `workerState` records each worker's `finished` flag and
   cycle count.
3. The host did not die during the run.
4. No stall was detected.

| Exit code | Meaning |
| --- | --- |
| 0 | Completed, every workload alive to the end, all thresholds met |
| 1 | Completed but breached at least one threshold |
| 2 | The host process died during the run |
| 3 | A stall was detected |
| 4 | Interrupted, or a workload gave up before the duration elapsed |
| 5 | The harness itself failed (could not sample, could not write the series) |

**Never report a tier as passing unless the exit code was 0 and `completed` is `true`.** A
truncated run is an unrun test; reporting it either way is a false claim in one direction or the
other.

### Stall detection is per-worker

A worker that has not made progress within its own budget is a stall. The budget is
`max(--stall-timeout-ms, that worker's declared idle time)`, because the churn worker legitimately
sleeps for ~346 s between cycles on the 24 h tier: a single global timeout would abort every long
run as a "stall" two minutes in. Idleness is declared, not faked — the sleep loop does **not**
heartbeat, so a genuinely wedged host is still caught.

## Thresholds

Defaults, all overridable. Trend thresholds compare the **median of the final quartile against the
median of the second quartile**, skipping the first quartile as warm-up, and require at least
**20 samples** — below that a quartile median is decided by a single point, so the metric reports
`null` instead.

| Threshold | Default | Reason |
| --- | --- | --- |
| `maxRssGrowthMb` | 150 | Host working set must be flat under sustained use |
| `maxHandleGrowthPerChurn` | 4 | **Per cycle, not absolute.** node-pty 1.1.0 measures ~1.75 and cannot be fixed from here, so an absolute bound would either fail every long run or be too loose to catch anything. A rate catches a regression that makes the leak worse. |
| `maxThreadGrowth` | 20 | `kill()` disposes the ConPTY conout worker; threads must return to baseline |
| `maxErrorRate` | 0.001 | `errors / (successful operations + errors)`. Deliberately not errors/successes — that ratio reports **0 when everything failed** |
| `maxStalls` | 0 | Any stall is a deadlock candidate |
| `maxLatencyDegradationRatio` | 3 | Final-quartile p95 ÷ second-quartile p95. An absolute ceiling alone passes a run that got 8× slower over its own duration, which is what endurance testing exists to catch |
| `maxP95LatencyMs` | 2000 | Absolute backstop on the churn cycle (measured p95 230 ms), so a hang or an order-of-magnitude regression fails even when the trend ratio does not |
| `maxP95ObserveMs` | 1000 | `observe` is the highest-volume call — three per pool cycle — so a regression there is diluted into the cycle figure without its own ceiling (measured p95 0.7 ms) |
| `minThroughputRatio` | 0.5 | Final-quartile cycles/min ÷ second-quartile. Catches a collapse that no single call would reveal |
| `maxOrphans` | 0 | Every pid the host ever reported must be gone once it exits |
| `maxLiveSessions` | `pool + 2` | If `terminal.close` stopped releasing registry entries this climbs toward 16; visible in every sample, so it is checked |
| `minMeasurableSampleFraction` | 0.9 | A run that could not read the host's resources is not a pass, however green everything else looks |

Arguments are validated, not trusted: `--pool` is 1–15 (one slot must stay free for the churn
workload, since the host's own limit is 16), `--max-churn` is 1–495 (the node-pty ceiling),
`--minutes` is at least 1, `--sample-seconds` at least 1, and an unknown `--tier` is rejected.
`--pool=0` would otherwise produce a green "sustained use" run containing no sustained use, and
`--sample-seconds=0` would spin the sampler hard enough to starve the process it measures.

Beyond the thresholds, these conditions are reported as breaches, because each would otherwise let
a broken run look healthy:

- the run produced **fewer samples than the trend floor**, so no trend was evaluated at all —
  without this, a 36-second run and a 24-hour pass are indistinguishable by exit code;
- the **churn workload produced no cycles** inside the comparison window (which would delete the
  only leak-rate metric);
- the host had to be **SIGKILLed** to stop it (`neededKillToStop`), or exited with a **non-zero
  code or any signal** — a host that no longer exits cleanly on stdin EOF is itself a regression,
  and is the documented failure mode of a leaked ConPTY worker;
- any **coverage** figure below `minMeasurableSampleFraction`, per metric this platform claims to
  support *and* for the live-session count. A `terminal.list` that fails on every sample would
  otherwise fold to `sessions: 0` — inside the limit — and the run would pass having measured
  nothing;
- any workload did not run to completion.

`RESULT` also reports `thresholdsEvaluated` against `thresholdsDeclared`, so "0 breaches" can be
distinguished from "nothing was evaluated".

### What `null` means, and what it does not

A metric is `null` in two very different situations:

- **Unsupported on this platform.** macOS exposes RSS but no cheap handle or thread count, so those
  are `null` by design and `supportedMetrics` in the result says which metrics this platform
  provides. Skipping those is correct.
- **Not measurable in this run.** Fewer than 20 samples, or a sampling command that failed. This is
  *not* silently skipped: `measurableSamples`, `measurementFailures` and `measurableFraction` are
  reported, and a run where fewer than 90% of samples yielded host metrics is a breach. If
  PowerShell is blocked on a Windows runner, the run fails rather than reporting a clean pass with
  nothing measured.

## What is sampled

The host is a subprocess, so its resources are read from outside:

| Platform | RSS | Handles | Threads |
| --- | --- | --- | --- |
| Windows | `Get-Process.WorkingSet64` | `HandleCount` | `Threads.Count` |
| Linux | `/proc/<pid>/status` `VmRSS` | `/proc/<pid>/fd` count | `/proc/<pid>/status` `Threads` |
| macOS | `ps -o rss=` | unsupported → `null` | unsupported → `null` |

The full time series is written as JSON Lines to `--out` (default
`artifacts/endurance-<tier>-<timestamp>.jsonl`; `artifacts/` is gitignored). One line per sample:
host and bench memory, handles, threads, live session count and pids, cumulative counters,
windowed throughput, windowed p95 latency, error rate, stall and measurement-failure counts.

Because the series is gitignored, a run's `RESULT` JSON is committed to
`docs/validation/runs/` so the numbers behind any claim are inspectable without the original
machine. **The series is the evidence; the summary is a digest of it.**

## CI

`.github/workflows/endurance.yml` is **`workflow_dispatch` only**. It never runs on push or
pull_request: a run occupies a runner for its whole duration, and triggering it per commit would
bill hours of CI to every review round. Issue #18 requires this separation.

GitHub-hosted jobs are capped at **6 hours**, so `8h` and `24h` cannot run there. The preflight
step refuses them based on `runner.environment`, **not** on the `self_hosted` input — trusting the
input would let `tier=24h, runner=ubuntu-latest, self_hosted=true` start a run that gets killed at
the cap, reporting a truncated run as a failure instead of as one that never completed.

`cancel-in-progress: false`, and the concurrency group is keyed on the **runner alone**, so two
tiers cannot run concurrently on one self-hosted machine and corrupt each other's measurements.

The run step uses `continue-on-error` so the series and `RESULT` line still upload when a threshold
is breached; a separate reporting step is the real gate and fails the job on `completed=false` or
on any breach. The harness flushes `RESULT` through the write callback rather than calling
`process.exit()` immediately, because stdout is a pipe and an immediate exit can truncate the very
line the reporter parses.

## Recorded runs

| Date | Tier | Platform | Node | Completed | Exit | Breaches | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-25 | `1h` | win32 **arm64** (local) | v24.18.1 | **true** (60.12 / 60 min) | **0** | **0** | [`runs/endurance-1h-2026-11-25.md`](runs/endurance-1h-2026-11-25.md) |
| 2026-11-25 | `1h` | win32 arm64 (local) | v24.18.1 | true (60.07 / 60 min) | 0 | 0 | [`runs/…-v1.md`](runs/endurance-1h-2026-11-25-v1.md) — **superseded** |
| — | `8h` | — | — | **never executed** | — | — | — |
| — | `24h` | — | — | **never executed** | — | — | — |

The 8h and 24h tiers are implemented and runnable but **have not been executed**. They are not
claimed as passing, and no result should be inferred for them from the 1h rows. A tier that has not
run is listed as "never executed" rather than omitted, so the table cannot be read as complete
coverage.

The current 1h result: 50,758 cycles, 152,523 observations, **0 errors, 0 stalls, 0 orphans**, RSS
growth −17.2 MB, handle leak exactly 1.00 per churn cycle, and both the latency-trend and
throughput ratios at 1.000 — no degradation across the hour. It ran on harness revision `f8cb0bd`
and its series was independently replayed against the current thresholds, which it also passes; the
run record has both sets of numbers.

The v1 row was produced by an earlier revision whose `completed` flag was wall-clock based and
whose latency figure ignored `observe` entirely. Its counters are valid observations; its *pass* was
not comparable, so it is retained marked superseded rather than deleted.

A tier is only eligible to report a trend verdict if it was configured to produce at least 20
samples (`trendEligible` in `RESULT`). The `smoke` tier at its default 30 s interval produces four
and is therefore a shakedown, not evidence — `npm run endurance:smoke` passes `--sample-seconds=5`
so that it does exercise the trend path.

## Known limitations

- **The churn workload is capped by node-pty, not by this runtime.** A 24 h run performs ~250
  create/close cycles, far below what a busy multi-user deployment would do. Raising it requires a
  node-pty upgrade (deferred until 1.2.0 is stable latest) or host recycling — see issue #21.
- **Trend comparison has blind spots.** A leak that is large during the warm-up quartile and flat
  afterwards is inside the skipped first quartile, so Q2→Q4 shows little growth; the same is true of
  a leak that starts and stops early. There is no absolute resource ceiling, only growth.
- **Orphan detection is by pid, and Windows recycles pids.** The real exposure is a *false
  positive*: by the end of a long run, the pid of a correctly-closed child may have been reassigned
  to an unrelated live process, which would be reported as an orphan and fail the run. A genuinely
  orphaned child cannot be hidden this way, because it holds its pid while alive. A 1h run recorded
  124 creates but 120 distinct pids, so reuse does happen at this churn rate.
- **Single host process.** This measures one runtime, not a fleet, and not the desktop bridge's
  host pool.
- **No fault injection.** Endurance runs the happy path for hours. Crashes, transport loss and
  ownership violations are `test/fault-injection.test.js` (issue #17); capacity exhaustion and
  recovery are `test/bench/lifecycle-stress.mjs --assert` (issue #16).
- **The harness itself grows.** Every latency sample is retained in memory for the whole run, so a
  24 h run at ~14 cycles/s accumulates on the order of 10⁷ numbers in the *bench* process. That is
  separate from the host under test and does not affect its measurements, but it bounds how long
  the harness can run unattended; a future revision should stream percentiles instead of retaining
  samples.
- **The duration budget includes host startup.** `t0` is taken at module load, before the host is
  spawned and `initialize` is answered, so `actualMinutes` is marginally generous — bounded in
  practice by the 30 s `initialize` request timeout, not by the 5 s completion tolerance. For any
  tier that produces enough samples to evaluate a trend the lost work is well under 1% of the
  budget, and every verdict-bearing metric is sample- or quartile-based rather than duration-based,
  so it cannot change a verdict. It is not corrected because doing so would complicate the budget
  arithmetic for no verdict gain; it is recorded so the number is not read as pure workload time.
- **`errorRate` has no per-operation breakdown.** Its denominator counts every successful operation
  (~3×10⁵ per hour, and ~5–6 counted operations per unit of churn work), so a failure rate that is
  catastrophic for one operation can sit below the 1e-3 limit. A `terminal.close` failure is not
  caught by it at all — `abandon()` deregisters unconditionally and `Session.close()` absorbs
  cleanup failures, so no RPC error is raised and the live-session count does not rise. What does
  catch a close that failed to kill its child is the orphan sweep. A close whose cleanup failed
  *without* leaving a live child is currently caught only by the `sentiora: cleanup failed`
  diagnostic in `hostStderrTail`, which is captured but not thresholded. Known gap, not fixed here.
