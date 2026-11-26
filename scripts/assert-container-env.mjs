// Asserts the properties of the environment that the container CI job claims to
// test in: a specific architecture and platform, a non-root user, and no
// controlling terminal.
//
// This is a file rather than inline shell for one reason. The alternative is three
// layers of quoting -- YAML block scalar, then bash -c '...', then node -e "..." --
// and at that depth the assertion is more likely to be wrong than the thing it
// checks. A quoted-away `!==` or a swallowed `$` turns a gate into a no-op that
// still exits 0, which is worse than no gate. Keeping it here means it can be run
// locally, both ways, before it is ever trusted in CI.
//
// Every condition is checked and *all* failures are reported, so a run says what is
// actually wrong instead of stopping at the first mismatch.
//
// Usage:
//   node scripts/assert-container-env.mjs --expect-arch=arm64 --expect-platform=linux \
//     [--expect-non-root] [--expect-no-tty] [--expect-home=/home/sentiora]
//
// Exit codes: 0 all assertions held, 1 at least one failed, 64 bad invocation.
import { parseArgs } from 'node:util';

let values;
try {
  ({ values } = parseArgs({
    options: {
      'expect-arch': { type: 'string' },
      'expect-platform': { type: 'string' },
      'expect-home': { type: 'string' },
      'expect-non-root': { type: 'boolean', default: false },
      'expect-no-tty': { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  }));
} catch (error) {
  // A typo'd flag must not turn into a stack trace, and above all must not turn
  // into a pass.
  console.error(`bad invocation: ${error.message}`);
  process.exit(64);
}

const expectedArch = values['expect-arch'];
const expectedPlatform = values['expect-platform'];
if (!expectedArch || !expectedPlatform) {
  console.error('--expect-arch and --expect-platform are both required; refusing to assert nothing');
  process.exit(64);
}

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const actual = {
  node: process.version,
  arch: process.arch,
  platform: process.platform,
  uid,
  home: process.env.HOME ?? null,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
};

console.log(`environment: ${JSON.stringify(actual)}`);

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
};

check(process.arch === expectedArch, `process.arch is ${expectedArch} (found ${process.arch})`);
check(process.platform === expectedPlatform, `process.platform is ${expectedPlatform} (found ${process.platform})`);

if (values['expect-non-root']) {
  // On Windows there is no uid at all, so this cannot be asserted there. Reporting
  // it as a failure rather than skipping it silently is the point: a platform that
  // cannot express the condition must not be allowed to claim it verified it.
  check(uid !== null && uid !== 0, `process is not root (uid ${uid})`);
}

if (values['expect-no-tty']) {
  check(!process.stdin.isTTY, 'stdin is not a TTY');
  check(!process.stdout.isTTY, 'stdout is not a TTY');
}

if (values['expect-home']) {
  check(actual.home === values['expect-home'], `HOME is ${values['expect-home']} (found ${actual.home})`);
}

if (failures.length) {
  console.error(`environment assertion FAILED: ${failures.length} condition(s) unmet`);
  process.exit(1);
}
console.log('environment assertion: OK');
