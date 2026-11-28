# MCP adapter

Issue #4, M4 slice 3. A Model Context Protocol server over the Sentiora runtime: MCP tool calls in,
the runtime's existing JSON-RPC out, through the same `agent-client` the tests use. It adds no
protocol of its own and does not reach into `src/`.

```bash
node packages/mcp-server/index.mjs          # stdio transport
SENTIORA_SERVER=/path/to/src/server.js node packages/mcp-server/index.mjs   # explicit runtime
```

The adapter spawns one runtime as its child and disposes it when stdin closes, so a client that goes
away does not leave PTYs behind.

## Tools

| tool | arguments | returns |
| --- | --- | --- |
| `terminal_create` | `command`, `args`, `cols`, `rows`, `cwd` | `sessionId`, `pid`, `state` |
| `terminal_type` | `sessionId`, `text` | the number of characters sent |
| `terminal_line` | `sessionId`, `line` | the number of characters sent, including Enter |
| `terminal_observe` | `sessionId` | `state`, `pid`, `revision`, `running`, `exit`, `cols`, `rows`, `screen` |
| `terminal_list` | — | the same observations for every open session |
| `terminal_close` | `sessionId` | `closed: true` |

`terminal_type` hides the revision guard: the runtime rejects a stale revision by design, and an
agent should not have to re-observe before every keystroke. `terminal_line` is the same with Enter
appended.

## The security property: the model never sees a capability

The owner token stays inside this process, keyed by session id. A tool returns the id and nothing
else. This matters because the model is the least trusted of the three parties in the chain: a model
that could read the owner token could type into a session it was only meant to watch, and the
mailbox capability would be equally exposed. `MCP-04` asserts that no tool result contains an
`owner`, `mailbox` or `childMailbox` field, on create, observe and list.

So the adapter is the authority boundary, and `terminal_observe` is deliberately read-only. If a
future tool needs the mailbox, it should post and drain **on the model's behalf**, not hand over a
capability.

## Failure shape

A tool failure is a **result with `isError: true`**, not a JSON-RPC error: MCP clients show the text
to the model, and a protocol-level error can be swallowed by the client instead. Unknown tools and
unknown sessions both come back that way, and the adapter keeps serving afterwards (`MCP-05`).

## Not implemented

- **Resources and prompts** (`resources/list`, `prompts/list`): tools are the whole surface today.
- **`terminal_key`**: the runtime has a named-key table, but exposing it before there is a caller
  that needs Ctrl+C would be speculative.
- **Remote transport**: this is stdio only. An authenticated remote MCP is the same design question
  as the runtime's remote transport, and it waits for that decision.
- **Recording**: no tool exposes `terminal.recording`, which can contain keystrokes.

## Tests

`test/mcp-server.test.js` speaks the protocol over stdio as a client would — `MCP-01` handshake,
`MCP-02` tool surface, `MCP-03` a full session lifecycle through tools, `MCP-04` the capability
assertion, `MCP-05` failures are results.