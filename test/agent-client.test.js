// End-to-end test for packages/agent-client against the real runtime and a real PTY.
//
// These are the agent-facing invariants: a command's output can be read as bytes, a
// stale revision is handled by the client rather than the caller, and a child exit is
// observable without polling terminal.observe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AgentClient } from '../packages/agent-client/index.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/interactive.mjs', import.meta.url));
const opts = { timeout: 60000 };

async function until(client, session, predicate, { timeoutMs = 20000, startCursor = null } = {}) {
  let cursor = startCursor;
  let text = '';
  const deadline = Date.now() + timeoutMs;
  let frame = null;
  while (Date.now() < deadline) {
    frame = await client.read(session, { afterSequence: cursor ?? 0, timeoutMs: 500 });
    cursor = frame.nextSequence;
    text += frame.text;
    if (predicate(text, frame)) return { text, frame, cursor };
  }
  throw new Error(`condition not met within ${timeoutMs}ms; last text:\n${text}`);
}

test('AGENT-01 a command runs and its output is read as bytes', opts, async t => {
  const client = await AgentClient.connect();
  t.after(async () => { await client.dispose(); });

  const session = await client.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
  assert.ok(Number.isInteger(session.pid) && session.pid > 0, 'create must report the child pid');

  // The first read is an attach: a snapshot, not bytes. An agent has to know that, so
  // the client reports it explicitly instead of pretending the screen was output.
  const attach = await client.read(session, { timeoutMs: 200 });
  assert.equal(attach.resync, true);

  // A freshly spawned shell needs a moment to print its banner; waitForText handles
  // the attach-then-bytes transition, so the caller does not have to.
  await client.waitForText(session, 'FIXTURE READY', { afterSequence: attach.nextSequence });

  // sendLine observes the revision internally; the caller never sees one.
  await client.sendLine(session, 'echo hello');
  const { text } = await client.waitForText(session, 'ECHO:hello', { afterSequence: attach.nextSequence });
  assert.match(text, /ECHO:hello/);

  assert.equal(await client.close(session), true);
  const remaining = await client.list();
  assert.equal(remaining.length, 0, 'a closed session must leave the registry');
});

test('AGENT-02 a failed shell is an error, not a session with no child', opts, async t => {
  const client = await AgentClient.connect();
  t.after(async () => { await client.dispose(); });

  await assert.rejects(
    () => client.create({ command: process.execPath, args: [FIXTURE], cwd: 'Z:/definitely/not/here' }),
    (error) => {
      assert.match(error.message, /Invalid cwd|Session failed to start|Cannot create process|Session observation timed out/);
      return true;
    },
  );
  assert.equal((await client.list()).length, 0, 'a failed create must not register a session');
});

test('AGENT-03 a child exit is visible through the stream', opts, async t => {
  const client = await AgentClient.connect();
  t.after(async () => { await client.dispose(); });

  const session = await client.create({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(7), 150)'],
    cols: 40, rows: 12,
  });
  const { frame } = await until(client, session, (_text, f) => f.exit !== null, { timeoutMs: 20000 });
  const code = frame.exit?.exitCode ?? frame.exit;
  assert.equal(code, 7, `expected exit code 7, got ${JSON.stringify(frame.exit)}`);
});

test('AGENT-04 the mailbox capability carries messages and not input rights', opts, async t => {
  const client = await AgentClient.connect();
  t.after(async () => { await client.dispose(); });

  const session = await client.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
  assert.equal(typeof session.mailbox, 'string', 'create must return a mailbox capability');
  assert.notEqual(session.mailbox, session.owner, 'the mailbox capability must not be the owner token');
  // The owner token must still not be enumerable, now that the handle carries a second capability.
  assert.ok(!JSON.stringify(session).includes(session.owner), 'the owner token must not be enumerable');

  const first = await session.post({ kind: 'task', text: 'run it' });
  const second = await session.post({ kind: 'task', text: 'and again' });
  assert.deepEqual([first.sequence, second.sequence], [1, 2]);

  const drained = await session.readMailbox({ afterSequence: 0 });
  assert.deepEqual(drained.messages.map(message => message.payload.text), ['run it', 'and again']);
  assert.equal(drained.nextSequence, 2);

  // The cursor means what it says: nothing new after the last sequence.
  const after = await session.readMailbox({ afterSequence: 2, timeoutMs: 200 });
  assert.deepEqual(after.messages, []);

  assert.equal(await client.close(session), true);
});

test('AGENT-05 a parented create hands the child an edge capability', opts, async t => {
  const client = await AgentClient.connect();
  t.after(async () => { await client.dispose(); });

  const parent = await client.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
  const child = await client.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16, parent: parent.sessionId });
  assert.equal(typeof child.childMailbox, 'string', 'a parented create must return the edge capability');

  // The parent posts through the client; the same capability is what the child reads in its env.
  await client.post(child, { kind: 'task', text: 'from the parent' });
  const drained = await client.mailbox(child, { afterSequence: 0 });
  assert.deepEqual(drained.messages.map(message => message.payload.text), ['from the parent']);

  await client.close(child);
  await client.close(parent);
});

test('AGENT-06 handover moves input rights to a new handle', opts, async t => {
  const client = await AgentClient.connect();
  t.after(async () => { await client.dispose(); });

  const session = await client.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
  const handed = await client.handover(session);

  assert.equal(handed.sessionId, session.sessionId, 'the handover must be the same session');
  assert.notEqual(handed.owner, session.owner, 'the handover must issue a new owner token');
  assert.equal(handed.mailbox, session.mailbox, 'the mailbox capability is not part of the input handover');

  // The old token is dead: closing with it is refused, so the two handles are not equivalent.
  await assert.rejects(client.close(session), /Ownership required/);

  // The new handle is the live one, and it can still be typed into and closed.
  await client.sendLine(handed, 'echo HANDOVER-CLIENT-OK');
  const { text } = await client.waitForText(handed, 'ECHO:HANDOVER-CLIENT-OK', { afterSequence: 0 });
  assert.match(text, /ECHO:HANDOVER-CLIENT-OK/);
  assert.equal(await client.close(handed), true);
});
