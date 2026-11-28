import { defineConfig } from '@playwright/test';

// Interaction tests for the built UI (issue #19). They run against the real IPC server and a fake
// runtime; the build must exist first, which is why test:e2e builds before running.
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  // Each test binds its own loopback port and its own runtime process. Running them in parallel
  // would work, but a failure is easier to read when the log is one test at a time.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    // Retained only on failure: a passing run should not leave hundreds of megabytes of traces.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
