<div align="center">

# Sentiora Terminal

### Give intelligence senses.

**Cross-platform terminal perception and interaction for humans and AI agents.**

![Status](https://img.shields.io/badge/status-early%20development-orange)
![Runtime](https://img.shields.io/badge/runtime-Node.js-339933)
![Protocol](https://img.shields.io/badge/protocol-JSON--RPC-blue)
![License](https://img.shields.io/github/license/egarim/sentiora-terminal)

[Vision](#vision) · [Architecture](#architecture) · [Developer experience](#developer-experience) · [Roadmap](#roadmap) · [Creatura](#the-creatura-ecosystem)

</div>

> Intelligence is not enough. To act in the world, an agent must first be able to perceive it.

## Vision

Sentiora takes its name from the Latin *sentire*: to feel, sense or perceive. It is a proposed sensorimotor interface for artificial intelligence, beginning with the terminal.

Think of it as **Playwright for terminals**. Instead of treating a command-line application as a one-shot subprocess, Sentiora aims to let an agent observe a living interactive session, understand its current state, act through keyboard input and observe the consequences.

Many developer tools, installers, interactive menus and terminal user interfaces are designed for people. A stream of stdout alone is not a faithful representation of what a person sees. Sentiora bridges that gap.

## What makes it different?

| Traditional process execution | Sentiora's intended model |
| --- | --- |
| Run a command and collect output | Maintain an interactive session |
| Read stdout and stderr | Observe the rendered terminal screen and cursor |
| Send a line of input | Type, press keys and navigate interactive controls |
| Wait for process exit | Wait for observable changes or exit |
| Assume output describes reality | Expose observations for independent verification |

## Architecture

```mermaid
flowchart TD
    A[Human or AI agent] <-->|JSON-RPC / future MCP| B[Sentiora session manager]
    B --> C[Input ownership and revision checks]
    C --> D[node-pty]
    D <--> E[Interactive terminal application]
    D --> F[xterm headless emulator]
    F --> G[Screen, cursor and revisions]
    G --> B
```

The runtime is deliberately model-agnostic. Sentiora supplies perception and action; the caller supplies goals, reasoning, authorization and independent verification.

### Technology choices

- **Node.js and TypeScript:** portable runtime and typed contracts.
- **node-pty:** native pseudoterminals, including Windows ConPTY and Unix PTYs.
- **@xterm/headless:** terminal emulation without a browser.
- **JSON-RPC:** initial local transport over stdio.
- **C# SDK:** planned first-class .NET integration.
- **MCP and Python SDK:** planned additional integration surfaces.

### Target platforms

| Platform | Backend | Architectures | Verification status |
| --- | --- | --- | --- |
| Windows | ConPTY | ARM64 | **Verified twice** — physical Snapdragon X hardware (20 native scenarios, 37 tests, Node 22 and 24) and GitHub-hosted `windows-11-arm`. See [Windows native validation](docs/validation/windows-native-validation.md). |
| Windows | ConPTY | x64 | **Verified in CI** (`windows-latest`, Node 22 and 24). No physical-machine x64 run. |
| Linux | Unix PTY | x64 | **Verified in CI** — mocked suite plus one cross-platform native PTY test. |
| macOS | Unix PTY | Apple Silicon | **Verified in CI** (`macos-latest`, Node 22 and 24) after the `spawn-helper` permissions fix. |
| Linux | Unix PTY | ARM64 | Not verified. |
| macOS | Unix PTY | Intel | Not verified — `macos-latest` is Apple Silicon; Intel needs `macos-15-intel`. |

These are targets plus whatever has actually been measured, not a blanket compatibility claim.
CI verifies that every native binary's architecture matches the runtime
(`scripts/report-native-arch.mjs`), so an x64 image running under emulation can never be reported
as ARM64.

## Developer experience

The following examples illustrate the intended API, not a published SDK.

```csharp
// Proposed C# API
await using var session = await terminal.CreateAsync("my-interactive-tool");
var screen = await session.ObserveAsync();
await session.TypeAsync("help", expectedRevision: screen.Revision);
await session.PressKeyAsync("Enter");
var next = await session.WaitForChangeAsync(screen.Revision);
```

A session exposes structured observations. This is the actual current shape returned by
`terminal.observe`:

```json
{
  "sessionId": "example",
  "pid": 41072,
  "state": "operational",
  "revision": 12,
  "running": true,
  "exit": null,
  "cols": 120,
  "rows": 40,
  "cursor": { "x": 2, "y": 1 },
  "writeErrors": 0,
  "screen": "Select an option:\n> Continue\n  Cancel",
  "idleMilliseconds": 84
}
```

`state` is one of `spawned` (a child process exists but nothing has rendered yet), `operational`
(the emulator has rendered output), `exited` (the child is gone, resources still held) or
`released` (`terminal.close` completed). **`spawned` is not readiness** — whether an application is
ready to accept input is only knowable from a condition the caller defines, such as a prompt
appearing on screen, reached with `terminal.wait` rather than a sleep.

`pid` is the real child process id, stable across observations and after exit, so a caller can
verify process identity independently. `writeErrors` counts asynchronous writes to the terminal
input that failed; a non-zero value means some input was lost.

Revision checks and exclusive input ownership help prevent accidental actions against a changed
screen. Note that a successful write **advances the revision itself**, so a `terminal.wait` must be
armed with the revision returned by the write, not the one read before it.

### Initial protocol surface

| Operation | Purpose |
| --- | --- |
| initialize | Negotiate protocol capabilities |
| terminal.create | Start an interactive process |
| terminal.list | Enumerate sessions |
| terminal.observe | Read screen and process state |
| terminal.type | Send text |
| terminal.key | Send a keyboard event |
| terminal.wait | Wait for change or exit |
| terminal.resize | Change terminal dimensions |
| terminal.close | End a session |

The protocol is provisional until the implementation and contract tests land.

`terminal.create` accepts `{command, args, cwd, cols, rows, conptyDll}` and returns the first
observation plus the `owner` token for that session. `conptyDll` selects node-pty's bundled
`conpty.dll` instead of the OS ConPTY and defaults to `false`; the host-wide default can be set
with `SENTIORA_CONPTY_DLL=1`, and `initialize` reports the effective value. The bundled provider is
**exposed for comparison, not recommended**: measured over 30 sessions it leaks a worker thread,
about 8 Win32 handles and ~6.5 MB per session, and leaves the host process unable to exit. See the
[provider comparison](docs/validation/conpty-provider-comparison.md).

## The Creatura ecosystem

Sentiora is independent, but its first planned integration is [Creatura](https://github.com/egarim/creatura), an agent framework inspired by cognitive architecture and regulation.

| Concept | Role |
| --- | --- |
| Creatura | Cognition, goals and regulation |
| Vessel | Computational host |
| Sentiora Terminal | Terminal perception and action |
| World | Environment and observable effects |
| Vivarium | Habitat and supervision |

```mermaid
flowchart TB
    subgraph H["VIVARIUM · habitat and supervision"]
        subgraph V["VESSEL · computational host"]
            C["CREATURA<br/>Mind · goals · regulation"]
            W["World adapter<br/>Creatura.Worlds.Terminal · planned"]
            subgraph S["SENTIORA TERMINAL · sensorimotor organ"]
                P["Sensory<br/>Screen · cursor · revisions"]
                M["Motor<br/>Text · keys · resize"]
            end
            C -->|Intention| W
            W -->|Authorized action| M
            P -->|Observation| W
            W -->|Feedback| C
        end
    end
    M -->|Input| T["TERMINAL WORLD<br/>Interactive application"]
    T -->|Output| P
    T -.-> J["Independent judge<br/>Actual task outcome"]
    J -.-> C
    classDef mind fill:#ede9fe,stroke:#7952b3,color:#302050
    classDef sense fill:#ccfbf1,stroke:#0d9488,color:#134e4a
    classDef world fill:#e2e8f0,stroke:#64748b,color:#1e293b
    class C mind
    class P,M sense
    class W,T,J world
```

**Creatura thinks. Sentiora senses and acts. The Vessel hosts. The World responds.**

This is the intended embodiment architecture, not a claim that the integration is already shipped. Sentiora is an independent runtime; the World adapter and independent task judge belong to the Creatura integration. Vivarium represents the supervisory habitat, not a required runtime dependency.

The integration is tracked in [Creatura #101](https://github.com/egarim/creatura/issues/101), with the adapter in [#102](https://github.com/egarim/creatura/issues/102), verification in [#103](https://github.com/egarim/creatura/issues/103), distribution in [#104](https://github.com/egarim/creatura/issues/104) and documentation in [#105](https://github.com/egarim/creatura/issues/105).

## Roadmap

- [ ] Native PTY runtime and synchronized headless screen perception
- [ ] Session lifecycle, revision tracking, input ownership and bounded history
- [ ] Versioned JSON-RPC protocol and deterministic interactive fixture
- [ ] Cross-platform CI and native integration tests
- [ ] C# SDK and contract tests
- [ ] Creatura real and simulated terminal worlds
- [ ] MCP server and Python SDK
- [ ] Browser-based human takeover
- [ ] Authenticated remote sessions and distributed execution

## Security and responsible automation

Terminal output is untrusted data, not instructions. A terminal can display misleading messages, request credentials or attempt prompt injection. Callers must enforce least privilege, explicit approval policies, bounded execution and independent verification of outcomes.

Sentiora is not intended to bypass authentication, permission gates, subscription restrictions or provider terms. Credentials should remain outside logs and repositories. Remote access must be authenticated, authorized and encrypted.

## Getting started

The JavaScript ESM runtime, native Windows validation and CI configuration are in this
repository. SDKs are not yet published.

```bash
npm ci                 # reproducible install from package-lock.json
npm run fix:native-permissions   # macOS only: restores node-pty's spawn-helper executable bit
npm run test:unit      # mocked tests, no native dependency
npm run test:native    # real PTY tests (ConPTY on Windows)
npm test               # both
npm start              # JSON-RPC server over stdio
```

On macOS the permissions step is **required**: node-pty 1.1.0 publishes
`prebuilds/darwin-*/spawn-helper` as mode 644, and macOS `posix_spawnp`s it, so without the
executable bit every spawn fails with `posix_spawnp failed.` CI runs it automatically. Linux uses
`forkpty` and Windows uses ConPTY, so neither needs it.

The server communicates over newline-delimited JSON-RPC on stdio. See
[CI results](https://github.com/egarim/sentiora-terminal/actions) for current status.

### Benchmarks and stress harnesses

These are long-running and are **not** part of `npm test`:

```bash
npm run bench:conpty -- os  30 90000    # OS ConPTY provider, 30 trials
npm run bench:conpty -- dll 30 90000    # bundled-DLL provider, 30 trials
npm run stress                          # 100 sequential + 10 concurrent + cancellation,
                                        # termination, resize, input and shutdown phases
node test/bench/fd-exhaustion.mjs 1200  # finds the per-host session ceiling
```

## Documentation

| Document | Contents |
| --- | --- |
| [Windows native validation](docs/validation/windows-native-validation.md) | The 20 native ConPTY scenarios, the session-teardown hang and its fix, ARM64 verification, Ctrl+C semantics, measurement pitfalls. |
| [ConPTY provider comparison](docs/validation/conpty-provider-comparison.md) | OS ConPTY vs bundled `conpty.dll`, lifecycle states, the host-crash defect, long-running reliability, the ~500-session ceiling, CI and the macOS root cause. |
| [Telekinesis integration](docs/integrations/telekinesis.md) | **Proposed** contract for using Sentiora as an optional Telekinesis console backend. Not implemented. |

### Ecosystem

Sentiora Terminal is independently usable and has **no runtime dependency** on any other project
in the ecosystem. The relationships below are documentation-level only.

| Repository | Relationship | Status |
| --- | --- | --- |
| [Creatura](https://github.com/egarim/creatura) | Artificial cognition; would consume Sentiora through a World adapter | Proposed — [creatura#101](https://github.com/egarim/creatura/issues/101), [#107](https://github.com/egarim/creatura/issues/107) |
| [Telekinesis](https://github.com/egarim/telekinesis) | Perception and interaction; Sentiora as an optional console backend | Proposed — [telekinesis#67](https://github.com/egarim/telekinesis/issues/67) |
| [Sentiora Browser](https://github.com/egarim/sentiora-browser) | Sibling sensorimotor surface for the browser | Separate project |
| [Vivarium](https://github.com/egarim/vivarium) | Agent habitat and supervision | Supervisory context, not a dependency |
| [Custodia](https://github.com/egarim/custodia) | Credential management and authorization | No integration |
| [Unisono](https://github.com/egarim/unisono) | MCP host; a future Sentiora MCP surface would follow its patterns | No integration |

Milestones for this repository are tracked in [#1](https://github.com/egarim/sentiora-terminal/issues/1)
(native runtime), [#2](https://github.com/egarim/sentiora-terminal/issues/2) (protocol and
lifecycle), [#3](https://github.com/egarim/sentiora-terminal/issues/3) (C# SDK),
[#4](https://github.com/egarim/sentiora-terminal/issues/4) (MCP, Python, takeover) and
[#5](https://github.com/egarim/sentiora-terminal/issues/5) (Telekinesis interoperability).

## Contributing

Ideas, terminal fixtures, platform-specific test cases and design feedback are welcome. Open an [issue](https://github.com/egarim/sentiora-terminal/issues) to discuss a proposal. Prefer small, testable changes and explicit documentation of platform limitations.

## License

See the repository's license file for the applicable terms.

---

<div align="center">

**Sentiora Terminal — Give intelligence senses.**

Built for humans, agents and the space between them.

</div>
