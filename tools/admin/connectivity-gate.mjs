// The admin's save check (v5 data contract 6): before a save is written, the effective data it would publish is built
// and the connectivity invariant run on it; a save that cuts off a room or a building is refused.
//
// "Cuts off" means: reachable before the save, unreachable after. A room or building that was already unreachable (or
// that the save itself adds unwired) does not block a save, so one pre-existing gap never freezes the editor; the
// test suite keeps the real data at zero.
//
// The check is the shared one, scripts/data/connectivity.mjs, run on the published campus the exporter builds for the
// proposed overrides (buildExport, which also gives each waypoint its hallway's class).
import { checkConnectivity } from '../../scripts/data/connectivity.mjs';

/** The save check and where it comes from (getAdminStatus shows the source). */
export const CONNECTIVITY = { check: checkConnectivity, source: 'scripts/data/connectivity.mjs' };

/**
 * The campus and outdoor graph as the check must see them: an outdoor node that is also a campus node (an entrance)
 * takes the campus node's access, so an admin change to a door reaches the outdoor side before npm run campus-map has
 * rerun. Returns copies; the inputs are not changed.
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
