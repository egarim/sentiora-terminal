# Linux containers

Issue #28. What was actually measured on Linux, what a container changes about it, and the one
environmental dependency that a runner image hides.

Two things are verified separately, because they are different claims:

| Job | What it proves |
| --- | --- |
| `test (ubuntu-24.04-arm, 22 / 24)` | The runtime works on Linux **ARM64**, on a GitHub-hosted runner image |
| `container (debian bookworm arm64, non-root, no TTY)` | The runtime installs and works in the shape a **real deployment** uses |

A runner image is not a container. It arrives with a compiler toolchain, runs as root, and has
systemd at PID 1. `debian:bookworm-slim` has none of those, and each difference breaks something
independently.

## node-pty has no Linux prebuilds

This was not documented anywhere and is the first thing that stops a container install:

> node-pty 1.1.0 publishes prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64` and
> `win32-x64` **only**. There is no `linux-x64` and no `linux-arm64`.

Every Linux install therefore compiles node-pty from source with node-gyp. **A container without
`python3`, `make` and `g++` cannot install this package at all** — it fails at `npm ci`, before any
Sentiora code runs. The x64 Linux CI cells had been depending on the runner image's preinstalled
toolchain for this all along, which is why nobody noticed.

The observable consequence is in the architecture report: Linux finds **1** native binary
(`build/Release/pty.node`, freshly compiled) where Windows finds 9 from prebuilds.

```
runtime: node v24.22.3 arch=arm64 platform=linux abi=137
node-pty: 1.1.0
  build/Release/pty.node: arm64
native architecture check: OK (1 binaries, all consistent with arm64)
```

That check reads the ELF `e_machine` header rather than trusting the filename, and fails the job on
a mismatch. The summary line above is what it printed at the time; it has since been tightened to
report how many binaries were actually *verified*, because three separate ways it could pass without
having checked anything were found and closed:

- **zero** binaries inspected — it used to print `no native binaries found` and then
  `check: OK (0 binaries, all consistent with arm64)`, exiting 0, which would have passed the one
  job whose entire purpose is catching that;
- node-pty **unresolvable**, which exited 0 with `node-pty is not installed`;
- any matched file whose architecture it **could not determine** — truncated, unreadable,
  header-less, a universal Mach-O fat binary, an unlisted machine code — which still counted toward
  the total and was then covered by the claim that every file was consistent.

The third was found by review after the first two were fixed, which is worth recording: closing one
false green does not close the class. Injecting a header-less `.node` into the local prebuilds
directory now produces `ARCH CHECK INCONCLUSIVE: could not determine the architecture of 1 of 10
file(s): prebuilds\win32-arm64\bogus.node (not-a-native-image)`, where the old code printed
`OK (10 binaries, all consistent with arm64)`. Copying a real x64 `pty.node` into the arm64
directory produces `ARCH MISMATCH vs runtime arm64: 1 file(s): … (x64)`. The comparison also used to
handle only the `arm64`/`x64` pair, so an `x86` or 32-bit `arm` binary inside an arm64 runtime would
have counted as consistent; any classified architecture that is not the runtime's is now a mismatch.

What the binary check still cannot do on its own is catch a runner of the wrong architecture: if an
x64 machine served the `ubuntu-24.04-arm` label, node-pty would compile x64 binaries under an x64
runtime and the check would pass, self-consistently, while the job reported ARM64 coverage. That is
why every cell now also runs `scripts/assert-runtime-env.mjs`, comparing `process.arch` and
`process.platform` against what the label claims.

## What was measured

Run [`45792413782`](https://github.com/egarim/sentiora-terminal/actions/runs/45792413782) on
`2a8f9f2`. Every count below was read out of that job's own Node test-runner summary, not computed.
The four runtime suites hold **99** tests; the desktop suites are separate jobs.

| Cell | Node | Arch check | unit | native | server | fault | Executed | Skipped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ubuntu-24.04-arm` | v22.23.5, abi 127 | OK, 1 binary | 40/40 | 1/23 | 20/26 | 10/10 | **71 / 99** | 28 |
| `ubuntu-24.04-arm` | v24.22.3, abi 137 | OK, 1 binary | 40/40 | 1/23 | 20/26 | 10/10 | **71 / 99** | 28 |
| `container` bookworm arm64, uid 1000, no TTY | v24.22.3, abi 137 | OK, 1 binary | 40/40 | 1/23 | 20/26 | 10/10 | **71 / 99** | 28 |
| `desktop (ubuntu-24.04-arm)` | v24.22.3 | OK, 1 binary | 63/63 mocked | 12/12 real runtime | | | **75 / 75** | 0 |
| `macos-latest` | v24.22.3, abi 137 | OK, 2 binaries | 40/40 | 1/23 | 20/26 | 10/10 | **71 / 99** | 28 |
| `windows-11-arm` | v24.22.3, abi 137 | OK, 9 binaries | 40/40 | 23/23 | 26/26 | 8/10 | **97 / 99** | 2 |
| `windows-latest` | v22.23.5, abi 127 | OK, 9 binaries | 40/40 | 23/23 | 26/26 | 8/10 | **97 / 99** | 2 |

Linux ARM64 is cell-for-cell identical to Linux x64 and to macOS arm64. All ten fault-injection
tests ran on every Linux and macOS cell — the `SENTIORA_FAULT_FILL=0` gate is Windows-only, because
the crash it works around (#21) is a ConPTY defect — so Linux ARM64 repeatedly filling and draining
to the 16-session cap is real coverage, not coverage traded away.

The binary counts are themselves a measurement: **1** on Linux (a single compiled
`build/Release/pty.node`, because there are no Linux prebuilds), **2** on macOS (the prebuilt
`pty.node` plus `spawn-helper`), **9** on Windows (prebuilt `pty.node`, `conpty.node`,
`conpty_console_list.node`, `winpty.dll`, `winpty-agent.exe`, and the bundled `conpty.dll` and
`OpenConsole.exe` in two locations).

The 28 POSIX skips are all `native ConPTY scenario: Windows only`: `windows-native.test.js` is 22
tests and `windows-server.test.js` is 6. The cross-platform native file, `native.test.js`, is **one
test**. That is a genuine thinness in POSIX native coverage and it is recorded here rather than
papered over; the 71 that do run include real Unix PTY sessions across the server, environment and
fault suites.

The 2 Windows skips are `FI-09` and `FI-10`, the #21 containment gate.

### One cell did not pass in that run

`test (windows-latest, 24)` failed, and it is recorded here rather than omitted because a table of
green cells that hides a red one is worse than no table. The step summary read
`tests 15, pass 14, fail 1`, which needs unpacking because it reads like a contradiction. `WIN-01`
through `WIN-13` passed — 13 of `windows-native.test.js`'s 22 tests — plus the single cross-platform
test in `native.test.js`, which is the 14th. The one failure is the file-level entry Node's test
runner records when a test file's process dies. `WIN-14 cleans up without orphaned processes` was
the test in flight and never reported a result. There was no JavaScript error, no exit code and no
exception in the log — only Node's own footer.

It is not caused by this branch. `windows-native.test.js` imports only `helpers/native.mjs`, and
this PR changed `helpers/runtime.mjs`, `fault-injection.test.js` and added `proc-stat.test.js`; there
is no path from the diff to that file. The same cell passed on both earlier commits of this same
branch and passes on `main`. So it is intermittent, in a suite that runs ConPTY **in-process**, which
is the shape #21 describes — but `WIN-14` creates only 3 concurrent sessions against the
near-the-16-cap concurrency that #21's other occurrences had, so attributing it to #21 would be a
guess and is not made here.

The real defect this exposes is that the failure was **undiagnosable from the log**. That is now
fixed: the workflow captures Windows event-log entries 1000/1001 on failure, which carry the
faulting module and the exception code (`0xc0000005` is `STATUS_ACCESS_VIOLATION`). The next
occurrence can be named instead of speculated about.

Note also what that stderr flood costs: the crash sat among **21** identical
`Error: AttachConsole failed` traces in that one job's log, each from
`conpty_console_list_agent` and each followed by its own `Node.js v24.22.3` footer. Those are benign
— every `kill()` forks that agent and it fails to attach to an already-exited console, so node-pty
resolves via a 5000ms timeout — but they make a real crash hard to find, which is why identifying
this one took three reads of the same log.

### Resolution status

The next commit (`47cbc6d` — documentation and CI diagnostics only, nothing
`windows-native.test.js` imports) re-ran the cell and it passed, in run
[`45795716953`](https://github.com/egarim/sentiora-terminal/actions/runs/45795716953), which is
**17/17 green**. Measured there for `test (windows-latest, 24)`: arch check OK with 9 x64 binaries,
unit 40/40, native 23/23 with `WIN-14` itself passing in 11775ms and reporting 0 leftover conhost
hosts, server 26/26, fault 8/10 with the 2 expected gate skips — **97 / 99** executed.

This is **one more sample from a non-deterministic suite, not a fix.** Nothing about `WIN-14`,
node-pty or ConPTY changed between the two runs, so the only honest statement is that the failure
does not reproduce on every run — which was already known. It is recorded unattributed on #21 and
stays open.

## The container's PID 1 does not reap

The container job passed every step up to fault injection, and failed there. From run
[`45789937818`](https://github.com/egarim/sentiora-terminal/actions/runs/45789937818) on `4b9bf53`,
job `139806115694`, quoted verbatim — including the line lengths, because reformatting a log into
something tidier is how a paraphrase starts passing as evidence:

```
environment: {"node":"v24.22.3","arch":"arm64","platform":"linux","uid":1000,"home":"/home/sentiora","stdinIsTTY":false,"stdoutIsTTY":false}
```

`uid 1000` — genuinely non-root, asserted not assumed. Both streams report `isTTY: false`. Then
`FI-05`, which SIGKILLs the runtime and checks that its shells do not outlive it:

```
    FI-05 survivors after SIGKILL of the runtime: 3 of 3 (linux, exit {"code":null,"signal":"SIGKILL"}, pid1 {"pid":1,"comm":"tail","state":"S","note":null})
    FI-05 survivor detail: [{"pid":4871,"killSaysAlive":true,"state":"Z","ppid":1,"comm":"MainThread"},{"pid":4879,"killSaysAlive":true,"state":"Z","ppid":1,"comm":"MainThread"},{"pid":4887,"killSaysAlive":true,"state":"Z","ppid":1,"comm":"MainThread"}]
✖ FI-05 killing the runtime outright leaves no orphaned shells (30257.616773ms)
  AssertionError [ERR_ASSERTION]: killing the runtime orphaned shell pids 4871, 4879, 4887; kernel state […as above…]; pid1 {"pid":1,"comm":"tail","state":"S","note":null}
```

Read that carefully, because the first version of this failure was ambiguous and the ambiguity was
the whole problem.

- `state: "Z"` — all three **exited**. Nothing was running. No PTY held, no CPU, no memory.
- `ppid: 1` — they were reparented when the runtime died, exactly as POSIX requires.
- `pid1 comm: "tail"` — PID 1 is the process the runner uses to keep the container alive. `tail`
  never calls `wait()`, so the exit statuses are never collected and the zombies persist for the
  life of the container.

The same test **passes on `ubuntu-24.04-arm` in the same run**, because there PID 1 is systemd,
which reaps. The architecture is not the variable; the init is.

`kill(pid, 0)` — the liveness probe every teardown assertion in this suite uses — **succeeds for a
zombie**. So before this was diagnosed, "3 survivors" could not distinguish a leaked running shell
from three harmless exit records. Those are opposite conclusions with different owners, and picking
one without measuring is how a real leak gets buried under a green re-run.

### What the test asserts now

`FI-05` asserts that nothing is still **running**, and reports unreaped exit records separately
rather than counting them as survivors. Verbatim from run
[`45792413782`](https://github.com/egarim/sentiora-terminal/actions/runs/45792413782) on `2a8f9f2`,
job `139814502723` — the first run in which the container job went green:

```
    FI-05 after SIGKILL of the runtime: 0 running, 3 exited-but-unreaped, of 3 (linux, exit {"code":null,"signal":"SIGKILL"}, pid1 {"pid":1,"comm":"tail","state":"S","note":null})
    FI-05 unreaped exit records: [{"pid":4868,"killSaysAlive":true,"state":"Z","ppid":1,"comm":"MainThread"},{"pid":4876,"killSaysAlive":true,"state":"Z","ppid":1,"comm":"MainThread"},{"pid":4884,"killSaysAlive":true,"state":"Z","ppid":1,"comm":"MainThread"}]
✔ FI-05 killing the runtime outright leaves no orphaned shells (346.420718ms)
```

The test also went from **30257ms to 346ms**. It had been spending its entire budget waiting for an
exit record to disappear, which nothing in that container was ever going to make happen. `FI-06`
gave back 20 seconds the same way.

This is not a weakened assertion. A shell that outlived the runtime would be state `S`, `R` or `D`
and would still fail the test, so the SIGHUP-on-master-close mechanism is still fully under test.
Only the exit-record case changed classification.

Where the runtime is still alive the suite keeps the strict check, because there a zombie means the
runtime failed to reap a child it owns. Worth being precise about which function that is:
`server.test.js` imports `untilGone` from `test/helpers/registry.mjs`, not from `runtime.mjs`, and
that one is untouched — as is `runtime.mjs`'s own `untilGone`, which `FI-13` still uses. Only
`FI-05` and `FI-06`, both after a SIGKILL of the runtime, moved to `untilNotRunning`. All 13 of
`server.test.js`'s strict calls pass inside the container, so the path where Sentiora owns the
reaping is clean.

The classification lives in a pure `classifyLiveness()` with unit tests, including the case that
matters most: an **unreadable** state counts as running. Windows and macOS have no `/proc`, so if
"unknown" meant "gone" every leak assertion there would pass by asserting nothing. That test was
verified non-vacuous by mutation — flipping the unknown-state branch to "gone" fails `PROC-11` and
`PROC-13`, and the mutation was then reverted and the suite re-run at 40/40.

`FI-06`'s call sits in a `finally`, where `untilNotRunning` would throw on a pid it cannot probe and
mask the failure the test came to report — the exact hazard `collectSurvivors` exists to avoid. It
filters unprobeable pids the same way and says so in the log rather than implying they are gone.

### Deployment guidance

If you run the runtime in a container **and you kill it** — which is what a supervisor restarting a
wedged session does — give the container an init:

```
docker run --init ...          # Docker's built-in tini
```

or run `tini` / `dumb-init` as PID 1 yourself. Without one, every hard-killed runtime leaves its
session shells behind as zombies. They cost a pid slot each and nothing else, so a short-lived build
container will never notice; a long-lived one that recycles sessions will eventually reach
`kernel.pid_max`.

This is not something `src/` can fix. A SIGKILLed process runs no cleanup handler, and once it is
gone it is not the parent of record — reaping belongs to PID 1 by definition.

## Not covered

- **macOS x64.** `macos-latest` is arm64 and there is no `macos-13` job. Unverified, and the
  workflow says so explicitly rather than listing it beside a gap that has been closed.
- **On-device Mac Studio.** The container run this issue asked for on that machine is blocked on SSH
  access (`Permission denied (publickey)`, no host entry for the tailnet address). The CI container
  job answers the same question on the same architecture and the same image class, but on a
  GitHub-hosted runner. It is recorded as a substitute, not presented as the thing itself.
- **A container with an init.** Not run as a separate CI job. The causal chain is already closed by
  direct measurement — state `Z`, `ppid 1`, PID 1 named as `tail` — so an A/B job would cost CI time
  to confirm something the evidence already establishes.
