// The local admin (tools/admin): the page, the server's calls, and that every write lands in the overrides files
// and shows up in the next export (plan acceptance 4).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { READ_FNS, SERVER_FNS, createAdmin, isWriteFn, mapInputsOf, resolveSiteUrl } from '../../tools/admin/server.mjs';
import { writeFileAtomic, writeOverrides } from '../../scripts/data/campus-engine.mjs';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = fs.readFileSync(path.join(here, '..', '..', 'tools', 'admin', 'Admin.html'), 'utf8');
// A synthetic private location (the real hidden floors live outside the repository): one made-up hidden floor.
const PRIVATE = path.join(here, 'fixtures', 'private');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-admin-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = path.join(tmp, `o${++n}`);
  fs.mkdirSync(d);
  return d;
};
const readOv = (dir, c) => JSON.parse(fs.readFileSync(path.join(dir, `${c}.json`), 'utf8'));
const quiet = () => {};

test('the page: no PIN gate, no Import tab, no Apps Script scriptlet, no key literal, no Google Maps; its scripts parse', () => {
  assert.ok(!/pin-gate|adminPin|verifyAdminPin|changeAdminPin|setMapsApiKey|importFloorData|reseedCampusData|data-tab="import"/.test(ADMIN_HTML));
  assert.ok(!/<\?/.test(ADMIN_HTML), 'no Apps Script template scriptlets');
  assert.ok(ADMIN_HTML.includes('data-app-url="__MSCN_SITE_URL__"'));
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(ADMIN_HTML));
  assert.ok(!/maps\.googleapis|maps\.google\.com|google\.maps|mapsApiKey/.test(ADMIN_HTML), 'no Google Maps loader in the Buildings tab');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let scripts = 0;
  while ((m = re.exec(ADMIN_HTML))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    assert.doesNotThrow(() => new vm.Script(m[2], { filename: 'Admin.html' }));
    scripts++;
  }
  assert.ok(scripts >= 1);
});

test('every server function the page calls is one the admin answers', () => {
  const admin = createAdmin({ overridesDir: freshDir(), log: quiet });
  const chained = [...ADMIN_HTML.matchAll(/^\s*\.([a-zA-Z]+)\(/gm)].map((x) => x[1]).filter((x) => !/^with/.test(x));
  const viaRunServer = [...ADMIN_HTML.matchAll(/runServer\('([A-Za-z]+)'/g)].map((x) => x[1]);
  const called = [...new Set([...chained, ...viaRunServer])].sort();
  assert.ok(called.length >= 20, `found ${called.length} calls`);
  for (const fn of called) {
    const ok = READ_FNS.includes(fn) || SERVER_FNS.includes(fn) || (isWriteFn(fn) && typeof admin.campus().gas.ctx[fn] === 'function');
    assert.ok(ok, `Admin.html calls ${fn}, which the local admin does not answer`);
  }
});

test('writes land in data/overrides as the difference from the seed and pipeline data, and the export shows them', () => {
  const dir = freshDir();
  const admin = createAdmin({ overridesDir: dir, log: quiet, privateDir: PRIVATE });
  admin.call('updateRoom', [{ id: 'room-it-1-0141', label: 'Dean of Engineering' }]);
  assert.deepEqual(readOv(dir, 'rooms'), [{ id: 'room-it-1-0141', label: 'Dean of Engineering' }]);
  for (const c of ['buildings', 'floors', 'navNodes', 'navEdges', 'photos', 'qrLocations', 'config']) assert.deepEqual(readOv(dir, c), [], c);

  const qr = admin.call('saveQrLocation', [{ buildingId: 'bld-it', floorId: 'floor-it-1', nodeId: 'it-1-n0490', description: 'Main lobby', permanent: true }]);
  const q = readOv(dir, 'qrLocations');
  assert.equal(q.length, 1);
  assert.equal(q[0].id, qr.id);
  assert.equal(q[0]._new, true);
  assert.equal(q[0].description, 'Main lobby');

  // A node delete cascades to its edges: the node and each edge become _delete records.
  const node = admin.call('getAllCampusData', []).navNodes.find((x) => x.floorId === 'floor-it-9');
  const touching = admin.call('getAllCampusData', []).navEdges.filter((e) => e.fromNodeId === node.id || e.toNodeId === node.id);
  const res = admin.call('deleteNavNode', [{ id: node.id }]);
  assert.equal(res.edgesRemoved, touching.length);
  assert.deepEqual(readOv(dir, 'navNodes'), [{ id: node.id, _delete: true }]);
  assert.deepEqual(readOv(dir, 'navEdges').map((e) => e.id).sort(), touching.map((e) => e.id).sort());

  // A restart (a new admin over the same files) and the export both see the edits.
  const again = createAdmin({ overridesDir: dir, log: quiet, privateDir: PRIVATE });
  const data = again.call('getAllCampusData', []);
  assert.equal(data.rooms.find((r) => r.id === 'room-it-1-0141').label, 'Dean of Engineering');
  assert.equal(data.navNodes.find((x) => x.id === node.id), undefined);
  const x = buildExport({ overridesDir: dir, privateDir: PRIVATE });
  assert.equal(x.campus.rooms.find((r) => r.id === 'room-it-1-0141').label, 'Dean of Engineering');
  assert.deepEqual(x.campus.qrLocations.map((r) => r.id), [qr.id]);
  assert.deepEqual(x.report.orphans, []);

  // Setting the field back to the pipeline's value in the admin removes the edit from the file again.
  const base = buildExport({ overridesDir: freshDir() }).campus.rooms.find((r) => r.id === 'room-it-1-0141').label;
  again.call('updateRoom', [{ id: 'room-it-1-0141', label: base }]);
  assert.deepEqual(readOv(dir, 'rooms'), []);
});

test('the admin shows the hidden floors from the private location when it exists and works without them', () => {
  const bare = createAdmin({ overridesDir: freshDir(), log: quiet, privateDir: path.join(tmp, 'no-such-private-dir') });
  assert.equal(bare.campus().hiddenFloorsLoaded, false);
  assert.deepEqual(bare.call('getAllCampusData', []).floors.filter((f) => f.public === false), []);
  const admin = createAdmin({ overridesDir: freshDir(), log: quiet, privateDir: PRIVATE });
  assert.equal(admin.campus().hiddenFloorsLoaded, true);
  assert.deepEqual(admin.call('getAllCampusData', []).floors.filter((f) => f.public === false).map((f) => f.id), ['floor-it-9']);
  assert.match(admin.call('getFloorPlanSvg', ['floor-it-9']), /data-floor-id="floor-it-9"/);
  // The public data the save check builds is the same either way.
  assert.deepEqual(admin.call('checkConnectivityNow', []), bare.call('checkConnectivityNow', []));
});

test('a save that changes an entrance class, levels or height reruns the campus-map build in the background; others do not', async () => {
  const runs = [];
  const logs = [];
  let release;
  const admin = createAdmin({ overridesDir: freshDir(), log: (l) => logs.push(l),
    rebuildMap: () => { runs.push(Date.now()); return new Promise((ok) => { release = () => ok('no changes'); }); } });
  admin.call('updateRoom', [{ id: 'room-it-1-0141', label: 'Dean of Engineering' }]);
  assert.equal(runs.length, 0, 'a room label is not a campus-map input');
  admin.call('updateNavNode', [{ id: 'ep-1-n0356', access: 'main' }]);
  assert.equal(runs.length, 1, 'an entrance class is');
  assert.equal(admin.status().mapRebuild.running, true);
  admin.call('updateBuilding', [{ id: 'bld-it', levels: 4 }]);
  assert.equal(runs.length, 1, 'a save during a run queues one more run instead of a parallel one');
  release();
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(runs.length, 2, 'the queued run starts when the first settles');
  release();
  await admin.mapRebuildIdle();
  const st = admin.status().mapRebuild;
  assert.equal(st.running, false);
  assert.equal(st.last.ok, true);
  assert.ok(st.last.ms >= 0);
  assert.ok(logs.some((l) => /campus map rebuilt in \d+\.\d s: no changes/.test(l)), logs.join(' | '));
  // a failing build is reported, not thrown at the editor
  const bad = createAdmin({ overridesDir: freshDir(), log: quiet, rebuildMap: () => Promise.reject(new Error('boom')) });
  bad.call('updateBuilding', [{ id: 'bld-ep', height: 21 }]);
  await bad.mapRebuildIdle();
  assert.deepEqual([bad.status().mapRebuild.last.ok, bad.status().mapRebuild.last.error], [false, 'boom']);
  // the inputs string sees exactly those fields
  const d = { navNodes: [{ id: 'a', type: 'entrance', floorId: 'f', x: 1, y: 2, access: 'alt', label: 'ignored' }, { id: 'b', type: 'room', access: 'main' }], buildings: [{ id: 'x', levels: 3, height: '' }] };
  assert.equal(mapInputsOf(d), JSON.stringify([[['a', 'f', 1, 2, 'alt']], [['x', '3', '']]]));
});

test('the admin rebuilds the map only for the repository overrides by default (npm run campus-map reads data/overrides)', () => {
  const logs = [];
  const admin = createAdmin({ overridesDir: freshDir(), log: (l) => logs.push(l) });
  admin.call('updateBuilding', [{ id: 'bld-it', levels: 4 }]);
  assert.ok(logs.some((l) => /not rebuilt \(overrides outside data\/overrides\)/.test(l)), logs.join(' | '));
  assert.equal(admin.status().mapRebuild.last, null);
});

test('a failed write changes nothing on disk or in memory', () => {
  const dir = freshDir();
  const admin = createAdmin({ overridesDir: dir, log: quiet });
  admin.call('updateRoom', [{ id: 'room-it-1-0141', label: 'kept' }]);
  const before = fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8');
  assert.throws(() => admin.call('updateRoom', [{ id: 'room-nope', label: 'x' }]), /Room not found/);
  assert.throws(() => admin.call('saveRoom', [{ number: '1' }]), /Missing required fields: floorId/);
  assert.equal(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'), before);
  assert.equal(admin.call('getAllCampusData', []).rooms.find((r) => r.id === 'room-it-1-0141').label, 'kept');
});

test('only page functions are callable: helpers, init and unknown names are refused', () => {
  const admin = createAdmin({ overridesDir: freshDir(), log: quiet });
  for (const fn of ['adminOp_', 'initSystem', 'seedAllCampusData', 'doGet', 'eval', 'constructor', 'updateNothing']) {
    assert.throws(() => admin.call(fn, []), /Script function not found/, fn);
  }
});

test('reloadFromDisk picks up a hand-edited overrides file and reports orphans; getAdminStatus counts records', () => {
  const dir = freshDir();
  const admin = createAdmin({ overridesDir: dir, log: quiet });
  admin.call('updateRoom', [{ id: 'room-it-1-0141', label: 'one' }]);
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify([{ id: 'room-it-1-0141', label: 'two' }, { id: 'room-it-1-9999', label: 'gone' }]));
  assert.equal(admin.call('getAllCampusData', []).rooms.find((r) => r.id === 'room-it-1-0141').label, 'one');
  admin.call('reloadFromDisk', []);
  assert.equal(admin.call('getAllCampusData', []).rooms.find((r) => r.id === 'room-it-1-0141').label, 'two');
  const st = admin.call('getAdminStatus', []);
  assert.deepEqual(st.files.find((f) => f.name === 'rooms.json'), { name: 'rooms.json', records: 2 });
  assert.ok(st.report.some((l) => /^ORPHAN rooms room-it-1-9999/.test(l)));
  // The orphan survives the next save untouched.
  admin.call('updateRoom', [{ id: 'room-it-1-0141', label: 'three' }]);
  assert.deepEqual(readOv(dir, 'rooms'), [{ id: 'room-it-1-0141', label: 'three' }, { id: 'room-it-1-9999', label: 'gone' }]);
});

test('site URL for QR codes: MSCN_SITE_URL, else the planned Pages address; always ends with /', () => {
  assert.equal(resolveSiteUrl({ MSCN_SITE_URL: 'https://nav.example.edu' }), 'https://nav.example.edu/');
  assert.match(resolveSiteUrl({}), /^https:\/\/.+\/$/);
});

function request(port, { method = 'GET', pathName = '/', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

test('HTTP: the page and the shim are served; calls run; other hosts, other origins and non-JSON posts are refused', async () => {
  const admin = createAdmin({ overridesDir: freshDir(), env: { MSCN_SITE_URL: 'https://nav.example.edu/' }, log: quiet });
  await new Promise((r) => admin.server.listen(0, '127.0.0.1', r));
  const { port } = admin.server.address();
  try {
    const host = { host: `localhost:${port}` };
    const page = await request(port, { headers: host });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('data-app-url="https://nav.example.edu/"'));
    assert.ok(page.body.includes('<script src="/__admin/gas-client.js"></script>'));
    const shim = await request(port, { pathName: '/__admin/gas-client.js', headers: host });
    assert.equal(shim.status, 200);
    assert.ok(shim.body.includes('/__admin/run/'));
    const json = { ...host, 'content-type': 'application/json' };
    const st = await request(port, { method: 'POST', pathName: '/__admin/run/getAdminStatus', headers: json, body: '[]' });
    assert.equal(JSON.parse(st.body).ok, true);
    const bad = await request(port, { method: 'POST', pathName: '/__admin/run/initSystem', headers: json, body: '[]' });
    assert.deepEqual(JSON.parse(bad.body), { ok: false, error: 'Script function not found: initSystem' });
    assert.equal((await request(port, { headers: { host: 'evil.example:80' } })).status, 403);
    assert.equal((await request(port, { method: 'POST', pathName: '/__admin/run/getAdminStatus', headers: { ...json, origin: 'https://evil.example' }, body: '[]' })).status, 403);
    assert.equal((await request(port, { method: 'POST', pathName: '/__admin/run/getAdminStatus', headers: { ...host, 'content-type': 'text/plain' }, body: '[]' })).status, 415);
  } finally {
    await new Promise((r) => admin.server.close(r));
  }
});

test('backend writes validate access, numbers, polygons and referenced ids before they change anything (review v5, finding 5)', () => {
  const dir = freshDir();
  const admin = createAdmin({ overridesDir: dir, log: quiet });
  const node = () => admin.call('getAllCampusData', []).navNodes.find((x) => x.id === 'ep-1-n0365');
  const before = node();
  const bad = [
    ['updateNavNode', { id: 'ep-1-n0365', access: 'bogus' }, /NavNodes ep-1-n0365: access must be main, alt or emergency \(got "bogus"\)/],
    ['updateNavNode', { id: 'ep-1-n0365', x: 'not-a-number' }, /NavNodes ep-1-n0365: x must be a number/],
    ['updateNavNode', { id: 'ep-1-n0365', floorId: 'floor-none' }, /floorId names no Floors record: floor-none/],
    ['updateRoom', { id: 'room-ep-1-1322', polygon: 'not-json' }, /Rooms room-ep-1-1322: polygon must be JSON/],
    ['updateRoom', { id: 'room-ep-1-1322', access: 'Main' }, /access must be main, alt or emergency/],
    ['saveNavEdge', { fromNodeId: 'ep-1-n0365', toNodeId: 'nope' }, /toNodeId names no NavNodes record: nope/],
    ['saveNavEdge', { fromNodeId: 'ep-1-n0365', toNodeId: 'ep-1-n0365' }, /an edge must join two different nodes/],
    ['saveBatchNavNodes', { floorId: 'floor-ep-1', nodes: [{ x: 1, y: 2 }, { x: 'q', y: 2 }] }, /NavNodes \[1\] nav-\d+: x must be a number/],
    ['updateBuilding', { id: 'bld-it', lng: 500 }, /lng must be from -180 to 180/],
  ];
  for (const [fn, arg, re] of bad) assert.throws(() => admin.call(fn, [arg]), re, fn);
  assert.deepEqual(node(), before, 'nothing changed in memory');
  assert.ok(!fs.existsSync(path.join(dir, 'navNodes.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'navNodes.json'), 'utf8')).length === 0, 'nor on disk');
  assert.equal(admin.call('getAllCampusData', []).navNodes.filter((x) => x.floorId === 'floor-ep-1' && x.x === 1 && x.y === 2).length, 0, 'a batch with one bad row adds none');
  // a numeric string from a form field and a blank (clears) are fine
  admin.call('updateNavNode', [{ id: 'ep-1-n0365', access: 'main', x: String(before.x) }]);
  assert.equal(node().access, 'main');
});

test('override files are written through a temporary sibling and a rename (review v5, finding 8)', () => {
  const dir = freshDir();
  const calls = [];
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  fs.writeFileSync = (p, ...rest) => { calls.push(['write', path.basename(String(p))]); return realWrite(p, ...rest); };
  fs.renameSync = (a, b) => { calls.push(['rename', path.basename(String(a)), path.basename(String(b))]); return realRename(a, b); };
  try {
    writeOverrides(dir, { rooms: [{ id: 'room-it-1-0141', label: 'x' }] });
  } finally {
    fs.writeFileSync = realWrite;
    fs.renameSync = realRename;
  }
  const rooms = calls.filter((c) => c.some((x) => String(x).startsWith('rooms.json')));
  assert.equal(rooms.length, 2, JSON.stringify(calls));
  assert.match(rooms[0][1], /^rooms\.json\.\d+\.tmp$/, 'written to a sibling first');
  assert.deepEqual(rooms[1].slice(2), ['rooms.json'], 'then renamed over the file');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')), [{ id: 'room-it-1-0141', label: 'x' }]);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
  // the admin's own files use the same helper
  assert.equal(typeof writeFileAtomic, 'function');
});

