// Access classes in the published campus data (v5, plan mscn-v5-access-classes-and-editors).
//
//   rooms of type corridor             access "main" | "alt" | "emergency" (default main); other rooms carry none
//   navNodes door, entrance, waypoint  access (default main); other nodes carry none
//   a waypoint inside a corridor       takes that corridor's access (on the boundary of several: the strictest), so an
//                                      admin's change to a hallway's class reaches routing
//   a room the overrides make a        its hub node becomes a waypoint with the corridor's access (routes pass through
//   corridor                           it as through a hallway) and the room stops being searchable
//
// Runs on the engine's output (getPublicCampusData: seed + pipeline + data/overrides merged, so the effective room
// types and classes are already in it) before the map fields are added and the export is hashed. Pure, in place.

import { ACCESS_CLASSES } from './overrides.mjs';

export { ACCESS_CLASSES };
const RANK = { main: 0, alt: 1, emergency: 2 };
const CLASSED_NODES = new Set(['door', 'entrance', 'waypoint']);
/** A boundary waypoint (an area line between two hallways) counts as in a hallway this close to it, in SVG units. */
const EDGE_TOLERANCE = 12;

const toBool = (v) => v === true || /^(true|1|yes)$/i.test(String(v));
const norm = (v) => (ACCESS_CLASSES.includes(v) ? v : 'main');

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

const polygonOf = (r) => {
  const p = typeof r.polygon === 'string' ? JSON.parse(r.polygon || '[]') : r.polygon;
  return Array.isArray(p) && p.length >= 3 ? p : null;
};

/**
 * Applies the access rules to a campus payload in place.
 * @return {{rooms: Object, nodes: Object, corridors: number, hubsMadeWaypoints: string[], waypointsInherited: number}}
 */
export function applyAccess(campus) {
  const report = { rooms: {}, nodes: {}, corridors: 0, hubsMadeWaypoints: [], waypointsInherited: 0 };
  const corridorsByFloor = new Map();
  for (const r of campus.rooms) {
    if (r.type !== 'corridor') {
      delete r.access;
      continue;
    }
    r.access = norm(r.access);
    report.corridors++;
    report.rooms[r.access] = (report.rooms[r.access] || 0) + 1;
    const ring = polygonOf(r);
    if (!ring) continue;
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const box = [Math.min(...xs) - EDGE_TOLERANCE, Math.min(...ys) - EDGE_TOLERANCE, Math.max(...xs) + EDGE_TOLERANCE, Math.max(...ys) + EDGE_TOLERANCE];
    if (!corridorsByFloor.has(r.floorId)) corridorsByFloor.set(r.floorId, []);
    corridorsByFloor.get(r.floorId).push({ room: r, ring, box });
  }
  const corridorById = new Map(campus.rooms.filter((r) => r.type === 'corridor').map((r) => [r.id, r]));
  for (const n of campus.navNodes) {
    // A room the operator made a hallway: its hub is a point on the hallway now.
    const c = n.type === 'room' && n.roomId ? corridorById.get(n.roomId) : null;
    if (c) {
      n.type = 'waypoint';
      n.access = c.access;
      if (toBool(c.searchable)) c.searchable = false;
      report.hubsMadeWaypoints.push(n.id);
    }
    if (!CLASSED_NODES.has(n.type)) {
      delete n.access;
      continue;
    }
    n.access = norm(n.access);
    if (n.type !== 'waypoint' || c) continue;
    const x = Number(n.x);
    const y = Number(n.y);
    let cls = null;
    for (const k of corridorsByFloor.get(n.floorId) || []) {
      if (x < k.box[0] || y < k.box[1] || x > k.box[2] || y > k.box[3]) continue;
      if (!inRing(x, y, k.ring) && distToRing(x, y, k.ring) > EDGE_TOLERANCE) continue;
      if (cls === null || RANK[k.room.access] > RANK[cls]) cls = k.room.access;
    }
    if (cls !== null) {
      n.access = cls;
      report.waypointsInherited++;
    }
  }
  for (const n of campus.navNodes) {
    if (!n.access) continue;
    const k = n.type;
    report.nodes[k] = report.nodes[k] || {};
    report.nodes[k][n.access] = (report.nodes[k][n.access] || 0) + 1;
  }
  return report;
}

/** A numeric routing.<name> config row: a missing row is added, a malformed or out-of-range value set to the default. */
function publishRoutingNumber(campus, name, dflt, ok) {
  const key = `routing.${name}`;
  let row = campus.config.find((c) => c.key === key);
  if (!row) {
    row = { key, value: dflt };
    campus.config.push(row);
  }
  const v = row.value === '' || row.value === null ? NaN : Number(row.value);
  row.value = Number.isFinite(v) && ok(v) ? v : dflt;
  return row.value;
}

/** routing.altFactor in the config rows: a positive number, default 3 (a missing or malformed row is set to 3). */
export function publishAltFactor(campus, dflt = 3) {
  return publishRoutingNumber(campus, 'altFactor', dflt, (v) => v > 0);
}

/**
 * routing.altDoorCost in the config rows: the meters a route pays once for each alt door or entrance it passes through,
 * on top of altFactor (0 or more, default 300; measured on the real campus: below about 280 routes from across campus
 * still enter IT by its side door it-2-n0551, because the main doors' approach walks more road, which is alt).
 */
export function publishAltDoorCost(campus, dflt = 300) {
  return publishRoutingNumber(campus, 'altDoorCost', dflt, (v) => v >= 0);
}
