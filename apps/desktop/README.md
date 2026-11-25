# Sentiora Living Terminal — desktop app (PR1)

The desktop UI shell and native session bridge for
[issue #7](https://github.com/egarim/sentiora-terminal/issues/7). It is a **client** of the runtime in
`../../src/`, which is unchanged and remains independently usable.

Full design, measurements, security model, blocked items and the proposed protocol changes are in
[`../../docs/desktop/living-terminal.md`](../../docs/desktop/living-terminal.md). Read that first.

## Layout

```
apps/desktop/
  bin/living-terminal.mjs   entry point: host pool + session bridge + loopback IPC server
  bridge/                   Node-side, zero npm dependencies (runs under a plain `npm ci`)
    runtime-client.js       newline-delimited JSON-RPC 2.0 over stdio, one host process
    host-pool.js            session cap, lifetime ceiling, recycling, backend-lost
    session-bridge.js       owner custody, revisions, the output pump, scrollback recovery
    settings.js             persistent settings, schema validation, animation-off switch
    shell-catalog.js        S1 shell detection; refuses anything but an absolute existing file
    errors.js               the single place runtime error strings are mapped to kinds
    protocol.js             every measured constant (limits, ceilings, grace periods)
  server/ipc.js             loopback HTTP + SSE, bearer token, origin allowlist, rate limit
  theme/tokens.js           design tokens; shared with the Node tests that measure contrast
  ui/                       React 19 + TypeScript + xterm.js 5.5
```

The bridge has **no npm dependencies** on purpose: the root install only provides `node-pty` and
`@xterm/headless`, so the bridge must be loadable and testable under a plain `npm ci` at the repo
root — which is how the desktop test suites run in CI.

## Run it

```bash
npm ci                                     # at the repo root: runtime deps
npm --prefix apps/desktop ci               # UI deps
npm --prefix apps/desktop run build        # -> apps/desktop/dist

node apps/desktop/bin/living-terminal.mjs  # prints: open http://127.0.0.1:<port>/#token=<token>
```

The bridge serves `dist/` itself, so the UI and the API share one origin and one token.

Development, two processes:

```bash
node apps/desktop/bin/living-terminal.mjs --port 8791 --allow-origin http://localhost:5173
npm --prefix apps/desktop run dev          # vite on :5173, proxies /api to :8791
```

then open `http://localhost:5173/#token=<token>`.

Environment: `SENTIORA_RUNTIME` (path to `src/server.js`), `SENTIORA_NODE` (node used to run it),
`SENTIORA_DESKTOP_SETTINGS` (settings file), `SENTIORA_DESKTOP_PORT`.

## Tests

From the repo root — these are part of `npm test`:

```bash
node --test test/desktop-bridge.test.js     # bridge logic, scriptable fake runtime, all platforms
node --test test/desktop-settings.test.js   # settings, contrast, shell catalog
node --test test/desktop-ipc.test.js        # IPC security + SSE, fake runtime, real HTTP
node --test test/desktop-native.test.js     # real src/server.js on a real PTY: U01-U04, U11
```

`test/desktop-native.test.js` drives the actual runtime and is the one that matters; the others exist
so the bridge's own logic can be pinned deterministically without spending a PTY. None of them
replace the runtime's existing native suites.

## Tauri packaging — BLOCKED

No Rust toolchain and no MSVC compiler/linker on the machine this was built on (Windows 11 ARM64
build 26200). WebView2 Runtime 152 is present. Nothing was faked and no `src-tauri` scaffold was
committed. Exact missing prerequisites and the install commands are in
[section 8 of the design doc](../../docs/desktop/living-terminal.md#8-blocked-tauri-2-packaging).
