// The remaining interaction behaviours #19 names: splits, pane focus, settings persistence and
// process exit. Each is driven the way a person would drive it — a keyboard shortcut, a click, a
// typed line — against the real bridge.
//
// Sessions are launched through onboarding rather than relying on the app's boot tab: that tab is a
// convenience with its own timing, and a test that depends on it measures the convenience.
import { test, expect } from '@playwright/test';
import { startApp } from './harness.mjs';

/** Opens the app and launches the default shell from the first-run screen. */
async function launch(page, app) {
  await page.goto(app.launchUrl);
  await page.getByRole('button', { name: 'Launch terminal' }).click();
  await expect(page.locator('.pane')).toHaveCount(1, { timeout: 30000 });
}

test('E2E-16 a shell that exits reports its exit code in the status bar', async ({ page }) => {
  // Real runtime: the point is a process that actually ends.
  const app = await startApp({ real: true });
  try {
    await launch(page, app);
    const pane = page.locator('.pane');
    await pane.click();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');

    // The chip is rendered from the observation, so this is the whole path: child exits, runtime
    // reports it, bridge forwards it, status bar shows it. Scoped to the status bar: several
    // elements carry role="status" and a strict locator would be ambiguous.
    const status = page.locator('footer.statusbar');
    await expect(status).toContainText(/exit \d+/, { timeout: 30000 });
  } finally {
    await app.stop();
  }
});
