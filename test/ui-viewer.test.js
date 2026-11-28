// Structural tests for the session viewer component (issue #35).
//
// This is not an interaction test: it calls the component as a function and inspects the element
// tree it returns. What it can prove is what gets *rendered* for a given state — rows, order, depth,
// selection, the log, and the permanent gap marker — which is the half of the viewer that has
// logic in it. Clicking, focus and layout need a browser, which is #19.
//
// It runs in the desktop-ui job, where apps/desktop's dependencies (React) are installed; the root
// test job does not install them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTree } from '../apps/desktop/ui/components/SessionTree.ts';
import { appendMailbox, buildSessionTree, flattenSessionTree } from '../apps/desktop/ui/lib/tree.ts';

/** Depth-first collection of elements carrying a given data-testid. */
function findAll(node, testId, found = []) {
  if (node === null || typeof node !== 'object') return found;
  const props = node.props ?? {};
  if (props['data-testid'] === testId) found.push(node);
  const children = Array.isArray(props.children) ? props.children.flat(Infinity) : [props.children];
  for (const child of children) findAll(child, testId, found);
  return found;
}

const textOf = element => (Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children);

const sessions = [
  { sessionId: 'root', parent: null, state: 'operational', label: 'zsh · home' },
  { sessionId: 'child', parent: 'root', state: 'exited', label: 'npm test' },
  { sessionId: 'grandchild', parent: 'child', state: 'operational' },
  { sessionId: 'second-root', parent: null, state: 'operational', label: 'pwsh' },
];

test('VIEW-01 every session renders, in tree order, with its depth', () => {
  const tree = SessionTree({ sessions });
  const rows = findAll(tree, 'session-row');

  assert.deepEqual(rows.map(row => row.props['data-session-id']), ['root', 'child', 'grandchild', 'second-root']);
  assert.deepEqual(rows.map(row => row.props['data-depth']), ['0', '1', '2', '0']);
  assert.deepEqual(rows.map(row => row.props['data-state']), ['operational', 'exited', 'operational', 'operational']);
  assert.ok(findAll(tree, 'session-tree').length === 1, 'exactly one tree container');
});

test('VIEW-02 the label falls back to the session id when the bridge has none', () => {
  const tree = SessionTree({ sessions });
  const labels = findAll(findAll(tree, 'session-row')[2], 'session-label');
  assert.equal(textOf(labels[0]), 'grandchild', 'a session without a label shows its id');
});

test('VIEW-03 the selected session is announced, not only coloured', () => {
  const tree = SessionTree({ sessions, selectedId: 'child' });
  const rows = findAll(tree, 'session-row');
  const current = rows.filter(row => row.props['aria-current'] === 'true');
  assert.equal(current.length, 1);
  assert.equal(current[0].props['data-session-id'], 'child');
});

test('VIEW-04 the log renders in sequence order and keeps the gap visible', () => {
  let log = appendMailbox({ messages: [], dropped: 5 });
  log = appendMailbox({ messages: [{ sequence: 2, payload: { text: 'second' } }, { sequence: 1, payload: 'first' }] }, log);

  const tree = SessionTree({ sessions, selectedId: 'child', log });
  const messages = findAll(tree, 'log-message');
  assert.deepEqual(messages.map(message => message.props['data-sequence']), ['1', '2']);
  assert.equal(textOf(messages[0]), 'first', 'a string payload renders as text');
  assert.equal(textOf(messages[1]), '{"text":"second"}', 'a structured payload renders as JSON');

  const gap = findAll(tree, 'log-gap');
  assert.equal(gap.length, 1, 'a drop is permanent information and must not vanish');
  assert.equal(gap[0].props['data-dropped'], '5');
});

test('VIEW-05 an orphaned session is shown and called out', () => {
  const tree = SessionTree({ sessions: [{ sessionId: 'stray', parent: 'gone' }] });
  assert.equal(findAll(tree, 'session-row').length, 1, 'the session is not hidden');
  const callout = findAll(tree, 'tree-orphans');
  assert.equal(callout.length, 1);
  assert.equal(callout[0].props['data-count'], '1');
});

test('VIEW-06 nothing rendered carries a capability or an owner token', () => {
  let log = appendMailbox({ messages: [{ sequence: 1, payload: 'hello' }] });
  const tree = SessionTree({ sessions, selectedId: 'child', log });
  const rendered = JSON.stringify(tree, (key, value) => (key === 'onClick' ? undefined : value));
  assert.doesNotMatch(rendered, /"owner"|"capability"|"mailbox"|"childMailbox"/);
});

test('VIEW-07 the component renders the same thing twice for the same state', () => {
  // A pure component: rendering must not depend on hidden state, or the tree would drift from the
  // model between paints. Compared structurally, with React's element identity ignored.
  const once = JSON.stringify(SessionTree({ sessions, selectedId: 'root' }), (k, v) => (k === '_owner' || k === 'onClick' ? undefined : v));
  const twice = JSON.stringify(SessionTree({ sessions, selectedId: 'root' }), (k, v) => (k === '_owner' || k === 'onClick' ? undefined : v));
  assert.equal(once, twice);
});

test('VIEW-08 the models the component depends on are the ones under test', () => {
  // Guards against the component quietly re-implementing tree building: the rows it renders must
  // equal what flattenSessionTree produces for the same input.
  const rows = findAll(SessionTree({ sessions }), 'session-row').map(row => row.props['data-session-id']);
  const expected = flattenSessionTree(buildSessionTree(sessions)).map(({ entry }) => entry.sessionId);
  assert.deepEqual(rows, expected);
});
