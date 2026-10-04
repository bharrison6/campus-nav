// Live smoke test against the DEPLOYED static site (tests/smoke/live-site.smoke.ts): it loads, fetches the campus
// data, and draws a floor plan. Run after a deploy:
//   npm run test:smoke                                   (the site address from build.config.json)
//   APP_URL=https://<other address>/ npm run test:smoke  (any deployment, e.g. a custom domain or a local preview)
// (PowerShell: $env:APP_URL = '<url>'.) Add PW_CHANNEL=chrome to use the installed Chrome instead of a downloaded
// browser. The local suite against a fresh build is tests/e2e (npm run test:e2e).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** The published address: build.config.json domain (served at its root) when set, else siteUrl. */
function configuredSiteUrl(): string {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'build.config.json'), 'utf8'));
  const url = cfg.domain ? `https://${cfg.domain}/` : String(cfg.siteUrl || '');
  if (!url) throw new Error('set APP_URL, or siteUrl in build.config.json');
  return url;
}

const raw = process.env.APP_URL || configuredSiteUrl();
const appUrl = raw.endsWith('/') ? raw : raw + '/';
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: '*.smoke.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/smoke',
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
