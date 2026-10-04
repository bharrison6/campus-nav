// The campus map style (src/web/WebApp_MapStyle.html): generated from design tokens, valid against MapLibre's own
// style spec (the @maplibre/maplibre-gl-style-spec package maplibre-gl depends on), basemap classification for both
// layouts the data contract allows, and the stacked-floor GeoJSON of the building view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { ROOT, loadInclude } from './load-include.mjs';

const S = loadInclude('WebApp_MapStyle.html', 'MSCNMapStyle');
const plain = (v) => JSON.parse(JSON.stringify(v));
// The real committed campus map (npm run campus-map): buildings and one file per basemap layer.
const MAP = join(ROOT, 'data', 'campus-map');
const buildings = JSON.parse(readFileSync(join(MAP, 'buildings.geojson'), 'utf8'));
const layers = readdirSync(join(MAP, 'layers')).filter((f) => f.endsWith('.geojson')).sort()
  .map((f) => ({ fc: JSON.parse(readFileSync(join(MAP, 'layers', f), 'utf8')), hint: f.replace(/\.geojson$/, '') }));

const tokens = (dark) => ({
  land: dark ? '#0e1723' : '#eef1f4', green: '#dbe8d3', water: '#bfd6ec', parking: '#e1e5eb', road: '#ffffff', roadCasing: '#cfd6df',
  path: '#ffffff', pathCasing: '#aab6c4', steps: '#8a6400', building: '#d6dce5', buildingIndoor: '#b9c8de', buildingSelected: '#f2c64d',
  slab: '#c9d2de', label: '#2a3747', labelMuted: '#5b6878', labelHalo: '#ffffff', route: '#0b57d0', routeCasing: '#ffffff',
  routeDim: '#8fb0e6', door: '#ecac00', gps: '#1a73e8', start: '#146c2e', dest: '#b3261e', lightIntensity: '0.38',
  room: { corridor: '#f7f8fa', restroom: '#d9e7f6', stair: '#f4e3b5', elevator: '#f4e3b5', storage: '#e9e4da', mechanical: '#e1e4e8', other: '#e7edf5' },
  roomOther: '#e7edf5',
});

test('the generated style is valid MapLibre style JSON, with and without the aerial layer, in both themes', () => {
  const base = S.mergeBase(layers);
  for (const dark of [false, true]) {
    for (const aerial of [null, { tiles: 'https://example.org/campus-nav/data/campus-map/aerial/{z}/{x}/{y}.jpg', minzoom: 15, maxzoom: 18 }]) {
      const style = plain(S.build(tokens(dark), { buildings, base, aerial, aerialVisible: !!aerial }));
      const errors = validateStyleMin(style);
      assert.deepEqual(errors.map((e) => e.message), [], `dark=${dark} aerial=${!!aerial}`);
      assert.equal(style.glyphs, undefined, 'no glyphs URL: labels are drawn from local fonts, nothing is fetched');
      assert.equal(style.layers.some((l) => l.id === 'aerial'), !!aerial);
      assert.equal(style.layers.find((l) => l.id === 'background').paint['background-color'], dark ? '#0e1723' : '#eef1f4');
      assert.match(style.sources['campus-buildings'].attribution, /OpenStreetMap/);
      for (const src of Object.values(style.sources)) {
        if (src.data && typeof src.data === 'string') assert.ok(!/^https?:/.test(src.data), 'no remote data source');
      }
    }
  }
});

test('the validator catches a broken style (positive control for the test above)', () => {
  const style = plain(S.build(tokens(false), { buildings, base: S.mergeBase(layers) }));
  style.layers.find((l) => l.id === 'paths').paint['line-width'] = 'wide';
  assert.ok(validateStyleMin(style).length > 0);
});

test('paint(tokens) covers every token-driven layer of the style (the theme switch reapplies it)', () => {
  const style = plain(S.build(tokens(false), { buildings, base: S.mergeBase(layers) }));
  const ids = new Set(style.layers.map((l) => l.id));
  for (const id of Object.keys(plain(S.paint(tokens(true))))) assert.ok(ids.has(id), id);
  assert.equal(style.layers.find((l) => l.id === 'buildings-3d').type, 'fill-extrusion');
});

test('basemap classification: one file with kinds, or one file per layer', () => {
  const f = (geomType, props) => ({ type: 'Feature', properties: props, geometry: { type: geomType, coordinates: [] } });
  assert.equal(S.classifyBase(f('LineString', { kind: 'footway' })), 'paths');
  assert.equal(S.classifyBase(f('LineString', { kind: 'steps' })), 'paths');
  assert.equal(S.classifyBase(f('LineString', { kind: 'residential' })), 'roads');
  assert.equal(S.classifyBase(f('LineString', { kind: 'service' })), 'roads');
  assert.equal(S.classifyBase(f('Polygon', { kind: 'parking' })), 'parking');
  assert.equal(S.classifyBase(f('Polygon', { kind: 'pond' })), 'water');
  assert.equal(S.classifyBase(f('Polygon', { kind: 'grass' })), 'landuse');
  assert.equal(S.classifyBase(f('Point', { name: 'The Quad' })), 'labels');
  assert.equal(S.classifyBase(f('Polygon', { kind: 'whatever' }), 'water'), 'water', 'a layers/<name>.geojson file name wins over guessing');
  assert.equal(S.classifyBase(f('LineString', { layer: 'paths' }), 'roads'), 'paths', 'an explicit layer property wins over the file name');
  const merged = plain(S.mergeBase([{ fc: { features: [f('LineString', { kind: 'steps' }), f('LineString', { kind: 'footway', steps: false })] }, hint: 'paths' }]));
  assert.deepEqual(merged.features.map((x) => [x.properties.layer, x.properties.steps]), [['paths', true], ['paths', false]]);
});

test('building view GeoJSON: one slab per floor at FLOOR_STEP spacing, rooms of the active floor tall, floors above faint', () => {
  const floors = [{ id: 'f1', level: 1 }, { id: 'f2', level: 2 }, { id: 'f3', level: 3 }];
  const sq = (x) => [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]];
  const roomsByFloor = {
    f1: [{ id: 'r1', type: 'corridor', polygon: sq(0) }],
    f2: [{ id: 'r2', type: 'restroom', polygon: sq(20) }, { id: 'r3', type: 'other', polygon: sq(40) }],
    f3: [{ id: 'r4', type: 'other', polygon: sq(60) }],
  };
  const seen = [];
  const project = (x, y, floorId) => { seen.push(floorId); return [-88.32 + x * 1e-6, 36.61 - y * 1e-6]; };
  const fc = plain(S.indoorFeatures({ floors, roomsByFloor, footprint: null, project, activeFloorId: 'f2', selectedRoomId: 'r3' }));
  // every vertex is projected in its own floor's frame (the georef module applies that floor's offset)
  assert.deepEqual([...new Set(seen)].sort(), ['f1', 'f2', 'f3']);
  assert.equal(seen.filter((f) => f === 'f2').length, 8, 'two rooms of four vertices on f2');
  const slabs = fc.features.filter((f) => f.properties.role === 'slab');
  assert.deepEqual(slabs.map((f) => [f.properties.floorId, f.properties.base, f.properties.above]), [['f1', 0, false], ['f2', S.FLOOR_STEP, false], ['f3', 2 * S.FLOOR_STEP, true]]);
  const rooms = fc.features.filter((f) => f.properties.role === 'room');
  assert.deepEqual(rooms.map((f) => f.properties.roomId), ['r1', 'r2', 'r3'], 'no rooms drawn above the active floor');
  const r2 = rooms.find((f) => f.properties.roomId === 'r2').properties;
  const r1 = rooms.find((f) => f.properties.roomId === 'r1').properties;
  assert.ok(r2.active && !r1.active);
  assert.ok(r2.top - r2.base > r1.top - r1.base, 'active rooms stand taller');
  assert.equal(rooms.find((f) => f.properties.roomId === 'r3').properties.selected, true);
  const ring = rooms[0].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'closed rings');
});
