// The pid-reuse guard (issue #24). This is the check that decides whether a "surviving child" is a
// leaked process or a recycled id, and the harness's zero-survivor threshold depends on it — so it is
// tested rather than trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CREATED_AFTER_SLACK_MS, identityIsOurs, processIdentities } from './bench/lib/identity.mjs';

test('ID-01 a process created after the spawn time is not ours', () => {
  const spawnedAt = Date.now();

  // The measured failure mode: a recycled pid belonging to a conhost created much later.
  assert.equal(identityIsOurs({ name: 'conhost.exe', createdMs: spawnedAt + 60000 }, spawnedAt), false);
  // Our own child was created at or just before we recorded the time.
  assert.equal(identityIsOurs({ name: 'node.exe', createdMs: spawnedAt - 50 }, spawnedAt), true);
  // Within the clock-skew slack it is still ours.
  assert.equal(identityIsOurs({ name: 'node.exe', createdMs: spawnedAt + CREATED_AFTER_SLACK_MS - 1 }, spawnedAt), true);
  // Just past the slack it is not.
  assert.equal(identityIsOurs({ name: 'node.exe', createdMs: spawnedAt + CREATED_AFTER_SLACK_MS + 1 }, spawnedAt), false);
});

test('ID-02 an unreadable identity or spawn time is kept, not discarded', () => {
  const spawnedAt = Date.now();
  // Conservative on both sides: a possibly-leaked child must not be filtered away by a failed query.
  assert.equal(identityIsOurs(undefined, spawnedAt), true);
  assert.equal(identityIsOurs({ name: 'node.exe', createdMs: Number.NaN }, spawnedAt), true);
  assert.equal(identityIsOurs({ name: 'node.exe', createdMs: spawnedAt + 60000 }, undefined), true);
});

test('ID-03 a live child is found by one batched query and accepted', {
  skip: process.platform !== 'win32' ? 'Win32_Process is Windows only' : false,
  timeout: 60000,
}, async t => {
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });

  const identities = await processIdentities([child.pid]);
  const identity = identities.get(child.pid);
  assert.ok(identity, 'the child must be found by the batched query');
  assert.match(identity.name, /node/i);
  assert.equal(identityIsOurs(identity, spawnedAt), true,
    `the child was created ${identity.createdMs - spawnedAt}ms relative to the recorded spawn time`);
});

test('ID-04 off Windows it returns nothing rather than guessing', async () => {
  const identities = await processIdentities([1234], { platform: 'linux' });
  assert.equal(identities.size, 0);
});
