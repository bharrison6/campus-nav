// v5 access classes on the data side (plan mscn-v5-access-classes-and-editors): the exporter's rules
// (scripts/data/access.mjs), v4 primary overrides read as access, outdoor path classes and pathAccess.json, and a
// building without floor plans (the new nursing building) drawn in overrides.geojson with its entrances.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';
import { applyAccess, publishAltFactor } from '../../scripts/data/access.mjs';
import { applyOverrides, overrideAccess } from '../../scripts/data/overrides.mjs';
import { checkConnectivity } from '../../scripts/data/connectivity.mjs';
import { autoEntranceAccess, buildCampusMap, drawnEntrances } from '../../scripts/campus-map/build.mjs';
import { loadInputs } from '../../scripts/campus-map/inputs.mjs';
import { pathAccess } from '../../scripts/campus-map/outdoor-graph.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-access-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (files = {}) => {
  const d = path.join(tmp, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
  return d;
};

// One campus-map build carries every map-side case (the build is slow: the georef fit): operator classes for three
// doors, pathAccess.json entries, a drawn alt path, and the nursing building drawn with its entrances.
const COMMITTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/campus-map/outdoor-graph.json'), 'utf8'));
const WAY = COMMITTED.edges.find((e) => e.kind === 'footway' && e.way.startsWith('way/')).way;
const ROAD_EDGE = COMMITTED.edges.find((e) => e.kind === 'road');
const ROAD = ROAD_EDGE.way;
const at = (id) => COMMITTED.nodes.find((x) => x.id === id);
const DRAWN_PATH = {
  type: 'Feature',
  properties: { layer: 'paths', name: 'test shortcut', kind: 'footway', access: 'alt' },
  geometry: { type: 'LineString', coordinates: [[at(ROAD_EDGE.from).lng, at(ROAD_EDGE.from).lat], [at(ROAD_EDGE.to).lng, at(ROAD_EDGE.to).lat]] },
};
const NAV_OVERRIDES = [{ id: 'ep-1-n0356', primary: true }, { id: 'it-2-n0554', access: 'alt' }, { id: 'it-1-n0490', access: 'emergency' }];
const PATH_OVERRIDES = [{ way: WAY, access: 'alt' }, { way: ROAD, access: 'main' }, { way: 'way/1', access: 'main' }, { way: 'way/2', access: 'emergency' }];
let built = null;
function combined() {
  if (!built) {
    const inputs = loadInputs({ overridesDir: dir({ 'navNodes.json': NAV_OVERRIDES, 'pathAccess.json': PATH_OVERRIDES }) });
    const features = [...inputs.overridesGeo.features, DRAWN_PATH, ...NURSING];
    built = { inputs, features, drawnId: `override/${inputs.overridesGeo.features.length + 1}`, out: buildCampusMap({ ...inputs, overridesGeo: { ...inputs.overridesGeo, features } }) };
  }
  return built;
}

test('automatic classes: heuristic doors main, stair-tower exits emergency, other exterior doors alt; roads alt', () => {
  assert.equal(autoEntranceAccess(true, 'corridor'), 'main');
  assert.equal(autoEntranceAccess(true, 'stair'), 'main', 'the heuristic\'s choice stands');
  assert.equal(autoEntranceAccess(false, 'stair'), 'emergency');
  assert.equal(autoEntranceAccess(false, 'other'), 'alt');
  assert.equal(autoEntranceAccess(false, undefined), 'alt', 'an added door of unknown room');
  for (const k of ['footway', 'path', 'pedestrian', 'crossing', 'steps', 'connector']) assert.equal(pathAccess(k), 'main', k);
  assert.equal(pathAccess('road'), 'alt');
});

test('a v4 primary override reads as access: true main, false alt; an explicit access wins', () => {
  assert.equal(overrideAccess({ id: 'x', primary: true }), 'main');
  assert.equal(overrideAccess({ id: 'x', primary: 'false' }), 'alt');
  assert.equal(overrideAccess({ id: 'x', primary: false, access: 'emergency' }), 'emergency');
  assert.equal(overrideAccess({ id: 'x', label: 'y' }), null);
  const headers = { navNodes: ['id', 'type', 'primary', 'access'] };
  const base = { navNodes: [{ id: 'a', type: 'entrance', primary: false, access: 'alt' }, { id: 'b', type: 'entrance', primary: true, access: 'main' }] };
  const { data } = applyOverrides(base, { navNodes: [{ id: 'a', primary: true }, { id: 'b', primary: false }] }, headers);
  assert.deepEqual(data.navNodes.map((r) => r.access), ['main', 'alt']);
});

test('export: a v4 primary override and an access override reach the published entrances and the map', () => {
  const { campus } = buildExport({ overridesDir: dir({ 'navNodes.json': NAV_OVERRIDES }) });
  const node = (id) => campus.navNodes.find((x) => x.id === id);
  assert.deepEqual([node('ep-1-n0356').access, node('ep-1-n0356').primary], ['main', true]);
  assert.deepEqual([node('it-2-n0554').access, node('it-2-n0554').primary], ['alt', false]);
  assert.equal(node('it-1-n0490').access, 'emergency');
  const ep = campus.buildings.find((b) => b.id === 'bld-ep');
  assert.equal(ep.entrances.find((e) => e.nodeId === 'ep-1-n0356').access, 'main');
  // the campus-map build reads the same overrides; an emergency door is taken off the paths
  const { out } = combined();
  const g = (id) => out.graph.nodes.find((x) => x.id === id);
  assert.equal(g('ep-1-n0356').access, 'main');
  assert.equal(g('it-2-n0554').access, 'alt');
  assert.ok(!g('it-1-n0490'));
  assert.deepEqual(out.report.entrances['bld-it'].operatorOverrides.slice().sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)), [{ nodeId: 'it-1-n0490', access: 'emergency' }, { nodeId: 'it-2-n0554', access: 'alt' }]);
  assert.ok(out.report.entrances['bld-it'].byClass.emergency.includes('it-1-n0490'));
});

test('export: a room made a hallway routes as one (its hub becomes a waypoint of its class) and leaves search', () => {
  const ov = dir({ 'rooms.json': [{ id: 'room-it-2-0214', type: 'corridor', access: 'alt' }] });
  const { campus, geo } = buildExport({ overridesDir: ov });
  const room = campus.rooms.find((r) => r.id === 'room-it-2-0214');
  assert.deepEqual([room.type, room.access, room.searchable], ['corridor', 'alt', false]);
  const hub = campus.navNodes.filter((x) => x.roomId === 'room-it-2-0214');
  assert.equal(hub.length, 1);
  assert.deepEqual([hub[0].type, hub[0].access], ['waypoint', 'alt']);
  assert.deepEqual(geo.classes.hubsMadeWaypoints, [hub[0].id]);
  assert.equal(checkConnectivity(campus, JSON.parse(fs.readFileSync(path.join(ROOT, 'data/campus-map/outdoor-graph.json'), 'utf8'))).ok, true);
});

test('applyAccess: a waypoint takes its hallway\'s class, the strictest on a shared boundary; others carry none', () => {
  const sq = (x0, x1) => [[x0, 0], [x1, 0], [x1, 100], [x0, 100]];
  const campus = {
    config: [{ key: 'dataVersion', value: 'x' }],
    rooms: [
      { id: 'h1', floorId: 'f', type: 'corridor', access: '', polygon: sq(0, 100), searchable: false },
      { id: 'h2', floorId: 'f', type: 'corridor', access: 'emergency', polygon: sq(100, 200), searchable: false },
      { id: 'r', floorId: 'f', type: 'office', access: '', polygon: sq(200, 300), searchable: true },
    ],
    navNodes: [
      { id: 'w1', floorId: 'f', type: 'waypoint', x: 50, y: 50, access: 'main' },
      { id: 'w2', floorId: 'f', type: 'waypoint', x: 150, y: 50, access: 'main' },
      { id: 'wb', floorId: 'f', type: 'waypoint', x: 100, y: 50, access: 'main' },
      { id: 'w3', floorId: 'f', type: 'waypoint', x: 250, y: 50, access: 'alt' },
      { id: 'd', floorId: 'f', type: 'door', x: 200, y: 50, access: '' },
      { id: 'hub', floorId: 'f', type: 'room', roomId: 'r', x: 250, y: 60, access: '' },
    ],
  };
  const rep = applyAccess(campus);
  const acc = Object.fromEntries(campus.navNodes.map((x) => [x.id, x.access]));
  assert.deepEqual(acc, { w1: 'main', w2: 'emergency', wb: 'emergency', w3: 'alt', d: 'main', hub: undefined });
  assert.deepEqual(campus.rooms.map((r) => r.access), ['main', 'emergency', undefined]);
  assert.equal(rep.waypointsInherited, 3);
  assert.equal(publishAltFactor(campus), 3);
  assert.deepEqual(campus.config[1], { key: 'routing.altFactor', value: 3 });
  campus.config[1].value = '1.5';
  assert.equal(publishAltFactor(campus), 1.5);
  campus.config[1].value = 'nonsense';
  assert.equal(publishAltFactor(campus), 3);
});

test('export: routing.altFactor is published (3) and editable through config.json', () => {
  const { campus } = buildExport({ overridesDir: dir({ 'config.json': [{ key: 'routing.altFactor', value: '2' }] }) });
  assert.deepEqual(campus.config.find((c) => c.key === 'routing.altFactor'), { key: 'routing.altFactor', value: 2 });
});

// ---- outdoor paths ----

test('outdoor paths: pathAccess.json reclasses a way (unknown ones reported); a drawn path carries its own access', () => {
  const { out, drawnId: id } = combined();
  const way = WAY;
  const road = ROAD;
  const edges = (w) => out.graph.edges.filter((e) => e.way === w);
  assert.ok(edges(way).length && edges(way).every((e) => e.access === 'alt'));
  assert.ok(edges(road).length && edges(road).every((e) => e.access === 'main'));
  assert.deepEqual(out.report.overrides.pathAccess.unknown, ['way/1']);
  assert.deepEqual(out.report.overrides.pathAccess.invalid, [{ way: 'way/2', access: 'emergency' }], 'paths have no emergency class');
  assert.ok(edges(id).length >= 1 && edges(id).every((e) => e.access === 'alt'), 'the drawn path is alt, way = its feature id');
  // the basemap layers carry the class the graph uses
  assert.equal(out.layers.paths.find((f) => f.properties.osmId === way).properties.access, 'alt');
  assert.equal(out.layers.paths.find((f) => f.properties.way === id).properties.access, 'alt');
  assert.equal(out.layers.roads.find((f) => f.properties.osmId === road).properties.access, 'main');
});

// ---- a building without floor plans: the nursing building drawn by the operator ----

const NURSING = [
  {
    type: 'Feature',
    properties: { layer: 'buildings', name: 'School of Nursing and Health Professions', building: 'university', buildingId: 'bld-nursing', levels: 3 },
    geometry: { type: 'Polygon', coordinates: [[[-88.323918, 36.613647], [-88.323478, 36.613647], [-88.323478, 36.614007], [-88.323918, 36.614007], [-88.323918, 36.613647]]] },
  },
  { type: 'Feature', properties: { layer: 'entrances', building: 'bld-nursing', access: 'main', label: 'West entrance' }, geometry: { type: 'Point', coordinates: [-88.323918, 36.613827] } },
  { type: 'Feature', properties: { layer: 'entrances', building: 'bld-nursing', access: 'emergency', label: 'East exit' }, geometry: { type: 'Point', coordinates: [-88.323478, 36.613827] } },
  { type: 'Feature', properties: { layer: 'entrances', access: 'alt' }, geometry: { type: 'Point', coordinates: [-88.3235, 36.6139] } },
];

test('drawn building and entrances (the nursing building): footprint matched, main entrance joined, emergency exit not', () => {
  const { out, features } = combined();
  assert.deepEqual(drawnEntrances(features).entrances.map((e) => [e.id, e.access, e.label]), [
    ['entrance-bld-nursing-1', 'main', 'West entrance'],
    ['entrance-bld-nursing-2', 'emergency', 'East exit'],
  ]);
  assert.deepEqual(drawnEntrances(features).rejected, [{ feature: features.length, why: 'no building id' }]);
  const fp = out.buildings.find((f) => f.properties.buildingId === 'bld-nursing');
  assert.ok(fp, 'the drawn footprint is the nursing building');
  assert.deepEqual([fp.properties.name, fp.properties.levels, fp.properties.height, fp.properties.source], ['School of Nursing and Health Professions', 3, 10.5, 'override']);
  const ent = out.graph.nodes.find((x) => x.id === 'entrance-bld-nursing-1');
  assert.deepEqual({ ...ent, lat: undefined, lng: undefined }, { id: 'entrance-bld-nursing-1', lat: undefined, lng: undefined, type: 'entrance', access: 'main', primary: true, buildingId: 'bld-nursing', label: 'West entrance' });
  assert.ok(out.graph.edges.some((e) => e.way === 'connector/entrance-bld-nursing-1'));
  assert.ok(!out.graph.nodes.some((x) => x.id === 'entrance-bld-nursing-2'), 'the emergency exit is not on the paths');
  assert.equal(out.report.graph.entrancesInMainComponent, true);

  // the export lists them as the building's entrances; the connectivity check counts the building
  const cm = dir({ 'overrides.geojson': { type: 'FeatureCollection', features } });
  const { campus, geo } = buildExport({ campusMapDir: cm });
  const b = campus.buildings.find((x) => x.id === 'bld-nursing');
  assert.deepEqual(b.entrances.map((e) => [e.nodeId, e.access, e.label]), [
    ['entrance-bld-nursing-1', 'main', 'West entrance'],
    ['entrance-bld-nursing-2', 'emergency', 'East exit'],
  ]);
  assert.equal(geo.drawn, 2);
  assert.equal(checkConnectivity(campus, out.graph).ok, true);
  // with only its emergency exit, the building would be unreachable
  const noMain = JSON.parse(JSON.stringify(campus));
  noMain.buildings.find((x) => x.id === 'bld-nursing').entrances.shift();
  assert.deepEqual(checkConnectivity(noMain, out.graph).unreachableBuildings, ['bld-nursing']);
});
