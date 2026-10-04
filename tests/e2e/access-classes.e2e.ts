import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// v5 access classes (plan mscn-v5-access-classes-and-editors) in the app, on the real campus with page.route patches
// standing in for the classed data lane P publishes: IT's "Northwest entrance, level 2" (it-2-n0551) becomes a side
// (alt) door and its "South entrance 2, level 2" (it-2-n0557) an emergency exit opening into room 250C, marked an
// emergency hallway; both doors get a connector to the nearest path node, as the campus-map build gives a classed
// door. EP 1332 -> IT 203: the main doors win at the default alt factor; the side door saves about 19 m and wins with
// "Use side doors and paths" on; the emergency exit would save more and is never used.

const SIDE = 'it-2-n0551';
const EXIT = 'it-2-n0557';
const EXIT_ROOM = 'room-it-2-0250C';

async function patchClasses(page: Page) {
  await page.route(/\/data\/campus\.json(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const c = await res.json();
    for (const n of c.navNodes) {
      if (n.id === SIDE) n.access = 'alt';
      if (n.id === EXIT) n.access = 'emergency';
    }
    for (const r of c.rooms) if (r.id === EXIT_ROOM) Object.assign(r, { type: 'corridor', access: 'emergency' });
    await route.fulfill({ response: res, json: c });
  });
  await page.route(/\/data\/campus-map\/outdoor-graph\.json(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const g = await res.json();
    g.nodes.push({ id: SIDE, lat: 36.616204, lng: -88.323407, type: 'entrance', access: 'alt' });
    g.nodes.push({ id: EXIT, lat: 36.615436, lng: -88.322824, type: 'entrance', access: 'emergency' });
    g.edges.push({ id: 'test-side', from: SIDE, to: 'o471', distance: 19, accessible: true, kind: 'connector', access: 'main' });
    g.edges.push({ id: 'test-exit', from: EXIT, to: 'o498', distance: 47, accessible: true, kind: 'connector', access: 'main' });
    await route.fulfill({ response: res, json: g });
  });
}

async function boot(page: Page) {
  await page.goto('./');
  await expect(page.locator('#loading-screen')).toBeHidden();
  // the classed doors join once the outdoor graph is in
  await expect.poll(() => page.evaluate((id) => !!(window as any).APP.graph.adj[id]?.some((e: any) => e.outdoor), EXIT), { timeout: 30_000 }).toBe(true);
}

async function searchAndOpen(page: Page, q: string, title: string) {
  if (await page.locator('#view-map').isVisible()) await page.getByRole('tab', { name: 'Indoor' }).click();
  const input = page.locator('#search-input');
  await input.fill(q);
  await expect(page.locator('#search-results li').first()).toContainText(title);
  await page.locator('#search-results li').first().click();
  await expect(page.locator('#room-sheet-title')).toHaveText(title);
}

async function routeEpToIt203(page: Page) {
  await searchAndOpen(page, 'EP 1332', 'EP 1332');
  await page.getByRole('button', { name: 'Set as start' }).click();
  await searchAndOpen(page, 'IT 203', 'IT 203');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.locator('#route-panel')).toContainText('Route to');
}

// The route's node ids, the doors it enters by (with their class) and its step titles.
const routeFacts = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const r = w.NAV.route;
  const g = w.APP.graph;
  const ids: string[] = [].concat(...r.steps.map((s: any) => s.nodeIds));
  const doors = r.steps.filter((s: any) => s.kind === 'door').map((s: any) => ({ id: s.nodeId, access: w.MSCNPath.accessOf(g.nodes[s.nodeId]), title: s.title }));
  return { ids, doors, titles: r.steps.map((s: any) => s.title), error: r.error };
});

// Next until the step on IT's second floor indoors.
async function toItSecondFloor(page: Page) {
  for (let i = 0; i < 12; i++) {
    const s = await page.evaluate(() => { const r = (window as any).NAV.route; const st = r.steps[(window as any).NAV.stepIndex]; return st.floorId + ':' + st.kind; });
    if (s.startsWith('floor-it-2:')) break;
    const at = await page.evaluate(() => (window as any).NAV.stepIndex);
    await page.locator('#route-next').click();
    await expect(page.locator('#route-step .count')).toContainText(`Step ${at + 2} of`);
  }
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('Second Floor');
}

test('an emergency exit is drawn on the floor plan and never on a route; the route enters by a main door', async ({ page }) => {
  test.slow(); // a cross-building route: its outdoor steps fly the software-rendered (SwiftShader) map
  await patchClasses(page);
  await boot(page);
  await routeEpToIt203(page);
  const f = await routeFacts(page);
  expect(f.error).toBeNull();
  expect(f.ids).not.toContain(EXIT);
  expect(f.ids).not.toContain(SIDE);
  const itDoor = f.doors[f.doors.length - 1];
  expect(itDoor.access, itDoor.id).toBe('main');
  expect(f.titles.join(' | ')).not.toMatch(/side door|emergency/i);

  await toItSecondFloor(page);
  const exit = page.locator(`#viewer .fv-marker--exit[data-marker-id="class:${EXIT}"]`);
  await expect(exit).toHaveCount(1);
  await expect(exit).toContainText('EXIT');
  await expect(exit.locator('title')).toHaveText('Emergency exit (not used for directions)');
  await expect(page.locator(`#viewer .fv-marker--door-alt[data-marker-id="class:${SIDE}"]`)).toHaveCount(1);
  await expect(page.locator('#viewer .fv-marker--door-main')).not.toHaveCount(0);
  await expect(page.locator('#viewer .is-emergency')).not.toHaveCount(0);
  await expect(page.locator('#viewer .fv-route[data-route="active"] .fv-route-line')).toHaveCount(1);

  // the legend says what the three classes mean
  await page.locator('#route-legend summary').click();
  await expect(page.locator('#route-legend')).toContainText('Emergency exit');
  await expect(page.locator('#route-legend')).toContainText('Side door');
});

test('"Use side doors and paths" flips the route onto the side door, says so, and is remembered', async ({ page }) => {
  test.slow(); // a cross-building route: its outdoor steps fly the software-rendered (SwiftShader) map
  await patchClasses(page);
  await boot(page);
  await routeEpToIt203(page);
  expect((await routeFacts(page)).ids).not.toContain(SIDE);

  const toggle = page.locator('label.switch', { hasText: 'Use side doors and paths' });
  await toggle.click();
  await expect(page.locator('#use-side-doors')).toBeChecked();
  await expect.poll(async () => (await routeFacts(page)).ids.includes(SIDE)).toBe(true);
  const f = await routeFacts(page);
  expect(f.ids).not.toContain(EXIT);
  const side = f.doors.find((d) => d.id === SIDE)!;
  expect(side.access).toBe('alt');
  expect(side.title).toBe('Enter by the side door (Northwest entrance, level 2)');
  expect(await page.evaluate(() => window.localStorage.getItem('mscnUseSideDoors'))).toBe('1');

  // the step shows the side door on the plan
  await toItSecondFloor(page);
  await expect(page.locator('#route-step .title')).toHaveText(/side door|Arrive at IT 203|Take the/);

  // off again: back on the main door
  await toggle.click();
  await expect.poll(async () => (await routeFacts(page)).ids.includes(SIDE)).toBe(false);
  expect(await page.evaluate(() => window.localStorage.getItem('mscnUseSideDoors'))).toBe('0');
});

// The phone screenshot for the lane record (light): MSCN_SHOT=1, desktop project only (it sets its own Pixel 7 page).
test('screenshot: a phone floor plan with an emergency exit and a route from a main door', async ({ browser }, info) => {
  test.skip(!process.env.MSCN_SHOT || info.project.name !== 'desktop', 'set MSCN_SHOT=1 to write .scratch/s-classes-light.png');
  const { devices } = await import('@playwright/test');
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', serviceWorkers: 'block', baseURL: info.project.use.baseURL });
  const page = await ctx.newPage();
  await patchClasses(page);
  await boot(page);
  // no start: the automatic start is IT's main "South entrance, level 2", near the emergency exit
  await searchAndOpen(page, 'IT 244', 'IT 244');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await toItSecondFloor(page);
  const first = await page.evaluate(() => { const w = window as any; const id = w.NAV.route.steps[0].nodeIds[0]; return w.MSCNPath.accessOf(w.APP.graph.nodes[id]) + ':' + id; });
  expect(first).toBe('main:it-2-n0552');
  // frame the exit and the route from the main door
  await page.evaluate((id) => {
    const w = window as any;
    const n = w.APP.graph.nodes[id];
    const st = w.NAV.route.steps[w.NAV.stepIndex];
    w.IND.viewer.focusPoints([[n.x, n.y]].concat(st.points || []));
  }, EXIT);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(info.config.rootDir, '..', '..', '.scratch', 's-classes-light.png') });
  await ctx.close();
});
