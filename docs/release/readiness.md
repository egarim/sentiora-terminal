# Release readiness

One page answering "how close is this to a stable release", with the evidence for each claim and the
things that are genuinely not done. Measured on `e0d2b6d` (2026-11-28), win32/arm64, Node 24.18.1,
.NET SDK 10.0.400, Python 3.14.7.

## What is verified

| gate | command | result |
| --- | --- | --- |
| Node test suites | `npm test` | **263 passing, 0 failing**, 227 s — unit 64, native 23, server 80, fault 10, desktop 86 |
| .NET contract | `dotnet run --project clients/dotnet/Sentiora.ContractCheck -- .` | **17/17 passed** |
| Python client | `python clients/python/selfcheck.py .` | **12/12 passed** |
| CI matrix | GitHub Actions | 5 OS families (incl. `windows-11-arm`), Node 22 and 24, a non-root arm64 container, desktop and desktop-ui jobs |
| Stress | `node test/bench/lifecycle-stress.mjs 1 --assert` | 172 sessions, 0 breaches, shutdown 1096 ms |
| Full-suite record | `docs/validation/runs/main-full-2026-11-28.md` | the same suites at `adefc01`, kept as a historical artifact |

The protocol surface is documented and tested: `protocolVersion: 1` with feature detection, 16-session
cap, revision-guarded input, exclusive ownership and cooperative handover, streaming and recording,
request cancellation (`$/cancelRequest`), the host-relayed mailbox, parent/child edges with cascade
close, and the session tree (`terminal.list` → `parent`).

Clients: JavaScript (`packages/agent-client`), .NET (`clients/dotnet`), Python (stdlib only), and an
MCP adapter that never hands a model a capability.

## What is not done

### Two defects in node-pty 1.1.0, both measured

| defect | shape | evidence |
| --- | --- | --- |
| `STATUS_ACCESS_VIOLATION` (`3221225477`) | the host process dies under external-kill churn | reproduced; diagnosed to an unsynchronised `ptyHandles` vector upstream |
| teardown never returns | the host stays alive after its stdin closes; `FI-03`/`FI-02` can stall | reproduced 2/2 with the external-kill bench; three JS containments tried and all failed |

Neither is fixed by any patch this repository can carry: the stall happens inside a native call.
`docs/security/trust-boundaries.md` and issue #21 carry the full analysis.

### The upgrade that would fix them is blocked on its own release

node-pty `1.2.0-beta.18` was measured to remove the crash (3/3 clean external-kill runs) but:

- `scripts/patch-node-pty.mjs` **fails loudly** on 1.2, so `npm ci` cannot complete;
- `test:server` **hangs** on 1.2 (measured twice, most recently across all 80 server tests);
- WIN-22/WIN-23 fail because `connect()` no longer throws — the spawn error model changed.

**Decision taken: wait for a stable 1.2.** The upgrade checklist is recorded on #21.

### The desktop viewer ships; its interaction tests do not

`#35` is built: tree data on the wire, models (`tree.ts`), bridge and IPC relay
(`GET /api/sessions`, `POST`/`GET /api/sessions/:id/messages`), and the component itself
(`SessionTree.ts`) with **structural tests, VIEW-01..08**, run in the `desktop-ui` job where React is
installed.

What remains is the half that needs a browser — **clicking, focus and layout** — i.e. an interaction
suite (#19). The component's logic (order, depth, selection, log, the permanent drop marker, the
orphan callout) is covered structurally.

### Packaging is blocked outside this repository

`#7`'s Tauri 2 packaging needs MSVC build tools; `#5` needs the Telekinesis side of its adapter.

## Decisions still open

| # | decision | what it unblocks |
| --- | --- | --- |
| 1 | crash/hang policy: tolerate the two upstream defects, or freeze merges until stable 1.2 | CI red cells; the retry rule on #21 is provisional without it |
| 2 | approve a Playwright dependency and CI browser step | #19, the #35 viewer component, #7's acceptance |
| 3 | close #1, #2, #3, #34 (each has a committed evidence table) | the milestone slate; `#2`'s remaining gap is closed by #53/#54 |
| 4 | design for #4's preemptive takeover and authenticated remote transport | the last two slices of the integration story |

## How to reproduce every number above

```bash
npm ci && npm --prefix apps/desktop ci
npm test                                              # 263
dotnet run --project clients/dotnet/Sentiora.ContractCheck -- .   # 17
python clients/python/selfcheck.py .                  # 12
node test/bench/lifecycle-stress.mjs 1 --assert       # stress gate
```

The Windows-native suites (`npm run test:native`, `test:server`) need ConPTY and are the cells that
actually exercise a real shell; they are part of `npm test` above.

## What "stable" would mean here

A release is defensible when **all** of these hold:

- [ ] no known crash or hang in the teardown path (today: two, upstream);
- [ ] CI green on the whole matrix without any merge-time retry;
- [x] a documented protocol with a version and feature detection;
- [x] three clients passing a shared contract check, plus an MCP adapter;
- [x] a verified verification record in `docs/validation/runs/`;
- [x] documented trust boundaries with tests pinning every claim;
- [ ] the desktop viewer shipped with interaction tests (the component and its structural tests are
      in; the browser interaction suite is #19).

**Four of seven are done.** One is half done — the viewer renders and its logic is tested, but the
interaction suite needs #19. Two — no crash or hang, and green CI without a retry — depend on
node-pty, which means they depend on the upgrade decision rather than on more work in this repository.
