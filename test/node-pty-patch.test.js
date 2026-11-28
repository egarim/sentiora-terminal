// The constructor patch is applied to node_modules by scripts/patch-node-pty.mjs at install
// time. Nothing else verifies that it ran: a fresh `npm ci` on a machine where the
// postinstall was skipped would silently reinstate the host leak, and every behavioural
// test would still pass until the day a spawn failed inside connect(). This test is the
// tripwire, and it fails with the fix rather than the symptom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

test('WIN-24 the installed node-pty carries the failed-connect cleanup', {
  skip: process.platform !== 'win32' ? 'the patch is Windows ConPTY only' : false,
}, async () => {
  const require = createRequire(import.meta.url);
  const agentPath = join(dirname(require.resolve('node-pty')), 'windowsPtyAgent.js');

  let source;
  try {
    source = await readFile(agentPath, 'utf8');
  } catch (error) {
    assert.fail(`cannot read the installed node-pty at ${agentPath}: ${error.message}`);
  }

  assert.ok(source.includes('_releaseAfterFailedConnect'),
    `the installed node-pty has no failed-connect cleanup, so a spawn that fails inside connect() ` +
    `leaves the host unable to exit. Run: npm run patch:node-pty\nFile: ${agentPath}`);
});
