import { defineConfig, devices } from '@playwright/test';

const appUrl =
  process.env.APP_URL ||
  'https://script.google.com/macros/s/AKfycbwK7uZ5SDu_PIDrUfWYj7866Y4gbs68cbQxxLZN4kQs0iv5EpiKeR62qBGOfk75CEo/exec';

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
