// E2E against the BUILT static site served at a sub-path, the way GitHub Pages serves it:
// the web server builds build/e2e-site (scripts/build/build-site.mjs, analytics off, the real committed campus map in
// data/campus-map and data/georef) and serves it at http://localhost:<port>/campus-nav/ with dev/serve.mjs --dist.
// Nothing answers outside /campus-nav/, so a root-relative URL in the app fails visibly.
//   npm run test:e2e        (PW_CHANNEL=chrome to use the installed Chrome instead of a downloaded browser)
// The live smoke test against the deployed site is tests/smoke (npm run test:smoke).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.MSCN_E2E_PORT || 8788);
const BASE_PATH = '/campus-nav/';
const SITE_DIR = 'build/e2e-site';
// Use an installed browser when Playwright's bundled build is missing: PW_CHANNEL=chrome | msedge.
const channel = process.env.PW_CHANNEL || undefined;
// The campus map is WebGL 2 (MapLibre); headless Chrome gets it from SwiftShader.
const launchOptions = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  timeout: 45_000, // the WebGL map renders in software (SwiftShader); a full parallel run is slow
  expect: { timeout: 7_000 },
  fullyParallel: true,
  // Each worker renders WebGL in software; more than a few at once starve each other (timeouts, not failures).
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: '../../test-results/e2e',
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // page.route cannot see requests a service worker answers; the offline test turns workers on for itself.
    serviceWorkers: 'block',
  },
  webServer: {
    command: `node dev/serve.mjs --dist ${SITE_DIR} --base ${BASE_PATH} --port ${PORT} --build --quiet`,
    cwd: '../..',
    url: `http://localhost:${PORT}${BASE_PATH}`,
    // MSYS_NO_PATHCONV keeps Git Bash from rewriting --base /campus-nav/ into a Windows path.
    env: { MSYS_NO_PATHCONV: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel, colorScheme: 'light', launchOptions } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel, colorScheme: 'dark', launchOptions } },
  ],
});
