// The site build: the include resolver (scripts/build/render-page.mjs) and the build's checks
// (scripts/build/build-site.mjs): config (no map key), vendored MapLibre, the campus-map copy and manifest, the service
// worker (scripts/build/service-worker.mjs), root-relative URL guard, 404 page, schedules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { renderPage } from '../../scripts/build/render-page.mjs';
import {
  copyCampusMap, findRootRelativeUrls, loadBuildConfig, MAPLIBRE_FILES, maplibreDir, notFoundPage, siteConfig, validateLinks, validateSchedule,
} from '../../scripts/build/build-site.mjs';
import { AERIAL_MAX_TILES, buildHash, precacheEntries, serviceWorkerSource } from '../../scripts/build/service-worker.mjs';
import { ROOT, SRC } from './load-include.mjs';

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mscn-render-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name + '.html'), body);
  return dir;
}

test('renderPage inlines nested includes and strips comments', () => {
  const dir = fixtureDir({
    Page: '<head><?!= include(\'Styles\') ?></head><body><!-- note --><?!= include("Part") ?></body>',
    Styles: '<style>a{}</style>',
    Part: '<p>part</p><?!= include(\'Leaf\') ?>',
    Leaf: '<i>leaf</i>',
  });
  assert.equal(renderPage(dir, 'Page'), '<head><style>a{}</style></head><body><p>part</p><i>leaf</i></body>');
});

test('renderPage refuses leftover scriptlets, cycles, missing and unsafe includes', () => {
  const dir = fixtureDir({
    Code: '<p><? var x = 1; ?></p>',
    Print: '<p><?= ScriptApp.getService().getUrl(); ?></p>',
    A: '<?!= include(\'B\') ?>',
    B: '<?!= include(\'A\') ?>',
    Missing: '<?!= include(\'Nope\') ?>',
  });
  assert.throws(() => renderPage(dir, 'Code'), /unhandled scriptlet in Code/);
  assert.throws(() => renderPage(dir, 'Print'), /unhandled scriptlet in Print/);
  assert.throws(() => renderPage(dir, 'A'), /include cycle: A -> B -> A/);
  assert.throws(() => renderPage(dir, 'Missing'), /include not found: Nope/);
  assert.throws(() => renderPage(dir, '../Code'), /invalid include name/);
});

test('the real web app renders to one static page: every module inlined, no scriptlet, no root-relative URL, scripts parse', () => {
  const html = renderPage(SRC, 'WebApp');
  assert.equal(/<\?/.test(html), false);
  const modules = readdirSync(SRC).filter((f) => /^WebApp_.*\.html$/.test(f));
  assert.ok(modules.length >= 11);
  for (const m of modules) {
    const first = readFileSync(join(SRC, m), 'utf8').split('\n').find((l) => l.trim() && !/^<(script|style)>$/.test(l.trim()));
    assert.ok(html.includes(first.trim()), `${m} is inlined`);
  }
  assert.deepEqual(findRootRelativeUrls(html), []);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.doesNotThrow(() => new vm.Script(scripts.join('\n;\n')));
});

test('root-relative URL guard: catches /data, src="/x", fetch("/x"); allows relative and protocol-relative', () => {
  assert.deepEqual(findRootRelativeUrls('<img src="/logo.png"><a href=\'/x\'>'), ['src="/logo.png"', 'href=\'/x\'']);
  assert.equal(findRootRelativeUrls("fetch('/api/x')").length, 1);
  assert.equal(findRootRelativeUrls("var u = '/data/campus.json';").length, 1);
  assert.deepEqual(findRootRelativeUrls('<script src="https://cdn.example/x.js"></script><a href="//cdn.example/y">' +
    "<link href=\"data/x\"> var u = 'data/campus.json'; var r = /^\\/x/;"), []);
});

test('build config: base path shape, domain implies root base, analytics passthrough', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mscn-cfg-'));
  const write = (o) => { const p = join(dir, 'c.json'); writeFileSync(p, JSON.stringify(o)); return p; };
  assert.deepEqual(loadBuildConfig(write({ basePath: '/campus-nav/', analytics: { site: ' msu ' } })),
    { basePath: '/campus-nav/', domain: '', siteUrl: '', analytics: { provider: 'goatcounter', site: 'msu' } });
  assert.equal(loadBuildConfig(write({ basePath: '/campus-nav/', domain: 'Nav.Example.org' })).basePath, '/');
  assert.equal(loadBuildConfig(write({ domain: 'nav.example.org' })).domain, 'nav.example.org');
  assert.throws(() => loadBuildConfig(write({ basePath: 'campus-nav' })), /basePath/);
  assert.throws(() => loadBuildConfig(write({ domain: 'https://nav.example.org' })), /domain/);
  assert.equal(loadBuildConfig(join(dir, 'absent.json')).basePath, '/');
  const committed = loadBuildConfig(join(ROOT, 'build.config.json'));
  assert.equal(committed.basePath, '/campus-nav/');
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'build.config.json'), 'utf8'))).includes('mapsApiKey'), false,
    'the committed config never carries a key');
});

test('config.json carries no map key of any kind (v4: MapLibre on committed data)', () => {
  const cfg = { basePath: '/campus-nav/', domain: '', analytics: { provider: 'goatcounter', site: '' } };
  assert.deepEqual(Object.keys(siteConfig(cfg)), ['analytics', 'basePath', 'domain']);
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.equal(/MAPS_API_KEY/.test(workflow), false, 'the deploy workflow no longer references a Maps secret');
});

test('MapLibre is vendored from node_modules (no CDN): the four browser files exist', () => {
  const dir = maplibreDir();
  for (const f of MAPLIBRE_FILES) assert.ok(readFileSync(join(dir, f)).length > 1000, f);
  const page = renderPage(SRC, 'WebApp');
  assert.match(page, /<link rel="stylesheet" href="vendor\/maplibre-gl\.css">/);
  assert.match(page, /<script type="module" src="vendor\/modules\.mjs"><\/script>/);
  assert.equal(/unpkg\.com\/maplibre|cdn\.jsdelivr\.net\/npm\/maplibre|maps\.googleapis/.test(page), false);
});

test('copyCampusMap: the fixture campus map lands under data/ with a manifest of what exists', () => {
  const out = mkdtempSync(join(tmpdir(), 'mscn-map-'));
  const m = copyCampusMap(join(ROOT, 'tests', 'fixtures', 'campus-map'), out);
  assert.equal(m.buildings, 'data/campus-map/buildings.geojson');
  assert.deepEqual(m.basemap, ['data/campus-map/basemap.geojson']);
  assert.equal(m.outdoorGraph, 'data/campus-map/outdoor-graph.json');
  assert.equal(m.aerial, null);
  assert.deepEqual(Object.keys(m.georef).sort(), ['bld-ep', 'bld-it']);
  assert.equal(m.georefModule, true);
  assert.equal(m.fixture, true);
  for (const p of [m.buildings, m.outdoorGraph, 'data/georef/bld-it.json', 'vendor/georef.mjs']) assert.ok(readFileSync(join(out, p)).length > 10, p);
  // an empty root is valid: nothing is published and the app falls back to its building list
  const empty = copyCampusMap(mkdtempSync(join(tmpdir(), 'mscn-none-')), mkdtempSync(join(tmpdir(), 'mscn-out-')));
  assert.deepEqual(empty, { buildings: null, basemap: [], outdoorGraph: null, aerial: null, georef: {}, georefModule: false, fixture: false });
});

test('service worker: precache manifest hashes every published file except sw.js, 404, CNAME, maps and aerial tiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mscn-sw-'));
  const put = (rel, body) => { const p = join(dir, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };
  put('index.html', '<html></html>');
  put('data/campus.json', '{}');
  put('floors/floor-a.svg', '<svg/>');
  put('vendor/maplibre-gl.mjs', 'export {}');
  put('vendor/maplibre-gl.mjs.map', '{}');
  put('data/campus-map/aerial/17/1/2.jpg', 'jpg');
  put('sw.js', 'old');
  put('404.html', 'x');
  put('CNAME', 'x');
  const entries = precacheEntries(dir);
  assert.deepEqual(entries.map((e) => e.url), ['data/campus.json', 'floors/floor-a.svg', 'index.html', 'vendor/maplibre-gl.mjs']);
  assert.ok(entries.every((e) => /^[0-9a-f]{12}$/.test(e.hash) && e.bytes > 0));
  const src = serviceWorkerSource({ version: 'v123', entries });
  assert.doesNotThrow(() => new vm.Script(src));
  assert.match(src, /var DATA_VERSION = "v123";/);
  assert.match(src, /"floors\/floor-a\.svg"/);
  assert.equal(src.includes('aerial/17'), false);
  // a changed file changes the build id, which is what makes browsers install the new worker
  const before = buildHash(entries);
  put('data/campus.json', '{"changed":true}');
  assert.notEqual(buildHash(precacheEntries(dir)), before);
  assert.equal(AERIAL_MAX_TILES > 0, true);
});

test('service worker: install precaches, fetch serves cache-first offline, version.json goes to the network first', async () => {
  const entries = [{ url: 'index.html', hash: 'a', bytes: 1 }, { url: 'data/campus.json', hash: 'b', bytes: 1 }];
  const src = serviceWorkerSource({ version: 'v1', entries });
  const store = new Map();
  const cache = {
    addAll: async (reqs) => { for (const r of reqs) store.set(r.url, 'cached:' + r.url); },
    match: async (req, o) => { const u = new URL(req.url); if (o && o.ignoreSearch) u.search = ''; return store.get(u.href) || null; },
    put: async () => {}, keys: async () => [],
  };
  const listeners = {};
  let online = false;
  const ctx = {
    URL, Request: class { constructor(url, o) { this.url = String(url); this.mode = (o && o.mode) || 'cors'; this.method = 'GET'; } },
    Promise, caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async (r) => { if (!online) throw new Error('offline'); return 'net:' + r.url; },
    self: { registration: { scope: 'https://example.org/campus-nav/' }, addEventListener: (t, f) => { listeners[t] = f; }, clients: { claim: async () => {} }, skipWaiting() {} },
  };
  vm.runInNewContext(src, ctx);
  let done;
  listeners.install({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepEqual([...store.keys()], ['https://example.org/campus-nav/index.html', 'https://example.org/campus-nav/data/campus.json']);
  const fetchOf = async (url, mode) => {
    let res;
    listeners.fetch({ request: new ctx.Request(url, { mode }), respondWith: (p) => { res = p; } });
    return res;
  };
  assert.equal(await fetchOf('https://example.org/campus-nav/?room=x', 'navigate'), 'cached:https://example.org/campus-nav/index.html');
  assert.equal(await fetchOf('https://example.org/campus-nav/data/campus.json?v=v1'), 'cached:https://example.org/campus-nav/data/campus.json');
  online = true;
  assert.equal(await fetchOf('https://example.org/campus-nav/data/campus.json?v=v2'), 'net:https://example.org/campus-nav/data/campus.json?v=v2');
  assert.equal(await fetchOf('https://example.org/campus-nav/data/version.json'), 'net:https://example.org/campus-nav/data/version.json');
  assert.equal(await fetchOf('https://other.example/x.js'), undefined, 'foreign requests are not handled');
});

test('404.html sends any deep path back to the base with the query kept', () => {
  const html = notFoundPage('/campus-nav/');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const run = (href) => {
    const u = new URL(href);
    let to = null;
    vm.runInNewContext(code, { window: { location: { pathname: u.pathname, search: u.search, hash: u.hash, hostname: u.hostname, replace: (x) => { to = x; } } } });
    return to;
  };
  assert.equal(run('https://bharrison6.github.io/campus-nav/old/path?room=room-it-1-0141&nav=1'), '/campus-nav/?room=room-it-1-0141&nav=1');
  assert.equal(run('https://bharrison6.github.io/campus-nav/x#h'), '/campus-nav/#h');
  // served from another base (a renamed repository) on github.io: the first path segment is the site
  assert.equal(run('https://bharrison6.github.io/other-name/deep?sched=eday'), '/other-name/?sched=eday');
  assert.equal(run('https://nav.example.org/deep?sched=eday'), '/?sched=eday');
});

const campus = {
  buildings: [{ id: 'bld-it' }, { id: 'bld-ep' }],
  floors: [{ id: 'floor-it-1', buildingId: 'bld-it', public: true }, { id: 'floor-it-3', buildingId: 'bld-it', public: false }],
  rooms: [{ id: 'room-it-1-0141', floorId: 'floor-it-1' }, { id: 'room-it-3-0301', floorId: 'floor-it-3' }],
};
const links = { prog: { title: 'Program', url: 'https://example.org/p.pdf' } };

test('schedule checks: a good schedule passes; bad ids, times, rooms, hidden floors and links are named', () => {
  const good = { id: 'eday', title: 'E-Day', date: '2026-11-07', events: [
    { time: '09:00', title: 'Welcome', buildingId: 'bld-it', roomId: 'room-it-1-0141', links: ['prog'] },
    { time: '12:00', title: 'Lunch', buildingId: 'bld-ep' },
  ] };
  assert.deepEqual(validateSchedule(good, 'eday', campus, links), []);
  const bad = { id: 'other', title: '', date: '11/07/2026', events: [
    { time: '9:00', title: 'x', buildingId: 'bld-zz' },
    { time: '10:00', title: 'y', buildingId: 'bld-it', roomId: 'room-it-3-0301' },
    { time: '11:00', title: 'z', buildingId: 'bld-ep', roomId: 'room-it-1-0141', links: ['nope'] },
  ] };
  const errs = validateSchedule(bad, 'eday', campus, links).join('\n');
  for (const want of [/id "other" must match/, /title is required/, /date must be YYYY-MM-DD/, /event 1: time must be HH:MM/,
    /event 1: unknown buildingId "bld-zz"/, /event 2: room room-it-3-0301 is on a floor that is not public/,
    /event 3: room room-it-1-0141 is in bld-it, not bld-ep/, /event 3: link id "nope"/]) {
    assert.match(errs, want);
  }
  assert.deepEqual(validateLinks(links), []);
  assert.equal(validateLinks({ x: { title: 'X', url: 'javascript:alert(1)' } }).length, 1);
});

test('the committed sample schedule and links are well formed', () => {
  const sched = JSON.parse(readFileSync(join(ROOT, 'data', 'schedules', 'eday-sample.json'), 'utf8'));
  const l = JSON.parse(readFileSync(join(ROOT, 'data', 'links.json'), 'utf8'));
  assert.deepEqual(validateLinks(l), []);
  assert.equal(sched.id, 'eday-sample');
  for (const ev of sched.events) for (const id of ev.links || []) assert.ok(l[id], id);
});
