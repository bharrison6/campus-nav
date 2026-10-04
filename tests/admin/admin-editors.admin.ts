// The admin's v5 editors in a real browser, over a copy of the data (see playwright.config.ts). Each step checks the
// file the editor wrote. Screenshots of both editors go to test-results/admin-e2e-data/screenshots.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const DATA = join(__dirname, '..', '..', 'test-results', 'admin-e2e-data');
const SHOTS = join(DATA, 'screenshots');
const readJson = (rel: string) => JSON.parse(readFileSync(join(DATA, rel), 'utf8'));
const statusText = (page: Page) => page.locator('#status-msg');

test.describe.configure({ mode: 'serial' });

test('Map Editor: a path is reclassed alt (pathAccess.json) and a new path is drawn (overrides.geojson)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#main-content')).toBeVisible();
  await page.click('button[data-tab="mapedit"]');
  await page.waitForFunction(() => (window as any).__adminMapReady === true, null, { timeout: 90_000 });
  await page.waitForTimeout(2000);
  const box = (await page.locator('#mapedit-map').boundingBox())!;

  // a walkway away from entrances and drawn paths
  const pt = await page.evaluate(() => {
    const m = (window as any).mapEd.map;
    const c = m.getCanvas();
    for (let y = 80; y < c.clientHeight - 80; y += 9) for (let x = 80; x < c.clientWidth - 80; x += 9) {
      const f = m.queryRenderedFeatures([[x - 2, y - 2], [x + 2, y + 2]], { layers: ['path-l'] });
      if (f.length && f[0].properties._layer === 'paths' && f[0].properties._way && !f[0].properties._set) {
        const near = m.queryRenderedFeatures([[x - 9, y - 9], [x + 9, y + 9]], { layers: ['ent-l', 'dpath-l'] });
        if (!near.length) return { x, y, way: f[0].properties._way as string };
      }
    }
    return null;
  });
  expect(pt, 'a walkway is drawn on the map').not.toBeNull();
  await page.mouse.click(box.x + pt!.x, box.y + pt!.y);
  await expect(page.locator('#mapedit-panel')).toContainText(pt!.way);
  await page.click('#mapedit-panel button[data-access="alt"]');
  await expect(statusText(page)).toContainText(`Path ${pt!.way}: alt`);
  expect(readJson('overrides/pathAccess.json')).toContainEqual({ way: pt!.way, access: 'alt' });

  // draw a three-point path, alt, named
  await page.click('button[data-maptool="path"]');
  for (const [dx, dy] of [[-220, 180], [-150, 200], [-90, 230]]) await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await expect(page.locator('#mapedit-panel')).toContainText('3 points so far');
  await page.selectOption('#mapedit-path-access', 'alt');
  await page.fill('#mapedit-path-name', 'Browser test walk');
  await page.click('#mapedit-finish');
  await expect(statusText(page)).toContainText('Path saved');
  const feats = readJson('campus-map/overrides.geojson').features;
  const drawn = feats[feats.length - 1];
  expect(drawn.properties).toMatchObject({ layer: 'paths', access: 'alt', name: 'Browser test walk', kind: 'footway' });
  expect(drawn.geometry.coordinates.length).toBe(3);

  // select it for the screenshot, once the map has drawn it
  const midHandle = await page.waitForFunction((id) => {
    const me = (window as any).mapEd;
    const f = me.data && me.data.geo.features.find((x: any) => x.properties.id === id);
    if (!f) return null;
    const c = f.geometry.coordinates;
    const p = me.map.project([(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2]);
    const hit = me.map.queryRenderedFeatures([[p.x - 3, p.y - 3], [p.x + 3, p.y + 3]], { layers: ['dpath-l'] });
    return hit.some((h: any) => h.properties.id === id) ? { x: p.x, y: p.y } : null;
  }, drawn.properties.id);
  const mid = (await midHandle.jsonValue()) as { x: number; y: number };
  const box2 = (await page.locator('#mapedit-map').boundingBox())!; // the page may have scrolled since
  await page.mouse.click(box2.x + mid.x, box2.y + mid.y);
  await expect(page.locator('#mapedit-panel')).toContainText('Browser test walk');
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('#tab-mapedit .card').screenshot({ path: join(SHOTS, 'map-editor.png') });
});

/** Clicks a nav node on the Doors & Halls canvas. */
async function clickNode(page: Page, id: string) {
  const p = await page.evaluate((nodeId) => {
    const w = window as any;
    const n = w.findById(w.campusData.navNodes, nodeId);
    const c = w.accessEd.canvas;
    return { x: c.offsetX + n.x * c.scale, y: c.offsetY + n.y * c.scale };
  }, id);
  const box = (await page.locator('#access-canvas').boundingBox())!;
  await page.mouse.click(box.x + p.x, box.y + p.y);
  await expect(page.locator('#access-panel')).toContainText(id);
}

test('Doors & Halls: EP 1322\'s only door is refused as emergency; another door is set emergency; a room becomes an alt hallway', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#main-content')).toBeVisible();
  await page.click('button[data-tab="access"]');
  await page.selectOption('#access-building-select', 'bld-ep');
  await page.waitForTimeout(1200);
  await clickNode(page, 'ep-1-n0365');
  await page.click('#access-panel button[data-access="emergency"]');
  await expect(page.locator('#access-panel .refusal')).toContainText('Room EP 1322');
  expect(readJson('overrides/navNodes.json').some((n: any) => n.id === 'ep-1-n0365')).toBe(false);

  await page.selectOption('#access-building-select', 'bld-it');
  await page.waitForTimeout(1200);
  await clickNode(page, 'it-1-n0270');
  await page.click('#access-panel button[data-access="emergency"]');
  await expect(statusText(page)).toContainText('it-1-n0270 is now emergency');
  expect(readJson('overrides/navNodes.json')).toContainEqual({ id: 'it-1-n0270', access: 'emergency' });

  await page.locator('#access-candidates .candidate-row').first().locator('button:has-text("Show")').click();
  await page.check('#access-room-hallway');
  await page.click('#access-panel button[data-access="alt"]');
  await page.click('#access-panel button:has-text("Save")');
  await expect(statusText(page)).toContainText('is a hallway, class alt');
  expect(readJson('overrides/rooms.json')).toContainEqual({ id: 'room-it-1-0141', type: 'corridor', access: 'alt' });
  expect(readJson('overrides/corridorReview.json')).toContainEqual({ room: 'room-it-1-0141', decision: 'accepted' });

  // frame the emergency door and the new hallway for the screenshot
  await page.evaluate(() => {
    const w = window as any;
    const r = w.findById(w.campusData.rooms, 'room-it-1-0141');
    const n = w.findById(w.campusData.navNodes, 'it-1-n0270');
    const c = w.accessEd.canvas;
    const cx = (r.centerX + n.x) / 2, cy = (r.centerY + n.y) / 2;
    const span = Math.max(Math.abs(r.centerX - n.x), Math.abs(r.centerY - n.y)) + 260;
    c.scale = Math.min(c.cssWidth, c.cssHeight) / span;
    c.offsetX = c.cssWidth / 2 - cx * c.scale;
    c.offsetY = c.cssHeight / 2 - cy * c.scale;
    c.render();
  });
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('#tab-access').screenshot({ path: join(SHOTS, 'floor-editor.png') });
});
