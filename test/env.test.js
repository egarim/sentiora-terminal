// Unit tests for the session environment allowlist (issue #26). No PTY is spawned,
// so these run identically on every platform -- including the Windows
// case-insensitivity rules, which CI would otherwise never exercise on Linux.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionEnv, envValidationError,
  POSIX_ENV_NAMES, WINDOWS_ENV_NAMES, DEFAULT_ENV_NAMES,
} from '../src/env.js';

const HOST = {
  PATH: '/usr/bin', HOME: '/home/agent', TERM: 'xterm-256color', LANG: 'C.UTF-8',
  SHELL: '/bin/bash', USER: 'agent', TMPDIR: '/tmp', TZ: 'UTC',
  SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  // The sort of thing that must never reach a session.
  AWS_SECRET_ACCESS_KEY: 'super-secret-value',
  GITHUB_TOKEN: 'ghp_alsosecret',
  OPENAI_API_KEY: 'sk-secret',
};

test('the default environment is an allowlist, not the host environment', () => {
  const env = sessionEnv(undefined, { hostEnv: HOST, caseInsensitive: false, names: POSIX_ENV_NAMES });
  assert.equal(env.PATH, '/usr/bin', 'a shell needs PATH');
  assert.equal(env.HOME, '/home/agent');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.LANG, 'C.UTF-8');
  for (const secret of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY']) {
    assert.equal(env[secret], undefined, `${secret} must not be inherited by default`);
  }
  assert.ok(!JSON.stringify(env).includes('secret'), 'no secret value may appear anywhere in the environment');
});

test('the default allowlist cannot be widened by what the host happens to have', () => {
  const env = sessionEnv(undefined, { hostEnv: HOST, caseInsensitive: false, names: POSIX_ENV_NAMES });
  // Every key must be one the allowlist asked for; nothing extra may slip through
  // just because the host had it.
  for (const name of Object.keys(env)) {
    assert.ok(POSIX_ENV_NAMES.includes(name), `${name} is not on the allowlist`);
  }
});

test('an explicitly requested variable is passed, and only that one', () => {
  const env = sessionEnv({ BUILD_NUMBER: '42' }, { hostEnv: HOST, caseInsensitive: false, names: POSIX_ENV_NAMES });
  assert.equal(env.BUILD_NUMBER, '42');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'an explicit request must not unlock the rest of the host env');
});

test('an explicit value overrides an inherited default', () => {
  const env = sessionEnv({ TERM: 'dumb', LANG: 'C' }, { hostEnv: HOST, caseInsensitive: false, names: POSIX_ENV_NAMES });
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.LANG, 'C');
  // One entry each, not a default and an override side by side.
  assert.equal(Object.keys(env).filter(k => k === 'TERM').length, 1);
});

test('an explicit empty string clears a default rather than keeping it', () => {
  const env = sessionEnv({ TZ: '' }, { hostEnv: HOST, caseInsensitive: false, names: POSIX_ENV_NAMES });
  assert.equal(env.TZ, '', 'an explicitly empty value is a choice, not an omission');
});

test('Windows names differing only by case collapse to one variable', () => {
  const host = { PATH: 'C:\\bin', Path: 'C:\\other', SystemRoot: 'C:\\Windows', PATHEXT: '.EXE;.CMD' };
  const env = sessionEnv({ path: 'C:\\caller' }, { hostEnv: host, caseInsensitive: true, names: WINDOWS_ENV_NAMES });
  const pathKeys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH');
  assert.equal(pathKeys.length, 1, `PATH must appear once, got ${JSON.stringify(pathKeys)}`);
  // The caller's spelling and value win, since an explicit request overrides a default.
  assert.equal(env[pathKeys[0]], 'C:\\caller');
  // The host's own spelling is preserved for a name the caller did not supply, so
  // SystemRoot stays SystemRoot rather than becoming SYSTEMROOT.
  assert.ok('SystemRoot' in env, `expected the host spelling to be preserved, got ${JSON.stringify(Object.keys(env))}`);
  assert.equal(env.SystemRoot, 'C:\\Windows');
});

test('case-sensitive matching keeps two names that differ only by case', () => {
  const host = { PATH: '/usr/bin', Path: '/other' };
  const env = sessionEnv(undefined, { hostEnv: host, caseInsensitive: false, names: ['PATH', 'Path'] });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.Path, '/other');
});

test('non-string values are dropped rather than coerced', () => {
  const env = sessionEnv({ A: 'ok', B: 123, C: null, D: { nested: true } },
    { hostEnv: HOST, caseInsensitive: false, names: [] });
  assert.equal(env.A, 'ok');
  for (const name of ['B', 'C', 'D']) {
    assert.equal(env[name], undefined, `${name} must not be coerced into the environment`);
  }
});

test('an empty name is dropped', () => {
  const env = sessionEnv({ '': 'value' }, { hostEnv: HOST, caseInsensitive: false, names: [] });
  assert.deepEqual(env, {});
});

test('defaults come from the platform, and both lists are non-trivial', () => {
  assert.equal(DEFAULT_ENV_NAMES, process.platform === 'win32' ? WINDOWS_ENV_NAMES : POSIX_ENV_NAMES);
  for (const [label, names] of [['posix', POSIX_ENV_NAMES], ['windows', WINDOWS_ENV_NAMES]]) {
    assert.ok(names.includes('PATH'), `${label} list must include PATH`);
    assert.ok(names.includes('TERM'), `${label} list must include TERM`);
  }
  // The Windows extras are not decoration: without them a session spawns and then
  // cannot run anything, which is worse than the leak being closed.
  for (const required of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'USERPROFILE']) {
    assert.ok(WINDOWS_ENV_NAMES.includes(required), `windows list must include ${required}`);
  }
});

test('envValidationError accepts an object of strings and nothing else', () => {
  assert.equal(envValidationError(undefined), null);
  assert.equal(envValidationError(null), null);
  assert.equal(envValidationError({}), null);
  assert.equal(envValidationError({ A: 'b' }), null);
  for (const bad of ['string', 42, true, [], [{ A: 'b' }], { A: 1 }, { A: null }, { A: ['x'] }, { '': 'x' }]) {
    assert.equal(envValidationError(bad), 'Invalid env', `should reject ${JSON.stringify(bad)}`);
  }
});

test('names and values that would corrupt the environment block are rejected', () => {
  // node-pty builds `key=value`, and on Windows concatenates the block as `K=V\0`.
  // An `=` in a name yields a differently-named variable than the caller asked for,
  // and a NUL in either half injects extra entries into the child's environment.
  for (const bad of [
    { 'A=B': 'x' },
    { 'A\0B': 'x' },
    { A: 'x\0INJECTED=y' },
    // `{__proto__: ...}` as a literal sets the prototype and creates no own
    // property, so it would test nothing. Real requests arrive through JSON.parse,
    // which DOES create an own `__proto__` key -- that is the case worth rejecting.
    JSON.parse('{"__proto__":"x"}'),
    { constructor: 'x' },
    { prototype: 'x' },
  ]) {
    assert.equal(envValidationError(bad), 'Invalid env', `should reject ${JSON.stringify(bad)}`);
  }
  assert.ok(Object.hasOwn(JSON.parse('{"__proto__":"x"}'), '__proto__'),
    'precondition: JSON.parse must yield an own __proto__ key for the case above to mean anything');
  // And sessionEnv drops them rather than passing them through, so a caller that
  // bypasses validation cannot get them into the child either.
  const env = sessionEnv({ 'A=B': 'x', GOOD: 'y', A: 'v\0BAD=z' },
    { hostEnv: {}, caseInsensitive: false, names: [] });
  assert.deepEqual(env, { GOOD: 'y' }, `sanitisation let something through: ${JSON.stringify(env)}`);
});

test('the allowlist covers what ordinary Windows tooling needs', () => {
  // cmd.exe starting is the floor, not the bar: git, npm, PowerShell module
  // auto-loading, MSBuild and most installers read APPDATA/LOCALAPPDATA, and
  // `%ProgramFiles%` expanding to nothing breaks ordinary scripts. A list narrow
  // enough that the shell starts but the tooling misbehaves is on the wrong side of
  // the standard src/env.js sets for itself.
  for (const required of [
    'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
    'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
    'ProgramFiles', 'ProgramFiles(x86)', 'PSModulePath', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS', 'OS', 'PUBLIC', 'USERDOMAIN',
  ]) {
    assert.ok(WINDOWS_ENV_NAMES.includes(required), `windows allowlist is missing ${required}`);
  }
});

test('every allowlisted name survives a round trip from a fully populated host', () => {
  // Guards the list against a name that is declared but never actually copied,
  // which would silently narrow sessions on that platform.
  for (const [label, names] of [['posix', POSIX_ENV_NAMES], ['windows', WINDOWS_ENV_NAMES]]) {
    const host = Object.fromEntries(names.map(n => [n, `v-${n}`]));
    const env = sessionEnv(undefined, { hostEnv: host, caseInsensitive: false, names });
    for (const n of names) {
      assert.equal(env[n], `v-${n}`, `${label}: ${n} was declared but not inherited`);
    }
    assert.equal(Object.keys(env).length, names.length, `${label}: unexpected extra or missing names`);
  }
});

test('no validation message echoes a value', () => {
  // The whole point of the allowlist is that secrets do not travel. An error that
  // quoted the offending entry would put one into a JSON-RPC response and every log
  // downstream of it -- a wider leak than the one being closed.
  //
  // The secret is a well-formed string alongside a genuinely invalid entry, so the
  // object is rejected because of BAD while the secret sits right next to it: the
  // realistic shape of a caller getting one value wrong.
  const secret = 'sk-live-do-not-log-me';
  const message = envValidationError({ API_KEY: secret, BAD: 123 });
  assert.equal(message, 'Invalid env');
  assert.ok(!message.includes(secret), 'the secret value was echoed');
  assert.ok(!message.includes('API_KEY'), 'a neighbouring variable name was echoed');
  assert.ok(!message.includes('BAD'), 'the offending variable name was echoed');
  assert.ok(!message.includes('123'), 'the offending value was echoed');
});
