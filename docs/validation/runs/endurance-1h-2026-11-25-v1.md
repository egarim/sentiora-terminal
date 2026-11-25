# Endurance run — 1h tier, 2026-11-25 (harness revision v1, SUPERSEDED)

Committed because `artifacts/` is gitignored: without this, the numbers quoted in
`docs/validation/endurance.md` would rest on a file that no longer exists.

**Status: superseded.** This run was produced by the first revision of `test/bench/endurance.mjs`.
Independent review found two defects in that revision which make its *verdict* unsound, though not
its raw measurements:

1. `completed` was derived from the **wall clock**, so a clock step or a suspended machine could
   consume the budget without the work being done.
2. The p95 latency figure was the **churn cycle only**, ignoring the pool workload and all 152,758
   `observe` calls — so a large regression in observation latency would have passed.

Neither defect could have made this run report a *failure* as a pass in the direction that matters
here (it completed its duration and the host stayed healthy throughout), but the pass is not
comparable to a pass from the corrected harness and is not relied on. A re-run under the corrected
harness supersedes it.

## Environment

```
node v24.18.1, win32/arm64, local machine (not CI)
started  2026-11-25T10:50:11.259Z
finished 2026-11-25T11:50:16.503Z
config   pool=4  maxChurn=250  churnInterval=30000ms  sampleSeconds=30
         stallTimeout=120000ms  requestTimeout=30000ms
series   artifacts/endurance-1h-2026-11-25T10-50-11-246Z.jsonl (118 samples)
```

## Outcome

```
completed            true
requestedMinutes     60
actualMinutes        60.07
exit code            0
breaches             0
samples              118
hostExit             {code: 0, signal: null}   (clean shutdown)
corruptResponseLines 0
```

## Counters

| Counter | Value |
| --- | --- |
| cycles | 50,824 |
| creates / closes | 124 / 124 |
| writes | 50,824 |
| observes | 152,758 |
| waits | 50,986 |
| resizes | 2,532 |
| churnCycles | 120 |
| errors / timeouts / rpcErrors / hostDeaths | **0 / 0 / 0 / 0** |
| stalls | 0 |
| orphans | **0** (of 124 spawned) |

## Latency

| Operation | n | median | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| create | 124 | 67 ms | 89 ms | 251 ms | 251 ms |
| ready | 50,948 | 16 ms | 32 ms | 46 ms | 499 ms |
| write | 50,824 | 0 ms | 1 ms | 1 ms | 77 ms |
| resize | 2,532 | 1 ms | 2 ms | 3 ms | 14 ms |
| close | 124 | 10 ms | 13 ms | 16 ms | 16 ms |
| churn cycle | 120 | 208 ms | 230 ms | 292 ms | 374 ms |

## Resource trend (second quartile → final quartile)

| Metric | Change |
| --- | --- |
| RSS | **−14.7 MB** |
| Win32 handles | +59 over 59 churn cycles = **1.00 per cycle** |
| Threads | +1 |

Absolute RSS settled around 190–210 MB after roughly 20 minutes of warm-up and did not trend
upward over the remaining 40. The 1.00 handles-per-cycle figure reproduces node-pty 1.1.0's
documented leak at scale.

## Two anomalies recorded rather than smoothed over

- `write` latency reported a minimum of **−3 ms**. The v1 harness timed with `Date.now()`, which
  cannot go negative unless the wall clock stepped backwards — the same hazard that made v1's
  `completed` flag untrustworthy. The corrected harness times with `performance.now()`.
- 124 creates produced only **120 distinct pids**, i.e. Windows recycled four pids within the hour.
  v1's documentation described this as a risk of *missing* an orphan; that is backwards. A live
  orphan holds its pid, so it cannot be hidden by reuse. The real exposure is a **false positive** —
  a correctly-closed child whose pid was later reassigned to an unrelated live process would be
  reported as an orphan. Corrected in the current documentation.
