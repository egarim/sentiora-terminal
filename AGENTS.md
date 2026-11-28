# AGENTS.md

What has **already been decided** by the owner, recorded here so it is not re-litigated per pull
request and not re-requested as a permission. A standing permission, not a per-task grant.

Written because these decisions were scattered across issue threads: `readiness.md` was asking for
approvals that had already been given, and the merge policy had to be negotiated in comment 15 of a
17-comment issue about a node-pty crash, where no future reviewer would find it.

## Standing authorizations

1. **Playwright is approved** as a development dependency. Real desktop interaction tests may be
   written and run in CI — #19, the #35 viewer's interaction tests, and #7's desktop acceptance
   criteria all proceed on this.

2. **An independently correct change may be merged over known unrelated intermittent failures**,
   provided mechanical independence is demonstrated, the original failures are preserved, and the
   exact merged commit is verified. One diagnostic retry is permitted for crashes and hangs; a
   successful retry does not erase the original failure. Tests are never weakened and retries are
   never added to manufacture green CI. See `docs/decisions/0001-merge-policy-over-intermittent-failures.md`.

3. **node-pty 1.2-beta may be evaluated on an experimental branch.** `main` stays on the stable
   version until there is sufficient evidence and an explicit production adoption decision. See
   `docs/decisions/0002-node-pty-version-policy.md`.

4. **Issues may be closed** — #1, #2, #3, #34, #24 and future ones — when their original acceptance
   criteria are independently satisfied. Closing does not require per-issue approval. Two cautions
   that belong with this permission: *failure to reproduce a defect is not evidence that it is
   fixed*, and a partial delivery is not a delivery.

5. **The remaining security slices of #4 are authorized** to be designed and implemented, requiring
   threat modelling, least privilege, explicit capabilities, session-scoped authorization,
   revocation, auditing, and independent security review.

6. **Cross-repository work with Telekinesis is approved** for #5. Real interoperability tests are
   required — a adapter that has never run against the other side is not an integration.

7. **Standard development tooling is approved**, including MSVC build tools and Playwright, without
   introducing paid infrastructure.

## Autonomy policy

**Proceed autonomously** on: routine implementation, testing, documentation, development
dependencies, issue creation and closure, pull requests, independently verified merges, and standard
tooling.

**Experiment autonomously on isolated branches** for: alternative architectures, prerelease
dependencies, native implementations, replacement libraries, and runtime isolation. An experiment
that produced a negative result still belongs on a branch — a result that cannot be inspected cannot
be corrected, which is exactly what happened to the teardown-hang investigation (#21 → #63).

**Request owner approval only for**: irreversible architectural commitments, significant expenditure,
licensing changes, destructive operations, production security exceptions, and reductions in
established quality requirements.

## Where the detail lives

| topic | record |
| --- | --- |
| merging over known intermittent failures | `docs/decisions/0001-merge-policy-over-intermittent-failures.md` |
| node-pty version policy and the upgrade checklist | `docs/decisions/0002-node-pty-version-policy.md`, measurements on #21 |
| what "stable" means, and which gates CI enforces | `docs/release/readiness.md` |
| protocol shape, capabilities and what they never grant | `docs/streaming-and-recording.md`, `docs/security/trust-boundaries.md` |
| desktop architecture and its limitations | `docs/desktop/living-terminal.md` |

Decision records are append-only: a changed decision gets a new numbered record that supersedes the
old one, rather than an edit that hides what was previously believed.
