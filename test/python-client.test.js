// The Python client (issue #4, M4 slice 4). The client itself is checked by a Python self-check
// script, because the point of it is that a host with only the standard library can drive a
// terminal — and checking it should not itself require a Python test framework.
//
// This wrapper runs that script and asserts on its output, so the Python client is part of the
// same `npm run test:server` gate as everything else. It skips (visibly) when no Python is present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELFCHECK = fileURLToPath(new URL('../clients/python/selfcheck.py', import.meta.url));

async function findPython() {
  for (const candidate of ['python', 'python3']) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 10000 });
      if (/Python 3\./.test(stdout)) return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

test('PY-01 the Python client drives a real session end to end', { timeout: 120000 }, async t => {
  const python = await findPython();
  if (!python) {
    // A skipped gate must not be indistinguishable from a passed one. CI runners ship Python 3, so a
    // missing interpreter there means the environment changed under us and this client is silently
    // unverified — a failure, not a skip. A developer machine without Python still skips visibly,
    // because there the absence is expected rather than a regression (issue #65).
    if (process.env.CI) {
      assert.fail('no Python 3 on a CI runner: the Python client would go unverified (see issue #65)');
    }
    t.skip('no Python 3 on this machine');
    return;
  }

  const { stdout } = await execFileAsync(python, [SELFCHECK, ROOT], { timeout: 120000 });
  const passes = stdout.split('\n').filter(line => line.startsWith('PASS '));
  assert.ok(passes.length >= 9, `expected at least 9 passing checks, saw ${passes.length}:\n${stdout}`);
  assert.match(stdout, /PYTHON CLIENT SELF-CHECK PASSED/);
});
