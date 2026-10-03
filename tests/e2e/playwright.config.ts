// E2E against the local harness (dev/serve.mjs + mocked google.script.run).
//   npx playwright test -c tests/e2e/playwright.config.ts   (PW_CHANNEL=chrome to use installed Chrome)
// The root playwright.config.ts stays the live smoke config (APP_URL).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.MSCN_E2E_PORT || 8788);
// Use an installed browser when Playwright's bundled build is missing: PW_CHANNEL=chrome | msedge.
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: '../../test-results/e2e',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node dev/serve.mjs --port ${PORT}`,
    cwd: '../..',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel, colorScheme: 'light' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel, colorScheme: 'dark' } },
  ],
});
