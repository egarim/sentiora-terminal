// Boots the real desktop stack for a browser test: the loopback IPC server, a session bridge backed
// by either the scriptable fake runtime or the real one, and the built UI on disk.
//
// Two modes, deliberately:
//   * `real: false` (default) uses the scriptable runtime. The question is what the UI does with a
//     session, and a failure there must not be caused by ConPTY.
//   * `real: true` uses src/server.js with actual shells, which is what issue #19's terminal
//     interaction tests need.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeBackend, createRealBackend, temporaryDirectory, removeDirectory } from '../../../test/helpers/desktop.mjs';
import { IpcServer, generateToken } from '../server/ipc.js';
import { SettingsStore } from '../bridge/settings.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * Starts the app and returns everything a test needs.
 * The token travels in the URL fragment, exactly as the real launcher delivers it, so the tests
 * exercise the same bootstrap path a user does.
 */
export async function startApp({ settingsPatch = null, real = false } = {}) {
  const backend = real ? await createRealBackend() : await createFakeBackend({});
  const settingsDir = await temporaryDirectory('sentiora-e2e-settings-');
  const settings = new SettingsStore({ path: join(settingsDir, 'settings.json') });
  await settings.load();
  if (settingsPatch) await settings.updateAndSave(settingsPatch);
  const token = generateToken();
  const server = new IpcServer({ bridge: backend.bridge, settings, token, staticRoot: DIST });
  const { url } = await server.listen();
  return {
    url,
    token,
    backend,
    settings,
    /** The URL a user would open: fragment token, never a query string. */
    launchUrl: `${url}/#token=${token}`,
    async stop() {
      await server.close();
      await backend.shutdown();
      await removeDirectory(settingsDir);
    },
  };
}
