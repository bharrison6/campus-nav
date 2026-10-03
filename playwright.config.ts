// Live smoke test against a deployed web app (tests/smoke.spec.ts). It needs the deployment's /exec URL:
//   APP_URL=https://script.google.com/macros/s/<deployment id>/exec npm run test:smoke
// (PowerShell: $env:APP_URL = '<url>'; npm run test:smoke). Add PW_CHANNEL=chrome when Playwright's bundled
// browser is not installed. The local suite is tests/e2e/playwright.config.ts (npm run test:e2e).
import { defineConfig, devices } from '@playwright/test';

const appUrl = process.env.APP_URL;
if (!appUrl) {
  throw new Error('APP_URL is not set. The live smoke test needs the deployed /exec URL (see scripts/apps-script/DEPLOYMENT.md).');
}
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './tests',
  testMatch: 'smoke.spec.ts',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results/smoke',
  use: {
    baseURL: appUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel } },
  ],
});
