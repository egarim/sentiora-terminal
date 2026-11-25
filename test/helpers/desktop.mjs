// Shared helpers for the desktop bridge tests.
//
// These drive the bridge against test/fixtures/fake-runtime.mjs, which reproduces
// the real protocol's revision guard, lifecycle states and error strings without
// spending a PTY. The real runtime is exercised separately in
// test/desktop-native.test.js; nothing here replaces those tests.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from '../../apps/desktop/bridge/runtime-client.js';
import { RuntimeHostPool } from '../../apps/desktop/bridge/host-pool.js';
import { SessionBridge } from '../../apps/desktop/bridge/session-bridge.js';
import { SettingsStore } from '../../apps/desktop/bridge/settings.js';

export const FAKE_RUNTIME = fileURLToPath(new URL('../fixtures/fake-runtime.mjs', import.meta.url));
export const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const REAL_RUNTIME = fileURLToPath(new URL('../../src/server.js', import.meta.url));
export const INTERACTIVE_FIXTURE = fileURLToPath(new URL('../fixtures/interactive.mjs', import.meta.url));

// Builds a bridge whose runtime hosts are fake-runtime processes. `runtimeArgs`
// selects the failure mode under test; `pool` options control recycling.
export async function createFakeBackend({
  runtimeArgs = [],
  recycleAfter = 350,
  maxHosts = 4,
  sessionLimit = 16,
  scrollbackLimit = 2000,
  maxQueuedFrames = 4,
} = {}) {
  const pool = new RuntimeHostPool({
    recycleAfter,
    maxHosts,
    sessionLimit,
    factory: async () => {
      const client = new RuntimeClient({
        command: process.execPath,
        args: [FAKE_RUNTIME, ...runtimeArgs],
      }).start();
      await client.initialize();
      return client;
    },
  });
  const bridge = new SessionBridge({ pool, scrollbackLimit, maxQueuedFrames });
  const events = [];
  for (const name of ['session-created', 'session-closed', 'session-lost', 'session-state', 'write-error', 'session-close-error']) {
    bridge.on(name, payload => events.push({ name, payload }));
  }
  pool.on('host-recycled', payload => events.push({ name: 'host-recycled', payload }));
  pool.on('host-lost', payload => events.push({ name: 'host-lost', payload }));

  return {
    pool,
    bridge,
    events,
    eventsOf: name => events.filter(event => event.name === name).map(event => event.payload),
    // The fake runtime announces issued owner tokens on stderr. Tests read them
    // back so they can assert the token appears in no UI-facing payload, instead
    // of guessing the token from the fixture's numbering scheme.
    ownerTokensIssued() {
      return pool.clients
        .flatMap(client => client.stderrTail.split('\n'))
        .filter(line => line.startsWith('OWNER '))
        .map(line => line.split(' ')[2]);
    },
    async shutdown() {
      await bridge.shutdown();
    },
  };
}

// A real bridge against src/server.js, for the native tests.
export async function createRealBackend({
  command = process.execPath,
  args = [INTERACTIVE_FIXTURE],
  scrollbackLimit = 2000,
  maxQueuedFrames = 4,
} = {}) {
  const pool = new RuntimeHostPool({
    factory: async () => {
      const client = new RuntimeClient({ command: process.execPath, args: [REAL_RUNTIME], cwd: REPOSITORY_ROOT }).start();
      await client.initialize();
      return client;
    },
  });
  const bridge = new SessionBridge({ pool, scrollbackLimit, maxQueuedFrames });
  return {
    pool, bridge, command, args,
    async shutdown() { await bridge.shutdown(); },
  };
}

export async function temporaryDirectory(prefix = 'sentiora-desktop-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function temporarySettings() {
  const dir = await temporaryDirectory();
  return { dir, path: join(dir, 'settings.json'), store: new SettingsStore({ path: join(dir, 'settings.json') }) };
}

export async function removeDirectory(dir) {
  await rm(dir, { recursive: true, force: true });
}

const TIMEOUT = Symbol('frame-timeout');

// Pulls frames from a subscription with an overall deadline. Returns whatever
// arrived rather than throwing, so a caller can decide whether a shortfall is a
// failure -- and so that "produce output while draining" loops can be written
// without a helper that gives up on them.
//
// Racing next() against a timer is only safe because a subscription parks a
// single shared waiter: a call that loses the race keeps ownership of the frame
// it was waiting for, so nothing is forfeited by timing out and trying again.
export async function collectFrames(subscription, { count = Infinity, timeoutMs = 20000, kind = 'frame', into = null } = {}) {
  const frames = into ?? [];
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const frame = await Promise.race([
      subscription.next(),
      new Promise(resolveRace => setTimeout(() => resolveRace(TIMEOUT), remaining)),
    ]);
    if (frame === TIMEOUT || frame === null) break;
    if (kind === null || frame.kind === kind) frames.push(frame);
  }
  return frames;
}

// Drains a subscription until it has been quiet for `quietMs`, returning what was
// delivered. Used where the point is the converged final state rather than a
// specific frame count; stopping at a fixed count would compare two consumers at
// two different points in the stream.
export async function drainUntilQuiet(subscription, { quietMs = 800, hardMs = 20000, kind = null } = {}) {
  const frames = [];
  const deadline = Date.now() + hardMs;
  for (;;) {
    const remaining = Math.min(quietMs, deadline - Date.now());
    if (remaining <= 0) break;
    const frame = await Promise.race([
      subscription.next(),
      new Promise(resolveWait => setTimeout(() => resolveWait(TIMEOUT), remaining)),
    ]);
    // TIMEOUT means the stream went quiet; null means it closed. Both end the
    // drain, but they are different facts and must not be conflated by accident.
    if (frame === TIMEOUT || frame === null) break;
    if (kind === null || frame.kind === kind) frames.push(frame);
  }
  return frames;
}

// Polls a predicate until it holds. Used instead of sleeping wherever a test has
// to wait for the pump, which is asynchronous by design.
export async function until(predicate, { timeoutMs = 10000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs));
  }
}

// Recursively collects every string in a value, so a test can assert a credential
// appears nowhere in a payload rather than checking the fields it remembered.
export function allStrings(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, found);
  return found;
}

export function assertNoOwner(assert, value, owner) {
  const haystack = JSON.stringify(value);
  if (haystack !== undefined && haystack.includes(owner)) {
    assert.fail(`an owner token leaked into a UI-facing payload: ${haystack}`);
  }
}
