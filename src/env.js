// Environment allowlist for spawned sessions (issue #26).
//
// terminal.create used to spawn with `env: process.env`, so every program an agent
// ran could read the host process's entire environment -- API keys, cloud
// credentials, signing tokens. Nothing in the runtime needed that; it was the
// default falling out of node-pty's signature, and it was documented as a known
// gap in three places rather than fixed.
//
// The default is now a small fixed allowlist of variables a shell genuinely needs.
// Anything else reaches a session only if the caller names it explicitly.
//
// Values are never echoed. An error that quoted an offending value would put a
// secret into a JSON-RPC error response, a log line, and anything downstream of
// both -- which is a wider leak than the one being closed.

// Windows needs more than the POSIX set, and the extras are not convenience:
// without SystemRoot a large part of the Win32 API fails outright, without ComSpec
// cmd.exe cannot be located, and PATHEXT governs which extensions are executable.
// Omitting them produces a session that spawns and then cannot run anything, which
// is a worse outcome than the leak this file exists to close.
//
// The same reasoning extends to the program-location and shell variables: git, npm,
// PowerShell module auto-loading, MSBuild and most installers read APPDATA and
// LOCALAPPDATA, and `%ProgramFiles%` expanding to nothing breaks ordinary scripts.
// A list narrow enough that cmd.exe starts but the usual tooling misbehaves is on
// the wrong side of the bar this file sets for itself.
const POSIX_NAMES = [
  'PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TZ',
];
const WINDOWS_NAMES = [
  'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'PSModulePath', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'OS', 'PUBLIC',
  'TERM', 'LANG', 'TZ',
];

// node-pty builds `key=value` and, on Windows, concatenates the block as `K=V\0`.
// An `=` in a name therefore produces a differently-named variable than the caller
// asked for, and a NUL in either half injects extra entries into the child's
// environment. No privilege is gained today -- everything injected is
// caller-supplied and a caller may name any variable anyway -- but this is the file
// that defines the boundary, so its encoding should not be able to disagree with
// its intent. The prototype keys are rejected rather than silently dropped so a
// caller can tell "set" from "ignored".
const REJECTED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function nameIsUsable(name) {
  return typeof name === 'string' && name !== ''
    && !name.includes('=') && !name.includes('\0')
    && !REJECTED_NAMES.has(name);
}

export const POSIX_ENV_NAMES = POSIX_NAMES;
export const WINDOWS_ENV_NAMES = WINDOWS_NAMES;
export const DEFAULT_ENV_NAMES = process.platform === 'win32' ? WINDOWS_NAMES : POSIX_NAMES;

// Builds the environment for a session.
//
// `caseInsensitive` and `names` are parameters rather than being read from
// process.platform unconditionally so both behaviours are testable on any platform
// -- CI runs Linux, where the Windows case rules would otherwise be untestable.
//
// Windows environment variable names are case-insensitive but case-preserving, so a
// caller's `Path` and an inherited `PATH` are the same variable. Emitting both
// leaves which one wins undefined; collapsing them on a canonical key and keeping
// the caller's spelling does not.
export function sessionEnv(requested, options = {}) {
  const {
    hostEnv = process.env,
    caseInsensitive = process.platform === 'win32',
    names = DEFAULT_ENV_NAMES,
  } = options;

  const canonical = new Map();
  const key = name => (caseInsensitive ? name.toUpperCase() : name);
  const put = (name, value) => {
    if (!nameIsUsable(name)) return;
    // A NUL in a value would terminate the Windows environment block early and
    // inject whatever follows it as further entries.
    if (typeof value !== 'string' || value.includes('\0')) return;
    canonical.set(key(name), { name, value });
  };

  // Host defaults first, so an explicit request overrides them. The host's own
  // spelling of a name is preferred when the caller does not supply one, which
  // keeps `SystemRoot` capitalised rather than normalising it to `SYSTEMROOT`.
  for (const wanted of names) {
    const found = Object.keys(hostEnv).find(k => key(k) === key(wanted));
    if (found !== undefined) put(found, hostEnv[found]);
  }
  if (requested) {
    for (const [name, value] of Object.entries(requested)) put(name, value);
  }

  // Always returns a plain object, never undefined or null. That is load-bearing:
  // node-pty does `opt.env = opt.env || process.env` in both unixTerminal.js and
  // windowsTerminal.js, so a falsy return here would silently restore the exact
  // leak this module exists to close, with no test failing. `{}` is truthy.
  const out = {};
  for (const { name, value } of canonical.values()) out[name] = value;
  return out;
}

// Validates the caller-supplied env without ever putting a name or a value in the
// message. An error that echoed either would put a secret into a JSON-RPC response
// and every log downstream of it -- a wider leak than the one being closed.
export function envValidationError(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'Invalid env';
  for (const [name, entry] of Object.entries(value)) {
    if (!nameIsUsable(name)) return 'Invalid env';
    if (typeof entry !== 'string' || entry.includes('\0')) return 'Invalid env';
  }
  return null;
}
