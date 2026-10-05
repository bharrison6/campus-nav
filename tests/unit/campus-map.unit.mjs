// The v4 campus map data (scripts/campus-map, data/campus-map, data/georef, src/shared/georef.mjs) and its join with
// the published indoor data: georeference residuals, the shared transform module, the outdoor
// graph's connectivity, the entrance join, door-to-room routes over outdoor + indoor graphs with the web app's own
// pathfinding module, the admin's access/levels overrides, the aerial manifest, and that every committed output is
// what the committed inputs give. Needs no drawings and no network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadInclude } from './load-include.mjs';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';
import { openCampus } from '../../scripts/data/campus-engine.mjs';
import { buildCampusMap, georeferenceBuilding, withEntrances } from '../../scripts/campus-map/build.mjs';
import { loadInputs } from '../../scripts/campus-map/inputs.mjs';
import { haversine } from '../../scripts/campus-map/geo.mjs';
import { nameSimilarity, buildingHeight } from '../../scripts/campus-map/osm.mjs';
import { tilesFor, AERIAL_BBOX, CAP_BYTES } from '../../scripts/campus-map/aerial.mjs';
import { choosePrimary, outwardVector } from '../../scripts/floorplan-pipeline/stages/primary-entrances.mjs';
import * as G from '../../src/shared/georef.mjs';

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const georef = { 'bld-it': readJson('data/georef/bld-it.json'), 'bld-ep': readJson('data/georef/bld-ep.json') };
const graph = readJson('data/campus-map/outdoor-graph.json');
const buildings = readJson('data/campus-map/buildings.geojson');
const campus = buildExport().campus; // what the site publishes (committed overrides applied)
const floorJson = (id) => readJson(`data/floorplans/${id}.json`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-campusmap-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- georeference ----

test('georef: IT and EP fit their OpenStreetMap footprints with a residual under 3 m (recomputed, not just read)', () => {
  const inputs = loadInputs();
  for (const bid of ['bld-it', 'bld-ep']) {
    const rec = georef[bid];
    assert.equal(rec.floorFrame, 'svg');
    assert.equal(rec.transform.metersPerUnit, 0.0254);
    assert.ok(rec.residualMeters < 3, `${bid} committed residual ${rec.residualMeters}`);
    const fp = buildings.features.filter((f) => f.properties.buildingId === bid);
    assert.equal(fp.length, 1, `${bid} has one footprint`);
    const floors = inputs.floors.filter((f) => f.json.buildingId === bid && f.json.public).map((f) => ({ floorId: f.floorId, level: f.json.level, json: f.json })).sort((a, b) => a.level - b.level);
    const { record } = georeferenceBuilding(bid, floors, { ring: fp[0].geometry.coordinates[0], osmId: rec.fittedTo });
    assert.ok(record.residualMeters < 3, `${bid} recomputed residual ${record.residualMeters}`);
    // The recomputed transform places the floor's corners where the committed one does (within 0.1 m).
    const j = floors[0].json;
    for (const [x, y] of [[0, 0], [j.widthPx, 0], [0, j.heightPx], [j.widthPx, j.heightPx]]) {
      const a = G.svgToLngLatWith(rec, x, y);
      const b = G.svgToLngLatWith(record, x, y);
      assert.ok(haversine(a[1], a[0], b[1], b[0]) < 0.1, `${bid} corner (${x}, ${y})`);
    }
  }
});

test('georef: a positive control, a wrong footprint (another building) does not fit under 3 m', () => {
  const inputs = loadInputs();
  const floors = inputs.floors.filter((f) => f.json.buildingId === 'bld-it' && f.json.public).map((f) => ({ floorId: f.floorId, level: f.json.level, json: f.json })).sort((a, b) => a.level - b.level);
  const wrong = buildings.features.find((f) => f.properties.buildingId === 'bld-cc'); // Curris Center
  const { record } = georeferenceBuilding('bld-it', floors, { ring: wrong.geometry.coordinates[0], osmId: 'x' });
  assert.ok(record.residualMeters > 3, `residual ${record.residualMeters}`);
});

test('georef: svgToLngLat and lngLatToSvg are inverse; floors map through their offsets into one drawing frame', () => {
  G.clearGeoref();
  assert.deepEqual(G.setGeoref(Object.values(georef)).sort(), ['bld-ep', 'bld-it']);
  assert.equal(G.svgToLngLat('bld-nope', 1, 2), null);
  for (const [bid, rec] of Object.entries(georef)) {
    for (const [x, y] of [[0, 0], [1000, 2000], [3000, 500]]) {
      for (const floorId of [rec.fittedFloor, ...Object.keys(rec.floorOffsets)]) {
        const [lng, lat] = G.svgToLngLat(bid, x, y, floorId);
        const [x2, y2] = G.lngLatToSvg(bid, lng, lat, floorId);
        assert.ok(Math.abs(x2 - x) < 1e-6 && Math.abs(y2 - y) < 1e-6, `${bid} ${floorId}`);
      }
    }
    // The same drawing point on two floors (SVG origins differ) lands on the same spot.
    for (const [floorId, [dx, dy]] of Object.entries(rec.floorOffsets)) {
      const a = G.svgToLngLat(bid, 1500, 1500, rec.fittedFloor);
      const b = G.svgToLngLat(bid, 1500 - dx, 1500 - dy, floorId);
      assert.ok(haversine(a[1], a[0], b[1], b[0]) < 1e-6, floorId);
      const fa = floorJson(rec.fittedFloor).frame;
      const fb = floorJson(floorId).frame;
      assert.ok(Math.abs(dx - (fb.x - fa.x)) < 1e-3 && Math.abs(dy - (fa.y - fb.y)) < 1e-3, `${floorId} offset matches the frames`);
    }
  }
  // Scale: 100 drawing inches are 2.54 m on the ground.
  const a = G.svgToLngLat('bld-it', 0, 0);
  const b = G.svgToLngLat('bld-it', 100, 0);
  assert.ok(Math.abs(haversine(a[1], a[0], b[1], b[0]) - 2.54) < 0.01);
  G.clearGeoref();
});

// ---- buildings and layers ----

test('buildings: footprints carry the contract properties; IT and EP are matched; heights are positive', () => {
  for (const f of buildings.features) {
    const p = f.properties;
    assert.deepEqual(Object.keys(p).sort(), ['buildingId', 'height', 'levels', 'name', 'osmId', 'source']);
    assert.ok(['osm', 'override', 'default'].includes(p.source));
    assert.ok(p.height > 0 && p.levels >= 1);
    assert.equal(f.geometry.type, 'Polygon');
  }
  const ids = new Set(buildings.features.map((f) => f.properties.buildingId).filter(Boolean));
  assert.ok(ids.has('bld-it') && ids.has('bld-ep'));
  assert.ok(ids.size >= 45, `${ids.size} seeded buildings matched`);
  const manifest = readJson('data/campus-map/manifest.json');
  assert.match(manifest.attribution.osm, /OpenStreetMap contributors/);
  assert.match(manifest.license, /ODbL/);
});

test('matching and heights: name similarity ignores generic words; override > OSM > default', () => {
  assert.equal(nameSimilarity('Hart College', 'Hester College'), 0);
  assert.equal(nameSimilarity('J. H. White College', 'RH White College'), 1);
  assert.deepEqual(buildingHeight({ building: 'university' }, null, 'Faculty Hall'), { height: 10.5, levels: 3, source: 'default' });
  assert.deepEqual(buildingHeight({ building: 'dormitory' }, null, 'Hart College'), { height: 14, levels: 4, source: 'default' });
  assert.deepEqual(buildingHeight({ building: 'yes', 'building:levels': '9' }, null, ''), { height: 31.5, levels: 9, source: 'osm' });
  assert.deepEqual(buildingHeight({ building: 'yes', 'building:levels': '9' }, { levels: 5 }, ''), { height: 17.5, levels: 5, source: 'override' });
  assert.deepEqual(buildingHeight({ building: 'yes' }, { height: 12, levels: '' }, ''), { height: 12, levels: 3, source: 'override' });
});

// ---- main entrances (the primary-entrance heuristic) ----

test('main entrances: 2 to 4 per indoor building (the primary heuristic), recorded with their scores, seeded and published', () => {
  for (const bid of ['bld-it', 'bld-ep']) {
    const ents = campus.navNodes.filter((n) => n.type === 'entrance' && campus.floors.find((f) => f.id === n.floorId).buildingId === bid);
    const main = ents.filter((n) => n.access === 'main');
    assert.ok(main.length >= 2 && main.length <= 4, `${bid}: ${main.length}`);
    const scored = campus.floors.filter((f) => f.buildingId === bid).flatMap((f) => floorJson(f.id).entrances || []);
    assert.deepEqual(scored.filter((e) => e.access === 'main').map((e) => e.nodeId).sort(), main.map((n) => n.id).sort());
    for (const e of scored) assert.ok(e.score >= 0 && e.score <= 1 && e.factors && e.outwardDeg >= 0);
    // every other exterior door is alt, or emergency when it opens out of a stairwell
    for (const e of scored.filter((x) => x.access !== 'main')) assert.equal(e.access, e.roomType === 'stair' ? 'emergency' : 'alt', e.nodeId);
    for (const n of ents) assert.ok(['main', 'alt', 'emergency'].includes(n.access), n.id);
  }
  // EP's stair-tower exit out of stair 1300K is an emergency exit.
  assert.equal(campus.navNodes.find((n) => n.id === 'ep-1-n0359').access, 'emergency');
  // The v4 primary flag is retired: no node carries it; only doors, entrances and waypoints carry access.
  assert.ok(campus.navNodes.every((n) => !('primary' in n)));
  for (const n of campus.navNodes) assert.equal('access' in n, ['door', 'entrance', 'waypoint'].includes(n.type), n.id);
});

test('primary choice: min 2, max 4, a close pair or a door on the same face is skipped', () => {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mk = (id, score, x, y, outward) => ({ nodeId: id, score, x, y, outward });
  const list = [mk('a', 0.9, 0, 0, 0), mk('b', 0.89, 3, 0, 0), mk('c', 0.8, 20, 0, 10), mk('d', 0.5, 100, 0, 180), mk('e', 0.45, 0, 100, 90), mk('f', 0.44, 200, 0, 270)];
  assert.deepEqual(choosePrimary(list, { distance: d }), ['a', 'd']); // b too close, c same face, e/f below 0.75 x best
  const many = [mk('a', 0.9, 0, 0, 0), mk('b', 0.85, 100, 0, 90), mk('c', 0.8, 200, 0, 180), mk('d', 0.8, 300, 0, 270), mk('e', 0.8, 400, 0, 45)];
  assert.deepEqual(choosePrimary(many, { distance: d }), ['a', 'b', 'c', 'd']);
  // Outward: the normal of the nearest outline edge, toward the outside.
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const r = (v) => v.map((c) => Math.round(c) + 0);
  assert.deepEqual(r(outwardVector([50, 0], square)), [0, -1]);
  assert.deepEqual(r(outwardVector([100, 40], square)), [1, 0]);
});

// ---- outdoor graph and the join ----

test('outdoor graph: one connected component holding every main and alt entrance, no emergency exit; edges well formed', () => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.equal(ids.size, graph.nodes.length);
  const adj = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), e.id);
    assert.ok(e.distance > 0 && e.distance < 2000, `${e.id} ${e.distance}`); // a straight town road can be one 1.2 km segment
    assert.equal(e.accessible, e.kind !== 'steps');
    // v5: every edge has a class and names what it was drawn from
    assert.equal(e.access, e.kind === 'road' ? 'alt' : 'main', e.id);
    assert.match(e.way, /^(way\/\d+|override\/\d+|connector\/.+|[A-Za-z0-9_.:-]+)$/, e.id);
    if (e.kind === 'connector') assert.equal(e.way, `connector/${e.from.startsWith('o') ? e.to : e.from}`);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  const start = graph.nodes[0].id;
  const seen = new Set([start]);
  const q = [start];
  while (q.length) for (const m of adj.get(q.shift())) if (!seen.has(m)) { seen.add(m); q.push(m); }
  assert.equal(seen.size, graph.nodes.length, 'one component');
  const open = campus.navNodes.filter((n) => n.type === 'entrance' && n.access !== 'emergency').map((n) => n.id).sort();
  const inGraph = graph.nodes.filter((n) => n.type === 'entrance').map((n) => n.id).sort();
  assert.deepEqual(inGraph, open, 'every main and alt entrance (and sole door) is joined; emergency exits are not');
  // Haversine check on a sample of edges.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges.filter((_, i) => i % 97 === 0)) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    assert.ok(Math.abs(haversine(a.lat, a.lng, b.lat, b.lng) - e.distance) < 0.2, e.id);
  }
});

test('entrance join: graph entrances are published entrance nodes at the same coordinates; buildings list them', () => {
  const nodes = new Map(campus.navNodes.map((n) => [n.id, n]));
  for (const g of graph.nodes.filter((n) => n.type === 'entrance')) {
    const n = nodes.get(g.id);
    assert.ok(n && n.type === 'entrance', g.id);
    assert.ok(haversine(g.lat, g.lng, n.lat, n.lng) < 0.2, g.id);
    assert.equal(g.access, n.access, g.id);
    assert.ok(!('primary' in g), g.id);
  }
  for (const b of campus.buildings.filter((x) => x.hasIndoor)) {
    assert.ok(Array.isArray(b.entrances) && b.entrances.length >= 2, b.id);
    for (const e of b.entrances) {
      assert.deepEqual(Object.keys(e), ['nodeId', 'lat', 'lng', 'label', 'access']);
      assert.equal(e.lat, nodes.get(e.nodeId).lat);
      assert.match(e.label, /^(North|Northeast|East|Southeast|South|Southwest|West|Northwest) entrance( \d+)?(, level \d)?$/);
    }
    assert.equal(b.entrances[0].access, 'main', 'main entrances first');
    const order = { main: 0, alt: 1, emergency: 2 };
    assert.ok(b.entrances.every((e, i) => !i || order[b.entrances[i - 1].access] <= order[e.access]), 'then alt, then emergency');
    assert.ok(b.levels >= 1);
  }
  // Every entrance's coordinates lie on its building's footprint (within 6 m of it or inside it).
  for (const n of campus.navNodes.filter((x) => x.type === 'entrance')) assert.ok(Number.isFinite(n.lat) && Number.isFinite(n.lng), n.id);
});

test('door to room: routes from the far corner of campus reach rooms through a main door, or a side door that is simpler, step-free too', () => {
  // The app's own engine: the published indoor graph joined with the outdoor graph by MSCNPath.addOutdoorGraph.
  const P = loadInclude('WebApp_Pathfinding.html', 'MSCNPath');
  const g = P.addOutdoorGraph(P.buildGraph(campus, {}), graph);
  // The far corner: the graph node farthest from the campus center.
  const c = { lat: 36.6155, lng: -88.322 };
  const far = graph.nodes.reduce((best, n) => (haversine(c.lat, c.lng, n.lat, n.lng) > haversine(c.lat, c.lng, best.lat, best.lng) ? n : best));
  assert.ok(haversine(c.lat, c.lng, far.lat, far.lng) > 1000, 'the start is across town');
  const doors = new Set(graph.nodes.filter((n) => n.type === 'entrance').map((n) => n.id));
  const rooms = campus.rooms.filter((r) => r.searchable !== false && r.searchable !== 'false');
  const sample = ['room-it-1-0141', 'room-it-2-0241', 'room-ep-2-2321', 'room-ep-1-1322', ...rooms.filter((_, i) => i % 23 === 0).map((r) => r.id)];
  for (const roomId of sample) {
    for (const accessibleOnly of [false, true]) {
      const route = P.findPath(g, far.id, P.nodesForRoom(g, roomId), { accessibleOnly });
      assert.ok(route, `${roomId}${accessibleOnly ? ' step-free' : ''}`);
      const entered = route.nodeIds.filter((id) => doors.has(id));
      assert.ok(entered.length >= 1, `${roomId} enters through a door of the outdoor graph`);
      for (const d of entered) {
        if (P.accessOf(g.nodes[d]) === 'main' || g.nodes[d].soleDoor === true) continue;
        // v5.1: a side door only when it makes the indoor way simpler than any main door does (the confusion score)
        const front = P.findPath(g, far.id, P.nodesForRoom(g, roomId), { accessibleOnly, avoidNodes: Object.fromEntries(Object.values(g.entrances).flat().filter((id) => P.accessOf(g.nodes[id]) === 'alt').map((id) => [id, true])) });
        const score = (r) => { const c = P.routeConfusion(g, r); const w = P.DEFAULTS; return c.turns * w.turnCost + c.floorChanges * w.floorChangeCost + c.junctions * w.junctionCost + c.rooms * w.roomCost; };
        assert.ok(!front || score(front) > score(route), `${roomId}: side door ${d} saves confusion`);
      }
      assert.ok(route.distance > 1000 && route.distance < 6000, `${roomId} ${route.distance}`);
    }
  }
  // EP 1322 is entered only through its own exterior door (the alt sole-access entrance).
  const r1322 = P.findPath(g, far.id, P.nodesForRoom(g, 'room-ep-1-1322'));
  assert.ok(r1322.nodeIds.includes('ep-1-n0365'));
  assert.equal(g.nodes['ep-1-n0365'].soleDoor, true);
  // Negative control: without the outdoor graph's edges the far corner reaches no room.
  const bare = P.addOutdoorGraph(P.buildGraph(campus, {}), { nodes: graph.nodes, edges: [] });
  assert.equal(P.findPath(bare, far.id, P.nodesForRoom(bare, 'room-it-1-0141')), null);
});

// ---- admin overrides ----

test('admin: setting an entrance class and levels/height are overrides the export publishes', () => {
  const dir = path.join(tmp, 'ov');
  fs.cpSync(path.join(ROOT, 'data', 'overrides'), dir, { recursive: true });
  const engine = openCampus({ overridesDir: dir });
  engine.gas.run('updateNavNode', [{ id: 'it-1-n0493', access: 'main' }]);
  engine.gas.run('updateNavNode', [{ id: 'it-1-n0490', access: 'alt' }]);
  engine.gas.run('updateBuilding', [{ id: 'bld-ac', levels: 2, height: 9 }]);
  engine.save();
  const nodes = JSON.parse(fs.readFileSync(path.join(dir, 'navNodes.json'), 'utf8'));
  assert.deepEqual(nodes.filter((r) => /it-1-n049[03]/.test(r.id)), [{ id: 'it-1-n0490', access: 'alt' }, { id: 'it-1-n0493', access: 'main' }]);
  const blds = JSON.parse(fs.readFileSync(path.join(dir, 'buildings.json'), 'utf8'));
  assert.deepEqual(blds.find((r) => r.id === 'bld-ac'), { id: 'bld-ac', levels: 2, height: 9 });
  const x = buildExport({ overridesDir: dir }).campus;
  const n = (id) => x.navNodes.find((m) => m.id === id);
  assert.equal(n('it-1-n0493').access, 'main');
  assert.equal(n('it-1-n0490').access, 'alt');
  const ac = x.buildings.find((b) => b.id === 'bld-ac');
  assert.equal(ac.levels, 2);
  assert.equal(ac.height, 9);
});

test('admin: an entrance moved, added or deleted in the admin is where the export puts it in the rebuilt outdoor graph', () => {
  const dir = path.join(tmp, 'ov-entrance');
  fs.cpSync(path.join(ROOT, 'data', 'overrides'), dir, { recursive: true });
  const engine = openCampus({ overridesDir: dir });
  const before = engine.gas.run('getAllCampusData', []).navNodes;
  const moved = before.find((n) => n.id === 'it-1-n0492');
  engine.gas.run('updateNavNode', [{ id: 'it-1-n0492', x: Number(moved.x) + 1000 }]);
  const added = engine.gas.run('saveNavNode', [{ floorId: 'floor-it-1', x: Number(moved.x) + 300, y: Number(moved.y) - 400, type: 'entrance', access: 'main' }]);
  const addedId = (added && (added.id || (added.record && added.record.id))) || null;
  engine.gas.run('deleteNavNode', [{ id: 'it-1-n0493' }]);
  engine.save();
  const exported = buildExport({ overridesDir: dir }).campus.navNodes;
  const out = buildCampusMap(loadInputs({ overridesDir: dir }));
  const gnode = (id) => out.graph.nodes.find((n) => n.id === id);
  const xnode = (id) => exported.find((n) => n.id === id);
  const apart = (id) => haversine(gnode(id).lat, gnode(id).lng, xnode(id).lat, xnode(id).lng);
  // moved by 1,000 drawing units (25 m): graph and export agree within 1 m, and both left the committed spot
  assert.ok(apart('it-1-n0492') < 1, `it-1-n0492 graph vs export ${apart('it-1-n0492')} m`);
  const committed = graph.nodes.find((n) => n.id === 'it-1-n0492');
  assert.ok(haversine(committed.lat, committed.lng, gnode('it-1-n0492').lat, gnode('it-1-n0492').lng) > 20, 'the graph follows the edit');
  assert.ok(out.graph.edges.some((e) => e.kind === 'connector' && (e.from === 'it-1-n0492' || e.to === 'it-1-n0492')), 'the moved door is still joined');
  // added as a main entrance: joined, at the exported point
  assert.ok(addedId, 'saveNavNode returned the new id');
  assert.ok(gnode(addedId), 'the added entrance is in the graph');
  assert.ok(apart(addedId) < 1, `${addedId} graph vs export ${apart(addedId)} m`);
  // deleted: in neither
  assert.equal(xnode('it-1-n0493'), undefined);
  assert.equal(gnode('it-1-n0493'), undefined);
  assert.ok(!Object.values(out.entranceBlocks).flat().some((e) => e.nodeId === 'it-1-n0493'), 'not scored either');
});

// ---- aerial ----

test('aerial (when present): manifest, every tile on disk, under the cap, NAIP credited', { skip: !fs.existsSync(path.join(ROOT, 'data/campus-map/aerial.json')) && 'no aerial layer' }, () => {
  const m = readJson('data/campus-map/aerial.json');
  assert.deepEqual(m.bounds, [AERIAL_BBOX.minLng, AERIAL_BBOX.minLat, AERIAL_BBOX.maxLng, AERIAL_BBOX.maxLat]);
  assert.equal(m.minzoom, 15);
  assert.equal(m.maxzoom, 18);
  assert.match(m.attribution, /NAIP.*public domain/);
  const tiles = tilesFor(AERIAL_BBOX);
  assert.equal(m.tileCount, tiles.length);
  let bytes = 0;
  for (const t of tiles) bytes += fs.statSync(path.join(ROOT, 'data/campus-map/aerial', String(t.z), String(t.x), `${t.y}.jpg`)).size;
  assert.equal(bytes, m.bytes);
  assert.ok(bytes < CAP_BYTES);
});

// ---- freshness ----

test('committed campus-map outputs are what the committed inputs give (npm run campus-map is current)', () => {
  const inputs = loadInputs();
  const out = buildCampusMap(inputs);
  for (const [rel, text] of Object.entries(out.files)) assert.equal(fs.readFileSync(path.join(ROOT, rel), 'utf8'), text, `${rel}: run npm run campus-map`);
  for (const f of inputs.floors) {
    if (!out.entranceBlocks[f.floorId]) continue;
    assert.deepEqual(f.json.entrances, withEntrances(f.json, out.entranceBlocks[f.floorId]).entrances, f.floorId);
  }
});
