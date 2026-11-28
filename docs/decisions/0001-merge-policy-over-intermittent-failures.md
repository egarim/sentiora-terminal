# 0001 — Merging over known intermittent failures

- **Status:** accepted (owner, 2026-11-28)
- **Supersedes:** the narrower rule proposed on #21 on 2026-11-28, which allowed a retry only for a
  proven `3221225477` crash.
- **Context issue:** #21 (node-pty teardown defects); the rule was negotiated there and is recorded
  here so a future reviewer does not have to find comment 15 of 17.

## Problem

The runtime depends on node-pty 1.1.0, which has two defects this repository cannot fix: an
access-violation crash (`3221225477`) under external-kill churn, and — until #68 — a teardown that
never returned because `kill()` was deferred behind terminal readiness. Both redden CI at random, on
branches that cannot possibly have caused them.

The first rule I wrote covered only a proven crash. That is too narrow: it treats every other red
cell as if it were the change's fault, which is how a correct fix waits forever behind a defect it
does not touch. PR #55 sat held for exactly that reason.

## Decision

A red CI cell may be retried once and merged with disclosure when **all three** hold:

1. **Mechanical independence** — the branch changes no `src/` and no test in the failing suite, so it
   cannot have caused the failure.
2. **Empirical equality** — the same suite, run N times on `main` and N times on the branch, fails at
   a comparable rate. In practice both zero locally while CI reddens, which identifies the failure as
   environmental rather than behavioural.
3. **The failure is named** — its test, its assertion, exit code and duration are recorded on the
   pull request, not merely "CI was red".

Independence is *proved*, not assumed. The mechanical check rules out causation; the A/B rules out
"it just happens to pass here".

## Rules that stay

- **One** diagnostic retry, per failing cell, for crashes and hangs. A successful retry does not erase
  the original failure: the PR records it, including how many retries were used.
- **Never weaken a test, never add a retry to manufacture green.** If a flake is in the test, fix the
  test and say so — that is what happened to STR-07 (#51).
- **Never merge over a red you cannot name.** An unexplained failure is a reason to stop, not a
  reason to retry.
- The merged commit is the commit that was verified. If `main` moved, rebase and re-verify.

## How it has been applied

| PR | red cell | why it was unrelated | outcome |
| --- | --- | --- | --- |
| #55 | `FI-03 server never exited` | no `src/` or fault-suite change; `test:fault` 0/5 failed on both `main` and the branch | merged after one retry |
| #59, #60 | `ST14-05` / native-suite abort with `3221225477` | docs-only and UI-only diffs; suites green locally | merged after one retry |
| #68 | `ST14-05` with `3221225477` | the crash, named with its exit code; `test:server` 80/80 locally | merged after one retry |

## Consequences

- A correct fix is no longer held indefinitely by an unrelated upstream defect.
- Every merge over red carries a written justification, so the pattern is auditable rather than
  invisible.
- The rule does not make CI green; it makes the *reason* for a red cell explicit and the retry
  bounded. The underlying crash still needs the node-pty upgrade decision
  (`0002-node-pty-version-policy.md`).
