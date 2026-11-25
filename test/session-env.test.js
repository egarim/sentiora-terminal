// End-to-end proof for issue #26: a secret in the runtime host's environment must
// not reach a session's child, by default or by accident, and must not appear in
// any response the runtime sends back.
//
// Drives the real src/server.js over stdio (test/helpers/runtime.mjs) with a secret
// injected into the host process environment, then asks the child what it can see.
// The child reports PRESENCE, never values, so a passing test cannot itself leak
// the secret into a log or a test report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startRuntime, reap } from './helpers/runtime.mjs';

const opts = { timeout: 120000 };
const SECRET_NAME = 'SENTIORA_TEST_SECRET';
const SECRET_VALUE = `sk-live-${randomUUID()}`;

// Prints `NAME=<present>|<absent>` for each name, and nothing else. Reporting
// presence rather than the value keeps the secret out of the screen buffer, which
// the runtime returns to any caller via terminal.observe.
function probeArgs(names) {
  const program = `const names = ${JSON.stringify(names)};`
    + `const out = names.map(n => n + '=' + (process.env[n] === undefined ? '<absent>' : '<present>')).join(' ');`
    + `process.stdout.write('PROBE ' + out + String.fromCharCode(10));`;
  return [process.execPath, ['-e', program]];
}

async function probe(server, names, extraParams) {
  const [command, args] = probeArgs(names);
  const created = await server.create({ command, args, cols: 100, rows: 6, ...extraParams });
  const observed = await server.waitScreen(created.sessionId, 'PROBE ');
  return { created, screen: observed.screen };
}

test('ENV-01 a session does not inherit the host environment', opts, async () => {
  const server = startRuntime({ env: { [SECRET_NAME]: SECRET_VALUE } });
  const pids = [];
  try {
    const { created, screen } = await probe(server, [SECRET_NAME, 'PATH', 'GITHUB_TOKEN']);
    pids.push(created.pid);

    assert.match(screen, new RegExp(`${SECRET_NAME}=<absent>`),
      `the host secret reached the session by default:\n${screen}`);
    assert.match(screen, /GITHUB_TOKEN=<absent>/, 'an unrelated host variable must not be inherited either');
    // The allowlist must still produce a usable session: PATH is present, so the
    // fix is not simply "give the child nothing".
    assert.match(screen, /PATH=<present>/, `the default allowlist must still pass PATH:\n${screen}`);
    assert.ok(!screen.includes(SECRET_VALUE), 'the secret value must not appear in the observation');
  } finally {
    await server.stop();
    reap(pids.filter(pid => Number.isInteger(pid) && pid > 0));
  }
});

test('ENV-02 an explicitly named variable reaches the session and nothing else does', opts, async () => {
  const server = startRuntime({ env: { [SECRET_NAME]: SECRET_VALUE } });
  const pids = [];
  try {
    const { created, screen } = await probe(server, [SECRET_NAME, 'BUILD_NUMBER', 'PATH'], {
      env: { BUILD_NUMBER: '42' },
    });
    pids.push(created.pid);

    assert.match(screen, /BUILD_NUMBER=<present>/, `an explicitly requested variable must arrive:\n${screen}`);
    assert.match(screen, new RegExp(`${SECRET_NAME}=<absent>`),
      `requesting one variable must not unlock the rest of the host environment:\n${screen}`);
    assert.match(screen, /PATH=<present>/, 'the allowlist still applies alongside an explicit request');
    assert.ok(!screen.includes(SECRET_VALUE));
  } finally {
    await server.stop();
    reap(pids.filter(pid => Number.isInteger(pid) && pid > 0));
  }
});

test('ENV-03 a malformed env is refused without echoing any value', opts, async () => {
  const server = startRuntime({ env: { [SECRET_NAME]: SECRET_VALUE } });
  try {
    const shapes = [
      'not-an-object',
      42,
      [],
      [{ A: 'b' }],
      { GOOD: 'value', BAD: 123 },
      { GOOD: 'value', BAD: null },
      { '': 'value' },
    ];
    for (const env of shapes) {
      const [command, args] = probeArgs([SECRET_NAME]);
      const response = await server.request('terminal.create', { command, args, cols: 100, rows: 6, env });
      assert.ok(response.response.error, `env ${JSON.stringify(env)} should have been rejected`);
      assert.match(response.response.error.message, /Invalid env/);
      // The rejection must not become a second leak: neither the value nor the
      // variable name may travel back in the error.
      assert.ok(!JSON.stringify(response.response).includes(SECRET_VALUE), 'the secret value was echoed in an error');
      assert.ok(!response.response.error.message.includes(SECRET_NAME), 'the secret name was echoed in an error');
    }
    assert.deepEqual(await server.list(), [], 'a rejected create must not register a session');
  } finally {
    await server.stop();
  }
});

test('ENV-04 the secret does not appear in any observation or listing', opts, async () => {
  const server = startRuntime({ env: { [SECRET_NAME]: SECRET_VALUE } });
  const pids = [];
  try {
    const first = await probe(server, [SECRET_NAME]);
    pids.push(first.created.pid);
    const second = await probe(server, [SECRET_NAME], { env: { EXTRA: 'x' } });
    pids.push(second.created.pid);

    // Everything the runtime can hand back about these sessions.
    const listed = await server.list();
    const observed = await server.call('terminal.observe', { sessionId: first.created.sessionId });
    const initialize = await server.call('initialize', {});
    const haystack = JSON.stringify({ listed, observed, initialize, stderr: server.stderr });

    // The VALUE must never appear. The NAME legitimately does: the probe child
    // prints `SENTIORA_TEST_SECRET=<absent>` into its own screen, and terminal.list
    // and terminal.observe return that screen by design. Asserting the name is
    // absent from a screen would be asserting that the child cannot report on its
    // own environment -- which is the thing under test. Issue #26 requires that
    // values never appear, not names.
    assert.ok(!haystack.includes(SECRET_VALUE), 'the host secret value leaked into a runtime response');
    // initialize and stderr have no screen to hide behind, so the name must not
    // reach them either.
    assert.ok(!JSON.stringify(initialize).includes(SECRET_NAME), 'initialize echoed the environment');
    assert.ok(!server.stderr.includes(SECRET_NAME) && !server.stderr.includes(SECRET_VALUE),
      `the runtime wrote the secret to stderr:\n${server.stderr}`);
  } finally {
    await server.stop();
    reap(pids.filter(pid => Number.isInteger(pid) && pid > 0));
  }
});
