// The viewer's models (issue #35), tested without a browser. The UI components are thin; the shape
// logic lives in tree.ts and is checked here, so the part that can be wrong in a way tests catch is
// covered while the UI test tooling decision is still open.
//
// Node strips TypeScript types natively from v24; older versions need a flag, so the import is
// dynamic and the tests skip visibly there rather than the whole file failing to load.
import test from 'node:test';
import assert from 'node:assert/strict';

const supportsTypeStripping = Boolean(process.features?.typescript);
const opts = {
  skip: supportsTypeStripping ? false : `node ${process.versions.node} has no type stripping (test:desktop passes --experimental-strip-types)`,
  timeout: 60000,
};

const models = () => import('../apps/desktop/ui/lib/tree.ts');

test('TREE-01 roots and children come from the parent links the runtime reports', opts, async () => {
  const { buildSessionTree } = await models();
  const tree = buildSessionTree([
    { sessionId: 'parent', parent: null },
    { sessionId: 'child-a', parent: 'parent' },
    { sessionId: 'child-b', parent: 'parent' },
    { sessionId: 'other-root', parent: null },
  ]);

  assert.deepEqual(tree.roots.map(entry => entry.sessionId), ['parent', 'other-root']);
  assert.deepEqual((tree.children.get('parent') ?? []).map(entry => entry.sessionId), ['child-a', 'child-b']);
  assert.equal(tree.children.get('child-a'), undefined, 'a leaf has no children entry');
  assert.deepEqual(tree.orphans, []);
});

test('TREE-02 a child whose parent is missing is shown as a root and reported', opts, async () => {
  const { buildSessionTree } = await models();
  // The runtime clears the link when an edge dies, so this cannot happen by design — which is
  // exactly why it must be handled: a viewer that silently dropped the session would hide a bug.
  const tree = buildSessionTree([{ sessionId: 'stray', parent: 'gone' }]);
  assert.deepEqual(tree.roots.map(entry => entry.sessionId), ['stray']);
  assert.deepEqual(tree.orphans.map(entry => entry.sessionId), ['stray']);
});

test('TREE-03 flattening is depth-first, parents before children, root depth zero', opts, async () => {
  const { buildSessionTree, flattenSessionTree } = await models();
  const tree = buildSessionTree([
    { sessionId: 'a', parent: null },
    { sessionId: 'a-1', parent: 'a' },
    { sessionId: 'a-1-x', parent: 'a-1' },
    { sessionId: 'b', parent: null },
  ]);

  assert.deepEqual(
    flattenSessionTree(tree).map(({ entry, depth }) => `${entry.sessionId}@${depth}`),
    ['a@0', 'a-1@1', 'a-1-x@2', 'b@0'],
  );
});

test('TREE-04 the mailbox log deduplicates overlapping polls and stays ordered', opts, async () => {
  const { appendMailbox, emptyMailboxLog } = await models();
  let log = emptyMailboxLog();
  log = appendMailbox({ messages: [{ sequence: 2, payload: 'two' }, { sequence: 1, payload: 'one' }], nextSequence: 2 }, log);
  assert.deepEqual(log.messages.map(message => message.payload), ['one', 'two'], 'ordered by sequence');
  assert.equal(log.nextSequence, 2);

  // A poll that overlaps the last cursor must not duplicate: sequence is the identity.
  log = appendMailbox({ messages: [{ sequence: 2, payload: 'two' }, { sequence: 3, payload: 'three' }], nextSequence: 3 }, log);
  assert.deepEqual(log.messages.map(message => message.sequence), [1, 2, 3]);
});

test('TREE-05 a drop stays reported after the frame that reported it is gone', opts, async () => {
  const { appendMailbox, emptyMailboxLog } = await models();
  let log = emptyMailboxLog();
  log = appendMailbox({ messages: [], nextSequence: 0, dropped: 14 }, log);
  log = appendMailbox({ messages: [{ sequence: 15, payload: 'after the gap' }], nextSequence: 15, dropped: 14 }, log);
  assert.equal(log.dropped, 14, 'the gap survives later frames');
  assert.equal(log.messages[0].sequence, 15);
});

test('TREE-06 malformed frames cannot corrupt the log', opts, async () => {
  const { appendMailbox, emptyMailboxLog } = await models();
  const log = appendMailbox({
    messages: [{ sequence: 0, payload: 'zero' }, { sequence: Number.NaN, payload: 'nan' }],
    nextSequence: 4,
  }, emptyMailboxLog());
  assert.deepEqual(log.messages, [], 'a non-positive or non-finite sequence is not a message');
  assert.equal(log.nextSequence, 4, 'the cursor still advances so a watcher cannot spin');
});
