import { defineConfig, devices } from '@playwright/test';

const appUrl =
  process.env.APP_URL ||
  'https://script.google.com/macros/s/AKfycbxM-sMOC8CQQf2ckPX6MgZHZsnWu-oAWKp0DeuqbEp3idjSKGZUY288zN_KhXlwbhy53Q/exec';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: appUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
