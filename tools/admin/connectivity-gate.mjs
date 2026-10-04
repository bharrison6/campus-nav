// The admin's save check (v5 data contract 6): before a save is written, the effective data it would publish is built
// and the connectivity invariant run on it; a save that cuts off a room or a building is refused.
//
// "Cuts off" means: reachable before the save, unreachable after. A room or building that was already unreachable (or
// that the save itself adds unwired) does not block a save, so one pre-existing gap never freezes the editor; the
// test suite (lane P) keeps the real data at zero.
//
// checkConnectivity comes from scripts/data/connectivity.mjs when that module exists (the data lane's shared check),
// else from the local stand-in next to this file.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../../scripts/data/campus-engine.mjs';
import { checkConnectivity as standIn } from './connectivity-standin.mjs';

const SHARED = path.join(REPO, 'scripts', 'data', 'connectivity.mjs');

/** { check, source }: the shared check when present, else the stand-in. */
export async function loadCheckConnectivity(sharedPath = SHARED) {
  if (fs.existsSync(sharedPath)) {
    const m = await import(pathToFileURL(sharedPath).href);
    if (typeof m.checkConnectivity === 'function') return { check: m.checkConnectivity, source: path.relative(REPO, sharedPath).replace(/\\/g, '/') };
  }
  return { check: standIn, source: 'tools/admin/connectivity-standin.mjs (stand-in until scripts/data/connectivity.mjs lands)' };
}

const inside = (x, y, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/**
 * The campus and outdoor graph as the check must see them:
 *  - a waypoint without its own access inherits the access of the corridor it stands in (contract 1; the exporter
 *    does this once lane P lands, and then every waypoint already carries one);
 *  - an outdoor node that is also a campus node (an entrance) takes the campus node's access, so an admin change to a
 *    door reaches the outdoor side before npm run campus-map has rerun.
 * Returns copies; the inputs are not changed.
 */
export function prepareForCheck(campus, graph) {
  const corridors = (campus.rooms || []).filter((r) => r.type === 'corridor' && r.access && r.access !== 'main' && Array.isArray(r.polygon) && r.polygon.length > 2);
  const navNodes = (campus.navNodes || []).map((n) => {
    if (n.type !== 'waypoint' || n.access) return n;
    const c = corridors.find((r) => r.floorId === n.floorId && inside(Number(n.x), Number(n.y), r.polygon));
    return c ? { ...n, access: c.access } : n;
  });
  const byId = new Map(navNodes.map((n) => [n.id, n]));
  const nodes = ((graph && graph.nodes) || []).map((n) => (byId.has(n.id) ? { ...n, access: byId.get(n.id).access || 'main' } : n));
  return { campus: { ...campus, navNodes }, graph: { ...(graph || {}), nodes, edges: (graph && graph.edges) || [] } };
}

/** Runs the check on prepared copies. */
export function runCheck(check, campus, graph) {
  const p = prepareForCheck(campus, graph);
  return check(p.campus, p.graph);
}

/**
 * What a save cuts off: reachable before, unreachable after (rooms and buildings that existed before).
 * @return {{ rooms: string[], buildings: string[] }}
 */
export function cutOffs(before, after, campusBefore) {
  const roomsBefore = new Set((campusBefore.rooms || []).map((r) => r.id));
  const bldBefore = new Set((campusBefore.buildings || []).map((b) => b.id));
  const wasBadR = new Set(before.unreachableRooms || []);
  const wasBadB = new Set(before.unreachableBuildings || []);
  return {
    rooms: (after.unreachableRooms || []).filter((r) => roomsBefore.has(r) && !wasBadR.has(r)),
    buildings: (after.unreachableBuildings || []).filter((b) => bldBefore.has(b) && !wasBadB.has(b)),
  };
}

/** Rooms and buildings by id as the refusal names them: "EP 1322 (room-ep-1-1322)". */
export function describeCutOffs(cut, campus) {
  const code = new Map((campus.buildings || []).map((b) => [b.id, b.code || b.name || b.id]));
  const floorB = new Map((campus.floors || []).map((f) => [f.id, f.buildingId]));
  const rooms = new Map((campus.rooms || []).map((r) => [r.id, r]));
  const names = new Map((campus.buildings || []).map((b) => [b.id, b.name || b.id]));
  return {
    rooms: cut.rooms.map((id) => { const r = rooms.get(id); return { id, label: r ? `${code.get(floorB.get(r.floorId)) || ''} ${r.label || r.number || id}`.trim() : id }; }),
    buildings: cut.buildings.map((id) => ({ id, label: names.get(id) || id })),
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
