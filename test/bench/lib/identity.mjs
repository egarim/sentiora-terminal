// Telling a leaked child from a recycled process id (issue #24).
//
// Windows recycles pids. A recycled id answers process.kill(pid, 0) and appears in tasklist, so a
// liveness check alone reports a leaked child whenever the id has been reused -- measured: nine
// "survivors" out of 200 externally-killed children were all conhost.exe created AFTER the child
// they replaced. That made #24's rate and #16's zero-survivor threshold measure the pid space
// rather than this runtime.
//
// The test of identity is the process's creation time: a process created after we spawned the pid
// cannot be the process we spawned. This module is separate from the bench so it can be tested
// without a pty.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Slack for clock skew between this process and the OS creation timestamp. */
export const CREATED_AFTER_SLACK_MS = 5000;

/**
 * True when `identity` could be the process we spawned at `spawnedAt`.
 * Unreadable identity or unknown spawn time keeps the conservative answer: possibly leaked.
 */
export function identityIsOurs(identity, spawnedAt, slackMs = CREATED_AFTER_SLACK_MS) {
  if (!identity || !Number.isFinite(identity.createdMs) || spawnedAt === undefined) return true;
  return identity.createdMs <= spawnedAt + slackMs;
}

/** pid -> { name, createdMs } for these pids, in one batched call. Empty off Windows. */
export async function processIdentities(pids, { platform = process.platform } = {}) {
  const identities = new Map();
  if (platform !== 'win32' || !pids.length) return identities;
  const filter = pids.map(pid => `ProcessId=${pid}`).join(' or ');
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CreationDate.ToString('o'))" }`;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000 });
    for (const line of String(stdout).split('\n')) {
      const [pid, name, created] = line.trim().split('|');
      const createdMs = Date.parse(created);
      if (Number.isInteger(Number(pid)) && Number.isFinite(createdMs)) identities.set(Number(pid), { name, createdMs });
    }
  } catch {
    // Unreadable: the conservative answer is "still alive", never "gone".
  }
  return identities;
}
