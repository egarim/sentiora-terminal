# Agent clients for the Sentiora runtime

Status: prototype, measured against the real runtime on `win32 arm64`, node v24.18.1,
`main` @ `82e1bbe`. This is the Sentiora half of M3 (#3); the consumer is
[Creatura](https://github.com/egarim/creatura) issue
[#102 `Creatura.Worlds.Terminal`](https://github.com/egarim/creatura/issues/102).

Two implementations exist, both dependency-free, and both speak the same
`protocolVersion 1` JSON-RPC:

| Client | Language | Path | Use |
| --- | --- | --- | --- |
| `agent-client` | ESM JavaScript, zero deps | `packages/agent-client/index.mjs` | JS/Node hosts, CI harnesses, the reference for other ports |
| `Sentiora.Client` | C# / .NET, zero package refs | `clients/dotnet/Sentiora.Client` | Creatura's World adapter and any .NET host |

## The contract, in one table

| Method | Purpose | Sharp edge the client hides |
| --- | --- | --- |
| `initialize` | protocol/capability version | returns `stream: 1`, `recording: 1` |
| `terminal.create` | spawn a shell under a ConPTY | the response carries the `owner` token and is the *only* place it appears |
| `terminal.observe` | screen + objective state (`pid`, `revision`, `running`, `exit`, geometry) | rendered screen, not bytes |
| `terminal.type` | input | requires the **current** revision; a stale one is rejected, so the client observes and retries |
| `terminal.wait` | block until the revision changes | no cancellation in the protocol; the client's timeout is the only exit |
| `terminal.stream` | the child's raw bytes with sequence numbers | first attach returns a **snapshot**, not bytes; falling behind returns `resync` |
| `terminal.close` | tear down and free the slot | once the create response is delivered, close must succeed or the slot leaks |
| `terminal.list` | observations of all sessions | never returns owner tokens |
| `terminal.handover` | the current owner gives input rights away; a new owner token is returned | the old token is refused everywhere at once, and this is **cooperative**: a caller that does not hold the token cannot seize the session. Both clients return a **new handle**; the handle you passed in keeps a dead token, which is the contract, not an oversight |
| `terminal.post` | enqueue a message for a session | uses the **mailbox capability**, never the owner token: it can message, it can never type |
| `terminal.mailbox` | drain messages after a cursor, long-polling | the client's request timeout is the poll timeout **plus** its own, so a legitimate long poll is not reported as a dead host |

Facts the client derives for its caller: the exit code (from the stream's `exit` event, not
from polling the screen), and the next stream cursor.

## C# quickstart

```csharp
await using var client = await SentioraClient.StartAsync(@"C:\repo\src\server.js");
var session = await client.CreateAsync(new CreateSessionRequest
{
    Command = @"C:\Program Files\nodejs\node.exe",
    Args = new[] { "app.js" },
    Cols = 100, Rows = 30,
});
await client.WaitForTextAsync(session, "ready>");
await client.SendLineAsync(session, "status");
var (text, frame, cursor) = await client.WaitForTextAsync(session, "OK", afterSequence: 0);
await client.CloseAsync(session);
```

Run the executable contract check (no test framework, restores offline):

```
dotnet run --project clients/dotnet/Sentiora.ContractCheck -- <repo-root>
```

## Measured results

`Sentiora.ContractCheck`, `win32/arm64`, real `src/server.js`, real ConPTY:

```
PASS create returns a real child pid
PASS first bytes are readable through terminal.stream
PASS type is revision-armed and accepted
PASS command output is observable as bytes
PASS observe reports objective state and revision
PASS close returns true
PASS a closed session leaves the registry
PASS child exit code is observable through the stream (7)
PASS a failed spawn is an error
CONTRACT CHECK PASSED
```

`test/agent-client.test.js` (JS): 3/3 pass — bytes, failed shell, exit code.

## Two runtime defects this exposed

1. **A failed spawn used to leak the ConoutConnection worker, and the host then never
   exited.** With the failed-spawn check enabled, `DisposeAsync` waited 20 047 ms and set
   `ForcedShutdown = true`; with that check skipped the same client shut the host down in
   5 026 ms (the normal ConPTY tail). The cause is upstream: on Windows
   `WindowsTerminal`'s constructor throws from `conptyNative.connect()` after
   `new ConoutConnection(...)` has started a worker, and the caller never receives a
   terminal to kill, so the worker and its sockets are never disposed.
   **Fixed on the Sentiora side** (`fix/failed-spawn-host-exit`): an unusable `cwd` and a
   missing absolute `command` are rejected before anything is spawned. With that fix the
   same check reports a JSON-RPC error, the host shuts down in 5 023 ms with
   `forced=False`, and the JS client's failed-shell test drops from 20 s to 208 ms. The
   remaining class - a command that exists but cannot be executed - still reaches
   `connect()`, so a node-pty constructor-cleanup patch is still the class-level fix.
2. **`#21` is an agent-facing defect, not just a CI flake.** A blocked host and a
   0xC0000005 crash both turn into a client timeout with no human to retry. A World
   adapter must treat `SentioraException`/timeout as a failed episode and recycle the host.

## Deliberately out of scope here

- MCP mapping (`console_*` tools) stays in Telekinesis; a Node MCP server for this repo
  would be a thin wrapper over `packages/agent-client`.
- Push transport. `terminal.stream` is a poll with a cursor; a push variant needs the
  framing decision in `docs/desktop/living-terminal.md` §9.1.
- Approvals and human handoff: ownership is the `owner` token; leases belong to #7 PR3.
