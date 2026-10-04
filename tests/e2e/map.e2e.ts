import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// v4 campus map against the built site (plan mscn-v4-campus-map-2-5d, acceptance 1 to 7): the MapLibre map renders
// (WebGL 2 from SwiftShader in headless Chrome, playwright.config.ts), search flies to a building and to a room, one
// route runs door to room with the tab handoff, "Avoid stairs" applies outdoors, the GPS blue dot (mocked with
// context.setGeolocation) starts and re-routes a walk, the building view stacks the real floors, and the app works
// offline after a first visit. The campus map is the real committed one (data/campus-map, npm run campus-map). The far
// corner is the outdoor node farthest from IT/EP (about 2 km out); building centers are the footprint vertex means the
// app itself uses. OpenStreetMap has no steps ways near IT/EP, so the avoid-stairs test adds one steps edge to the
// served outdoor graph (page.route) where the real walk detours most.

const MAP_DIR = join(__dirname, '..', '..', 'data', 'campus-map');
const GRAPH = JSON.parse(readFileSync(join(MAP_DIR, 'outdoor-graph.json'), 'utf8'));
const BUILDINGS = JSON.parse(readFileSync(join(MAP_DIR, 'buildings.geojson'), 'utf8'));
const CENTER = { lng: -88.322, lat: 36.6155 };
const FAR = GRAPH.nodes.reduce((b: any, n: any) => (meters(CENTER, n) > meters(CENTER, b) ? n : b));
function centerOf(bid: string) {
  const f = BUILDINGS.features.find((x: any) => x.properties.buildingId === bid);
  const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
  let sx = 0, sy = 0;
  const n = ring.length - 1;
  for (let k = 0; k < n; k++) { sx += ring[k][0]; sy += ring[k][1]; }
  return { lng: sx / n, lat: sy / n };
}
const EP_CENTER = centerOf('bld-ep');

async function boot(page: Page, query = '') {
  await page.goto('./' + query);
  await expect(page.locator('#loading-screen')).toBeHidden();
}

async function mapReady(page: Page) {
  await expect(page.locator('#map-canvas')).toHaveAttribute('data-map-ready', 'true', { timeout: 20_000 });
}

async function search(page: Page, q: string, first: string) {
  await page.locator('#search-input').fill(q);
  await expect(page.locator('#search-results li').first()).toContainText(first);
  await page.locator('#search-results li').first().click();
}

const mapState = (page: Page) => page.evaluate(() => {
  const m = (window as any).MAPV.map;
  return { center: m.getCenter(), zoom: m.getZoom(), pitch: m.getPitch(), moving: m.isMoving() };
});

function meters(a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}

const step = (page: Page) => page.locator('#route-panel #route-step');

test('the campus map renders in 2.5D with OpenStreetMap attribution, in the app\'s own style', async ({ page }) => {
  await boot(page);
  await mapReady(page);
  await expect(page.locator('#map-canvas canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap');
  const s = await mapState(page);
  expect(s.pitch).toBeGreaterThan(30);
  const info = await page.evaluate(() => {
    const m = (window as any).MAPV.map;
    return {
      buildings: m.queryRenderedFeatures({ layers: ['buildings-3d'] }).length,
      paths: m.queryRenderedFeatures({ layers: ['paths'] }).length,
      land: m.getPaintProperty('background', 'background-color'),
      token: getComputedStyle(document.documentElement).getPropertyValue('--map-land').trim(),
    };
  });
  expect(info.buildings).toBeGreaterThan(3);
  expect(info.paths).toBeGreaterThan(3);
  expect(info.land).toBe(info.token);
  await expect(page.locator('#map-pitch')).toBeVisible();
  await expect(page.locator('#map-locate')).toBeVisible();
});

test('the map opens on the academic core (quad, IT, EP) at a 45-degree tilt; the whole campus is a zoom-out away', async ({ page }) => {
  await boot(page);
  await mapReady(page);
  const view = await page.evaluate(() => {
    const m = (window as any).MAPV.map;
    const b = m.getBounds();
    const env = (window as any).MAPV.bounds;
    const fit = m.cameraForBounds([[env[0], env[1]], [env[2], env[3]]], { padding: 30, pitch: m.getPitch(), bearing: m.getBearing() });
    return { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth(), pitch: m.getPitch(), zoom: m.getZoom(), envelopeZoom: fit.zoom,
      core: (window as any).MAPV.manifest.defaultView };
  });
  expect(view.core.buildings).toEqual(expect.arrayContaining(['bld-it', 'bld-ep']));
  expect(view.pitch).toBeCloseTo(45, 0);
  const inView = (c: { lng: number; lat: number }, v: any) => c.lng >= v.w && c.lng <= v.e && c.lat >= v.s && c.lat <= v.n;
  for (const bid of ['bld-it', 'bld-ep', 'bld-fh', 'bld-wr']) expect(inView(centerOf(bid), view), bid).toBe(true);
  // the far end of campus (the Animal Health Technology Center, about 1.6 km west) is not in the opening view
  const far = centerOf('bld-cp');
  expect(inView(far, view)).toBe(false);
  // the opening view is the core, not the 2.7 km envelope: at least a zoom level closer than fitting the envelope
  expect(view.zoom - view.envelopeZoom).toBeGreaterThan(1);
  // zoomed all the way out the view spans the campus scale (km, not the core's few hundred m), and maxBounds is the
  // envelope, so the far end is in reach (on a portrait phone by a pan as well)
  const out = await page.evaluate((c) => {
    const m = (window as any).MAPV.map;
    m.jumpTo({ zoom: m.getMinZoom(), pitch: 0, bearing: 0 });
    const b = m.getBounds();
    const wide = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
    m.jumpTo({ center: [c.lng, c.lat] });
    const p = m.getBounds();
    return { wide, panned: { w: p.getWest(), s: p.getSouth(), e: p.getEast(), n: p.getNorth() } };
  }, far);
  expect(meters({ lng: out.wide.w, lat: out.wide.s }, { lng: out.wide.e, lat: out.wide.s })).toBeGreaterThan(1800);
  expect(inView(far, out.panned), JSON.stringify(out.panned)).toBe(true);
});

test('search flies the map to a building, and a room opens its floor in the building view', async ({ page }) => {
  await boot(page);
  await mapReady(page);
  await search(page, 'Engineering and Physics', 'Engineering and Physics Building');
  await expect(page.locator('#building-sheet-title')).toHaveText('Engineering and Physics Building');
  await expect.poll(async () => (await mapState(page)).moving, { timeout: 5000 }).toBe(false);
  const s = await mapState(page);
  expect(meters(s.center, EP_CENTER)).toBeLessThan(40);
  expect(s.zoom).toBeGreaterThan(17.5);

  await search(page, 'IT 241', 'IT 241');
  await expect(page.locator('#bview-bar')).toBeVisible();
  await expect(page.locator('#bview-bar [aria-checked="true"]')).toHaveText('Second Floor');
  await expect(page.locator('#building-sheet-title')).toHaveText('IT 241');
  await expect.poll(() => page.evaluate(() => (window as any).MAPV.map.queryRenderedFeatures({ layers: ['indoor-room-selected'] }).length)).toBeGreaterThan(0);
  await page.locator('#map-room-plan').click();
  await expect(page.locator('#room-sheet-title')).toHaveText('IT 241');
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('Second Floor');
});

test('building view: IT\'s real floors stacked, the floor chip switches the active floor, then the floor plan', async ({ page }) => {
  await boot(page);
  await mapReady(page);
  await search(page, 'Collins Industry', 'Collins Industry and Technology Center');
  await page.locator('#building-sheet [data-inside]').click();
  const bar = page.locator('#bview-bar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('[aria-checked="true"]')).toHaveText('First Floor');
  const count = (layer: string) => page.evaluate((l) => (window as any).MAPV.map.querySourceFeatures('indoor', { filter: ['==', ['get', 'role'], l] }).length, layer);
  await expect.poll(() => count('room')).toBeGreaterThan(100);
  await bar.getByRole('radio', { name: 'Second Floor' }).click();
  await expect(bar.locator('[aria-checked="true"]')).toHaveText('Second Floor');
  const activeFloors = () => page.evaluate(() => Array.from(new Set((window as any).MAPV.map.querySourceFeatures('indoor', {
    filter: ['all', ['==', ['get', 'role'], 'room'], ['==', ['get', 'active'], true]] }).map((f: any) => f.properties.floorId))));
  await expect.poll(activeFloors).toEqual(['floor-it-2']);
  await page.locator('#bview-open').click();
  await expect(page.locator('#view-indoor')).toBeVisible();
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('Second Floor');
});

test('one route door to room: map walk, the door hands off to the floor plan, stairs, arrival; back to the map when leaving', async ({ page }) => {
  await boot(page);
  await mapReady(page);
  await search(page, 'IT 241', 'IT 241');
  await page.locator('#map-room-nav').click();
  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('From the building entrance'); // no position yet: v3's indoor start
  await panel.locator('#route-from').selectOption('b:bld-ep');
  await expect(panel).toContainText('From Engineering and Physics Building');
  await expect(step(page)).toHaveAttribute('data-step-kind', 'outdoor');
  await expect(step(page).locator('.title')).toHaveText(/^Walk to the .+ of Collins Industry and Technology Center$/);
  await expect(page.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#map-canvas')).not.toHaveAttribute('data-route-lines', '0');
  await expect(panel.locator('#route-sentence')).toHaveText(/^Walk \d+ m along the path, enter by the .+, take the stairs up to Second Floor, arrive at IT 241\.$/);
  await expect(panel.locator('#route-campus')).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);

  await page.locator('#route-next').click();
  await expect(step(page)).toHaveAttribute('data-step-kind', 'door');
  await expect(page.getByRole('tab', { name: 'Indoor' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('First Floor');
  await expect(page.locator('#viewer .fv-marker--door')).toHaveCount(1);

  await page.locator('#route-next').click();
  await expect(step(page).locator('.title')).toHaveText('Take the stairs up to Second Floor');
  await page.locator('#route-next').click();
  await expect(step(page).locator('.title')).toHaveText('Arrive at IT 241');
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('Second Floor');

  // and back the other way: leaving IT for EP returns to the map at the door
  await page.locator('#route-close').click();
  await search(page, 'EP 1332', 'EP 1332');
  await page.locator('#room-sheet').getByRole('button', { name: 'Navigate here' }).click();
  await panel.locator('#route-from').selectOption('b:bld-it');
  await expect(page.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
  await expect(step(page)).toHaveAttribute('data-step-kind', 'outdoor');
});

test('"Avoid stairs" applies outdoors: a steps shortcut gives way to the step-free walk', async ({ page }) => {
  const routeItToEp1332 = async () => {
    await boot(page);
    await mapReady(page);
    await search(page, 'EP 1332', 'EP 1332');
    await page.locator('#map-room-nav').click();
    await page.locator('#route-panel #route-from').selectOption('b:bld-it');
    await expect(page.locator('#route-panel #route-step')).toBeVisible();
  };
  // 1. the real walk: find where it detours most between two of its path nodes
  await routeItToEp1332();
  const pick = await page.evaluate(() => {
    const G = (window as any).MSCNGeo;
    const g = (window as any).APP.graph;
    const s = (window as any).NAV.route.steps.find((x: any) => x.kind === 'outdoor');
    const ids = s.nodeIds.filter((id: string) => g.nodes[id] && g.nodes[id].outdoor);
    const ll = (id: string) => [g.nodes[id].lng, g.nodes[id].lat];
    const cum = [0];
    for (let i = 1; i < ids.length; i++) cum.push(cum[i - 1] + G.haversine(ll(ids[i - 1]), ll(ids[i])));
    let best: any = null;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 2; j < ids.length; j++) {
        const crow = G.haversine(ll(ids[i]), ll(ids[j]));
        if (!best || cum[j] - cum[i] - crow > best.detour) best = { from: ids[i], to: ids[j], distance: crow, detour: cum[j] - cum[i] - crow };
      }
    }
    return best;
  });
  expect(pick.detour).toBeGreaterThan(3);
  // 2. serve the outdoor graph with a steps edge across that detour
  const graph = JSON.parse(JSON.stringify(GRAPH));
  graph.edges.push({ id: 'e2e-steps', from: pick.from, to: pick.to, distance: Math.round(pick.distance * 10) / 10, accessible: false, kind: 'steps' });
  await page.route('**/data/campus-map/outdoor-graph.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(graph) }));
  await routeItToEp1332();
  const panel = page.locator('#route-panel');
  const outdoorStep = () => page.evaluate(() => {
    const s = (window as any).NAV.route.steps.find((x: any) => x.kind === 'outdoor');
    return { steps: !!s.steps, detail: s.detail, meters: (window as any).NAV.route.meters };
  });
  await expect.poll(async () => (await outdoorStep()).steps).toBe(true);
  const withSteps = await outdoorStep();
  expect(withSteps.detail).toContain('including steps');
  await panel.locator('label.switch').click();
  await expect.poll(async () => (await outdoorStep()).steps).toBe(false);
  const flat = await outdoorStep();
  expect(flat.detail).not.toContain('including steps');
  expect(flat.meters).toBeGreaterThan(withSteps.meters);
});

test.describe('GPS', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: FAR.lat, longitude: FAR.lng, accuracy: 8 } });

  test('blue dot on the path; a route starts at it, re-routes off the path, and hands off at the door', async ({ page, context }) => {
    await boot(page);
    await mapReady(page);
    await page.locator('#map-locate').click();
    await expect(page.locator('#map-canvas')).toHaveAttribute('data-gps', 'dot');
    await expect(page.locator('#map-locate')).toHaveAttribute('data-gps-state', 'on');
    expect(await page.evaluate(() => (window as any).GPS.fix.snapped)).toBe(true);

    await search(page, 'IT 241', 'IT 241');
    await page.locator('#map-room-nav').click();
    const panel = page.locator('#route-panel');
    await expect(panel).toContainText('From your location');
    await expect(step(page)).toHaveAttribute('data-step-kind', 'outdoor');
    expect(await page.evaluate(() => !!(window as any).NAV.route.lead)).toBe(true);

    // about 60 m off the route line, twice, a few seconds apart: a new route from there (the spot is chosen in the page,
    // around the far corner, as the one farthest from the walk's line)
    const offLL = await page.evaluate(() => {
      const G = (window as any).MSCNGeo;
      const r = (window as any).NAV.route;
      const line = (r.lead ? [r.lead[1]] : []).concat(r.steps[0].coords);
      const o = G.local(line[0]);
      let best: any = null;
      for (let a = 0; a < 360; a += 30) {
        const p = o.toLngLat(60 * Math.sin((a * Math.PI) / 180), 60 * Math.cos((a * Math.PI) / 180));
        const d = G.distanceToLine(p, line);
        if (!best || d > best.d) best = { p, d };
      }
      return best;
    });
    expect(offLL.d).toBeGreaterThan(30);
    const off = { latitude: offLL.p[1], longitude: offLL.p[0], accuracy: 6 };
    await context.setGeolocation(off);
    await page.waitForTimeout(3300);
    await context.setGeolocation({ ...off, latitude: off.latitude + 0.00001 });
    await expect.poll(() => page.evaluate(() => (window as any).NAV.reroutes)).toBeGreaterThan(0);

    // standing at the door of the walk: the floor plan takes over
    const door = await page.evaluate(() => { const s = (window as any).NAV.route.steps[0]; return s.coords[s.coords.length - 1]; });
    await context.setGeolocation({ latitude: door[1], longitude: door[0], accuracy: 5 });
    await expect(step(page)).toHaveAttribute('data-step-kind', 'door');
    await expect(page.getByRole('tab', { name: 'Indoor' })).toHaveAttribute('aria-selected', 'true');
  });

  test('indoors the app asks for a QR code instead of trusting GPS', async ({ page, context }) => {
    await context.setGeolocation({ latitude: EP_CENTER.lat, longitude: EP_CENTER.lng, accuracy: 20 }); // inside EP's footprint
    await boot(page);
    await mapReady(page);
    await page.locator('#map-locate').click();
    await expect(page.locator('#map-status')).toContainText('scan a nearby campus QR code');
    await expect(page.locator('#map-locate')).toHaveAttribute('data-gps-state', 'indoors');
  });
});

test('GPS denied: a clear message, and routes still start from a chosen building', async ({ page }) => {
  await page.addInitScript(() => {
    (navigator as any).geolocation.watchPosition = (_ok: any, err: any) => { setTimeout(() => err({ code: 1, message: 'denied' }), 10); return 1; };
  });
  await boot(page);
  await mapReady(page);
  await page.locator('#map-locate').click();
  await expect(page.locator('#map-status')).toContainText('Location is off for this site');
  await search(page, 'IT 241', 'IT 241');
  await page.locator('#map-room-nav').click();
  await page.locator('#route-panel #route-from').selectOption('gps');
  await expect(page.locator('#route-panel')).toContainText('Location is off for this site');
  await page.locator('#route-panel #route-from').selectOption('b:bld-ep');
  await expect(step(page)).toHaveAttribute('data-step-kind', 'outdoor');
});

test('"Directions to campus" opens Apple Maps on an iPhone', async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await boot(page);
  await mapReady(page);
  await search(page, 'Collins Industry', 'Collins Industry and Technology Center');
  await expect(page.locator('#building-sheet a[data-directions]')).toHaveAttribute('href', /^https:\/\/maps\.apple\.com\/\?daddr=36\.61\d+%2C-88\.32\d+$/);
  await ctx.close();
});

test('the floor plan wears the app\'s colors: no white paper, fills by room type, surface background', async ({ page }) => {
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await expect(page.locator('#viewer svg.fv-svg')).toBeVisible();
  const s = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    const wrap = getComputedStyle(document.getElementById('viewer-wrap')!).backgroundColor;
    const bg = getComputedStyle(document.querySelector('#viewer [id="background"]')!).fill;
    const corridor = getComputedStyle(document.querySelector('#viewer [data-room-type="corridor"]')!).fill;
    const probe = document.createElement('div');
    probe.style.color = v('--surface');
    document.body.appendChild(probe);
    const surface = getComputedStyle(probe).color;
    probe.style.color = v('--room-type-corridor');
    const corridorToken = getComputedStyle(probe).color;
    probe.remove();
    return { wrap, surface, bg, corridor, corridorToken, paper: document.querySelectorAll('#viewer .fv-paper').length };
  });
  expect(s.wrap).toBe(s.surface);
  expect(s.bg).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
  expect(s.corridor).toBe(s.corridorToken);
  expect(s.paper).toBe(0);
});

test.describe('offline', () => {
  test.use({ serviceWorkers: 'allow' });

  test('after the first visit the app, data, floor plans and campus map load with no network', async ({ page, context }) => {
    await boot(page);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(async () => {
      const keys = await caches.keys();
      const c = keys.find((k) => k.indexOf('mscn-precache-') === 0);
      return c ? (await (await caches.open(c)).keys()).length : 0;
    }), { timeout: 30_000 }).toBeGreaterThan(15);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#loading-screen')).toBeHidden();
    await mapReady(page);
    expect(await page.evaluate(() => (window as any).MAPV.map.queryRenderedFeatures({ layers: ['buildings-3d'] }).length)).toBeGreaterThan(3);
    await page.getByRole('tab', { name: 'Indoor' }).click();
    await page.locator('#building-select').selectOption('bld-ep');
    await expect(page.locator('#viewer svg.fv-svg')).toBeVisible();
    await expect(page.locator('#viewer [data-mscn-room]').first()).toBeAttached();
    await context.setOffline(false);
  });
});
