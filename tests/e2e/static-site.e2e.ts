import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { precacheEntries, serviceWorkerSource } from '../../scripts/build/service-worker.mjs';

// What the static deployment adds on top of the app behaviour (webapp.e2e.ts): sub-path-safe URLs, the 404
// redirect for deep links, the data cache, official schedules by id, no Google and no map key anywhere, and
// analytics that load only when configured. The site under test is the analytics-off build.

const BASE_PATH = '/campus-nav/';
const ROOT = join(__dirname, '..', '..');

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
  const cfg = await res.json();
  expect(cfg).toMatchObject({ basePath: BASE_PATH, analytics: { site: '' } });
  expect('mapsApiKey' in cfg).toBe(false);
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

// A deploy transition with the real service worker, on a server of this test's own (a copy of the e2e build) so the
// test can publish a next deploy and drop the connection. page.route cannot see requests the worker answers.
test.describe('deploy transition', () => {
  test.use({ serviceWorkers: 'allow' });

  test('an open old build keeps its own generation through a new deploy and a lost connection; Reload brings the new data', async ({ page }) => {
    test.setTimeout(90_000);
    const dir = mkdtempSync(join(tmpdir(), 'mscn-deploy-'));
    cpSync(join(ROOT, 'build', 'e2e-site'), dir, { recursive: true });
    // dev/serve.mjs has a top-level await (its CLI), so it cannot be a static import of a CommonJS-compiled spec
    const { createStaticServer } = await import('../../dev/serve.mjs');
    const serve = createStaticServer({ dist: dir, base: BASE_PATH }).listeners('request')[0] as (req: IncomingMessage, res: ServerResponse) => void;
    let down = (_path: string) => false;
    const server = createServer((req, res) => {
      if (down(new URL(req.url || '/', 'http://x').pathname)) { req.socket.destroy(); return; }
      serve(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BASE_PATH}`;
    const stored = () => page.evaluate(() => ({
      version: localStorage.getItem('campusDataVersion'),
      dataVersion: JSON.parse(localStorage.getItem('campusData') || '{}').version,
    }));
    // the EP building name the running page is using
    const shown = () => page.evaluate(() => (window as any).APP.by.buildings['bld-ep'].name);
    try {
      // first visit installs the worker; the reload is the first page it serves
      await page.goto(site);
      await expect(page.locator('#loading-screen')).toBeHidden();
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.reload();
      await expect(page.locator('#loading-screen')).toBeHidden();
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      const campusFile = join(dir, 'data', 'campus.json');
      const campus = JSON.parse(readFileSync(campusFile, 'utf8'));
      const v1 = String(campus.version);
      expect(await stored()).toEqual({ version: v1, dataVersion: v1 });
      const ep = campus.buildings.find((b: { id: string }) => b.id === 'bld-ep');
      const oldName = String(ep.name);
      const newName = oldName + ' (next deploy)';
      expect(await shown()).toBe(oldName);

      // the next deploy: a different campus body, its version, and the worker the build would emit for it
      const v2 = 'next-' + v1;
      ep.name = newName;
      campus.version = v2;
      for (const c of campus.config || []) if (c.key === 'dataVersion') c.value = v2;
      writeFileSync(campusFile, JSON.stringify(campus));
      writeFileSync(join(dir, 'data', 'version.json'), JSON.stringify({ version: v2, builtAt: '', gitSha: '' }));
      writeFileSync(join(dir, 'sw.js'), serviceWorkerSource({ version: v2, entries: precacheEntries(dir) }));

      // the connection drops after version.json: the old page stays whole and nothing is stored under the new version
      down = (p) => p !== BASE_PATH + 'data/version.json';
      await page.reload();
      await expect(page.locator('#loading-screen')).toBeHidden();
      expect(await shown()).toBe(oldName);
      expect(await stored()).toEqual({ version: v1, dataVersion: v1 });
      const asked = await page.evaluate((v) => fetch('data/campus.json?v=' + encodeURIComponent(v))
        .then((r) => r.text().then((t) => 'answered ' + r.status + ' ' + t.slice(0, 40)), () => 'failed'), v2);
      expect(asked, 'a request for the new version never gets the old precached payload').toBe('failed');

      // back online: the browser finds the new worker, the page offers Reload, and Reload brings the new build
      down = () => false;
      await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update(); });
      await expect(page.locator('#update-banner')).toBeVisible({ timeout: 30_000 });
      const reloaded = page.waitForEvent('load');
      await page.locator('#update-reload').click();
      await reloaded;
      await expect(page.locator('#loading-screen')).toBeHidden();
      expect(await shown()).toBe(newName);
      expect(await stored()).toEqual({ version: v2, dataVersion: v2 });
    } finally {
      await page.close();
      await new Promise((r) => server.close(r));
      server.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

test('the map is self-hosted: no request leaves the site, even with a stale mapsApiKey in config.json', async ({ page, request }) => {
  await withConfig(page, { mapsApiKey: 'TEST-KEY-not-real-0123456789' });
  const hosts = externalHosts(page);
  await boot(page);
  await expect(page.locator('#map-canvas')).toHaveAttribute('data-map-ready', 'true', { timeout: 20_000 });
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await expect(page.locator('#viewer svg.fv-svg')).toBeVisible();
  expect(hosts, 'external hosts').toEqual([]);
  const html = await (await request.get('./')).text();
  expect(html).not.toMatch(/maps\.googleapis|gm_authFailure|google\.maps\./);
  for (const f of ['vendor/maplibre-gl.mjs', 'vendor/maplibre-gl-worker.mjs', 'vendor/maplibre-gl.css', 'vendor/modules.mjs', 'data/map-manifest.json', 'sw.js']) {
    expect((await request.get('./' + f)).status(), f).toBe(200);
  }
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
