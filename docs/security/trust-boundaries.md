# Trust boundaries

Issue #2 asks for the trust boundaries to be documented, not just enforced. This is that document.
Every claim below names the test that pins it, so a change that breaks one fails a test rather than
quietly widening the boundary.

## Who is trusted

| party | trust | why |
| --- | --- | --- |
| **The parent process** (whatever spawned the runtime) | **trusted** | It owns the pipe. A parent that wants to spawn shells can do so directly; nothing here defends against it. |
| **The model / agent** behind an MCP client | **not trusted with capabilities** | It decides what to run, but must not hold the token that lets it type into a session it was only handed to watch. |
| **The programs run in a session** | **not trusted** | They may print secrets, escape sequences, or try to confuse the parser. |
| **Other local processes** | **cannot reach it** | The only transport is stdio; there is no listening socket, pipe server, or HTTP surface. |

The runtime is a **tool of its parent**, not a security boundary against it. What it defends is the
*inside* of the protocol — the model, the child, and the capabilities it hands out.

## The transport

The runtime speaks newline-delimited JSON-RPC on stdin/stdout and nothing else
(`src/server.js`, `startStdioTransport`). There is no network listener to authenticate and no IPC
endpoint to discover, which is why this document has no "remote transport" section: the remote
transport does not exist yet, and the issue that would add one (#4) records that it needs its own
security design rather than reusing this one.

Consequences worth stating:

- Only the process holding the pipe can send requests. On a shared machine, an OS-level debugger
  could attach to the process; that is the operating system's boundary, not this one.
- Nothing is authenticated, because there is nobody to authenticate to: the pipe is the identity.
- `initialize` reports `protocolVersion: 1` and advertises optional features (`stream`, `recording`,
  `mailbox`) so a client can feature-detect rather than probe.

## Capabilities

Four distinct things are held by different parties. Confusing any two of them is the failure mode
this section exists to prevent.

| capability | grants | **never** grants | rotation |
| --- | --- | --- | --- |
| **owner** token | `terminal.type`, `terminal.key`, `terminal.resize`, `terminal.close`, `terminal.recording`, `terminal.handover` | messages to other sessions; observation of other sessions | `terminal.handover` rotates it; the old token is refused everywhere at once (`OW-01`, `OW-02`, `OW-03`) |
| **mailbox** capability | `terminal.post` and `terminal.mailbox` for its own session | `terminal.type` or `terminal.close` (`MB-04`) | unchanged by a handover: moving input rights is not revoking messaging |
| **edge** capability | the same two methods, but only at the two sessions the edge joins | any third session, including a grandchild (`PE-04`, `PE-11`) | dies with either end; a message afterwards answers `Edge closed` (`PE-06`, `PE-10`) |
| **input recording** | nothing — it is an opt-in flag (`recordInput`), not a capability | captured keystrokes unless the caller asked for them | n/a |

The owner token is never returned by `terminal.list` or `terminal.observe`, and a watcher never
needs it: `terminal.stream` is read-only and filters input at the source (`STR-*`).

## The environment

A session **never inherits the host environment**. `src/env.js` builds a small fixed allowlist of
variables a shell genuinely needs, and anything else reaches a session only if the caller names it
explicitly. Values are never echoed in errors, because an error quoting an offending value would put
a secret into a JSON-RPC response and every log downstream of it.

The one exception is deliberate: a parented create injects `SENTIORA_MAILBOX_CAPABILITY` and
`SENTIORA_PARENT_SESSION` into the child's environment so the child can answer its parent
(`PE-01`). Those are host-controlled values, and the child receives the *edge* capability — never the
parent's owner token.

## What a model can see (the MCP adapter)

`packages/mcp-server` holds the owner tokens and the model never sees one: tool results carry a
session id and an observation, and `MCP-04` asserts that no result contains `owner`, `mailbox` or
`childMailbox`. The adapter is the authority boundary; `terminal_observe` is deliberately read-only.

If a future tool needs the mailbox, it should post and drain **on the model's behalf** rather than
hand over a capability.

## What this does not protect

Stated plainly, because a boundary document that only lists controls is a sales brochure:

- **A malicious parent.** It holds every capability it minted.
- **A child's own secrets.** Anything a program prints is in the stream and, if recording is on, in
  the recording. The runtime does not redact.
- **What was typed, when recording is enabled.** That is why `terminal.recording` is owner-gated and
  `recordInput` defaults to off; a caller who enables it has chosen to hold keystrokes.
- **Sandboxing.** A session runs with the user's privileges and can do anything the user can. The
  runtime isolates *sessions from each other's capabilities*, not processes from the machine.
- **Mailbox payloads.** They are not recorded and not scanned. A message is opaque to the host by
  design; the queue depth and size caps bound memory, not content.

## Verification map

| threat | control | test |
| --- | --- | --- |
| a watcher types into a session | input requires the owner token | `WIN-12`, `MB-04` |
| a message becomes input | mailbox capability cannot reach `terminal.type` | `MB-04` |
| a sibling or grandchild is addressed | edge capability is accepted only at its two ends | `PE-04`, `PE-11` |
| a dead edge is used silently | `Edge closed` vs `Mailbox capability required` | `PE-10` |
| a child outlives a parent that asked for a cascade | `closeChildren` | `PE-07` |
| an old owner keeps working after a handover | token rotation kills it in place | `OW-01`, `OW-02` |
| a failed handover locks out the real owner | a refused handover rotates nothing | `OW-03` |
| a create leaks a session nobody heard about | deferred sink rolled back on cancel or failure | `CAN-01`, `ST14-*` |
| a child inherits the host environment | allowlist only; the caller names variables | `session-env.test.js` |
| a capability leaks to a model | no capability in any tool result | `MCP-04` |
| a recording is read by a watcher | `terminal.recording` is owner-gated | `REC-*` |
| a hostile child corrupts the channel | stdout stays parseable under hostile output | `WIN-15` |
