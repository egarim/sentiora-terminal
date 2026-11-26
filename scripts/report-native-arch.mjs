// Reports the true architecture of every native binary node-pty will load, so a
// CI job can never silently claim ARM64 support while running an x64 image under
// emulation. Reads the container header directly: PE COFF Machine on Windows,
// Mach-O cputype on macOS, ELF e_machine on Linux.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const PE_MACHINE = { 0x014c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x01c0: 'arm', 0x01c4: 'arm-thumb2' };
const MACHO_CPUTYPE = { 0x01000007: 'x64', 0x0100000c: 'arm64', 0x07: 'x86', 0x0c: 'arm' };
const ELF_MACHINE = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'x86', 0x28: 'arm' };

function archOf(file) {
  const buf = readFileSync(file);
  if (buf.length < 64) return 'too-small';

  const mz = buf.readUInt16LE(0);
  if (mz === 0x5a4d) {
    const pe = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(pe) !== 0x00004550) return 'bad-pe-signature';
    const machine = buf.readUInt16LE(pe + 4);
    return PE_MACHINE[machine] ?? `pe-unknown-0x${machine.toString(16)}`;
  }

  const magic = buf.readUInt32BE(0);
  if (magic === 0xfeedfacf || magic === 0xcffaedfe) {
    return MACHO_CPUTYPE[buf.readUInt32LE(4)] ?? `macho-unknown-0x${buf.readUInt32LE(4).toString(16)}`;
  }
  if (magic === 0xcafebabe || magic === 0xbebafeca) return 'macho-fat';

  if (buf.readUInt32BE(0) === 0x7f454c46) {
    // e_machine is at offset 18 in both ELF32 and ELF64, so EI_CLASS does not
    // change where to read.
    const machine = buf.readUInt16LE(18);
    return ELF_MACHINE[machine] ?? `elf-unknown-0x${machine.toString(16)}`;
  }

  return 'not-a-native-image';
}

const require = createRequire(import.meta.url);
let pkg;
try {
  pkg = require('node-pty/package.json');
} catch (error) {
  // Not a pass. node-pty is a hard dependency, so if it cannot be resolved then
  // either the install failed or the layout changed, and in both cases the
  // architecture of the binary that will actually be loaded is unknown.
  console.error(`node-pty could not be resolved, so no native architecture was verified: ${error.code ?? error.message}`);
  process.exit(1);
}

// node-pty's main is ./lib/index.js, so resolving the entry point lands in lib/;
// walk up to the directory that actually holds prebuilds/ or build/.
function findPackageRoot() {
  let dir = dirname(require.resolve('node-pty'));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, 'prebuilds')) || existsSync(join(dir, 'build'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(require.resolve('node-pty'));
}
const root = findPackageRoot();

console.log(`runtime: node ${process.version} arch=${process.arch} platform=${process.platform} abi=${process.versions.modules}`);
console.log(`node-pty: ${pkg.version}`);

const roots = [join(root, 'build', 'Release'), join(root, 'prebuilds', `${process.platform}-${process.arch}`)];
let found = 0;
const mismatches = [];

for (const dir of roots) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!/\.(node|dll|exe|so|dylib)$/.test(name) && name !== 'spawn-helper') continue;
    const file = join(entry.parentPath ?? entry.path ?? dir, name);
    let detected;
    try {
      detected = archOf(file);
    } catch (error) {
      detected = `unreadable (${error.code ?? error.message})`;
    }
    found += 1;
    console.log(`  ${file.slice(root.length + 1)}: ${detected}`);
    // x64 images inside an arm64 runtime would mean emulation; flag them.
    if (process.arch === 'arm64' && detected === 'x64') mismatches.push(file);
    if (process.arch === 'x64' && detected === 'arm64') mismatches.push(file);
  }
}

if (found === 0) {
  // Printing "OK" here would be a false green: a job where node-pty produced no
  // native binary at all would still report a successful architecture check, which
  // is precisely the failure this script exists to prevent. Nothing inspected means
  // nothing verified, so the check fails instead of passing vacuously.
  console.log('  no native binaries found in build/Release or prebuilds/');
  console.error('ARCH CHECK INCONCLUSIVE: no native binary was inspected, so no architecture was verified');
  process.exit(1);
}
if (mismatches.length) {
  console.log(`ARCH MISMATCH vs runtime ${process.arch}: ${mismatches.length} file(s)`);
  process.exit(1);
}
console.log(`native architecture check: OK (${found} binaries, all consistent with ${process.arch})`);
