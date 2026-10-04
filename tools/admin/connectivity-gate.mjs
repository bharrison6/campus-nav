// The admin's save check (v5 data contract 6, Codex review v5 findings 3 and 4): before any save is written, the
// complete public data it would publish is built and the connectivity invariant run on it; a save after which any
// searchable room or any building with entrances has no route is refused, and nothing is written.
//
// "Complete" means both halves from the same proposed inputs, as publishing them would: the proposed data/overrides,
// path classes (pathAccess.json) and map overrides (overrides.geojson) go through the campus-map build in memory (the
// outdoor graph, the georeference records and the generated entrance classes, SeedCampusMap.gs), and then through the
// exporter with those records (the campus, its entrance nodes' positions and every building's entrances, the drawn
// ones included). So a footprint redraw, an entrance moved or given to another building, a deleted path and a hallway
// made emergency are all checked the same way. The build is cached by its inputs: a save that changes no map input
// (a room's type, a hallway's class, an edge) reuses the last build of the same inputs.
//
// The check is the shared one, scripts/data/connectivity.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConnectivity } from '../../scripts/data/connectivity.mjs';
import { writeOverrides } from '../../scripts/data/campus-engine.mjs';
import { canonical } from '../../scripts/data/overrides.mjs';
import { buildExport, GEOREF_DIR } from '../../scripts/data/export-campus-data.mjs';
import { formatGeo, formatPathAccess } from './map-overrides.mjs';

/** The save check and where it comes from (getAdminStatus shows the source). */
export const CONNECTIVITY = { check: checkConnectivity, source: 'scripts/data/connectivity.mjs' };

// The campus-map build, loaded ahead (saves are synchronous).
const [{ loadInputs: loadMapInputs }, { buildCampusMap }] = await Promise.all([import('../../scripts/campus-map/inputs.mjs'), import('../../scripts/campus-map/build.mjs')]);

/**
 * The campus and outdoor graph as the check must see them: an outdoor node that is also a campus node (an entrance)
 * takes the campus node's access, so a door's class on the campus side reaches the outdoor side. Returns copies.
 */
export function prepareForCheck(campus, graph) {
  const byId = new Map((campus.navNodes || []).map((n) => [n.id, n]));
  const nodes = ((graph && graph.nodes) || []).map((n) => (byId.has(n.id) ? { ...n, access: byId.get(n.id).access || 'main' } : n));
  return { campus, graph: { ...(graph || {}), nodes, edges: (graph && graph.edges) || [] } };
}

/** Runs the check on prepared copies. */
export function runCheck(check, campus, graph) {
  const p = prepareForCheck(campus, graph);
  return check(p.campus, p.graph);
}

const mapCache = new Map();
const MAP_CACHE_SIZE = 4;

/**
 * The campus-map build in memory (what npm run campus-map would write for these inputs): { graph, files }.
 * Cached by the inputs it reads from the overrides (navNodes, buildings, floors), the path classes and the map
 * overrides; the OpenStreetMap extract and floor plans are committed files that do not change while the admin runs.
 */
export function mapBuildInMemory({ overridesDir, overrides, geo, pathAccess }) {
  const key = canonical({ n: overrides.navNodes || [], b: overrides.buildings || [], f: overrides.floors || [], pathAccess, geo });
  if (mapCache.has(key)) return mapCache.get(key);
  const out = buildCampusMap({ ...loadMapInputs({ overridesDir }), overridesGeo: geo, pathAccessOverrides: pathAccess });
  const built = { graph: out.graph, files: out.files };
  mapCache.set(key, built);
  if (mapCache.size > MAP_CACHE_SIZE) mapCache.delete(mapCache.keys().next().value);
  return built;
}

/**
 * The public data a save would publish: { campus, graph }.
 * @param {Object} o
 * @param {Object} o.overrides   data/overrides collections as they would be saved
 * @param {Object} o.geo         overrides.geojson as it would be saved
 * @param {Object[]} o.pathAccess pathAccess.json as it would be saved
 * @param {string} [o.gsDir] @param {string} [o.extraCode]  the admin's backend (tests)
 * @param {Function} [o.mapBuild] ({overridesDir, overrides, geo, pathAccess}) -> {graph, files} (default mapBuildInMemory)
 */
export function proposedPublicData({ overrides, geo, pathAccess = [], gsDir, extraCode, mapBuild = mapBuildInMemory }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-gate-'));
  try {
    const overridesDir = path.join(tmp, 'overrides');
    writeOverrides(overridesDir, overrides);
    fs.writeFileSync(path.join(overridesDir, 'pathAccess.json'), formatPathAccess(pathAccess));
    const built = mapBuild({ overridesDir, overrides, geo, pathAccess });
    const files = built.files || {};
    // the georeference records: the committed ones, replaced by what the build would write
    const georefDir = path.join(tmp, 'georef');
    fs.mkdirSync(georefDir);
    if (fs.existsSync(GEOREF_DIR)) for (const f of fs.readdirSync(GEOREF_DIR).filter((x) => x.endsWith('.json'))) fs.copyFileSync(path.join(GEOREF_DIR, f), path.join(georefDir, f));
    for (const [rel, text] of Object.entries(files)) if (/^data\/georef\/[^/]+\.json$/.test(rel)) fs.writeFileSync(path.join(georefDir, path.basename(rel)), text);
    const campusMapDir = path.join(tmp, 'campus-map');
    fs.mkdirSync(campusMapDir);
    fs.writeFileSync(path.join(campusMapDir, 'overrides.geojson'), formatGeo(geo));
    const seed = files['tools/admin/gs/SeedCampusMap.gs'];
    const code = [extraCode, seed].filter(Boolean).join('\n;\n') || undefined;
    const campus = buildExport({ gsDir, overridesDir, georefDir, campusMapDir, extraCode: code }).campus;
    return { campus, graph: built.graph };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Rooms and buildings by id as the refusal names them: "EP 1322" for room-ep-1-1322, a building by its name. */
export function describeUnreachable(result, campus) {
  const code = new Map((campus.buildings || []).map((b) => [b.id, b.code || b.name || b.id]));
  const floorB = new Map((campus.floors || []).map((f) => [f.id, f.buildingId]));
  const rooms = new Map((campus.rooms || []).map((r) => [r.id, r]));
  const names = new Map((campus.buildings || []).map((b) => [b.id, b.name || b.id]));
  return {
    rooms: (result.unreachableRooms || []).map((id) => { const r = rooms.get(id); return { id, label: r ? `${code.get(floorB.get(r.floorId)) || ''} ${r.label || r.number || id}`.trim() : id }; }),
    buildings: (result.unreachableBuildings || []).map((id) => ({ id, label: names.get(id) || id })),
  };
}

/** An Error carrying the refusal: err.refused = { rooms: [{id, label}], buildings: [{id, label}] }. */
export function refusal(described, what) {
  const parts = [];
  if (described.rooms.length) parts.push(`${described.rooms.length} room(s): ${described.rooms.map((r) => r.label).join(', ')}`);
  if (described.buildings.length) parts.push(`${described.buildings.length} building(s): ${described.buildings.map((b) => b.label).join(', ')}`);
  const err = new Error(`Refused: ${what} would leave ${parts.join('; ')} with no route. Nothing was saved.`);
  err.refused = described;
  return err;
}

