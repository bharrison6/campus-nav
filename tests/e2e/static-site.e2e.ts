import { expect, test, type Page, type Request } from '@playwright/test';

// What the static deployment adds on top of the app behaviour (webapp.e2e.ts): sub-path-safe URLs, the 404
// redirect for deep links, the data cache, official schedules by id, the Maps key from config.json, and
// analytics that load only when configured. The site under test is the key-free, analytics-off build.

const BASE_PATH = '/campus-nav/';

async function boot(page: Page, query = '') {
  await page.goto('./' + query);
  await expect(page.locator('#loading-screen')).toBeHidden();
}

function sameOriginPaths(page: Page) {
  const paths: string[] = [];
  page.on('request', (req: Request) => {
    const u = new URL(req.url());
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') paths.push(u.pathname);
  });
  return paths;
}

const externalHosts = (page: Page) => {
  const hosts: string[] = [];
  page.on('request', (req: Request) => {
    const u = new URL(req.url());
    if (u.protocol.startsWith('http') && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') hosts.push(u.hostname);
  });
  return hosts;
};

async function withConfig(page: Page, patch: Record<string, unknown>) {
  await page.route('**/config.json*', async (route) => {
    const res = await route.fetch();
    const json = { ...(await res.json()), ...patch };
    await route.fulfill({ response: res, json });
  });
}

test('every request stays under the sub-path (relative URLs only)', async ({ page }) => {
  const paths = sameOriginPaths(page);
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await expect(page.locator('#viewer svg.fv-svg')).toBeVisible();
  await page.locator('#search-input').fill('EP 2321');
  await page.locator('#search-results li').first().click();
  await expect(page.locator('#room-sheet-title')).toHaveText('EP 2321');
  await page.goto('./?sched=eday-sample');
  await expect(page.locator('#official-schedule')).toBeVisible();
  const outside = paths.filter((p) => !p.startsWith(BASE_PATH));
  expect(outside, 'requests outside ' + BASE_PATH).toEqual([]);
  for (const want of ['config.json', 'data/version.json', 'data/campus.json', 'floors/floor-ep-1.svg', 'floors/floor-ep-2.svg',
    'data/schedules/eday-sample.json', 'data/links.json']) {
    expect(paths, want).toContain(BASE_PATH + want);
  }
});

test('the built page has no root-relative src/href and no leftover template scriptlet', async ({ page, request }) => {
  const html = await (await request.get('./')).text();
  expect(html).not.toMatch(/\s(src|href)=["']\/(?!\/)/);
  expect(html).not.toContain('<?');
  expect(html).not.toContain('google.script');
  const res = await request.get('./config.json');
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ mapsApiKey: '', basePath: BASE_PATH, analytics: { site: '' } });
});

test('a deep path that does not exist lands on the app with its query kept (404.html redirect)', async ({ page }) => {
  await page.goto('./rooms/old-link?room=room-ep-2-2321');
  await expect(page.locator('#loading-screen')).toBeHidden();
  expect(new URL(page.url()).pathname).toBe(BASE_PATH);
  await expect(page.locator('#room-sheet-title')).toHaveText('EP 2321');
});

test('a second visit uses the cached campus data when the published version is unchanged', async ({ page }) => {
  const paths = sameOriginPaths(page);
  await boot(page);
  await boot(page);
  expect(paths.filter((p) => p === BASE_PATH + 'data/version.json').length).toBe(2);
  expect(paths.filter((p) => p === BASE_PATH + 'data/campus.json').length).toBe(1);
  await expect(page.locator('#stale-banner')).toBeHidden();
});

test('a new published version replaces the cached data', async ({ page }) => {
  await boot(page);
  await page.route('**/data/version.json*', (r) => r.fulfill({ json: { version: 'newer-build', builtAt: '', gitSha: '' } }));
  const campus = page.waitForRequest((r) => r.url().includes('data/campus.json?v=newer-build'));
  await boot(page);
  await campus;
  expect(await page.evaluate(() => localStorage.getItem('campusDataVersion'))).toBe('newer-build');
});

test('?sched=<id> opens the official schedule read-only; events add to my schedule and route', async ({ page }) => {
  await boot(page, '?sched=eday-sample');
  const box = page.locator('#official-schedule');
  await expect(page.locator('#view-schedule')).toBeVisible();
  await expect(box.locator('#official-title')).toHaveText('Engineering Day (sample schedule)');
  await expect(box).toContainText('Saturday, November 7, 2026');
  await expect(box.locator('.official-event')).toHaveCount(6);
  await expect(box.locator('.official-event').first()).toContainText('Collins Industry and Technology Center · IT 141');
  await expect(box.locator('.official-event').first().getByRole('link', { name: 'Event program (PDF)' })).toHaveAttribute('target', '_blank');
  await expect(box.locator('.official-event').nth(4)).toContainText('Curris Center');
  await expect(box.locator('input, textarea, [contenteditable]')).toHaveCount(0);

  await box.locator('[data-official-add]').first().click();
  await expect(page.locator('#schedule-list')).toContainText('Check-in and welcome');
  await expect(page.locator('#schedule-list')).toContainText('IT 141');
  await box.locator('#official-add-all').click();
  await expect(page.locator('#schedule-list .event')).toHaveCount(6);

  await box.locator('[data-official-go]').nth(2).click();
  await expect(page.locator('#route-panel')).toContainText('Arrive at IT 241');

  await page.getByRole('tab', { name: 'Schedule' }).click();
  await page.locator('#official-close').click();
  await expect(box).toBeHidden();
  await expect(page.locator('#schedule-list .event')).toHaveCount(6);
});

test('an unknown or malformed schedule id says so and leaves the app usable', async ({ page }) => {
  await boot(page, '?sched=no-such-schedule');
  await expect(page.locator('#toast')).toContainText('That schedule was not found.');
  await boot(page, '?sched=..%2Fconfig');
  await expect(page.locator('#toast')).toContainText('That schedule link is not valid.');
  await expect(page.locator('#official-schedule')).toBeHidden();
});

test('a scanned schedule QR (an app URL with ?sched=) opens the official schedule', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).handleQrText('https://bharrison6.github.io/campus-nav/?sched=eday-sample', true));
  await expect(page.locator('#official-title')).toHaveText('Engineering Day (sample schedule)');
});

test('key-free fallback: no Maps key in config.json means no Maps request and the building list', async ({ page }) => {
  const hosts = externalHosts(page);
  await boot(page);
  await expect(page.locator('#map-notice')).toContainText('not configured');
  expect(hosts.filter((h) => h.includes('googleapis'))).toEqual([]);
});

test('a Maps key from config.json is used (and a failed Maps load still falls back)', async ({ page }) => {
  await withConfig(page, { mapsApiKey: 'TEST-KEY-not-real-0123456789' });
  const maps = page.waitForRequest((r) => r.url().startsWith('https://maps.googleapis.com/maps/api/js'));
  await page.route('https://maps.googleapis.com/**', (r) => r.abort('failed'));
  await boot(page);
  expect(new URL((await maps).url()).searchParams.get('key')).toBe('TEST-KEY-not-real-0123456789');
  await expect(page.locator('#map-notice')).toContainText('could not load');
});

test('analytics stay off unless config.json names a site', async ({ page }) => {
  const hosts = externalHosts(page);
  await boot(page, '?room=room-it-1-0141');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.locator('#route-panel')).toBeVisible();
  expect(hosts.filter((h) => /goatcounter|zgo\.at/.test(h))).toEqual([]);
  expect(await page.locator('script[data-goatcounter]').count()).toBe(0);
});

test('analytics: GoatCounter loads when configured; a deep-link page view carries no query; sched_open', async ({ page }) => {
  await withConfig(page, { analytics: { provider: 'goatcounter', site: 'msu-test' } });
  await page.route('https://gc.zgo.at/count.js', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: 'window.__gc = []; window.goatcounter = window.goatcounter || {}; window.goatcounter.count = function (o) { window.__gc.push(o); };',
  }));
  await page.route(/goatcounter\.com/, (r) => r.abort('failed'));
  await boot(page, '?sched=eday-sample');
  await expect(page.locator('#official-schedule')).toBeVisible();
  await expect(page.locator('script[data-goatcounter]')).toHaveAttribute('data-goatcounter', 'https://msu-test.goatcounter.com/count');
  await expect.poll(() => page.evaluate(() => ((window as any).__gc || []).length)).toBeGreaterThanOrEqual(2);
  const calls = await page.evaluate(() => (window as any).__gc);
  expect(calls[0]).toEqual({ path: BASE_PATH });
  expect(calls).toContainEqual({ path: 'sched_open', title: 'eday-sample', event: true });
});

test('analytics events on one page: qr_scan, search, route_start, floor_change', async ({ page }) => {
  await withConfig(page, { analytics: { provider: 'goatcounter', site: 'msu-test' } });
  await page.route('https://gc.zgo.at/count.js', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: 'window.__gc = []; window.goatcounter = window.goatcounter || {}; window.goatcounter.count = function (o) { window.__gc.push(o); };',
  }));
  await page.route(/goatcounter\.com/, (r) => r.abort('failed'));
  const payload = { type: 'location', nodeId: 'it-1-n0489', permanent: true, description: 'IT entrance' };
  const qr = encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString('base64'));
  await boot(page, '?qr=' + qr);
  await page.locator('#search-input').fill('IT 241');
  await page.locator('#search-results li').first().click();
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.locator('#route-panel')).toBeVisible();
  await page.locator('#floor-picker button', { hasText: 'Second Floor' }).click();
  await page.locator('#floor-picker button', { hasText: 'First Floor' }).click();
  await expect.poll(() => page.evaluate(() => ((window as any).__gc || []).length)).toBeGreaterThanOrEqual(5);
  const calls = await page.evaluate(() => (window as any).__gc);
  expect(calls[0]).toEqual({ path: BASE_PATH }); // the ?qr= payload never reaches the page view
  expect(calls).toContainEqual({ path: 'qr_scan', title: 'link location', event: true });
  expect(calls).toContainEqual({ path: 'search', title: 'room', event: true });
  expect(calls).toContainEqual({ path: 'route_start', title: 'bld-it', event: true });
  expect(calls).toContainEqual({ path: 'floor_change', title: 'floor-it-1', event: true });
  expect(JSON.stringify(calls)).not.toContain('IT 241'); // what was typed is never sent
});
