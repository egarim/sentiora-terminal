// The node-pty patches are applied to node_modules by scripts/patch-node-pty.mjs at install
// time. Nothing else verifies that they ran: a fresh `npm ci` on a machine where the
// postinstall was skipped would silently reinstate the host leak, and every behavioural
// test would still pass until the day a spawn failed inside connect(). This test is the
// tripwire, and it fails with the fix rather than the symptom.
//
// Both patches are checked: the failed-connect cleanup (WIN-24) and the console-list exit
// guard (WIN-26). The second one has no local behavioural test on purpose -- it only bites
// on x64 Windows runners, where ST14-05 is the behavioural test, so a local one would pass
// on ARM64 whether or not the guard is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const windowsOnly = { skip: process.platform !== 'win32' ? 'the patches are Windows ConPTY only' : false };

async function installedAgent() {
  const require = createRequire(import.meta.url);
  const agentPath = join(dirname(require.resolve('node-pty')), 'windowsPtyAgent.js');
  try {
    return await readFile(agentPath, 'utf8');
  } catch (error) {
    assert.fail(`cannot read the installed node-pty at ${agentPath}: ${error.message}`);
  }
}

test('WIN-24 the installed node-pty carries the failed-connect cleanup', windowsOnly, async () => {
  const source = await installedAgent();
  assert.ok(source.includes('_releaseAfterFailedConnect'),
    'the installed node-pty has no failed-connect cleanup, so a spawn that fails inside connect() ' +
    'leaves the host unable to exit. Run: npm run patch:node-pty');
});

test('WIN-26 the installed node-pty settles the console list when its agent exits', windowsOnly, async () => {
  const source = await installedAgent();
  // The console-process-list helper is a forked process. When AttachConsole fails -- which is
  // what happens when the child is already gone -- it exits without a message, and node-pty
  // 1.1.0 only settles the promise at the 5 s timeout. Without the guard, every such close
  // waits out that timeout while the child it was meant to reap stays alive; measured on
  // windows-latest x64, that is what turns ST14-05's sequential closes into a 60 s hang.
  assert.ok(source.includes('_consoleListExitGuard') && source.includes("agent.on('exit'"),
    'the installed node-pty settles the console-process-list promise only on its 5 s timeout, so a ' +
    'close whose helper exits without a message waits out the timeout. Run: npm run patch:node-pty');
});
