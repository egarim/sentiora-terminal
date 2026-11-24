// Shell discovery for the onboarding screen (issue #7, S1).
//
// The catalog returns a fixed, enumerated set of shells found on this machine.
// That enumeration is the security boundary: the UI offers these entries plus an
// explicit absolute path the user types, and nothing else. It never accepts a
// free-form command line from the webview, which is what keeps the frontend from
// becoming an arbitrary shell bridge (#7's "least privilege, no arbitrary
// frontend shell bridge").
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const PATHEXT = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);

function isExecutableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Scans PATH directly instead of spawning `where`/`which`: no child process, no
// console window on Windows, and the result is deterministic.
function findOnPath(name) {
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = windows
    ? entries.flatMap(dir => [join(dir, name), ...PATHEXT.map(ext => join(dir, `${name}${ext}`))])
    : entries.map(dir => join(dir, name));
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function systemRoot() {
  return process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
}

// `probe` is a command plus the text it must produce. Onboarding uses it for the
// "test this shell" button and the tests use it for U01, so the same assertion
// covers the UI path and the CI path.
const PROBES = {
  powershell: { command: 'Write-Output SENTIORA-PROBE-OK\r', expect: 'SENTIORA-PROBE-OK' },
  cmd: { command: 'echo SENTIORA-PROBE-OK\r', expect: 'SENTIORA-PROBE-OK' },
  posix: { command: 'echo SENTIORA-PROBE-OK\n', expect: 'SENTIORA-PROBE-OK' },
};

// Prompt patterns are heuristics, not a guarantee: a user's PS1 or PowerShell
// prompt can be anything. They gate Ctrl+C, where a false negative is safe (the
// interrupt is refused) and a false positive is not (the child can be killed),
// so they are deliberately narrow and always combined with the observed
// 'operational' state. PR3's shell integration is what replaces them properly.
//
// Written to be matched against the whole multi-line screen with no RegExp flags:
// the runtime trims trailing whitespace per line, so a prompt line ends on the
// marker itself or on a newline.
const PROMPTS = {
  powershell: 'PS [^\\n>]*>',
  cmd: '[A-Za-z]:\\\\[^\\n>]*>',
  bash: '[#$][ \t]*(?:\\n|$)',
  zsh: '[#$%>][ \t]*(?:\\n|$)',
  sh: '[#$][ \t]*(?:\\n|$)',
  fish: '[>$#][ \t]*(?:\\n|$)',
};

function entry({ id, label, family, command, args = [], cwd = null, promptPattern = null, probe }) {
  return {
    id, label, family, command, args, cwd,
    promptPattern,
    probe: PROBES[probe],
    available: isExecutableFile(command),
  };
}

function windowsShells() {
  const root = systemRoot();
  const shells = [
    entry({
      id: 'pwsh', label: 'PowerShell 7', family: 'powershell',
      command: findOnPath('pwsh') ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'], probe: 'powershell', promptPattern: PROMPTS.powershell,
    }),
    entry({
      id: 'powershell', label: 'Windows PowerShell', family: 'powershell',
      command: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo'], probe: 'powershell', promptPattern: PROMPTS.powershell,
    }),
    entry({
      id: 'cmd', label: 'Command Prompt', family: 'cmd',
      command: process.env.ComSpec ?? join(root, 'System32', 'cmd.exe'),
      args: [], probe: 'cmd', promptPattern: PROMPTS.cmd,
    }),
    entry({
      id: 'git-bash', label: 'Git Bash', family: 'bash',
      command: findOnPath('bash') ?? 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'], probe: 'posix', promptPattern: PROMPTS.bash,
    }),
    entry({
      id: 'wsl', label: 'WSL', family: 'wsl',
      command: join(root, 'System32', 'wsl.exe'),
      args: [], probe: 'posix', promptPattern: PROMPTS.bash,
    }),
  ];
  return shells;
}

function posixShells() {
  const loginShell = process.env.SHELL ?? null;
  const families = { bash: 'bash', zsh: 'zsh', fish: 'fish', sh: 'sh', dash: 'sh' };
  const shells = [];
  if (loginShell) {
    const base = loginShell.split('/').pop();
    shells.push(entry({
      id: 'login', label: `Login shell (${base})`, family: families[base] ?? 'sh',
      command: loginShell, args: [], probe: 'posix',
      promptPattern: PROMPTS[families[base]] ?? PROMPTS.sh,
    }));
  }
  for (const [name, family] of [['bash', 'bash'], ['zsh', 'zsh'], ['fish', 'fish']]) {
    const found = findOnPath(name);
    if (!found) continue;
    shells.push(entry({
      id: name, label: name, family, command: found, args: [], probe: 'posix',
      promptPattern: PROMPTS[family],
    }));
  }
  for (const path of ['/bin/sh', '/usr/bin/sh']) {
    if (!isExecutableFile(path)) continue;
    shells.push(entry({ id: 'sh', label: 'sh', family: 'sh', command: path, args: [], probe: 'posix', promptPattern: PROMPTS.sh }));
    break;
  }
  return shells;
}

export function detectShells() {
  return (windows ? windowsShells() : posixShells()).filter(shell => shell.available);
}

// The first available shell, preferring an interactive one over a bare /bin/sh.
export function defaultShell(shells = detectShells()) {
  return shells.find(s => s.id === 'pwsh')
    ?? shells.find(s => s.id === 'powershell')
    ?? shells.find(s => s.id === 'login')
    ?? shells.find(s => ['bash', 'zsh', 'cmd'].includes(s.id))
    ?? shells[0]
    ?? null;
}

// Validates a user-supplied shell path. Absolute and an existing file, or it is
// refused: a relative name would be resolved against the runtime host's PATH by
// whoever ends up spawning it, and a bare command string would turn the
// onboarding form into a command injection point.
export function validateCustomShell(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, reason: 'a shell path is required' };
  }
  const raw = input.trim();
  // Checked before resolve(): resolve() would happily turn a bare name into a
  // path under the current directory, and then which directory the shell came
  // from would depend on wherever the bridge happened to be started.
  if (!isAbsolute(raw)) return { ok: false, reason: 'the shell path must be absolute' };
  const path = resolve(raw);
  if (!existsSync(path)) return { ok: false, reason: `no such file: ${path}` };
  if (!isExecutableFile(path)) return { ok: false, reason: `not a regular file: ${path}` };
  // On Windows an extensionless file may still be a valid executable, but a file
  // with a non-executable extension is not: spawning one fails deep inside
  // CreateProcess with "error code: 193", which tells the user nothing. Refuse it
  // here with a reason they can act on.
  if (windows) {
    const base = path.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    // dot > 0 so a leading-dot filename is treated as extensionless.
    if (dot > 0) {
      const extension = base.slice(dot + 1).toLowerCase();
      if (!PATHEXT.some(candidate => candidate.toLowerCase() === `.${extension}`)) {
        return { ok: false, reason: `.${extension} is not an executable type on Windows (expected one of ${PATHEXT.join(', ')})` };
      }
    }
  }
  const base = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
  const family = Object.hasOwn(PROMPTS, base) ? base : 'sh';
  return {
    ok: true,
    shell: {
      id: 'custom',
      label: base,
      family,
      command: path,
      args: [],
      cwd: null,
      promptPattern: PROMPTS[family] ?? null,
      probe: windows && family === 'cmd' ? PROBES.cmd : PROBES.posix,
      available: true,
      custom: true,
    },
  };
}

// Resolves the persisted settings.shell selection back into a concrete entry.
// Falls back to detection when the stored shell has gone away (uninstalled, or
// settings copied between machines) rather than failing the launch.
export function resolveShell(settings, shells = detectShells()) {
  const selection = settings?.shell ?? {};
  if (selection.id && selection.id !== 'auto') {
    const match = shells.find(s => s.id === selection.id);
    if (match) return { shell: match, resolvedBy: 'id' };
  }
  if (typeof selection.command === 'string' && selection.command) {
    const validated = validateCustomShell(selection.command);
    if (validated.ok) {
      return {
        shell: { ...validated.shell, args: Array.isArray(selection.args) ? selection.args : [], cwd: selection.cwd ?? null },
        resolvedBy: 'command',
      };
    }
  }
  const fallback = defaultShell(shells);
  if (!fallback) return { shell: null, resolvedBy: 'none' };
  return { shell: fallback, resolvedBy: 'default' };
}
