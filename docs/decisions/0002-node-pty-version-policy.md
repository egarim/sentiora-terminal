# 0002 — node-pty version policy

- **Status:** accepted (owner, 2026-11-28)
- **Context:** #21 (both defects and every measurement), #63/#68 (the contained hang)
- **Related:** `0001-merge-policy-over-intermittent-failures.md`

## Decision

- `main` runs the **stable** node-pty (currently `1.1.0`) with two repository patches.
- **1.2-beta may be evaluated freely on experimental branches.** Beta is a research track, not a
  delivery track.
- **Adoption requires an explicit production decision**, supported by evidence gathered on a branch.
  Nothing in the experimental track changes what ships.

## Why not simply upgrade

`1.2.0-beta.18` was measured to remove the access-violation crash (3/3 clean external-kill runs) but
it is not a drop-in:

| obstacle | evidence |
| --- | --- |
| the patch script fails loudly on 1.2 | main's script knows only 1.1.0 and 1.2's `connect()` anchor has moved, so `npm ci` cannot complete |
| the spawn error model changed | `connect()` no longer throws, so a failed spawn returns a session instead of an error — WIN-22/WIN-23 fail |
| the server suite hangs on 1.2 | measured twice, most recently across all 80 `test:server` tests |

Full checklist and measurements live on #21 and are deliberately **not restated here** — one source
of truth, less to drift.

## Why the patches exist

`scripts/patch-node-pty.mjs` applies two changes to stable:

1. `_releaseAfterFailedConnect` — releases the agent when `connect()` fails, which 1.1.0 leaks.
2. `_consoleListExitGuard` — resolves when the console-list agent exits without a message, instead of
   waiting out a 5 s timeout for a list that cannot arrive.

The second is still needed on 1.2. A version-aware patch script is therefore part of any upgrade.

## Defects that survive on stable

| symptom | status |
| --- | --- |
| `STATUS_ACCESS_VIOLATION` (`3221225477`) under external-kill churn | **open**, upstream — the reason the upgrade track exists |
| teardown never returned (`kill()` deferred behind `_isReady`) | **contained** in #68 by releasing the conout worker; not fixed upstream |

The containment is why the hang no longer justifies an emergency upgrade. The crash still does not
have a containment that was ever measured to work — three attempts failed, and #63 explains why they
could not have succeeded.

## Consequences

- A beta evaluation cannot accidentally ship: adoption is a separate, explicit decision.
- The stable track keeps a documented, tested containment for the hang.
- The crash remains a known, accepted risk on `main`, mitigated only by the merge policy in 0001.
