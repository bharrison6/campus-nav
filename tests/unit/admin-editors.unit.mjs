// The v5 admin editors (tools/admin): the override shapes the map and floor-plan editors write, the save check that
// refuses a save cutting off a room or a building, and the local-only guards on the new routes.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAdmin } from '../../tools/admin/server.mjs';
import {
  addBuilding, addEntrance, addPath, autoPathAccess, deleteFeature, featureId, formatGeo, geoEditIsAdditive, setPathAccess, snapPoint,
  updateFeature,
} from '../../tools/admin/map-overrides.mjs';
import { cutOffs, loadCheckConnectivity, prepareForCheck } from '../../tools/admin/connectivity-gate.mjs';
import { checkConnectivity } from '../../tools/admin/connectivity-standin.mjs';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const MAP_DIR = path.join(REPO, 'data', 'campus-map');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-editors-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = (name = 'd') => {
  const d = path.join(tmp, `${name}${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
/** A copy of the campus-map files the admin reads and writes (never the committed overrides.geojson). */
function mapDir() {
  const d = freshDir('map');
  fs.mkdirSync(path.join(d, 'layers'));
  for (const f of ['overrides.geojson', 'outdoor-graph.json', 'buildings.geojson', 'layers/paths.geojson', 'layers/roads.geojson']) fs.copyFileSync(path.join(MAP_DIR, f), path.join(d, f));
  return d;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const quiet = () => {};
const editor = (o = {}) => {
  const overridesDir = freshDir('ov');
  const campusMapDir = o.campusMapDir || mapDir();
  const admin = createAdmin({ overridesDir, campusMapDir, log: quiet, rebuildMap: () => Promise.resolve('rebuilt'), ...o });
  return { admin, overridesDir, campusMapDir };
};

// ---------------------------------------------------------------- shapes (pure)

test('pathAccess.json: one {way, access} per way, sorted; auto removes the entry; bad values are refused', () => {
  let l = setPathAccess([], 'way/20', 'alt');
  l = setPathAccess(l, 'way/10', 'main');
  l = setPathAccess(l, 'way/20', 'main');
  assert.deepEqual(l, [{ way: 'way/10', access: 'main' }, { way: 'way/20', access: 'main' }]);
  assert.deepEqual(setPathAccess(l, 'way/10', 'auto'), [{ way: 'way/20', access: 'main' }]);
  assert.throws(() => setPathAccess(l, 'way/10', 'emergency'), /one of main, alt/);
  assert.throws(() => setPathAccess(l, 'DROP TABLE', 'main'), /OSM way id/);
  assert.equal(autoPathAccess('roads', 'residential'), 'alt');
  assert.equal(autoPathAccess('paths', 'footway'), 'main');
});

test('overrides.geojson: the committed file round-trips byte for byte through the writer', () => {
  const text = fs.readFileSync(path.join(MAP_DIR, 'overrides.geojson'), 'utf8');
  assert.equal(formatGeo(JSON.parse(text)), text);
});

test('a drawn path snaps its ends to an entrance, a vertex or a segment within 4 m and carries access and an id', () => {
  const targets = {
    entrances: [{ id: 'ep-1-n0358', lngLat: [-88.324557, 36.612281] }],
    lines: [{ id: 'way/1', coordinates: [[-88.3240, 36.6130], [-88.3230, 36.6130]] }],
  };
  // start 1.5 m from the entrance, end 2 m north of the middle of way/1's segment
  const geo = { type: 'FeatureCollection', features: [] };
  const r = addPath(geo, { coordinates: [[-88.324557, 36.612294], [-88.3235, 36.613018]], access: 'alt', name: 'Nursing walk' }, targets, 1);
  const f = r.geo.features[0];
  assert.equal(f.properties.layer, 'paths');
  assert.equal(f.properties.access, 'alt');
  assert.equal(f.properties.kind, 'footway');
  assert.equal(f.properties.name, 'Nursing walk');
  assert.equal(f.properties.id, r.id);
  assert.match(r.id, /^path-/);
  assert.deepEqual(f.geometry.coordinates[0], [-88.324557, 36.612281]);
  assert.deepEqual(f.geometry.coordinates[1], [-88.3235, 36.613]);
  assert.deepEqual(r.snaps.map((s) => [s.end, s.to, s.how]), [['start', 'ep-1-n0358', 'entrance'], ['end', 'way/1', 'segment']]);
  assert.equal(snapPoint([-88.3235, 36.6131], targets), null, '11 m away: no snap');
  assert.throws(() => addPath(geo, { coordinates: [[-88.3, 36.6]] }), /two points/);
  assert.throws(() => addPath(geo, { coordinates: [[-88.3, 36.6], [-88.31, 36.6]], access: 'emergency' }), /main, alt/);
});

test('a drawn building closes its ring and keeps name, code, levels, height; a redraw of an OSM building writes replaces', () => {
  const geo = { type: 'FeatureCollection', features: [] };
  const r = addBuilding(geo, { ring: [[-88.33, 36.61], [-88.329, 36.61], [-88.329, 36.611]], name: 'School of Nursing and Health Professions', code: 'NHP', levels: '3', height: 14 });
  const f = r.geo.features[0];
  assert.deepEqual(f.properties, {
    layer: 'buildings', id: r.id, name: 'School of Nursing and Health Professions', code: 'NHP', building: 'university', levels: 3, height: 14,
    source: 'override', note: 'Drawn in the local admin map editor; candidate contribution to OpenStreetMap.',
  });
  assert.equal(f.geometry.coordinates[0].length, 4);
  assert.deepEqual(f.geometry.coordinates[0][0], f.geometry.coordinates[0][3]);
  const re = addBuilding(r.geo, { ring: [[-88.33, 36.61], [-88.329, 36.61], [-88.329, 36.611]], name: 'Redrawn', replaces: 'way/1232965496' });
  assert.equal(re.geo.features[1].properties.replaces, 'way/1232965496');
  assert.throws(() => addBuilding(geo, { ring: [[-88.33, 36.61], [-88.329, 36.61], [-88.329, 36.611]], name: '' }), /name is required/);
  assert.throws(() => addBuilding(geo, { ring: [[-88.33, 36.61], [-88.329, 36.61], [-88.329, 36.611]], name: 'x', levels: 2.5 }), /whole number/);
  assert.throws(() => addBuilding(geo, { ring: [[-88.33, 36.61], [-88.329, 36.61], [-88.329, 36.611]], name: 'x', replaces: 'nope' }), /OSM id/);
});

test('an entrance point carries building, access and label; edits keep to the layer\'s fields; deletes remove it', () => {
  const geo = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { layer: 'paths', kind: 'footway' }, geometry: { type: 'LineString', coordinates: [[0, 0], [0, 1]] } }] };
  const r = addEntrance(geo, { building: 'bld-nursing', lngLat: [-88.33, 36.61], access: 'emergency', label: 'North door' });
  assert.deepEqual(r.geo.features[1].properties, { layer: 'entrances', id: r.id, building: 'bld-nursing', access: 'emergency', label: 'North door', source: 'override' });
  assert.deepEqual(r.geo.features[1].geometry, { type: 'Point', coordinates: [-88.33, 36.61] });
  assert.equal(featureId(r.geo.features[0], 0), 'override/1', 'a hand-written feature is addressed by its index');
  const u = updateFeature(r.geo, r.id, { access: 'main', label: 'Main door', kind: 'ignored' });
  assert.equal(u.after.access, 'main');
  assert.equal(u.after.label, 'Main door');
  assert.equal(u.after.kind, undefined);
  assert.equal(updateFeature(u.geo, 'override/1', { access: 'alt' }).after.access, 'alt');
  assert.throws(() => updateFeature(u.geo, 'override/1', { access: 'emergency' }), /main, alt/, 'paths have no emergency class');
  assert.equal(deleteFeature(u.geo, r.id).geo.features.length, 1);
  assert.throws(() => deleteFeature(u.geo, 'entrance-none'), /no feature/);
  assert.equal(geoEditIsAdditive('update', { layer: 'entrances', access: 'main' }, { layer: 'entrances', access: 'emergency' }), false);
  assert.equal(geoEditIsAdditive('update', { layer: 'paths', access: 'main' }, { layer: 'paths', access: 'alt' }), true);
  assert.equal(geoEditIsAdditive('delete', { layer: 'paths' }), false);
  assert.equal(geoEditIsAdditive('add'), true);
});

// ---------------------------------------------------------------- the server writes them

test('map editor saves: pathAccess.json by way, drawn paths, buildings and entrances in overrides.geojson; each reruns the map build', async () => {
  const runs = [];
  const { admin, overridesDir, campusMapDir } = editor({ rebuildMap: () => { runs.push(1); return Promise.resolve('ok'); } });
  const geoFile = path.join(campusMapDir, 'overrides.geojson');
  const before = readJson(geoFile).features.length;

  admin.call('setPathAccess', [{ way: 'way/108852560', access: 'main' }]);
  assert.deepEqual(readJson(path.join(overridesDir, 'pathAccess.json')), [{ way: 'way/108852560', access: 'main' }]);
  await admin.mapRebuildIdle();

  const p = admin.call('saveMapPath', [{ coordinates: [[-88.324557, 36.612290], [-88.3240, 36.6127]], access: 'alt', name: 'Test walk' }]);
  assert.equal(p.snaps[0].to, 'ep-1-n0358', 'the start snaps to the EP northeast entrance');
  await admin.mapRebuildIdle();
  const b = admin.call('saveMapBuilding', [{ ring: [[-88.3300, 36.6100], [-88.3290, 36.6100], [-88.3290, 36.6108], [-88.3300, 36.6108]], name: 'Nursing', levels: 3, height: 13 }]);
  await admin.mapRebuildIdle();
  const e = admin.call('saveMapEntrance', [{ building: 'bld-it', lngLat: [-88.3295, 36.6100], access: 'main', label: 'South door' }]);
  await admin.mapRebuildIdle();
  admin.call('updateMapFeature', [{ id: e.id, changes: { access: 'alt' } }]);
  await admin.mapRebuildIdle();
  admin.call('setPathAccess', [{ way: p.id, access: 'main' }]);
  await admin.mapRebuildIdle();

  const feats = readJson(geoFile).features;
  assert.equal(feats.length, before + 3);
  const byId = new Map(feats.map((f, i) => [featureId(f, i), f]));
  assert.equal(byId.get(p.id).properties.access, 'main', 'a drawn path keeps its class on its feature');
  assert.equal(byId.get(b.id).properties.layer, 'buildings');
  assert.deepEqual([byId.get(e.id).properties.layer, byId.get(e.id).properties.access, byId.get(e.id).properties.building], ['entrances', 'alt', 'bld-it']);
  assert.deepEqual(readJson(path.join(overridesDir, 'pathAccess.json')), [{ way: 'way/108852560', access: 'main' }], 'pathAccess.json holds OSM ways only');
  assert.equal(runs.length, 6, 'every map save reruns npm run campus-map');
  const d = admin.call('getMapEditorData', []);
  assert.ok(d.entrances.some((x) => x.id === 'ep-1-n0365' && x.buildingId === 'bld-ep' && /^(main|alt|emergency)$/.test(x.access)));
  assert.ok(d.geo.features.every((f) => f.properties.id), 'every feature is addressable');
  assert.equal(admin.status().mapRebuild.last.ok, true);
  assert.ok(admin.status().mapRebuild.last.ms >= 0, 'the run reports its duration');
});

test('floor-plan editor saves: a door\'s class in navNodes.json, a room made a hallway with its class in rooms.json', () => {
  const { admin, overridesDir } = editor();
  admin.call('updateNavNode', [{ id: 'it-1-n0270', access: 'emergency' }]);
  admin.call('updateRoom', [{ id: 'room-it-1-0141', type: 'corridor', access: 'alt' }]);
  assert.deepEqual(readJson(path.join(overridesDir, 'navNodes.json')), [{ id: 'it-1-n0270', access: 'emergency' }]);
  assert.deepEqual(readJson(path.join(overridesDir, 'rooms.json')), [{ id: 'room-it-1-0141', type: 'corridor', access: 'alt' }]);
  const pub = buildExport({ overridesDir }).campus;
  assert.equal(pub.navNodes.find((x) => x.id === 'it-1-n0270').access, 'emergency');
  assert.equal(pub.rooms.find((x) => x.id === 'room-it-1-0141').access, 'alt');
});

test('save check: removing the only door to EP 1322 is refused with what it cuts off, and nothing is written', async () => {
  const { admin, overridesDir } = editor();
  assert.match(admin.status().connectivity, /connectivity/);
  const err = (() => { try { admin.call('updateNavNode', [{ id: 'ep-1-n0365', access: 'emergency' }]); } catch (e) { return e; } return null; })();
  assert.ok(err, 'refused');
  assert.match(err.message, /^Refused: setting ep-1-n0365 to emergency would leave 1 room\(s\): EP 1322 with no route\. Nothing was saved\.$/);
  assert.deepEqual(err.refused, { rooms: [{ id: 'room-ep-1-1322', label: 'EP 1322' }], buildings: [] });
  assert.equal(fs.existsSync(path.join(overridesDir, 'navNodes.json')) ? readJson(path.join(overridesDir, 'navNodes.json')).length : 0, 0);
  assert.equal(admin.call('getAllCampusData', []).navNodes.find((x) => x.id === 'ep-1-n0365').access, '', 'not kept in memory either');
  assert.throws(() => admin.call('deleteNavNode', [{ id: 'ep-1-n0365' }]), /Refused: deleting ep-1-n0365 would leave 1 room\(s\): EP 1322/);
  assert.ok(admin.call('getAllCampusData', []).navNodes.some((x) => x.id === 'ep-1-n0365'));
  // alt keeps it routable, so that save goes through
  admin.call('updateNavNode', [{ id: 'ep-1-n0365', access: 'alt' }]);
  assert.deepEqual(readJson(path.join(overridesDir, 'navNodes.json')), [{ id: 'ep-1-n0365', access: 'alt' }]);

  // over HTTP the refusal arrives as { ok: false, error, refused }
  await new Promise((r) => admin.server.listen(0, '127.0.0.1', r));
  const { port } = admin.server.address();
  try {
    const res = await request(port, { method: 'POST', pathName: '/__admin/run/updateNavNode', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'ep-1-n0365', access: 'emergency' }]) });
    const reply = JSON.parse(res.body);
    assert.equal(reply.ok, false);
    assert.deepEqual(reply.refused.rooms.map((r) => r.id), ['room-ep-1-1322']);
  } finally {
    await new Promise((r) => admin.server.close(r));
  }
});

test('save check on the map: deleting an outdoor link that cuts a building off is refused; adding never runs the slow check', () => {
  let builds = 0;
  const realGraph = readJson(path.join(MAP_DIR, 'outdoor-graph.json'));
  // stands in for the campus-map build: the graph those overrides give no longer joins EP 1322's door to the paths
  const cut = { ...realGraph, edges: realGraph.edges.filter((x) => x.from !== 'ep-1-n0365' && x.to !== 'ep-1-n0365') };
  const { admin, campusMapDir } = editor({ outdoorGraphFor: () => { builds++; return cut; } });
  const e = admin.call('saveMapEntrance', [{ building: 'bld-ep', lngLat: [-88.3253, 36.6121], access: 'main', label: 'West door' }]);
  assert.equal(builds, 0, 'an addition cannot cut anything off');
  admin.call('updateMapFeature', [{ id: e.id, changes: { label: 'West side door' } }]);
  assert.equal(builds, 0);
  assert.throws(() => admin.call('deleteMapFeature', [{ id: e.id }]), (x) => x.refused && x.refused.rooms.some((r) => r.id === 'room-ep-1-1322'));
  assert.equal(builds, 1);
  assert.ok(readJson(path.join(campusMapDir, 'overrides.geojson')).features.some((f) => f.properties.id === e.id), 'the refused delete wrote nothing');
});

test('the gate counts only new cut-offs; waypoints inherit their hallway\'s class; entrance classes reach the outdoor graph', () => {
  const before = { unreachableRooms: ['r-old'], unreachableBuildings: [] };
  const afterR = { unreachableRooms: ['r-old', 'r-cut', 'r-new'], unreachableBuildings: ['b1'] };
  assert.deepEqual(cutOffs(before, afterR, { rooms: [{ id: 'r-old' }, { id: 'r-cut' }], buildings: [{ id: 'b1' }] }), { rooms: ['r-cut'], buildings: ['b1'] });
  const campus = {
    rooms: [{ id: 'h', floorId: 'f', type: 'corridor', access: 'emergency', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
    navNodes: [{ id: 'w1', floorId: 'f', type: 'waypoint', x: 5, y: 5 }, { id: 'w2', floorId: 'f', type: 'waypoint', x: 50, y: 5 }, { id: 'e', floorId: 'f', type: 'entrance', x: 0, y: 0, access: 'alt' }],
  };
  const p = prepareForCheck(campus, { nodes: [{ id: 'e', type: 'entrance' }], edges: [] });
  assert.equal(p.campus.navNodes[0].access, 'emergency');
  assert.equal(p.campus.navNodes[1].access, undefined);
  assert.equal(p.graph.nodes[0].access, 'alt');
});

test('the connectivity stand-in passes on the real data and finds EP 1322 cut off without its door; the shared check wins when present', async () => {
  const pub = buildExport().campus;
  const g = readJson(path.join(MAP_DIR, 'outdoor-graph.json'));
  const ok = checkConnectivity(pub, g);
  assert.deepEqual([ok.ok, ok.unreachableRooms, ok.unreachableBuildings], [true, [], []]);
  const cut = checkConnectivity({ ...pub, navNodes: pub.navNodes.map((x) => (x.id === 'ep-1-n0365' ? { ...x, access: 'emergency' } : x)) }, g);
  assert.deepEqual(cut.unreachableRooms, ['room-ep-1-1322']);
  assert.match((await loadCheckConnectivity(path.join(tmp, 'absent.mjs'))).source, /stand-in/);
  const shared = path.join(freshDir('shared'), 'connectivity.mjs');
  fs.writeFileSync(shared, 'export function checkConnectivity() { return { ok: true, unreachableRooms: [], unreachableBuildings: [], components: 1 }; }\n');
  const loaded = await loadCheckConnectivity(shared);
  assert.equal(loaded.check({}, {}).components, 1);
  assert.doesNotMatch(loaded.source, /stand-in/);
});

test('hallway suggestions: listed from data/review, accept makes the room a hallway (checked), reject is remembered', () => {
  const reviewDir = freshDir('review');
  fs.writeFileSync(path.join(reviewDir, 'corridor-candidates.json'), JSON.stringify([
    { roomId: 'room-it-1-0141', floorId: 'floor-it-1', label: '141', evidence: ['6 doors'], confidence: 0.7 },
    { roomId: 'room-it-1-0110', floorId: 'floor-it-1', label: '110', evidence: ['narrow'], confidence: 0.4 },
  ]));
  const { admin, overridesDir } = editor({ reviewDir });
  const r0 = admin.call('getCorridorReview', []);
  assert.deepEqual(r0.candidates.map((c) => [c.roomId, c.decision]), [['room-it-1-0141', ''], ['room-it-1-0110', 'accepted']], 'a room already typed corridor shows as accepted');
  admin.call('setCorridorReview', [{ roomId: 'room-it-1-0141', decision: 'accepted', access: 'alt' }]);
  assert.deepEqual(readJson(path.join(overridesDir, 'rooms.json')), [{ id: 'room-it-1-0141', type: 'corridor', access: 'alt' }]);
  const r = admin.call('setCorridorReview', [{ roomId: 'room-it-1-0110', decision: 'rejected' }]);
  assert.deepEqual(readJson(path.join(overridesDir, 'corridorReview.json')), [{ room: 'room-it-1-0110', decision: 'rejected' }, { room: 'room-it-1-0141', decision: 'accepted' }]);
  assert.deepEqual(r.candidates.map((c) => c.decision), ['accepted', 'rejected']);
});

// ---------------------------------------------------------------- local only

function request(port, { method = 'GET', pathName = '/', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

test('local only: the map files are served from an allow-list; other hosts, origins, non-JSON posts and path tricks are refused', async () => {
  const { admin } = editor();
  await new Promise((r) => admin.server.listen(0, '127.0.0.1', r));
  const { port } = admin.server.address();
  try {
    const host = { host: `localhost:${port}` };
    const ml = await request(port, { pathName: '/__admin/vendor/maplibre-gl.mjs', headers: host });
    assert.equal(ml.status, 200);
    assert.match(ml.type, /javascript/);
    assert.equal((await request(port, { pathName: '/__admin/campus-map/layers/paths.geojson', headers: host })).status, 200);
    for (const p of ['/__admin/vendor/package.json', '/__admin/vendor/../../package.json', '/__admin/campus-map/overrides.geojson', '/__admin/campus-map/../overrides/navNodes.json',
      '/__admin/campus-map/%2e%2e/overrides/navNodes.json', '/__admin/campus-map/source/osm-extract.json', '/__admin/campus-map/aerial/../../overrides/rooms.json']) {
      assert.equal((await request(port, { pathName: p, headers: host })).status, 404, p);
    }
    assert.equal((await request(port, { pathName: '/__admin/vendor/maplibre-gl.mjs', headers: { host: 'evil.example' } })).status, 403);
    const json = { ...host, 'content-type': 'application/json' };
    assert.equal((await request(port, { method: 'POST', pathName: '/__admin/run/setPathAccess', headers: { ...json, origin: 'http://evil.example' }, body: '[]' })).status, 403);
    assert.equal((await request(port, { method: 'POST', pathName: '/__admin/run/setPathAccess', headers: { ...host, 'content-type': 'text/plain' }, body: '[]' })).status, 415);
    assert.equal((await request(port, { method: 'GET', pathName: '/__admin/run/getMapEditorData', headers: host })).status, 404, 'calls are POST only');
  } finally {
    await new Promise((r) => admin.server.close(r));
  }
  const src = fs.readFileSync(path.join(REPO, 'tools', 'admin', 'server.mjs'), 'utf8');
  assert.match(src, /\.listen\(port, '127\.0\.0\.1'/, 'the server binds loopback only');
});
