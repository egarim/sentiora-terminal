// Terminal interaction tests against a REAL PTY (issue #19): src/server.js spawning actual shells,
// driven through the browser. The fake-runtime suite covers the UI's own behaviour; this one covers
// the path a keystroke takes when there is a real child process on the other end.
//
// Output is asserted through xterm's screen-reader tree, which the app now exposes as a setting
// rather than a test-only hook: xterm paints into a canvas, so the accessibility tree is the only
// honest way to read what a user would see, and it is a real feature for screen-reader users.
import { test, expect } from '@playwright/test';
import { startApp } from './harness.mjs';

const WITH_A11Y = { accessibility: { screenReaderMode: true } };

/** Launches the default shell from onboarding and waits for the pane. */
async function launchShell(page, app) {
  await page.goto(app.launchUrl);
  await page.getByRole('button', { name: 'Launch terminal' }).click();
  await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1);
  const panel = page.getByRole('tabpanel');
  await expect(panel).toBeVisible();
  return panel;
}

test('E2E-05 a real PTY session shows what the user types', async ({ page }) => {
  const app = await startApp({ real: true, settingsPatch: WITH_A11Y });
  try {
    const panel = await launchShell(page, app);

    // The pane must be focused for keystrokes to reach the child; clicking it is what a user does.
    await panel.click();
    await page.keyboard.type('echo SENTIORA_E2E_OK');
    await page.keyboard.press('Enter');

    // The marker only exists if the keystrokes reached the shell and its output came back.
    await expect(page.getByText('SENTIORA_E2E_OK').first()).toBeVisible({ timeout: 30000 });
  } finally {
    await app.stop();
  }
});

test('E2E-06 resizing the window changes the reported terminal geometry', async ({ page }) => {
  const app = await startApp({ real: true, settingsPatch: WITH_A11Y });
  try {
    const panel = await launchShell(page, app);
    const status = page.getByRole('status');
    // The status bar reports cols×rows, so the geometry is observable without reaching into xterm.
    const before = await status.locator('.chip', { hasText: /^\d+×\d+$/ }).first().textContent();
    expect(before).toMatch(/^\d+×\d+$/);

    await page.setViewportSize({ width: 1100, height: 900 });
    await panel.click();

    // A resize has to travel: fit addon -> bridge -> runtime -> the child's PTY size -> status bar.
    await expect.poll(async () => {
      const now = await status.locator('.chip', { hasText: /^\d+×\d+$/ }).first().textContent();
      return now;
    }, { timeout: 20000 }).not.toBe(before);
  } finally {
    await app.stop();
  }
});

test('E2E-07 a keyboard shortcut opens a second tab with its own session', async ({ page }) => {
  const app = await startApp({ real: true, settingsPatch: WITH_A11Y });
  try {
    await launchShell(page, app);
    const tabs = page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab');
    await expect(tabs).toHaveCount(1);

    await page.keyboard.press('Alt+T');
    await expect(tabs).toHaveCount(2);
    // The new tab is the selected one: opening a tab that does not take focus would be a defect.
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app.stop();
  }
});
