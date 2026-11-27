// node-pty 1.1.0 leaves a failed spawn half-constructed, and the half it leaves behind
// is the half that keeps the process alive.
//
// lib/windowsPtyAgent.js does four things in order when ConPTY is in use:
//
//   1. _ptyNative.startProcess()      creates the pseudoconsole, conin and conout pipes
//   2. new ConoutConnection(conout)   starts a worker thread that drains conout
//   3. fs.openSync(conin, 'w')        opens the input pipe
//   4. _ptyNative.connect()           CreateProcess, attached to the pseudoconsole
//
// connect() is the step that can fail on a perfectly ordinary input -- a cwd that does
// not exist, an absolute path that is not a loadable image (measured: a zero-byte .exe,
// CreateProcess error 193). When it throws, the constructor unwinds and the caller never
// receives an agent, so nobody ever reaches kill() and nothing disposes what steps 1-3
// created:
//
//   * the ConoutConnection worker thread keeps the event loop alive, so the host process
//     can never exit -- measured still alive 25 s after stdin closed, with no stderr and
//     no way to reclaim it from JavaScript;
//   * the pseudoconsole stays open, and its baton stays in conpty.cc's global
//     ptyHandles vector (only the exit-callback thread removes it, and that thread is
//     started by the connect() that failed);
//   * the two sockets and the input fd are never closed.
//
// The fix is one try/catch: release what steps 1-3 created, then rethrow the original
// error so the caller still sees the spawn fail. Applied to the published file at install
// time because there is no seam to intercept it from outside -- the half-built agent is
// not reachable by the caller.
//
// This script is idempotent, and it FAILS rather than skipping when it cannot recognise
// the file: a silent skip would put the leak back without saying so. Bump the anchors
// when node-pty changes.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const MARKER = '_releaseAfterFailedConnect';

function die(message) {
  console.error(`sentiora: ${message}`);
  console.error('sentiora: node-pty was NOT patched; a failed spawn will strand the host process.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
let agentPath;
try {
  agentPath = join(dirname(require.resolve('node-pty')), 'windowsPtyAgent.js');
} catch (error) {
  // node-pty is not installed (or was unpacked elsewhere); nothing to patch.
  console.log(`sentiora: node-pty not resolvable (${error.code ?? error.message}), skipping the constructor patch`);
  process.exit(0);
}

let source;
try {
  source = await readFile(agentPath, 'utf8');
} catch (error) {
  die(`cannot read ${agentPath}: ${error.message}`);
}

if (source.includes(MARKER)) {
  console.log(`sentiora: ${agentPath} already patched`);
  process.exit(0);
}

const CRLF = source.includes('\r\n');
const lf = CRLF ? source.replace(/\r\n/g, '\n') : source;

const CONNECT_BEFORE = [
  '        if (this._useConpty) {',
  '            var connect = this._ptyNative.connect(this._pty, commandLine, cwd, env, this._useConptyDll, function (c) { return _this._$onProcessExit(c); });',
  '            this._innerPid = connect.pid;',
  '        }',
].join('\n');

const CONNECT_AFTER = [
  '        if (this._useConpty) {',
  '            try {',
  '                var connect = this._ptyNative.connect(this._pty, commandLine, cwd, env, this._useConptyDll, function (c) { return _this._$onProcessExit(c); });',
  '                this._innerPid = connect.pid;',
  '            }',
  '            catch (error) {',
  `                this.${MARKER}();`,
  '                throw error;',
  '            }',
  '        }',
].join('\n');

const RESIZE_ANCHOR = '    WindowsPtyAgent.prototype.resize = function (cols, rows) {';

const RELEASE_METHOD = [
  '    /**',
  '     * Releases everything the constructor created before connect() threw. The agent is',
  '     * thrown away by the caller, so nothing else will ever dispose these: the worker',
  '     * thread alone keeps the event loop alive and the process unable to exit.',
  '     */',
  `    WindowsPtyAgent.prototype.${MARKER} = function () {`,
  '        try {',
  '            this._ptyNative.kill(this._pty, this._useConptyDll);',
  '        }',
  '        catch (error) { }',
  '        try {',
  '            this._inSocket.readable = false;',
  '            this._inSocket.destroy();',
  '        }',
  '        catch (error) { }',
  '        try {',
  '            this._outSocket.readable = false;',
  '            this._outSocket.destroy();',
  '        }',
  '        catch (error) { }',
  '        try {',
  '            this._conoutSocketWorker.dispose();',
  '        }',
  '        catch (error) { }',
  '    };',
  '',
  '',
].join('\n');

function replaceOnce(haystack, needle, replacement, what) {
  const first = haystack.indexOf(needle);
  if (first === -1) die(`cannot find ${what} in ${agentPath}; the file no longer matches node-pty 1.1.0`);
  if (haystack.indexOf(needle, first + 1) !== -1) die(`found more than one ${what} in ${agentPath}`);
  return haystack.slice(0, first) + replacement + haystack.slice(first + needle.length);
}

let patched = replaceOnce(lf, CONNECT_BEFORE, CONNECT_AFTER, 'the ConPTY connect() call');
patched = replaceOnce(patched, RESIZE_ANCHOR, RELEASE_METHOD + RESIZE_ANCHOR, 'the resize method anchor');

await writeFile(agentPath, CRLF ? patched.replace(/\n/g, '\r\n') : patched);
console.log(`sentiora: patched ${resolve(agentPath)} (release the ConPTY worker when connect() fails)`);
