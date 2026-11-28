// Boots the real desktop stack for a browser test: the loopback IPC server, a session bridge backed
// by the scriptable fake runtime, and the built UI on disk.
//
// Why the fake runtime rather than a real shell: an interaction test asserts what the UI does with a
// session, not that ConPTY works — that is `test:native`'s job. The fake answers deterministically, so
// a failure here means the UI drifted, not the machine.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeBackend, temporaryDirectory, removeDirectory } from '../../../test/helpers/desktop.mjs';
import { IpcServer, generateToken } from '../server/ipc.js';
import { SettingsStore } from '../bridge/settings.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * Starts the app and returns everything a test needs.
 * The token travels in the URL fragment, exactly as the real launcher delivers it, so the tests
 * exercise the same bootstrap path a user does.
 */
export async function startApp({ settingsPatch = null } = {}) {
  const backend = await createFakeBackend({});
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
