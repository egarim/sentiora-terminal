# Sentiora.Client (.NET)

Typed, dependency-free client for the Sentiora runtime's `protocolVersion 1` JSON-RPC over a
subprocess stdio transport. Intended consumer: `Creatura.Worlds.Terminal`
([creatura#102](https://github.com/egarim/creatura/issues/102)); Sentiora side of M3 (#3).

## Projects

| Project | Purpose |
| --- | --- |
| `Sentiora.Client` | the client: spawn, request/response by id, timeouts, cancellation, revision-armed `TypeAsync`, cursor-based `StreamAsync`, `WaitForTextAsync` |
| `Sentiora.ContractCheck` | console executable that drives the real `src/server.js` and a real PTY and exits non-zero on failure |

No package references: `System.Text.Json` and `System.Diagnostics.Process` are in the shared
framework, so this restores and builds offline and stays usable from a dependency-free host.

## Run

```powershell
dotnet build clients/dotnet/Sentiora.ContractCheck/Sentiora.ContractCheck.csproj
dotnet run --project clients/dotnet/Sentiora.ContractCheck --no-build -- C:\path\to\sentiora-terminal
```

`SENTIORA_SKIP_FAILED_SPAWN=1` skips the failed-spawn check. It is on by default because the
runtime leaks the ConoutConnection worker when a spawn fails, and the host then never exits;
the check records that as `forced=True` on shutdown.

## Design notes

- **One reader task** dispatches responses by JSON-RPC id; requests are correlated by
  `TaskCompletionSource` with a linked cancellation token and a per-request timeout.
- **A child process with its own stdio**, so a shell that prints a forged JSON-RPC line or
  binary output cannot corrupt the host protocol channel (WIN-15).
- **`TypeAsync`** observes the current revision and retries on `Stale observation`; the
  protocol rejects a stale revision on purpose and the client is where that loop belongs.
- **`WaitForTextAsync`** treats a `resync` snapshot as authoritative (it replaces the
  collected text instead of appending, so bytes are not duplicated) and stops on the `exit`
  event rather than waiting out the timeout.
- **`DisposeAsync`** closes stdin, waits 20 s for a clean exit, then kills the process tree
  and sets `ForcedShutdown` so a supervisor can tell a leak from a clean shutdown.

## Next for the Creatura adapter

- Map `Observation` into the World's two kinds of evidence: objective facts (`pid`, `state`,
  `revision`, `running`, `exit`) and derived semantics (screen text), kept separate.
- Tool surface: bounded `type`/`key`/`wait`, ownership enforced via the `owner` token, stale
  revisions rejected, cancellation mapped to `CancellationToken`.
- Fixture tests: simulated terminal first, then the real fixture on Windows/macOS/Linux
  (the contract check is the template).
