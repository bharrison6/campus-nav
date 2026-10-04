// OpenStreetMap elements (API 0.6 / Overpass JSON) -> compact GeoJSON layers for the campus map.
// Only the tags a layer uses survive; coordinates are rounded to 6 decimals (about 0.1 m).
import { localFrame, pointInRing, polygonArea, polygonCentroid, round } from './geo.mjs';
import { CENTER } from './config.mjs';

const R6 = (v) => round(v, 6);

/** Indexes elements: nodes by id, ways, relations. */
export function indexOsm(elements) {
  const nodes = new Map();
  const ways = [];
  const relations = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.push(e);
    else if (e.type === 'relation') relations.push(e);
  }
  const wayById = new Map(ways.map((w) => [w.id, w]));
  return { nodes, ways, relations, wayById };
}

/** [lng, lat] pairs of a way (nodes missing from the download are skipped). */
export function wayCoords(osm, w) {
  const out = [];
  for (const id of w.nodes) {
    const n = osm.nodes.get(id);
    if (n) out.push([R6(n.lon), R6(n.lat)]);
  }
  return out;
}

export const isClosed = (w) => w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];

/** Joins member ways of a multipolygon relation into closed outer rings ([lng, lat] each). */
function relationOuterRings(osm, rel) {
  const segs = rel.members
    .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === ''))
    .map((m) => osm.wayById.get(m.ref))
    .filter(Boolean)
    .map((w) => w.nodes.slice());
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let grew = true;
    while (ring[0] !== ring[ring.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const end = ring[ring.length - 1];
        if (s[0] === end) ring = ring.concat(s.slice(1));
        else if (s[s.length - 1] === end) ring = ring.concat(s.slice().reverse().slice(1));
        else continue;
        segs.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring[0] === ring[ring.length - 1] && ring.length >= 4) {
      rings.push(ring.map((id) => osm.nodes.get(id)).filter(Boolean).map((n) => [R6(n.lon), R6(n.lat)]));
    }
  }
  return rings;
}

/** Every building footprint: { osmId: 'way/123', name, tags, ring: [[lng, lat]...] (closed) }. */
export function footprints(osm) {
  const out = [];
  for (const w of osm.ways) {
    if (!w.tags || !w.tags.building || !isClosed(w)) continue;
    out.push({ osmId: `way/${w.id}`, name: w.tags.name || '', tags: w.tags, ring: wayCoords(osm, w) });
  }
  for (const r of osm.relations) {
    if (!r.tags || !r.tags.building || r.tags.type !== 'multipolygon') continue;
    const rings = relationOuterRings(osm, r);
    rings.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
    if (rings.length) out.push({ osmId: `relation/${r.id}`, name: r.tags.name || '', tags: r.tags, ring: rings[0] });
  }
  return out;
}

// ---- matching footprints to the seeded buildings ----

const STOP = new Set(['the', 'building', 'bldg', 'hall', 'center', 'centre', 'of', 'and', 'college', 'university', 'murray', 'state', 'msu', 'school', 'complex', 'facility']);
export function nameTokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP.has(t))
  );
}

/** Overlap coefficient of the meaningful name tokens: 1 when one name's tokens all appear in the other. */
export function nameSimilarity(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.size || !B.size) return 0;
  let k = 0;
  for (const t of A) if (B.has(t)) k++;
  return k / Math.min(A.size, B.size);
}

/**
 * Assigns each footprint the seeded building it most likely is: the seeded point lies inside the footprint, or the
 * names agree (similarity >= 0.5) within 150 m of the footprint's centroid. Among candidates the highest
 * score = 0.6 * name similarity + (inside ? 0.5 : 0.4 * (1 - d / 150)) wins. Several footprints may carry one
 * buildingId (a building mapped in parts); a footprint carries at most one.
 * @param {{id, name, lat, lng}[]} seeded
 * @return {Map<string, {buildingId, score, inside, distance, nameSim}>} by osmId
 */
export function matchBuildings(fps, seeded) {
  const F = localFrame(CENTER);
  const out = new Map();
  for (const fp of fps) {
    const ring = fp.ring.map(([lng, lat]) => F.toXY(lat, lng));
    const c = polygonCentroid(ring);
    let best = null;
    for (const b of seeded) {
      const p = F.toXY(Number(b.lat), Number(b.lng));
      const inside = pointInRing(p, ring);
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      const sim = nameSimilarity(fp.name, b.name);
      if (!inside && !(sim >= 0.5 && d <= 150)) continue;
      const score = 0.6 * sim + (inside ? 0.5 : 0.4 * Math.max(0, 1 - d / 150));
      if (!best || score > best.score) best = { buildingId: b.id, score: round(score, 3), inside, distance: round(d, 1), nameSim: round(sim, 2) };
    }
    if (best) out.set(fp.osmId, best);
  }
  return out;
}

// ---- heights ----

export const METERS_PER_LEVEL = 3.5;

/**
 * Default level count by building type (academic 3, residence 4, other 2). The type comes from the OSM `building`
 * tag, else from the seeded name (Murray State's residential colleges, College Courts, Sorority Suites, Heritage
 * Hall); any other seeded campus building counts as academic.
 */
export function defaultLevels(tags, seededName) {
  const b = (tags && tags.building) || '';
  if (/^(dormitory|residential|apartments)$/.test(b)) return { levels: 4, type: 'residence' };
  if (seededName && (/\bCollege$/.test(seededName) || /College Courts|Suites|Apartments|Heritage Hall/.test(seededName))) return { levels: 4, type: 'residence' };
  if (/^(university|school|college)$/.test(b) || seededName) return { levels: 3, type: 'academic' };
  return { levels: 2, type: 'other' };
}

const num = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Extrusion height (m) and level count of one footprint. Precedence: the operator's override (admin Buildings tab:
 * `height`, else `levels` x 3.5 m), then OSM `height`, then OSM `building:levels` x 3.5 m, then the default by type.
 * @return {{height, levels, source: 'override'|'osm'|'default'}}
 */
export function buildingHeight(tags, override, seededName) {
  const oh = num(override && override.height);
  const ol = num(override && override.levels);
  const th = num(tags && tags.height);
  const tl = num(tags && tags['building:levels']);
  if (oh) return { height: round(oh, 1), levels: ol || tl || Math.max(1, Math.round(oh / METERS_PER_LEVEL)), source: 'override' };
  if (ol) return { height: round(ol * METERS_PER_LEVEL, 1), levels: ol, source: 'override' };
  if (th) return { height: round(th, 1), levels: tl || Math.max(1, Math.round(th / METERS_PER_LEVEL)), source: 'osm' };
  if (tl) return { height: round(tl * METERS_PER_LEVEL, 1), levels: tl, source: 'osm' };
  if (tags && tags.building === 'roof') return { height: 4, levels: 1, source: 'default' };
  const d = defaultLevels(tags, seededName);
  return { height: round(d.levels * METERS_PER_LEVEL, 1), levels: d.levels, source: 'default' };
}

// ---- basemap layers ----

export const PATH_KINDS = { footway: 'footway', path: 'path', pedestrian: 'pedestrian', steps: 'steps', cycleway: 'path', bridleway: 'path', corridor: 'footway' };
export const ROAD_KINDS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street', 'track', 'road', 'primary_link', 'secondary_link', 'tertiary_link', 'trunk_link']);
const GREEN = {
  landuse: ['grass', 'meadow', 'recreation_ground', 'village_green', 'forest', 'cemetery', 'orchard'],
  leisure: ['park', 'pitch', 'garden', 'track', 'stadium', 'golf_course', 'playground', 'sports_centre', 'recreation_ground'],
  natural: ['wood', 'scrub', 'grassland', 'heath', 'wetland'],
};

/** The path kind of a highway way, or null: footway|path|pedestrian|steps|crossing. */
export function pathKind(tags) {
  if (!tags || !tags.highway) return null;
  if (/^(footway|path|cycleway)$/.test(tags.highway) && tags.footway === 'crossing') return 'crossing';
  return PATH_KINDS[tags.highway] || null;
}

export const feature = (geometry, properties) => ({ type: 'Feature', properties, geometry });
export const clean = (o) => {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') r[k] = v;
  return r;
};

/** Basemap layers as feature arrays: paths, roads, parking, landuse, water. */
export function basemapLayers(osm) {
  const L = { paths: [], roads: [], parking: [], landuse: [], water: [] };
  for (const w of osm.ways) {
    const t = w.tags || {};
    const coords = wayCoords(osm, w);
    if (coords.length < 2) continue;
    const closed = isClosed(w);
    const pk = pathKind(t);
    if (pk && t.area !== 'yes') {
      L.paths.push(feature({ type: 'LineString', coordinates: coords }, clean({ osmId: `way/${w.id}`, kind: pk, name: t.name, surface: t.surface, steps: pk === 'steps', bridge: t.bridge === 'yes' || undefined, source: 'osm' })));
      continue;
    }
    if (t.highway && ROAD_KINDS.has(t.highway) && t.area !== 'yes') {
      L.roads.push(feature({ type: 'LineString', coordinates: coords }, clean({ osmId: `way/${w.id}`, kind: t.highway, service: t.service, name: t.name, oneway: t.oneway === 'yes' || undefined })));
      continue;
    }
    if (t.highway === 'pedestrian' && closed) {
      L.landuse.push(feature({ type: 'Polygon', coordinates: [coords] }, { osmId: `way/${w.id}`, kind: 'plaza' }));
      continue;
    }
    if (!closed) {
      if (t.waterway) L.water.push(feature({ type: 'LineString', coordinates: coords }, clean({ osmId: `way/${w.id}`, kind: t.waterway, name: t.name })));
      continue;
    }
    if (t.building) continue;
    if (t.amenity === 'parking') {
      L.parking.push(feature({ type: 'Polygon', coordinates: [coords] }, clean({ osmId: `way/${w.id}`, kind: 'parking', name: t.name })));
    } else if (t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin') {
      L.water.push(feature({ type: 'Polygon', coordinates: [coords] }, clean({ osmId: `way/${w.id}`, kind: 'water', name: t.name })));
    } else {
      for (const [k, vals] of Object.entries(GREEN)) {
        if (vals.includes(t[k])) {
          L.landuse.push(feature({ type: 'Polygon', coordinates: [coords] }, clean({ osmId: `way/${w.id}`, kind: t[k], sport: t.sport, name: t.name })));
          break;
        }
      }
    }
  }
  return L;
}

/** A point well inside a ring for a label: the centroid when it is inside, else the inside grid point farthest from the edge. */
export function labelPoint(ring) {
  const F = localFrame({ lat: ring[0][1], lng: ring[0][0] });
  const xy = ring.map(([lng, lat]) => F.toXY(lat, lng));
  let c = polygonCentroid(xy);
  if (!pointInRing(c, xy)) {
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    let best = null;
    for (let i = 1; i < 20; i++) {
      for (let j = 1; j < 20; j++) {
        const p = [x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * j) / 20];
        if (!pointInRing(p, xy)) continue;
        let d = Infinity;
        for (let k = 0; k + 1 < xy.length; k++) {
          const a = xy[k];
          const b = xy[k + 1];
          const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
          const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2)) : 0;
          d = Math.min(d, Math.hypot(p[0] - a[0] - t * (b[0] - a[0]), p[1] - a[1] - t * (b[1] - a[1])));
        }
        if (!best || d > best.d) best = { p, d };
      }
    }
    if (best) c = best.p;
  }
  const [lat, lng] = F.toLatLng(c[0], c[1]);
  return [R6(lng), R6(lat)];
}
