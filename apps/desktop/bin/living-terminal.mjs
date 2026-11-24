#!/usr/bin/env node
// Starts the Living Terminal backend: the Sentiora runtime host pool, the session
// bridge, and the loopback IPC server the UI talks to.
//
// Run this, then open the printed URL. It contains the per-launch bearer token in
// the URL *fragment*, which browsers do not transmit and access logs do not
// record. What is never printed here is a session `owner` token: those stay
// inside this process for the lifetime of each session.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopBackend } from '../bridge/index.js';
import { IpcServer } from '../server/ipc.js';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    host: process.env.SENTIORA_DESKTOP_HOST ?? '127.0.0.1',
    port: Number(process.env.SENTIORA_DESKTOP_PORT ?? 0),
    staticRoot: null,
    allowedOrigins: [],
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') options.host = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--static') options.staticRoot = resolve(argv[++i]);
    else if (arg === '--allow-origin') options.allowedOrigins.push(argv[++i]);
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

const HELP = `Sentiora Living Terminal (PR1)

  node apps/desktop/bin/living-terminal.mjs [options]

Options
  --host <addr>          bind address (default 127.0.0.1)
  --port <n>             port (default 0 = random free port)
  --static <dir>         serve a built UI from this directory
  --allow-origin <orig>  permit a cross-origin UI (repeatable)
  --quiet                do not print the entry URL

Environment
  SENTIORA_RUNTIME       path to src/server.js (default: the one in this repo)
  SENTIORA_NODE          node executable used to run the runtime
  SENTIORA_DESKTOP_SETTINGS   settings file path
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // Default to the vite build output when it exists, so one command serves the
  // whole app. Without a Tauri shell this is the runnable desktop fallback.
  const staticRoot = options.staticRoot
    ?? (existsSync(resolve(here, '..', 'dist')) ? resolve(here, '..', 'dist') : null);

  const backend = await createDesktopBackend();
  const server = new IpcServer({
    bridge: backend.bridge,
    settings: backend.settings,
    host: options.host,
    port: options.port,
    allowedOrigins: options.allowedOrigins,
    staticRoot,
  });
  const { url, port, entryUrl } = await server.listen();

  if (!options.quiet) {
    process.stdout.write([
      '',
      '  Sentiora Living Terminal — PR1 (UI shell + native session bridge)',
      '',
      `  bridge      ${url}/api`,
      `  runtime     ${backend.runtime.path}`,
      `  settings    ${backend.settings.path}`,
      `  ui          ${staticRoot ?? 'not built (run: npm --prefix apps/desktop run build)'}`,
      '',
      `  open        ${entryUrl}`,
      '',
      '  The token in that URL is a per-launch credential for the loopback API.',
      '  Session owner tokens never leave this process.',
      '',
    ].join('\n'));
  }
  for (const warning of backend.settings.warnings) process.stderr.write(`settings: ${warning}\n`);

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!options.quiet) process.stdout.write(`\n${signal}: shutting down (the runtime reaps its sessions, ~5s)...\n`);
    try {
      await server.close();
      await backend.shutdown();
    } catch (error) {
      process.stderr.write(`shutdown error: ${error.message}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return port;
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
