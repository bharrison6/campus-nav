// E2E against the BUILT static site served at a sub-path, the way GitHub Pages serves it:
// the web server builds build/e2e-site (scripts/build/build-site.mjs, no Maps key, analytics off) and serves it
// at http://localhost:<port>/campus-nav/ with dev/serve.mjs --dist. Nothing answers outside /campus-nav/, so a
// root-relative URL in the app fails visibly.
//   npm run test:e2e        (PW_CHANNEL=chrome to use the installed Chrome instead of a downloaded browser)
// The root playwright.config.ts stays the live smoke config (APP_URL).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.MSCN_E2E_PORT || 8788);
const BASE_PATH = '/campus-nav/';
const SITE_DIR = 'build/e2e-site';
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
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node dev/serve.mjs --dist ${SITE_DIR} --base ${BASE_PATH} --port ${PORT} --build --quiet`,
    cwd: '../..',
    url: `http://localhost:${PORT}${BASE_PATH}`,
    // The suite's facts assume a key-free build; never let a developer's MAPS_API_KEY into it.
    // MSYS_NO_PATHCONV keeps Git Bash from rewriting --base /campus-nav/ into a Windows path.
    env: { MAPS_API_KEY: '', MSYS_NO_PATHCONV: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel, colorScheme: 'light' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel, colorScheme: 'dark' } },
  ],
});
