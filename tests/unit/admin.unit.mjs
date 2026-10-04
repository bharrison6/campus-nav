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
import { READ_FNS, SERVER_FNS, createAdmin, isWriteFn, resolveSiteUrl } from '../../tools/admin/server.mjs';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = fs.readFileSync(path.join(here, '..', '..', 'tools', 'admin', 'Admin.html'), 'utf8');

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

test('the page: no PIN gate, no Import tab, no Apps Script scriptlet, no key literal; its scripts parse', () => {
  assert.ok(!/pin-gate|adminPin|verifyAdminPin|changeAdminPin|setMapsApiKey|importFloorData|reseedCampusData|data-tab="import"/.test(ADMIN_HTML));
  assert.ok(!/<\?/.test(ADMIN_HTML), 'no Apps Script template scriptlets');
  assert.ok(ADMIN_HTML.includes('data-app-url="__MSCN_SITE_URL__"'));
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(ADMIN_HTML));
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
  const admin = createAdmin({ overridesDir: dir, log: quiet });
  admin.call('updateRoom', [{ id: 'room-it-1-0141', label: 'Dean of Engineering' }]);
  assert.deepEqual(readOv(dir, 'rooms'), [{ id: 'room-it-1-0141', label: 'Dean of Engineering' }]);
  for (const c of ['buildings', 'floors', 'navNodes', 'navEdges', 'photos', 'qrLocations', 'config']) assert.deepEqual(readOv(dir, c), [], c);

  const qr = admin.call('saveQrLocation', [{ buildingId: 'bld-it', floorId: 'floor-it-1', nodeId: 'it-1-n1', description: 'Main lobby', permanent: true }]);
  const q = readOv(dir, 'qrLocations');
  assert.equal(q.length, 1);
  assert.equal(q[0].id, qr.id);
  assert.equal(q[0]._new, true);
  assert.equal(q[0].description, 'Main lobby');

  // A node delete cascades to its edges: the node and each edge become _delete records.
  const node = admin.call('getAllCampusData', []).navNodes.find((x) => x.floorId === 'floor-ep-3');
  const touching = admin.call('getAllCampusData', []).navEdges.filter((e) => e.fromNodeId === node.id || e.toNodeId === node.id);
  const res = admin.call('deleteNavNode', [{ id: node.id }]);
  assert.equal(res.edgesRemoved, touching.length);
  assert.deepEqual(readOv(dir, 'navNodes'), [{ id: node.id, _delete: true }]);
  assert.deepEqual(readOv(dir, 'navEdges').map((e) => e.id).sort(), touching.map((e) => e.id).sort());

  // A restart (a new admin over the same files) and the export both see the edits.
  const again = createAdmin({ overridesDir: dir, log: quiet });
  const data = again.call('getAllCampusData', []);
  assert.equal(data.rooms.find((r) => r.id === 'room-it-1-0141').label, 'Dean of Engineering');
  assert.equal(data.navNodes.find((x) => x.id === node.id), undefined);
  const x = buildExport({ overridesDir: dir });
  assert.equal(x.campus.rooms.find((r) => r.id === 'room-it-1-0141').label, 'Dean of Engineering');
  assert.deepEqual(x.campus.qrLocations.map((r) => r.id), [qr.id]);
  assert.deepEqual(x.report.orphans, []);

  // Setting the field back to the pipeline's value in the admin removes the edit from the file again.
  const base = buildExport({ overridesDir: freshDir() }).campus.rooms.find((r) => r.id === 'room-it-1-0141').label;
  again.call('updateRoom', [{ id: 'room-it-1-0141', label: base }]);
  assert.deepEqual(readOv(dir, 'rooms'), []);
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
