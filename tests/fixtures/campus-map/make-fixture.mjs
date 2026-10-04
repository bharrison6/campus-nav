// FIXTURE for lane K (MSCN v4) until lane J's real campus-map data lands. Writes, under this folder, the files the
// plan's data contract names, small and hand-checkable:
//   data/campus-map/buildings.geojson    IT and EP footprints (hull of their floor-1 rooms through the georef) + 8 neighbors
//   data/campus-map/basemap.geojson      paths (from the graph edges), two roads, parking, a green, a pond, labels
//   data/campus-map/outdoor-graph.json   rings around IT and EP, a quad hub, a steps shortcut vs. a longer ramp, a far corner
//   data/georef/bld-it.json, bld-ep.json transforms that put each floor frame's center on the seeded building point
// The georef math is ./src/shared/georef.mjs (the stand-in for J's module). Run: node tests/fixtures/campus-map/make-fixture.mjs
// Swap at integration: delete MSCN_CAMPUS_MAP_ROOT from the e2e config; the build then reads the real data/campus-map/**,
// data/georef/** and src/shared/georef.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lngLatToSvg, svgToLngLat } from './src/shared/georef.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const OUT = join(here, 'data');
const R = 6371000;
const D2R = Math.PI / 180;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;

const SEED = {
  'bld-it': { lat: 36.615712, lng: -88.322748, name: 'Collins Industry and Technology Center', floor: 'floor-it-1', levels: 2 },
  'bld-ep': { lat: 36.612114, lng: -88.324838, name: 'Engineering and Physics Building', floor: 'floor-ep-1', levels: 2 },
};
const NEIGHBORS = [
  ['bld-nash', 'Nash House', 36.611581, -88.324721, 2],
  ['bld-central-plant', 'Central Heating and Cooling Plant', 36.615038, -88.32344, 2],
  ['bld-cb', 'Jesse D. Jones Hall (Chemistry Building)', 36.612529, -88.325798, 3],
  ['bld-bl', 'Blackburn Science Building', 36.614806, -88.322556, 3],
  ['bld-bauernfeind', 'Arthur J. Bauernfeind College of Business', 36.611723, -88.323687, 3],
  ['bld-we', 'Wells Hall', 36.612407, -88.323633, 3],
  [null, 'Storage Shed', 36.6135, -88.3215, 1],
];
// Primary entrances chosen by hand for the fixture (J's heuristic picks the real ones).
const PRIMARY = { 'bld-it': ['it-1-n0489', 'it-1-n0493', 'it-1-n0492'], 'bld-ep': ['ep-1-n0359', 'ep-1-n0363', 'ep-1-n0356'] };

function hav(a, b) {
  const dLat = (b[1] - a[1]) * D2R, dLng = (b[0] - a[0]) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const offset = (p, east, north) => [p[0] + east / (R * Math.cos(p[1] * D2R)) / D2R, p[1] + north / R / D2R];
function hull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function thin(ring, minMeters) {
  const out = [];
  for (const p of ring) if (!out.length || hav(out[out.length - 1], p) >= minMeters) out.push(p);
  if (out.length > 3 && hav(out[0], out[out.length - 1]) < minMeters) out.pop();
  return out;
}
const centroid = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const rect = (c, w, h) => [offset(c, -w / 2, -h / 2), offset(c, w / 2, -h / 2), offset(c, w / 2, h / 2), offset(c, -w / 2, h / 2)];
const closed = (ring) => ring.concat([ring[0]]).map((p) => [r6(p[0]), r6(p[1])]);

// ---- georef: the floor frame's center lands on the seeded building point, no rotation
const georef = {};
const floorData = {};
for (const [id, s] of Object.entries(SEED)) {
  const f = JSON.parse(readFileSync(join(ROOT, 'data', 'floorplans', s.floor + '.json'), 'utf8'));
  floorData[id] = f;
  const mpu = f.metersPerPixel || 0.0254;
  const proto = { transform: { originLat: s.lat, originLng: s.lng, rotationDeg: 0, metersPerUnit: mpu } };
  const [cx, cy] = [f.widthPx / 2, f.heightPx / 2];
  const at = svgToLngLat(proto, cx, cy); // where the center would land with origin at the seed
  const origin = [s.lng - (at[0] - s.lng), s.lat - (at[1] - s.lat)];
  georef[id] = {
    buildingId: id, floorFrame: 'svg',
    transform: { originLat: r6(origin[1]) , originLng: r6(origin[0]), rotationDeg: 0, metersPerUnit: mpu },
    method: 'fixture: frame center on the seeded building point (lane K stand-in)', residualMeters: 0, fittedTo: 'fixture',
  };
}

// ---- buildings.geojson
const features = [];
const footprint = {};
for (const [id, s] of Object.entries(SEED)) {
  const pts = [];
  for (const room of floorData[id].rooms) for (const p of room.polygon || []) pts.push(svgToLngLat(georef[id], p[0], p[1]));
  footprint[id] = thin(hull(pts), 4);
  features.push({ type: 'Feature', id: features.length + 1, properties: { osmId: 'fixture/' + id, buildingId: id, name: s.name, height: s.levels * 4.2, levels: s.levels, source: 'default' },
    geometry: { type: 'Polygon', coordinates: [closed(footprint[id])] } });
}
for (const [id, name, lat, lng, levels] of NEIGHBORS) {
  features.push({ type: 'Feature', id: features.length + 1, properties: { osmId: 'fixture/' + (id || 'shed'), buildingId: id, name, height: levels * 3.5, levels, source: 'default' },
    geometry: { type: 'Polygon', coordinates: [closed(rect([lng, lat], 44, 26))] } });
}

// ---- outdoor graph
const nodes = [];
const edges = [];
const byId = {};
function node(id, p, type = 'path', extra = {}) { const n = { id, lat: r6(p[1]), lng: r6(p[0]), type, ...extra }; nodes.push(n); byId[id] = n; return n; }
function edge(a, b, opts = {}) {
  const A = byId[a], B = byId[b];
  edges.push({ id: 'oe' + (edges.length + 1), from: a, to: b, distance: r1(hav([A.lng, A.lat], [B.lng, B.lat])), accessible: opts.steps ? false : true,
    kind: opts.kind || (opts.steps ? 'steps' : 'footway'), ...(opts.name ? { name: opts.name } : {}) });
}
const ringIds = {};
for (const [id] of Object.entries(SEED)) {
  const c = centroid(footprint[id]);
  const ring = thin(footprint[id].map((p) => {
    const d = hav(c, p); const k = (d + 9) / d; return [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
  }), 12);
  ringIds[id] = ring.map((p, i) => node(`${id}-ring-${i}`, p).id);
  for (let i = 0; i < ring.length; i++) edge(ringIds[id][i], ringIds[id][(i + 1) % ring.length], { name: i === 0 ? null : undefined });
}
function nearestOf(ids, p) { let best = null, bd = Infinity; for (const id of ids) { const n = byId[id]; const d = hav([n.lng, n.lat], p); if (d < bd) { bd = d; best = id; } } return best; }
// entrances: every floor-1 entrance node (primary flagged), joined to the nearest ring vertex
for (const [id] of Object.entries(SEED)) {
  for (const n of floorData[id].nav.nodes.filter((x) => x.type === 'entrance')) {
    const p = svgToLngLat(georef[id], n.x, n.y);
    node(n.id, p, 'entrance', { buildingId: id, primary: PRIMARY[id].includes(n.id) });
    edge(n.id, nearestOf(ringIds[id], p), { kind: 'footway' });
  }
}
// hub between the two buildings, 60 m east of the midpoint; IT side by a plain walk with a crossing
const itC = [SEED['bld-it'].lng, SEED['bld-it'].lat], epC = [SEED['bld-ep'].lng, SEED['bld-ep'].lat];
const mid = [(itC[0] + epC[0]) / 2, (itC[1] + epC[1]) / 2];
const hub = node('quad-hub', offset(mid, 60, 0));
const itGate = nearestOf(ringIds['bld-it'], [hub.lng, hub.lat]);
node('quad-n1', offset([hub.lng, hub.lat], 0, 70));
node('quad-x1', offset([hub.lng, hub.lat], 0, 140), 'crossing');
edge('quad-hub', 'quad-n1', { name: 'Quad Walk' }); edge('quad-n1', 'quad-x1', { kind: 'crossing' }); edge('quad-x1', itGate);
// EP side: a short flight of steps vs. a longer step-free ramp
const epGate = nearestOf(ringIds['bld-ep'], [hub.lng, hub.lat]);
const g = byId[epGate];
node('steps-top', offset([g.lng, g.lat], 30, 45));
node('steps-bottom', offset([g.lng, g.lat], 12, 15));
edge('quad-hub', 'steps-top'); edge('steps-top', 'steps-bottom', { steps: true }); edge('steps-bottom', epGate);
node('ramp-1', offset([hub.lng, hub.lat], 70, -60));
node('ramp-2', offset([g.lng, g.lat], 75, -20));
edge('quad-hub', 'ramp-1', { name: 'Ramp Walk' }); edge('ramp-1', 'ramp-2'); edge('ramp-2', epGate);
// far corner of campus (south-west), for long routes and the GPS start
node('far-corner', offset(epC, -380, -260));
node('far-1', offset(epC, -250, -160));
edge('far-corner', 'far-1'); edge('far-1', nearestOf(ringIds['bld-ep'], [byId['far-1'].lng, byId['far-1'].lat]));

const graph = { fixture: true, nodes, edges };

// ---- basemap.geojson: paths from the graph, plus the other layers
const base = [];
for (const e of edges) {
  const A = byId[e.from], B = byId[e.to];
  if (A.type === 'entrance' || B.type === 'entrance') continue;
  base.push({ type: 'Feature', properties: { layer: 'paths', kind: e.kind, steps: e.kind === 'steps', name: e.name || '' },
    geometry: { type: 'LineString', coordinates: [[A.lng, A.lat], [B.lng, B.lat]] } });
}
const road = (name, a, b, kind = 'road') => base.push({ type: 'Feature', properties: { layer: 'roads', kind, name }, geometry: { type: 'LineString', coordinates: [a, b].map((p) => [r6(p[0]), r6(p[1])]) } });
road('North 16th Street', offset(epC, -170, -320), offset(itC, -230, 250));
road('Chestnut Street', offset(itC, -500, 230), offset(itC, 450, 230));
road('Service Drive', offset(epC, 130, -60), offset(itC, 160, 0), 'service');
const poly = (layer, kind, name, ring) => base.push({ type: 'Feature', properties: { layer, kind, name }, geometry: { type: 'Polygon', coordinates: [closed(ring)] } });
poly('parking', 'parking', 'Lot 12', rect(offset(epC, 150, 40), 70, 45));
poly('landuse', 'grass', 'The Quad', rect(offset([hub.lng, hub.lat], 40, 30), 120, 160));
poly('water', 'pond', 'Fixture Pond', rect(offset(itC, 210, -60), 40, 28));
base.push({ type: 'Feature', properties: { layer: 'labels', kind: 'place', name: 'The Quad' }, geometry: { type: 'Point', coordinates: [r6(hub.lng + 0.0004), r6(hub.lat)] } });

const write = (rel, obj) => { const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 1) + '\n'); };
write('campus-map/buildings.geojson', { type: 'FeatureCollection', fixture: true, features });
write('campus-map/basemap.geojson', { type: 'FeatureCollection', fixture: true, features: base });
write('campus-map/outdoor-graph.json', graph);
for (const [id, g] of Object.entries(georef)) write(`georef/${id}.json`, g);
const check = lngLatToSvg(georef['bld-it'], ...svgToLngLat(georef['bld-it'], 100, 200));
console.log(`fixture: ${features.length} buildings, ${base.length} basemap features, graph ${nodes.length} nodes / ${edges.length} edges; round trip ${check.map(r1)}`);
