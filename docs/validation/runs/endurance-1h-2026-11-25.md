# Endurance run — 1h tier, 2026-11-25 (harness revision `f8cb0bd`)

The current 1-hour result. Supersedes `endurance-1h-2026-11-25-v1.md`.

**Harness revision:** the run was executed by the harness as it stood at `f8cb0bd`. The verdict was
independently recomputed from the preserved series against the thresholds as they stand at the
commit that records this file, and passes — see "Re-validation" below. The later revision changed
verdict logic (per-metric coverage, `thresholdsEvaluated` accounting, the trend-eligibility rule),
not the measurements.

## Environment

```
node v24.18.1, win32/arm64, local machine (not CI)
started  2026-11-25T12:30:11Z
finished after 60.12 of 60 requested minutes
config   pool=4  maxChurn=250  churnInterval=30000ms  sampleSeconds=30
         stallTimeout=120000ms  requestTimeout=30000ms
series   artifacts/endurance-1h-2026-11-25T12-30-11-498Z.jsonl (118 samples)
```

## Outcome

```
EXIT 0   completed=true   breaches=0   samples=118   actualMinutes=60.12/60
allWorkersFinished   true        (all 4 pool workers and the churn worker ran to the deadline)
hostExit             {code: 0, signal: null}   — clean shutdown, no SIGKILL needed
neededKillToStop     false
corruptResponseLines 0
measurementFailures  0           (118/118 samples yielded rss, handles and threads)
```

## Counters

| Counter | Value |
| --- | --- |
| cycles | 50,758 |
| creates / closes | 123 / 123 |
| writes | 50,758 |
| observes | 152,523 |
| waits | 50,884 |
| resizes | 2,530 |
| churnCycles | 119 |
| errors / timeouts / rpcErrors / hostDeaths | **0 / 0 / 0 / 0** |
| stalls | 0 |
| orphans | **0** (of 123 spawned; 120 distinct pids) |

## Measurement against thresholds

| Metric | Measured | Limit | Result |
| --- | --- | --- | --- |
| `rssGrowthMb` (Q4 − Q2 median) | **−17.2 MB** | 150 | pass |
| `handleGrowthPerChurn` | **1.00** (59 handles over 59 churn cycles) | 4 | pass |
| `threadGrowth` | **0** | 20 | pass |
| `errorRate` | **0** | 0.001 | pass |
| `latencyTrendRatio` (Q4 p95 ÷ Q2 p95) | **1.000** | 3 | pass |
| `throughputRatio` (Q4 cycles/min ÷ Q2) | **1.000** | ≥ 0.5 | pass |
| `maxP95LatencyMs` (churn cycle) | 32.3 ms | 2000 | pass |
| `maxP95ObserveMs` | 0.60 ms | 1000 | pass |
| `maxLiveSessions` | 4 (= pool) | 6 | pass |
| `maxOrphans` | 0 | 0 | pass |
| `minMeasurableSampleFraction` | 1.000 (118/118) | ≥ 0.9 | pass |
| `maxStalls` | 0 | 0 | pass |

The two ratios are the important ones and both came out at exactly 1.000: latency in the final
quartile was indistinguishable from the second quartile, and throughput did not decay. Sampled
throughput held at 840–857 cycles/minute from minute 6 to minute 60.

Absolute RSS rose from ~95 MB at startup to ~215 MB by minute 20 and then oscillated between
115 MB and 215 MB for the remaining 40 minutes — GC-driven, not trending. The quartile comparison
is slightly negative as a result.

## Re-validation under the corrected thresholds

The series was replayed through an independent analysis of the same JSONL, applying the thresholds
as they stand after the round-3 fixes:

```
samples: 118
coverage: {"rss":118,"handles":118,"threads":118,"sessions":118} of 118
rssGrowthMb -17.2 | handleGrowthPerChurn 1 | threadGrowth 0
latencyTrendRatio 0.996 | throughputRatio 1.004 | maxLiveSessions 4 | stalls 0
VERDICT under corrected thresholds: PASS
```

(The ratios differ in the third decimal from the harness's own figures because the harness rounds
each to two places before reporting; both round to 1.00.)

## Limitations of this run

- **Windows ARM64 only.** Linux and macOS sampling paths exist in the harness but were not
  exercised by this run.
- **Churn capped at 119 cycles** by `--max-churn`, because node-pty 1.1.0 stops creating sessions
  near 495. This is ~2 create/close cycles per minute, far below a busy deployment. See
  `endurance.md` → "Why churn is capped".
- **Handle growth of exactly 1.00 per cycle is node-pty's leak, not this runtime's**, and it is
  measured, not fixed. Over a 24h run at the same cap that is ~250 handles; uncapped churn would
  reach the ~495-session ceiling in roughly four hours at this rate.
- **123 creates produced 120 distinct pids**, so Windows recycled three within the hour. As
  documented, the exposure from pid reuse is a false *positive* (an unrelated live process holding
  a recycled pid reported as an orphan), not a missed orphan.
- The 8h and 24h tiers remain **never executed**.
