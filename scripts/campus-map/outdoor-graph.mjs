// The outdoor walking graph: OpenStreetMap footways, paths, pedestrian ways, steps and crossings, plus the roads a
// walker uses where no sidewalk is mapped (service roads, residential and minor streets), plus the hand-drawn
// override paths (data/campus-map/overrides.geojson), plus the primary entrances joined by short connectors.
//
//   { nodes: [{id, lat, lng, type: path|crossing|entrance, primary (entrances only)}],
//     edges: [{id, from, to, distance, accessible, kind}] }
// Entrance nodes are the primary entrances (primary: true) and any door that is the only way into a room (primary:
// false; EP 1322's exterior door): routes enter buildings only through these.
//
// Nodes sit at every way vertex; ways sharing an OSM node meet there (that is how OSM models an intersection).
// Ids: OSM vertices "n<osmNodeId>", override vertices "v<feature>-<vertex>", split points "s<k>", entrances keep their
// indoor NavNodes id (so the outdoor and indoor graphs join by id). Edge kind: footway|path|pedestrian|steps|crossing|
// road|connector; `accessible` is false for steps only. Distances are haversine meters.
import { closestOnSegment, haversine, localFrame, pointInRing, round } from './geo.mjs';
import { CENTER } from './config.mjs';
import { pathKind } from './osm.mjs';

/** Roads a pedestrian may walk along when no sidewalk is mapped. Trunk and motorway roads are excluded. */
export const WALKABLE_ROADS = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'service', 'living_street', 'track', 'road']);

/** The graph edge kind of an OSM way, or null when a pedestrian cannot use it. */
export function walkKind(tags) {
  if (!tags || !tags.highway || tags.area === 'yes') return null;
  if (tags.foot === 'no' || ((tags.access === 'no' || tags.access === 'private') && !/^(yes|designated|permissive)$/.test(tags.foot || ''))) {
    // Campus service drives are often access=private for cars; a footway tag or foot=yes overrides that.
    if (!pathKind(tags)) return null;
  }
  const pk = pathKind(tags);
  if (pk) return pk;
  if (WALKABLE_ROADS.has(tags.highway) && tags.service !== 'drive-through') return 'road';
  return null;
}

const R6 = (v) => round(v, 6);

export class OutdoorGraph {
  constructor() {
    this.F = localFrame(CENTER);
    this.nodes = new Map(); // id -> {id, lat, lng, type}
    this.edges = new Map(); // id -> {id, from, to, distance, accessible, kind}
    this.adj = new Map(); // id -> Set(edgeId)
    this.nextEdge = 1;
    this.nextSplit = 1;
    this.report = { connectors: [], overrideSnaps: [] };
  }

  addNode(id, lat, lng, type = 'path') {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, lat: R6(lat), lng: R6(lng), type });
      this.adj.set(id, new Set());
    } else if (type !== 'path') {
      this.nodes.get(id).type = type;
    }
    return this.nodes.get(id);
  }

  addEdge(from, to, kind, accessible = kind !== 'steps', distance) {
    if (from === to) return null;
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    const id = `e${this.nextEdge++}`;
    const e = { id, from, to, distance: round(distance != null ? distance : haversine(a.lat, a.lng, b.lat, b.lng), 2), accessible, kind };
    this.edges.set(id, e);
    this.adj.get(from).add(id);
    this.adj.get(to).add(id);
    return e;
  }

  removeEdge(id) {
    const e = this.edges.get(id);
    this.edges.delete(id);
    this.adj.get(e.from).delete(id);
    this.adj.get(e.to).delete(id);
  }

  xy(n) {
    return this.F.toXY(n.lat, n.lng);
  }

  /** Nearest point on an edge to a lat/lng; filter(edge) limits the candidates. Returns sorted candidates. */
  nearestEdges(lat, lng, { filter = () => true, max = 5, within = Infinity } = {}) {
    const p = this.F.toXY(lat, lng);
    const out = [];
    for (const e of this.edges.values()) {
      if (!filter(e)) continue;
      const a = this.xy(this.nodes.get(e.from));
      const b = this.xy(this.nodes.get(e.to));
      const c = closestOnSegment(p, a, b);
      const d = Math.hypot(c.p[0] - p[0], c.p[1] - p[1]);
      if (d <= within) out.push({ edge: e, point: c.p, t: c.t, d });
    }
    out.sort((x, y) => x.d - y.d);
    return out.slice(0, max);
  }

  /** Splits an edge at a local-frame point (or reuses an endpoint within 0.5 m); returns the node id there. */
  splitAt(edge, point) {
    const a = this.nodes.get(edge.from);
    const b = this.nodes.get(edge.to);
    const pa = this.xy(a);
    const pb = this.xy(b);
    if (Math.hypot(point[0] - pa[0], point[1] - pa[1]) < 0.5) return a.id;
    if (Math.hypot(point[0] - pb[0], point[1] - pb[1]) < 0.5) return b.id;
    const [lat, lng] = this.F.toLatLng(point[0], point[1]);
    const id = `s${this.nextSplit++}`;
    this.addNode(id, lat, lng, edge.kind === 'crossing' ? 'crossing' : 'path');
    this.removeEdge(edge.id);
    this.addEdge(a.id, id, edge.kind, edge.accessible);
    this.addEdge(id, b.id, edge.kind, edge.accessible);
    return id;
  }

  /** Connected components: Map nodeId -> component index (0 = the largest). */
  components() {
    const comp = new Map();
    const sizes = [];
    for (const id of this.nodes.keys()) {
      if (comp.has(id)) continue;
      const k = sizes.length;
      let n = 0;
      const stack = [id];
      comp.set(id, k);
      while (stack.length) {
        const cur = stack.pop();
        n++;
        for (const eid of this.adj.get(cur)) {
          const e = this.edges.get(eid);
          const o = e.from === cur ? e.to : e.from;
          if (!comp.has(o)) {
            comp.set(o, k);
            stack.push(o);
          }
        }
      }
      sizes.push(n);
    }
    const order = sizes.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]).map(([, i]) => i);
    const rank = new Map(order.map((c, r) => [c, r]));
    for (const [id, c] of comp) comp.set(id, rank.get(c));
    return { comp, sizes: order.map((c) => sizes[c]) };
  }

  /**
   * The published shape. Entrance nodes keep their indoor ids; every other node is renumbered "o1".."oN" in the order
   * of its build id (so the file stays compact and a rebuild from the same inputs gives the same ids); edges "e1".."eN"
   * in node order.
   */
  toJSON() {
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const sorted = [...this.nodes.values()].sort((a, b) => cmp(a.id, b.id));
    const rename = new Map();
    let k = 0;
    for (const n of sorted) rename.set(n.id, n.type === 'entrance' ? n.id : `o${++k}`);
    const nodes = sorted.map((n) => (n.type === 'entrance' ? { id: n.id, lat: n.lat, lng: n.lng, type: n.type, primary: !!n.primary } : { id: rename.get(n.id), lat: n.lat, lng: n.lng, type: n.type }));
    const edges = [...this.edges.values()]
      .map((e) => ({ from: rename.get(e.from), to: rename.get(e.to), distance: round(e.distance, 1), accessible: e.accessible, kind: e.kind, key: [rename.get(e.from), rename.get(e.to)].sort().join(' ') }))
      .sort((a, b) => cmp(a.key, b.key))
      .map((e, i) => ({ id: `e${i + 1}`, from: e.from, to: e.to, distance: e.distance, accessible: e.accessible, kind: e.kind }));
    return { nodes, edges };
  }
}

/** Adds every walkable OSM way to the graph, vertex by vertex. */
export function addOsmWays(g, osm) {
  const crossingNodes = new Set();
  for (const n of osm.nodes.values()) if (n.tags && (n.tags.highway === 'crossing' || n.tags.crossing)) crossingNodes.add(n.id);
  const ways = osm.ways.filter((w) => walkKind(w.tags)).sort((a, b) => a.id - b.id);
  for (const w of ways) {
    const kind = walkKind(w.tags);
    let prev = null;
    for (const nid of w.nodes) {
      const n = osm.nodes.get(nid);
      if (!n) { prev = null; continue; }
      const id = `n${nid}`;
      g.addNode(id, n.lat, n.lon, crossingNodes.has(nid) || kind === 'crossing' ? 'crossing' : 'path');
      if (prev) g.addEdge(prev, id, kind);
      prev = id;
    }
  }
  return ways.length;
}

/**
 * Adds the override paths (LineStrings with layer "paths"). Each endpoint snaps to the nearest graph vertex within
 * 3 m, else onto the nearest edge within 6 m (splitting it); interior vertices stay unjoined, like OSM ways that cross
 * without a shared node. Returns the snap report.
 */
export function addOverridePaths(g, features) {
  let fi = 0;
  for (const f of features) {
    fi++;
    const p = f.properties || {};
    if (p.layer !== 'paths' || !f.geometry || f.geometry.type !== 'LineString') continue;
    const kind = p.kind === 'steps' || p.steps ? 'steps' : p.kind || 'footway';
    const coords = f.geometry.coordinates;
    const ids = [];
    coords.forEach(([lng, lat], i) => {
      const end = i === 0 || i === coords.length - 1;
      let id = null;
      if (end) {
        const P = g.F.toXY(lat, lng);
        let bestV = null;
        for (const n of g.nodes.values()) {
          if (n.type === 'entrance') continue;
          const q = g.xy(n);
          const d = Math.hypot(q[0] - P[0], q[1] - P[1]);
          if (d <= 3 && (!bestV || d < bestV.d)) bestV = { id: n.id, d };
        }
        if (bestV) {
          id = bestV.id;
          g.report.overrideSnaps.push({ feature: p.name || `override ${fi}`, vertex: i, to: id, how: 'vertex', meters: round(bestV.d, 1) });
        } else {
          const near = g.nearestEdges(lat, lng, { within: 6, max: 1, filter: (e) => e.kind !== 'connector' });
          if (near.length) {
            id = g.splitAt(near[0].edge, near[0].point);
            g.report.overrideSnaps.push({ feature: p.name || `override ${fi}`, vertex: i, to: id, how: 'edge', meters: round(near[0].d, 1) });
          } else {
            g.report.overrideSnaps.push({ feature: p.name || `override ${fi}`, vertex: i, to: null, how: 'unjoined' });
          }
        }
      }
      if (!id) {
        id = `v${fi}-${i}`;
        g.addNode(id, lat, lng, kind === 'crossing' ? 'crossing' : 'path');
      }
      ids.push(id);
    });
    for (let i = 0; i + 1 < ids.length; i++) g.addEdge(ids[i], ids[i + 1], kind);
  }
}

/**
 * Joins an entrance to the network: the nearest point on a footway-class edge, unless a road is more than 10 m
 * nearer; the connector must not run through the building (`outline`, [lng, lat] ring). The point splits its edge.
 * @return {{nodeId, to, meters, viaKind, straight: boolean}} straight = longer than `maxMeters` (reported)
 */
export function connectEntrance(g, ent, { outline, maxMeters = 30 } = {}) {
  g.addNode(ent.id, ent.lat, ent.lng, 'entrance').primary = !!ent.primary;
  const P = g.F.toXY(ent.lat, ent.lng);
  const ring = outline ? outline.map(([lng, lat]) => g.F.toXY(lat, lng)) : null;
  // A door sits in the wall (on a curved wall, at its inner face), so the connector may start inside the outline for
  // up to 6 m; once outside it must not enter the building again.
  const throughBuilding = (q) => {
    if (!ring) return false;
    const L = Math.hypot(q[0] - P[0], q[1] - P[1]);
    let outside = false;
    for (let s = 0.5; s < L; s += 0.5) {
      const t = s / L;
      const inside = pointInRing([P[0] + (q[0] - P[0]) * t, P[1] + (q[1] - P[1]) * t], ring);
      if (!inside) outside = true;
      else if (outside || s > 6) return true;
    }
    return false;
  };
  const cands = g.nearestEdges(ent.lat, ent.lng, { max: 60, filter: (e) => e.kind !== 'connector' && e.from !== ent.id && e.to !== ent.id })
    .filter((c) => !throughBuilding(c.point));
  if (!cands.length) return null;
  const foot = cands.find((c) => c.edge.kind !== 'road');
  const road = cands.find((c) => c.edge.kind === 'road');
  const pick = foot && (!road || foot.d <= road.d + 10) ? foot : road;
  const to = g.splitAt(pick.edge, pick.point);
  g.addEdge(ent.id, to, 'connector', true);
  const r = { nodeId: ent.id, to, meters: round(pick.d, 1), viaKind: pick.edge.kind, straight: pick.d > maxMeters };
  g.report.connectors.push(r);
  return r;
}

/** Drops components other than the largest that hold no entrance (unreachable fragments: islands of parking aisles). */
export function pruneFragments(g) {
  const { comp } = g.components();
  const keepComp = new Set([0]);
  for (const n of g.nodes.values()) if (n.type === 'entrance') keepComp.add(comp.get(n.id));
  let dropped = 0;
  for (const [id, c] of comp) {
    if (keepComp.has(c)) continue;
    for (const eid of [...g.adj.get(id)]) if (g.edges.has(eid)) g.removeEdge(eid);
    g.nodes.delete(id);
    g.adj.delete(id);
    dropped++;
  }
  return dropped;
}
