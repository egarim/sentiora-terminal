// node-pty 1.1.0 publishes its prebuilt binaries with mode 644, including
// prebuilds/darwin-*/spawn-helper. macOS is the only platform that executes
// that helper -- src/unix/pty.cc posix_spawnp()s it inside `#if defined(__APPLE__)`
// -- so without the executable bit every pty spawn on macOS fails with
// "posix_spawnp failed." Linux uses forkpty and Windows uses ConPTY, which is
// why only the macOS CI job was red.
//
// Nothing in node-pty restores the bit: post-install.js merely lists
// spawn-helper among the files to preserve while cleaning build/Release. This
// script is the workaround, and a no-op when node-pty is absent or unpacked.
import { chmod, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// Walk up from the resolved entry point to the directory holding prebuilds, so
// this keeps working if node-pty rearranges its lib/ layout.
async function findPackageRoot() {
  let dir = dirname(createRequire(import.meta.url).resolve('node-pty'));
  for (let depth = 0; depth < 5; depth += 1) {
    if (await isDirectory(join(dir, 'prebuilds'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let root = null;
try {
  root = await findPackageRoot();
} catch {
  root = null;
}
if (!root) process.exit(0);

let platforms = [];
try {
  platforms = await readdir(join(root, 'prebuilds'));
} catch {
  process.exit(0);
}

let fixed = 0;
for (const platform of platforms) {
  const helper = join(root, 'prebuilds', platform, 'spawn-helper');
  try {
    await chmod(helper, 0o755);
  } catch {
    continue; // no helper for this platform, e.g. win32
  }
  fixed += 1;
  console.log(`sentiora: chmod 755 ${helper}`);
}

if (fixed === 0) console.log('sentiora: no node-pty spawn-helper prebuilds found, nothing to do');
