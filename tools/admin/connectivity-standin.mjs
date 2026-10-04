// A local stand-in for scripts/data/connectivity.mjs (lane P, v5 data contract 6), used by the admin's save check
// only while that module is absent; tools/admin/connectivity-gate.mjs prefers the real one. Same interface:
//
//   checkConnectivity(campus, outdoorGraph) -> { ok, unreachableRooms: [roomId], unreachableBuildings: [buildingId],
//                                                components }
//
// over the published campus data (navNodes, navEdges, rooms, buildings) plus the outdoor graph, with emergency nodes
// removed and alt allowed (alt only costs more): every searchable room must reach every other searchable room, and
// every building with mapped entrances must be reachable from every other. Indoor and outdoor graphs join at shared
// node ids (an entrance node id is the same in both). The reference component is the one holding the most searchable
// rooms; whatever lies outside it is unreachable. Never published: the build copies nothing from tools/admin.

const truthy = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || String(v).toLowerCase() === 'true');

export function checkConnectivity(campus, outdoorGraph) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const add = (id) => { if (!parent.has(id)) parent.set(id, id); };
  const union = (a, b) => { if (parent.has(a) && parent.has(b)) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); } };
  const emergency = new Set();
  const isEmergency = (n) => n && n.access === 'emergency';

  for (const n of campus.navNodes || []) (isEmergency(n) ? emergency.add(n.id) : add(n.id));
  for (const n of (outdoorGraph && outdoorGraph.nodes) || []) {
    if (isEmergency(n) || emergency.has(n.id)) { emergency.add(n.id); parent.delete(n.id); continue; }
    add(n.id);
  }
  for (const e of campus.navEdges || []) union(e.fromNodeId, e.toNodeId);
  for (const e of (outdoorGraph && outdoorGraph.edges) || []) union(e.from, e.to);

  // rooms: a searchable room is reached at its room node(s)
  const roomNodes = new Map();
  for (const n of campus.navNodes || []) if (n.roomId && parent.has(n.id)) (roomNodes.get(n.roomId) || roomNodes.set(n.roomId, []).get(n.roomId)).push(n.id);
  const searchable = (campus.rooms || []).filter((r) => truthy(r.searchable, true));
  const count = new Map();
  for (const r of searchable) {
    const seen = new Set((roomNodes.get(r.id) || []).map(find));
    for (const c of seen) count.set(c, (count.get(c) || 0) + 1);
  }
  const size = new Map();
  for (const id of parent.keys()) { const c = find(id); size.set(c, (size.get(c) || 0) + 1); }
  let main = null;
  for (const c of size.keys()) {
    if (main === null || (count.get(c) || 0) > (count.get(main) || 0) || ((count.get(c) || 0) === (count.get(main) || 0) && size.get(c) > size.get(main))) main = c;
  }
  const inMain = (id) => main !== null && parent.has(id) && find(id) === main;
  const unreachableRooms = searchable.filter((r) => !(roomNodes.get(r.id) || []).some(inMain)).map((r) => r.id).sort();

  // buildings with mapped entrances: their entrances (campus) plus outdoor entrance nodes tagged with the building
  const ents = new Map();
  const put = (b, id) => (ents.get(b) || ents.set(b, []).get(b)).push(id);
  for (const b of campus.buildings || []) for (const e of Array.isArray(b.entrances) ? b.entrances : []) if (e && e.nodeId) put(b.id, e.nodeId);
  for (const n of (outdoorGraph && outdoorGraph.nodes) || []) if (n.type === 'entrance' && (n.building || n.buildingId)) put(n.building || n.buildingId, n.id);
  const unreachableBuildings = [...ents.entries()].filter(([, ids]) => !ids.some(inMain)).map(([b]) => b).sort();

  return { ok: !unreachableRooms.length && !unreachableBuildings.length, unreachableRooms, unreachableBuildings, components: size.size };
}
