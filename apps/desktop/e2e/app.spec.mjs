// Interaction tests for the desktop UI (issue #19), driven by a real browser against the real
// loopback server. These are the assertions a structural test cannot make: that a person can open
// the app, be offered shells, launch one, and see it appear.
import { test, expect } from '@playwright/test';
import { startApp } from './harness.mjs';

test('E2E-01 an unlaunched page refuses to talk to the bridge', async ({ page }) => {
  const app = await startApp();
  try {
    // No fragment token: the app must not fall back to an unauthenticated call.
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: 'Sentiora Living Terminal' })).toBeVisible();
    await expect(page.getByText('This page was opened without a launch token')).toBeVisible();
    const bodies = [];
    page.on('request', request => { if (request.url().includes('/api/')) bodies.push(request.url()); });
    await page.waitForTimeout(250);
    expect(bodies, 'no API call may be attempted without a token').toEqual([]);
  } finally {
    await app.stop();
  }
});

test('E2E-02 a launch token opens the shell picker', async ({ page }) => {
  const app = await startApp();
  try {
    await page.goto(app.launchUrl);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Detected shells' })).toBeVisible();
    // At least one shell was detected on this machine, and it is selectable.
    const choices = dialog.locator('label.choice');
    await expect(choices.first()).toBeVisible();
    const launch = page.getByRole('button', { name: 'Launch terminal' });
    await expect(launch).toBeEnabled();
  } finally {
    await app.stop();
  }
});

test('E2E-03 launching from onboarding opens a tab and a status bar', async ({ page }) => {
  const app = await startApp();
  try {
    await page.goto(app.launchUrl);
    await page.getByRole('button', { name: 'Launch terminal' }).click();

    // The tab bar is the proof the session reached the bridge and came back as a tab.
    const tablist = page.getByRole('tablist', { name: 'Terminal tabs' });
    await expect(tablist).toBeVisible();
    const tab = tablist.getByRole('tab');
    await expect(tab).toHaveCount(1);
    await expect(tab).toHaveAttribute('aria-selected', 'true');

    // The status bar reports the session's state, which the fake runtime reaches deterministically.
    const status = page.getByRole('status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('operational');

    // The onboarding dialog must be gone: it is a first-run gate, not a permanent overlay.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await app.stop();
  }
});

test('E2E-04 a wrong token is refused rather than silently degrading', async ({ page }) => {
  const app = await startApp();
  try {
    await page.goto(`${app.url}/#token=not-the-token`);
    // The app surfaces the refusal; it must not fall through to a shell picker it cannot use.
    await expect(page.getByRole('heading', { name: 'Could not reach the bridge' })).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Detected shells' })).toHaveCount(0);
  } finally {
    await app.stop();
  }
});
