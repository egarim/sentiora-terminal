// Exercises node-pty's bundled-DLL ConPTY path (useConptyDll:true) and reports
// whether the host event loop drains afterwards.
//
// This runs as a separate process on purpose. The DLL path never disposes its
// conout worker, so a live worker keeps the event loop alive indefinitely;
// running it inside the test runner would hang the whole suite. The probe
// therefore reports what it observed and exits explicitly.
//
// Usage: node test/fixtures/conpty-dll-probe.mjs [os|dll]
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import { Session } from '../../src/session.js';

const provider = process.argv[2] ?? 'dll';
const useConptyDll = provider === 'dll';
const t0 = Date.now();
const say = (event, data) => console.log(`PROBE ${event} ${JSON.stringify(data)}`);

function portCount() {
  let n = 0;
  for (const h of process._getActiveHandles()) if (h.constructor?.name === 'MessagePort') n += 1;
  return n;
}

try {
  const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 500, allowProposedApi: true });
  const child = pty.spawn(process.execPath, ['-e', 'process.stdout.write("DLL-PROBE-READY");if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.resume();process.stdin.once("data",d=>{process.stdout.write("DLL-PROBE-ECHO:"+d.toString());setTimeout(()=>process.exit(0),150);});'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConptyDll,
  });
  const session = new Session(child, terminal);
  say('spawned', { provider, useConptyDll, pid: session.pid, arch: process.arch });

  let ready = null;
  const deadline = Date.now() + 20000;
  for (;;) {
    const snap = await session.observe();
    if (snap.screen.includes('DLL-PROBE-READY')) { ready = snap; break; }
    if (Date.now() > deadline) break;
    await session.wait(snap.revision, 100);
  }
  say('ready', { ok: ready !== null, state: ready?.state, pid: ready?.pid ?? null, ms: Date.now() - t0 });
  if (!ready) throw new Error('child never produced output through the pseudoconsole');

  const typed = await session.input({ owner: session.owner, revision: ready.revision, text: 'x' });
  let echoed = false;
  const echoDeadline = Date.now() + 15000;
  for (;;) {
    const snap = await session.observe();
    if (snap.screen.includes('DLL-PROBE-ECHO:x')) { echoed = true; break; }
    if (Date.now() > echoDeadline) break;
    await session.wait(snap.revision, 100);
  }
  say('roundTrip', { echoed, revision: typed.revision });

  await session.close();
  say('closed', { state: (await session.observe()).state, messagePorts: portCount() });
} catch (error) {
  say('error', { message: error.message });
  process.exit(1);
}

// If the loop drains on its own the process exits here. If a worker survives,
// the unref'd watchdog fires and reports that explicitly.
process.on('exit', code => say('exit', { code, ms: Date.now() - t0 }));
setTimeout(() => {
  say('didNotDrain', { messagePorts: portCount(), ms: Date.now() - t0 });
  process.exit(98);
}, 12000).unref();
