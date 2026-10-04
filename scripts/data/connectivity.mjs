// The connectivity invariant (v5, plan mscn-v5-access-classes-and-editors, contract item 6): over the published
// campus data and the outdoor graph, with every emergency node and edge (indoor and outdoor) removed and alt doors,
// hallways and paths allowed (the app's findPath walks exactly these),
//   every searchable room reaches every other searchable room, and
//   every building with mapped entrances is reachable from every other.
// Floors change through the stair and elevator links (navEdges with floorChange). The indoor and outdoor graphs join
// at entrance node ids, as the app's router joins them.
//
//   import { checkConnectivity } from './connectivity.mjs';
//   const r = checkConnectivity(campus, outdoorGraph);
//   // { ok, unreachableRooms: [roomId], unreachableBuildings: [buildingId], components: [{size, rooms, buildings}] }
//
// One check for every consumer: npm test runs it on the real data (tests/unit/connectivity.unit.mjs) and the local
// admin runs it on the effective data before it writes a save. Pure: reads its arguments, changes nothing.

import { normalizeAccess } from './overrides.mjs';

const toBool = (v) => v === true || /^(true|1|yes)$/i.test(String(v));
const isEmergency = (n) => !!n && normalizeAccess(n.access) === 'emergency';

/**
 * @param {Object} campus        published campus data ({rooms, navNodes, navEdges, buildings}; hidden floors absent)
 * @param {Object} [outdoorGraph] data/campus-map/outdoor-graph.json ({nodes, edges}); omitted, indoor only
 * @return {{ok: boolean, unreachableRooms: string[], unreachableBuildings: string[], components: Object[]}}
 *   components: the connected parts that hold a searchable room or a building entrance, largest first; the first is
 *   the one the others are measured against (the one holding the most outdoor nodes, else the most rooms)
 */
export function checkConnectivity(campus, outdoorGraph = null) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const next = parent.get(x);
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const outdoorIds = new Set();
  for (const n of campus.navNodes || []) if (!isEmergency(n)) parent.set(n.id, n.id);
  if (outdoorGraph) {
    for (const n of outdoorGraph.nodes || []) {
      if (isEmergency(n)) {
        parent.delete(n.id); // an emergency entrance is closed on both sides
        continue;
      }
      if (!parent.has(n.id)) parent.set(n.id, n.id);
      outdoorIds.add(n.id);
    }
  }
  // An entrance the indoor data marks emergency stays closed even if an older outdoor graph still joins it.
  for (const n of campus.navNodes || []) if (isEmergency(n)) parent.delete(n.id);
  for (const e of campus.navEdges || []) if (!isEmergency(e)) union(e.fromNodeId, e.toNodeId);
  if (outdoorGraph) for (const e of outdoorGraph.edges || []) if (!isEmergency(e)) union(e.from, e.to);

  // Where each searchable room is: the node that stands for it (its hub; stairs and elevators are their own hubs).
  const roomNode = new Map();
  for (const n of campus.navNodes || []) if (n.roomId && !roomNode.has(n.roomId) && /^(room|stair|elevator)$/.test(n.type)) roomNode.set(n.roomId, n.id);
  const rooms = (campus.rooms || []).filter((r) => toBool(r.searchable));
  const buildings = (campus.buildings || []).filter((b) => Array.isArray(b.entrances) && b.entrances.some((e) => e && e.nodeId));

  const comps = new Map();
  const compOf = (id) => {
    const c = find(id);
    if (!comps.has(c)) comps.set(c, { root: c, size: 0, outdoor: 0, rooms: 0, buildings: 0 });
    return comps.get(c);
  };
  for (const id of parent.keys()) {
    const c = compOf(id);
    c.size++;
    if (outdoorIds.has(id)) c.outdoor++;
  }
  const roomComp = new Map();
  for (const r of rooms) {
    const id = roomNode.get(r.id);
    if (!id || !parent.has(id)) continue;
    const c = compOf(id);
    c.rooms++;
    roomComp.set(r.id, c.root);
  }
  const buildingComps = new Map();
  for (const b of buildings) {
    const set = new Set();
    for (const e of b.entrances) if (e.nodeId && parent.has(e.nodeId) && !isEmergency(e)) set.add(find(e.nodeId));
    buildingComps.set(b.id, set);
    for (const c of set) comps.get(c).buildings++;
  }

  const relevant = [...comps.values()].filter((c) => c.rooms || c.buildings);
  relevant.sort((a, b) => b.outdoor - a.outdoor || b.rooms - a.rooms || b.size - a.size);
  const main = relevant.length ? relevant[0].root : null;
  const unreachableRooms = rooms.filter((r) => roomComp.get(r.id) !== main || main === null).map((r) => r.id);
  const unreachableBuildings = buildings.filter((b) => !buildingComps.get(b.id).has(main)).map((b) => b.id);
  return {
    ok: !unreachableRooms.length && !unreachableBuildings.length,
    unreachableRooms,
    unreachableBuildings,
    components: relevant.map((c) => ({ size: c.size, rooms: c.rooms, buildings: c.buildings, outdoorNodes: c.outdoor })),
  };
}

/** One line per finding, for logs and the admin's refusal message. */
export function describeConnectivity(r, { rooms = [] } = {}) {
  if (r.ok) return ['connectivity: every searchable room and every building with entrances is reachable'];
  const label = new Map(rooms.map((x) => [x.id, x.label || x.number || x.id]));
  const lines = [];
  if (r.unreachableRooms.length) lines.push(`unreachable rooms (${r.unreachableRooms.length}): ${r.unreachableRooms.map((id) => `${id}${label.has(id) ? ` (${label.get(id)})` : ''}`).join(', ')}`);
  if (r.unreachableBuildings.length) lines.push(`unreachable buildings (${r.unreachableBuildings.length}): ${r.unreachableBuildings.join(', ')}`);
  return lines;
}
