import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// v5.1 route choice (plan mscn-v5-1-route-choice-and-private-floors) in the app, on the real campus data. EP 1332 ->
// IT 157G: under Best entrance the route enters IT by its side door "South entrance 2" (it-1-n0495), which opens
// right by the 157 suite; by a main door the walk would climb down a stair and turn through the building, and the
// door step says so. Front door only keeps the main doors. Reroute: "This door is locked" at that door goes on to the
// next best door from outside it; "Path blocked" on the walk avoids the path ahead and walks around it.

const SIDE = 'it-1-n0495';
const SIDE_LABEL = 'South entrance 2';

async function boot(page: Page) {
  await page.goto('./');
  await expect(page.locator('#loading-screen')).toBeHidden();
  await expect.poll(() => page.evaluate((id) => !!(window as any).APP.graph.adj[id]?.some((e: any) => e.outdoor), SIDE), { timeout: 30_000 }).toBe(true);
}

async function searchAndOpen(page: Page, q: string, title: string) {
  if (await page.locator('#view-map').isVisible()) await page.getByRole('tab', { name: 'Indoor' }).click();
  const input = page.locator('#search-input');
  await input.fill(q);
  await expect(page.locator('#search-results li').first()).toContainText(title);
  await page.locator('#search-results li').first().click();
  await expect(page.locator('#room-sheet-title')).toHaveText(title);
}

async function routeEpToIt157G(page: Page) {
  await searchAndOpen(page, 'EP 1332', 'EP 1332');
  await page.getByRole('button', { name: 'Set as start' }).click();
  await searchAndOpen(page, 'IT 157G', 'IT 157G');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.locator('#route-panel')).toContainText('Route to');
}

const facts = (page: Page) => page.evaluate(() => {
  const w = (window as any);
  const r = w.NAV.route;
  const ids: string[] = [].concat(...r.steps.map((s: any) => s.nodeIds));
  return {
    ids, error: r.error, from: r.fromLabel,
    doors: r.steps.filter((s: any) => s.kind === 'door').map((s: any) => s.nodeId),
    kinds: r.steps.map((s: any) => s.kind),
    step: r.steps[w.NAV.stepIndex] ? r.steps[w.NAV.stepIndex].kind : null,
  };
});

// Next until the current step is of `kind` (and, for a door, that door).
async function nextUntil(page: Page, kind: string, nodeId?: string) {
  for (let i = 0; i < 12; i++) {
    const s = await page.evaluate(() => { const w = window as any; const st = w.NAV.route.steps[w.NAV.stepIndex]; return { kind: st.kind, nodeId: st.nodeId || null, at: w.NAV.stepIndex }; });
    if (s.kind === kind && (!nodeId || s.nodeId === nodeId)) return;
    await page.locator('#route-next').click();
    await expect(page.locator('#route-step .count')).toContainText(`Step ${s.at + 2} of`);
  }
  throw new Error(`no ${kind} step`);
}

test('the entrance choice: Best entrance takes the simpler side door and says why; Front door only keeps the main doors; remembered', async ({ page }) => {
  test.slow(); // a cross-building route: its outdoor steps fly the software-rendered (SwiftShader) map
  await boot(page);
  await routeEpToIt157G(page);
  const radios = page.locator('#route-entrance input[type="radio"]');
  await expect(radios).toHaveCount(3);
  await expect(page.locator('#route-entrance legend')).toHaveText('Entrance');
  await expect(page.getByRole('radio', { name: 'Best entrance' })).toBeChecked();
  const best = await facts(page);
  expect(best.error).toBeNull();
  expect(best.doors).toContain(SIDE);
  await nextUntil(page, 'door', SIDE);
  await expect(page.locator('#route-step .title')).toHaveText(`Enter by the side door (${SIDE_LABEL})`);
  await expect(page.locator('#route-why')).toHaveText(/^The side door is the simpler way in: by a main door there would be a stair or elevator ride, \d+ more turns/);

  await page.getByRole('radio', { name: 'Front door only' }).check();
  await expect.poll(async () => (await facts(page)).doors.includes(SIDE)).toBe(false);
  const front = await facts(page);
  expect(front.error).toBeNull();
  for (const d of front.doors) expect(await page.evaluate((id) => (window as any).MSCNPath.accessOf((window as any).APP.graph.nodes[id]), d)).toBe('main');
  await expect(page.locator('#route-why')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Front door only' })).toBeFocused();
  expect(await page.evaluate(() => window.localStorage.getItem('mscnEntrance'))).toBe('front');

  // remembered on the phone: a new visit plans with Front door only
  await page.reload();
  await boot(page);
  await routeEpToIt157G(page);
  await expect(page.getByRole('radio', { name: 'Front door only' })).toBeChecked();
  expect((await facts(page)).doors).not.toContain(SIDE);
});

test('the entrance choice: v5\'s "Use side doors and paths" switch, stored on, comes back as Any door', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('mscnUseSideDoors', '1'); sessionStorage.setItem('seeded', '1'); } });
  await boot(page);
  await searchAndOpen(page, 'IT 101F', 'IT 101F');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.getByRole('radio', { name: 'Any door' })).toBeChecked();
  expect(await page.evaluate(() => [localStorage.getItem('mscnEntrance'), localStorage.getItem('mscnUseSideDoors')])).toEqual(['any', null]);
  // Any door: the side door beside 101F, which Best entrance leaves alone (it only saves a few meters)
  await expect(page.locator('#route-panel')).toContainText('From the side door');
  await page.getByRole('radio', { name: 'Best entrance' }).check();
  await expect(page.locator('#route-panel')).toContainText('From the building entrance');
});

test('Reroute: "This door is locked" at the side door goes on to the next best door; by keyboard', async ({ page }) => {
  test.slow();
  await boot(page);
  await routeEpToIt157G(page);
  await nextUntil(page, 'door', SIDE);
  const btn = page.locator('#route-reroute');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#route-reroute')).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('group', { name: 'Reroute' });
  await expect(menu.getByRole('button')).toHaveText([/^This door is locked/]);
  await expect(page.locator('#reroute-locked')).toBeFocused();
  // Escape closes it, Enter opens it again
  await page.keyboard.press('Escape');
  await expect(page.locator('#route-reroute')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#route-reroute')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#reroute-locked')).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('#route-panel')).toContainText('From the locked door');
  await expect(page.locator('#route-summary')).toContainText('avoiding the locked door');
  const f = await facts(page);
  expect(f.error).toBeNull();
  expect(f.ids).not.toContain(SIDE);
  expect(f.kinds[0]).toBe('outdoor'); // from outside the locked door, on the paths, to another door
  expect(f.doors.length).toBeGreaterThan(0);
  await expect(page.locator('#route-reroute')).toBeFocused();
  // the marks last for this route only
  await page.locator('#route-close').click();
  expect(await page.evaluate(() => (window as any).hasAvoid())).toBe(false);
});

test('Reroute: "Path blocked" on the walk avoids the path ahead and walks around it', async ({ page }) => {
  test.slow();
  await boot(page);
  await routeEpToIt157G(page);
  await nextUntil(page, 'outdoor');
  const before = await page.evaluate(() => (window as any).NAV.route.meters);
  await page.locator('#route-reroute').click();
  await page.getByRole('button', { name: /^Path blocked/ }).click();
  await expect(page.locator('#route-summary')).toContainText('avoiding the blocked path');
  await expect(page.locator('#route-panel')).toContainText('From where the path is blocked');
  const r = await page.evaluate(() => {
    const w = window as any;
    const blocked = Object.keys(w.NAV.avoid.edges);
    const g = w.APP.graph;
    const walked: string[] = [];
    for (const s of w.NAV.route.steps) {
      for (let i = 1; i < s.nodeIds.length; i++) {
        const e = (g.adj[s.nodeIds[i - 1]] || []).find((x: any) => x.to === s.nodeIds[i] && x.outdoor);
        if (e) walked.push(e.edgeId);
      }
    }
    return { blocked, walked, error: w.NAV.route.error, meters: w.NAV.route.meters };
  });
  expect(r.error).toBeNull();
  expect(r.blocked.length).toBeGreaterThan(0);
  for (const id of r.blocked) expect(r.walked).not.toContain(id);
  expect(r.meters).toBeGreaterThan(0);
  expect(r.meters).not.toBe(before);
});

test('the route panel with the entrance choice and Reroute open fits a 375 px phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await boot(page);
  await searchAndOpen(page, 'IT 157G', 'IT 157G');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await page.locator('#route-reroute').click();
  await expect(page.locator('#route-reroute-menu')).toBeVisible();
  const box = await page.evaluate(() => {
    const p = document.getElementById('route-panel')!;
    const r = p.getBoundingClientRect();
    const parts = Array.from(document.querySelectorAll('#route-entrance label, #route-reroute, .reroute-opt')).map((e) => e.getBoundingClientRect());
    return { overflow: p.scrollWidth - p.clientWidth, left: Math.min(...parts.map((b) => b.left)), right: Math.max(...parts.map((b) => b.right)), panel: [r.left, r.right] };
  });
  expect(box.overflow).toBeLessThanOrEqual(1);
  expect(box.left).toBeGreaterThanOrEqual(box.panel[0] - 0.5);
  expect(box.right).toBeLessThanOrEqual(Math.min(375, box.panel[1]) + 0.5);
  for (const name of ['Best entrance', 'Front door only', 'Any door']) {
    const b = await page.locator('#route-entrance label', { hasText: name }).boundingBox();
    expect(b!.height, name).toBeGreaterThanOrEqual(40);
  }
});

// The phone screenshots for the lane record (light): MSCN_SHOT=1, desktop project only (each sets its own Pixel 7 page).
async function phone(browser: any, info: any) {
  const { devices } = await import('@playwright/test');
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', serviceWorkers: 'block', baseURL: info.project.use.baseURL });
  return { ctx, page: await ctx.newPage() };
}

const shotPath = (info: any, name: string) => join(info.config.rootDir, '..', '..', '.scratch', name);

test('screenshot: the route panel with the entrance choice and Reroute open', async ({ browser }, info) => {
  test.skip(!process.env.MSCN_SHOT || info.project.name !== 'desktop', 'set MSCN_SHOT=1 to write .scratch/w-route-options.png');
  test.slow();
  const { ctx, page } = await phone(browser, info);
  await boot(page);
  await routeEpToIt157G(page);
  await nextUntil(page, 'door', SIDE);
  await page.locator('#route-reroute').click();
  await expect(page.locator('#route-reroute-menu')).toBeVisible();
  await page.locator('#route-panel').evaluate((p) => { p.scrollTop = p.scrollHeight; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath(info, 'w-route-options.png') });
  await ctx.close();
});

test('screenshot: a side door chosen for confusion, with its why step', async ({ browser }, info) => {
  test.skip(!process.env.MSCN_SHOT || info.project.name !== 'desktop', 'set MSCN_SHOT=1 to write .scratch/w-side-door-why.png');
  test.slow();
  const { ctx, page } = await phone(browser, info);
  await boot(page);
  await routeEpToIt157G(page);
  await nextUntil(page, 'door', SIDE);
  await expect(page.locator('#route-why')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: shotPath(info, 'w-side-door-why.png') });
  await ctx.close();
});
