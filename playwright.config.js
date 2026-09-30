// Browser tests: `npm run test:e2e` (or `npm test` for everything).
// Each run starts the app on TEST_PORT with a fresh seeded database in a temp
// folder; nothing touches db/ or sends real email.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineConfig } = require('@playwright/test');

const port = process.env.TEST_PORT || '3199';
// Worker processes re-read this file; reuse the folder the main process made.
if (!process.env.VA_TEST_DIR) {
  process.env.VA_TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'volunteer-e2e-'));
}

module.exports = defineConfig({
  testDir: './test/e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['list']],
  outputDir: 'test-results',
  globalTeardown: './test/e2e/support/teardown.js',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node test/e2e/support/server.js',
    url: `http://127.0.0.1:${port}/events`,
    env: { VA_TEST_DIR: process.env.VA_TEST_DIR, TEST_PORT: port },
    reuseExistingServer: false,
    timeout: 30000,
    stdout: 'ignore',
    stderr: 'pipe'
  }
});
