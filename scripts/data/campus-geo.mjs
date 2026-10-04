// The map side of campus.json (v4): entrance coordinates, primary flags and building entrances, derived at export
// from the georeference records (data/georef/<buildingId>.json, written by npm run campus-map) through the one shared
// transform (src/shared/georef.mjs), so the exporter and the web app place a door at the same point.
//
//   navNodes of type entrance  gain lat, lng (when their building is georeferenced) and keep primary (boolean)
//   other navNodes             carry no primary field (the column exists for every node; only entrances use it)
//   buildings[].entrances      for a georeferenced indoor building: [{nodeId, lat, lng, label, primary}] from its
//                              published entrance nodes; other buildings keep theirs as authored
//   buildings[].levels/height  numbers when set, else removed (the campus map then uses its own footprint height)
import fs from 'node:fs';
import path from 'node:path';
import { svgBearingWith, svgToLngLatWith } from '../../src/shared/georef.mjs';

const COMPASS = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest'];
const R6 = (v) => Math.round(v * 1e6) / 1e6;
const toBool = (v) => v === true || /^(true|1|yes)$/i.test(String(v));

/** Reads every data/georef/*.json record: { buildingId -> record }. A missing directory is no records. */
export function readGeoref(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (rec && rec.buildingId && rec.transform) out[rec.buildingId] = rec;
  }
  return out;
}

/**
 * Outward bearings of the entrances the campus-map build scored (the entrances block of data/floorplans/<floor>.json):
 * { nodeId -> degrees from north }. A missing directory or block gives none.
 */
export function readEntranceFacing(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /^floor-.*.json$/.test(x)).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const e of j.entrances || []) if (e.outwardDeg != null) out[e.nodeId] = e.outwardDeg;
  }
  return out;
}

/**
 * The effective entrance set: the entrance nodes of a campus payload (the engine's output, data/overrides merged, so
 * a node the admin moved, put on another floor, added or deleted is where the admin left it), in the order given.
 * The exporter places exactly these on the map (addCampusGeo) and the campus-map build scores and joins exactly
 * these to the outdoor graph (scripts/campus-map/build.mjs), so the two cannot disagree on where a door is.
 * @return {Object[]} [{nodeId, floorId, x, y, node}]
 */
export function campusEntrances(campus) {
  return (campus.navNodes || []).filter((n) => n.type === 'entrance').map((n) => ({ nodeId: n.id, floorId: n.floorId, x: Number(n.x), y: Number(n.y), node: n }));
}

/** The compass side a door faces, from its outward bearing (degrees from north): North, Northeast, ... */
export function compassSide(bearingDeg) {
  return COMPASS[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}

/** "West entrance", "East entrance 2, level 2": the side the door faces, numbered when a building has several. */
export function entranceLabel(side, n, level) {
  return `${side} entrance${n > 1 ? ` ${n}` : ''}${level > 1 ? `, level ${level}` : ''}`;
}

/**
 * Adds the map fields to a campus payload in place (before the export hashes it). Returns a small report.
 * @param {Object} campus  getPublicCampusData() output
 * @param {Object} georef  { buildingId -> georef record }
 * @param {Object} [facing] { nodeId -> outward bearing } (readEntranceFacing); else the door's indoor neighbor decides
 */
export function addCampusGeo(campus, georef, facing = {}) {
  const floors = new Map(campus.floors.map((f) => [f.id, f]));
  const report = { entrances: 0, located: 0, primary: 0, buildingsWithEntrances: [] };
  const byBuilding = new Map();
  const nodeById = new Map(campus.navNodes.map((n) => [n.id, n]));
  const inner = new Map(); // entrance id -> the indoor node it opens from (same floor)
  for (const e of campus.navEdges) {
    const a = nodeById.get(e.fromNodeId);
    const b = nodeById.get(e.toNodeId);
    if (!a || !b || a.floorId !== b.floorId) continue;
    if (a.type === 'entrance' && !inner.has(a.id)) inner.set(a.id, b);
    if (b.type === 'entrance' && !inner.has(b.id)) inner.set(b.id, a);
  }
  for (const n of campus.navNodes) if (n.type !== 'entrance') delete n.primary;
  for (const { node: n, floorId, x, y } of campusEntrances(campus)) {
    report.entrances++;
    n.primary = toBool(n.primary);
    if (n.primary) report.primary++;
    const f = floors.get(floorId);
    const rec = f && georef[f.buildingId];
    if (!rec) continue;
    const [lng, lat] = svgToLngLatWith(rec, x, y, floorId);
    n.lat = R6(lat);
    n.lng = R6(lng);
    report.located++;
    if (!byBuilding.has(f.buildingId)) byBuilding.set(f.buildingId, []);
    const i = inner.get(n.id);
    const out = facing[n.id] != null ? facing[n.id] : i ? svgBearingWith(rec, x - Number(i.x), y - Number(i.y)) : null;
    byBuilding.get(f.buildingId).push({ n, level: Number(f.level) || 1, side: out == null ? 'Building' : compassSide(out) });
  }
  for (const b of campus.buildings) {
    const list = byBuilding.get(b.id);
    if (list && toBool(b.hasIndoor)) {
      const seen = {};
      b.entrances = list
        .sort((x, y) => (x.n.primary === y.n.primary ? (x.n.id < y.n.id ? -1 : 1) : x.n.primary ? -1 : 1))
        .map(({ n, level, side }) => {
          const k = side + '|' + level;
          seen[k] = (seen[k] || 0) + 1;
          return { nodeId: n.id, lat: n.lat, lng: n.lng, label: entranceLabel(side, seen[k], level), primary: n.primary };
        });
      report.buildingsWithEntrances.push(b.id);
    }
    for (const k of ['levels', 'height']) {
      const v = Number(b[k]);
      if (b[k] === '' || b[k] == null || !Number.isFinite(v) || v <= 0) delete b[k];
      else b[k] = v;
    }
  }
  return report;
}
