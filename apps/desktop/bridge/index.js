// Composition root for the desktop backend: runtime discovery, host pool,
// session bridge and settings, wired together.
//
// Discovery order mirrors the pattern proposed in
// docs/integrations/telekinesis.md section 9.1: an explicit environment override
// first, then the runtime that ships alongside this app. It fails loudly rather
// than silently substituting something else, so a run is always attributable to a
// specific runtime.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from './runtime-client.js';
import { RuntimeHostPool } from './host-pool.js';
import { SessionBridge } from './session-bridge.js';
import { SettingsStore, defaultSettingsPath } from './settings.js';
import { RECYCLE_AFTER_SESSIONS, SESSION_LIMIT } from './protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop/bridge -> repository root
const repositoryRoot = resolve(here, '..', '..', '..');

export function resolveRuntime({ runtimePath, nodePath } = {}) {
  const script = runtimePath
    ?? process.env.SENTIORA_RUNTIME
    ?? join(repositoryRoot, 'src', 'server.js');
  const executable = nodePath ?? process.env.SENTIORA_NODE ?? process.execPath;
  const absolute = resolve(script);
  if (!existsSync(absolute)) {
    throw new Error(`Sentiora runtime not found at ${absolute}. Set SENTIORA_RUNTIME to the path of src/server.js.`);
  }
  return { command: executable, args: [absolute], cwd: repositoryRoot, path: absolute };
}

export async function createDesktopBackend({
  runtime,
  settingsPath = defaultSettingsPath(),
  recycleAfter = RECYCLE_AFTER_SESSIONS,
  maxHosts = 4,
  sessionLimit = SESSION_LIMIT,
  scrollbackLimit = 2000,
  maxQueuedFrames = 4,
  env = process.env,
} = {}) {
  const resolved = runtime ?? resolveRuntime();
  const pool = new RuntimeHostPool({
    recycleAfter,
    maxHosts,
    sessionLimit,
    // Each host is a separate runtime process, so the 16-session cap and the
    // descriptor ceiling apply per host and recycling one cannot disturb another.
    factory: async () => {
      const client = new RuntimeClient({
        command: resolved.command, args: resolved.args, cwd: resolved.cwd, env,
      }).start();
      await client.initialize();
      return client;
    },
  });

  const bridge = new SessionBridge({ pool, scrollbackLimit, maxQueuedFrames });
  const settings = new SettingsStore({ path: settingsPath });
  await settings.load();

  return {
    pool,
    bridge,
    settings,
    runtime: resolved,
    async shutdown() {
      await bridge.shutdown();
    },
  };
}

export { RuntimeClient } from './runtime-client.js';
export { RuntimeHostPool } from './host-pool.js';
export { SessionBridge } from './session-bridge.js';
export { SettingsStore, resolveAnimation, validateSettings, defaultSettingsPath, DEFAULT_SETTINGS } from './settings.js';
export { SentioraError, classify, TransportError } from './errors.js';
export * from './protocol.js';
