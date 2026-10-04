// Browser test of the local admin's v5 editors (tests/admin/admin-editors.admin.ts): the Map Editor (reclass a path,
// draw a path) and Doors & Halls (a refused save, a door set to emergency, a room made a hallway), in Chrome with
// SwiftShader for MapLibre's WebGL. The admin runs over a copy of the data (tests/admin/serve-admin-copy.mjs), so the
// committed files are never written.
//   npx playwright test -c tests/admin        (PW_CHANNEL=chrome to use the installed Chrome)
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.MSCN_ADMIN_E2E_PORT || 8791);
const channel = process.env.PW_CHANNEL || undefined;
const launchOptions = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

export default defineConfig({
  testDir: '.',
  testMatch: '*.admin.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '../../test-results/admin-e2e',
  use: { baseURL: `http://localhost:${PORT}/`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `node tests/admin/serve-admin-copy.mjs --port ${PORT}`,
    cwd: '../..',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1400, height: 1100 }, launchOptions } }],
});
