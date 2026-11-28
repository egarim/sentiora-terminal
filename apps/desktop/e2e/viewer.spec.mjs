// The viewer (#35) in a browser: the session tree with real parent links, and the selected
// session's message log updating from the bridge.
//
// Sessions are created through the bridge directly rather than through the UI: what is under test is
// the tree's rendering of parent links and its log, not session creation (E2E-03 covers that).
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// The interactive fixture, so a real PTY session exists that does not exit on its own.
const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/interactive.mjs', import.meta.url));
import { startApp } from './harness.mjs';

const ONBOARDED = { onboarding: { completed: true } };

test('E2E-08 the viewer renders the session tree and the selected session log', async ({ page }) => {
  const app = await startApp({ settingsPatch: ONBOARDED });
  try {
    const parent = await app.backend.bridge.create({ command: 'fake', cols: 60, rows: 16 });
    const child = await app.backend.bridge.create({ command: 'fake', cols: 60, rows: 16, parentSessionId: parent.sessionId });

    await page.goto(app.launchUrl);

    const tree = page.getByTestId('session-tree');
    await expect(tree).toBeVisible();

    const rows = page.getByTestId('session-row');
    await expect(rows).toHaveCount(2, { timeout: 20000 });

    // The tree is the point: the child is drawn under its parent, at depth 1, from the parent link
    // the bridge reports -- not from anything the UI inferred.
    await expect(rows.nth(0)).toHaveAttribute('data-session-id', parent.sessionId);
    await expect(rows.nth(0)).toHaveAttribute('data-depth', '0');
    await expect(rows.nth(1)).toHaveAttribute('data-session-id', child.sessionId);
    await expect(rows.nth(1)).toHaveAttribute('data-depth', '1');

    // Selecting the child both marks it and switches the log to that session.
    await rows.nth(1).click();
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'true');

    const posted = await page.request.post(`${app.url}/api/sessions/${child.sessionId}/messages`, {
      headers: { authorization: `Bearer ${app.token}` },
      data: { payload: { text: 'hello from the agent' } },
    });
    expect(posted.ok()).toBe(true);

    // The log is polled, so this is the whole path: bridge mailbox -> HTTP -> hook -> SessionTree.
    const messages = page.getByTestId('log-message');
    await expect(messages).toHaveCount(1, { timeout: 20000 });
    await expect(messages.first()).toContainText('hello from the agent');
    await expect(messages.first()).toHaveAttribute('data-sequence', '1');
  } finally {
    await app.stop();
  }
});

test('E2E-09 the viewer draws a child under a parent that is still open', async ({ page }) => {
  // Regression guard for the tree's ordering: flattening must put a parent before its children even
  // when the list order is reversed, which is what `flattenSessionTree` promises (TREE-03).
  const app = await startApp({ settingsPatch: ONBOARDED });
  try {
    const parent = await app.backend.bridge.create({ command: 'fake', cols: 60, rows: 16 });
    const first = await app.backend.bridge.create({ command: 'fake', cols: 60, rows: 16, parentSessionId: parent.sessionId });
    const second = await app.backend.bridge.create({ command: 'fake', cols: 60, rows: 16, parentSessionId: parent.sessionId });

    await page.goto(app.launchUrl);
    const rows = page.getByTestId('session-row');
    await expect(rows).toHaveCount(3, { timeout: 20000 });

    const ids = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-id')));
    expect(ids[0]).toBe(parent.sessionId);
    expect(new Set(ids.slice(1))).toEqual(new Set([first.sessionId, second.sessionId]));
    const depths = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-depth')));
    expect(depths).toEqual(['0', '1', '1']);
  } finally {
    await app.stop();
  }
});

test('E2E-10 the viewer shows both directions of an exchange, and refuses a stranger', async ({ page }) => {
  // Real runtime: sender attribution exists only where the runtime checks the edge capability
  // (PE-15). The fake models neither senders nor edge capabilities, so it cannot prove this.
  const app = await startApp({ real: true, settingsPatch: ONBOARDED });
  const post = (to, payload, from) => page.request.post(`${app.url}/api/sessions/${to}/messages`, {
    headers: { authorization: `Bearer ${app.token}` },
    data: { payload, ...(from ? { from } : {}) },
  });
  try {
    const parent = await app.backend.bridge.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
    const child = await app.backend.bridge.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16, parentSessionId: parent.sessionId });

    await page.goto(app.launchUrl);
    await expect(page.getByTestId('session-row')).toHaveCount(2, { timeout: 20000 });

    // The parent selects itself by default, so this is the view a human sees next.
    const down = await post(child.sessionId, { text: 'do the task' }, parent.sessionId);
    expect(down.ok()).toBe(true);
    const up = await post(parent.sessionId, { text: 'done' }, child.sessionId);
    expect(up.ok()).toBe(true);

    // Received: the child answered the parent, and the viewer says who sent it.
    const received = page.getByTestId('log-message');
    await expect(received).toHaveCount(1, { timeout: 20000 });
    await expect(received.first()).toHaveAttribute('data-from', child.sessionId);
    await expect(received.first()).toContainText('done');

    // Sent: the task the parent wrote, gathered from the child's inbox because that is where it lives.
    const sent = page.getByTestId('sent-message');
    await expect(sent).toHaveCount(1, { timeout: 20000 });
    await expect(sent.first()).toContainText('do the task');

    // A session with no edge to the child cannot address it, and nothing is delivered.
    const stranger = await app.backend.bridge.create({ command: process.execPath, args: [FIXTURE], cols: 60, rows: 16 });
    const refused = await post(child.sessionId, { text: 'sibling' }, stranger.sessionId);
    expect(refused.ok()).toBe(false);
    expect(refused.status()).toBeGreaterThanOrEqual(400);
  } finally {
    await app.stop();
  }
});
