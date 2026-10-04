// The map editor's override shapes (v5 data contract 3 and 4), as pure functions over plain objects. The admin
// server reads the files, calls these, and writes the results; the campus-map build reads the files.
//
//   data/overrides/pathAccess.json         [{ "way": "way/123", "access": "main" | "alt" }]   sorted by way
//   data/campus-map/overrides.geojson      FeatureCollection; the admin adds features with a properties.id:
//     paths      LineString { layer: "paths", id, kind, access: "main" | "alt", name?, source: "override" }
//     buildings  Polygon    { layer: "buildings", id, name, code?, building, levels?, height?, buildingId?, replaces?,
//                             source: "override" }   (replaces: the OSM way it supersedes, as the existing layer does)
//     entrances  Point      { layer: "entrances", id (entrance-<building>-<n>, the outdoor node id), building, access, label,
//                             source: "override" }   (buildings without floor plans)
//   Features written by hand before v5 carry no id; they are addressed as override/<1-based index>, the name the
//   campus-map build gives them.
//
// A drawn path's two ends snap to the nearest entrance, path vertex or path segment within SNAP_METERS, so it joins
// the walking network (the campus-map build snaps again, at 3 m to a vertex and 6 m to an edge).

export const PATH_ACCESS = ['main', 'alt'];
export const DOOR_ACCESS = ['main', 'alt', 'emergency'];
export const SNAP_METERS = 4;
export const GEO_LAYERS = ['buildings', 'paths', 'entrances'];

/** The access a path has when nobody set one (contract 3): roads are alt, everything walkable is main. */
export function autoPathAccess(layer, kind) {
  return layer === 'roads' || kind === 'road' ? 'alt' : 'main';
}

/** The id a feature is addressed by: properties.id, else override/<1-based index>. */
export function featureId(f, i) {
  return (f && f.properties && f.properties.id) || `override/${i + 1}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (v, field, max = 120) => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new Error(`${field}: text expected`);
  const s = v.trim();
  if (s.length > max) throw new Error(`${field}: at most ${max} characters`);
  return s;
};
function lngLat(p, field) {
  if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) throw new Error(`${field}: [lng, lat] numbers expected`);
  if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) throw new Error(`${field}: not a longitude and latitude`);
  return [round6(p[0]), round6(p[1])];
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
function oneOf(v, list, field) {
  if (!list.includes(v)) throw new Error(`${field}: one of ${list.join(', ')} expected, got ${JSON.stringify(v)}`);
  return v;
}
function optNumber(v, field, min, max, integer) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${field}: ${integer ? 'a whole number' : 'a number'} from ${min} to ${max} expected`);
  return n;
}
const clean = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') out[k] = v;
  return out;
};

/** A fresh id for a new feature of a layer, unique in the collection. */
export function newFeatureId(geo, layer, now = Date.now()) {
  const taken = new Set(((geo && geo.features) || []).map(featureId));
  const stem = { paths: 'path', buildings: 'building', entrances: 'entrance' }[layer] || layer;
  let n = now;
  while (taken.has(`${stem}-${n.toString(36)}`)) n++;
  return `${stem}-${n.toString(36)}`;
}

// ---------------------------------------------------------------- pathAccess.json

/** Validates a pathAccess list (throws on a malformed one); returns it. */
export function validatePathAccess(list) {
  if (!Array.isArray(list)) throw new Error('pathAccess.json: must be an array');
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object' || typeof r.way !== 'string' || !r.way) throw new Error(`pathAccess.json[${i}]: "way" (a non-empty string) is required`);
    oneOf(r.access, PATH_ACCESS, `pathAccess.json[${i}].access`);
  });
  return list;
}

/** The list with way set to access (null or "auto" removes the entry); sorted by way, one entry per way. */
export function setPathAccess(list, way, access) {
  if (typeof way !== 'string' || !/^(way|relation|override)\/[\w-]+$|^path-[\w-]+$/.test(way)) throw new Error(`way: an OSM way id such as way/123 or an override path id expected, got ${JSON.stringify(way)}`);
  const out = validatePathAccess(list || []).filter((r) => r.way !== way);
  if (access !== null && access !== undefined && access !== 'auto') out.push({ way, access: oneOf(access, PATH_ACCESS, 'access') });
  return out.sort((a, b) => (a.way < b.way ? -1 : a.way > b.way ? 1 : 0));
}

export const formatPathAccess = (list) => (list.length ? '[\n' + list.map((r) => '  ' + JSON.stringify({ way: r.way, access: r.access })).join(',\n') + '\n]\n' : '[]\n');

// ---------------------------------------------------------------- overrides.geojson

/** One feature per line, the other top-level keys kept, as the committed file is written. */
export function formatGeo(geo) {
  const head = Object.entries(geo).filter(([k]) => k !== 'features').map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  const feats = (geo.features || []).map((f) => '  ' + JSON.stringify(f));
  return '{' + head.join(',\n') + ',\n"features":[\n' + feats.join(',\n') + '\n]}\n';
}

function findFeature(geo, id) {
  const i = (geo.features || []).findIndex((f, k) => featureId(f, k) === id);
  if (i === -1) throw new Error(`overrides.geojson: no feature ${id}`);
  return i;
}

const meters = (a, b) => {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * 111320;
  return Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110540);
};

/** The nearest point of segment ab to p (lng/lat treated as a local plane), with its distance in meters. */
function nearestOnSegment(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { point: [round6(q[0]), round6(q[1])], meters: meters(p, q) };
}

/**
 * Snaps one point to the nearest target within maxMeters: an entrance first, then a path vertex, then a point on a
 * path segment. targets: { entrances: [{id, lngLat}], lines: [{id, coordinates}] }.
 * @return {{ point, to, how, meters } | null}
 */
export function snapPoint(p, targets, maxMeters = SNAP_METERS) {
  let best = null;
  const consider = (cand) => { if (cand.meters <= maxMeters && (!best || cand.rank < best.rank || (cand.rank === best.rank && cand.meters < best.meters))) best = cand; };
  for (const e of (targets && targets.entrances) || []) consider({ point: e.lngLat, to: e.id, how: 'entrance', meters: meters(p, e.lngLat), rank: 0 });
  for (const l of (targets && targets.lines) || []) {
    const c = l.coordinates || [];
    for (const v of c) consider({ point: v, to: l.id, how: 'vertex', meters: meters(p, v), rank: 1 });
    for (let i = 1; i < c.length; i++) {
      const s = nearestOnSegment(p, c[i - 1], c[i]);
      consider({ point: s.point, to: l.id, how: 'segment', meters: s.meters, rank: 2 });
    }
  }
  if (!best) return null;
  return { point: best.point, to: best.to, how: best.how, meters: Math.round(best.meters * 10) / 10 };
}

/**
 * Adds a drawn path. o: { coordinates: [[lng, lat]...] (2 or more), access, name?, kind? }.
 * @return {{ geo, id, snaps: [{ end: 'start'|'end', to, how, meters }] }}
 */
export function addPath(geo, o, targets, now) {
  const raw = (o && o.coordinates) || [];
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('path: at least two points expected');
  const coords = raw.map((p, i) => lngLat(p, `path point ${i + 1}`));
  const snaps = [];
  [0, coords.length - 1].forEach((i, k) => {
    const s = snapPoint(coords[i], targets);
    if (!s) return;
    coords[i] = s.point;
    snaps.push({ end: k ? 'end' : 'start', to: s.to, how: s.how, meters: s.meters });
  });
  for (let i = 1; i < coords.length; i++) if (meters(coords[i - 1], coords[i]) < 0.3) coords.splice(i--, 1);
  if (coords.length < 2) throw new Error('path: its points are all in one place');
  const id = newFeatureId(geo, 'paths', now);
  const kind = o.kind ? oneOf(o.kind, ['footway', 'path', 'pedestrian', 'steps', 'crossing'], 'kind') : 'footway';
  const props = clean({ layer: 'paths', id, kind, access: oneOf(o.access || 'main', PATH_ACCESS, 'access'), name: text(o.name, 'name'), steps: kind === 'steps' || undefined, source: 'override', note: 'Drawn in the local admin map editor; candidate contribution to OpenStreetMap.' });
  const feature = { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } };
  return { geo: { ...geo, features: [...(geo.features || []), feature] }, id, snaps };
}

/**
 * Adds a building footprint. o: { ring: [[lng, lat]...] (3 or more, closed or not), name, code?, levels?, height?,
 * buildingId?, replaces? (the OSM way id it supersedes) }.
 */
export function addBuilding(geo, o, now) {
  const raw = (o && o.ring) || [];
  if (!Array.isArray(raw) || raw.length < 3) throw new Error('building: at least three corners expected');
  const ring = raw.map((p, i) => lngLat(p, `building corner ${i + 1}`));
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  if (ring.length < 4) throw new Error('building: at least three distinct corners expected');
  const name = text(o.name, 'name');
  if (!name) throw new Error('building: a name is required');
  const replaces = o.replaces ? text(o.replaces, 'replaces', 40) : '';
  if (replaces && !/^(way|relation)\/\d+$/.test(replaces)) throw new Error('replaces: an OSM id such as way/123 expected');
  const id = newFeatureId(geo, 'buildings', now);
  const props = clean({
    layer: 'buildings', id, name, code: text(o.code, 'code', 12), building: 'university',
    levels: optNumber(o.levels, 'levels', 1, 40, true), height: optNumber(o.height, 'height', 2, 200, false),
    buildingId: o.buildingId ? text(o.buildingId, 'buildingId', 60) : undefined, replaces: replaces || undefined, source: 'override',
    note: replaces ? `Redrawn in the local admin map editor over OpenStreetMap ${replaces}.` : 'Drawn in the local admin map editor; candidate contribution to OpenStreetMap.',
  });
  const feature = { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
  return { geo: { ...geo, features: [...(geo.features || []), feature] }, id };
}

/**
 * The id of a new entrance of a building: "entrance-<building>-<n>", the outdoor node id the campus-map build gives a
 * drawn entrance (drawnEntrances), past every number the building's entrances already use (by id or by file position).
 */
export function newEntranceId(geo, building) {
  const feats = ((geo && geo.features) || []).filter((f) => f.properties && f.properties.layer === 'entrances' && f.properties.building === building);
  const taken = new Set(((geo && geo.features) || []).map(featureId));
  const stem = `entrance-${building}-`;
  let n = feats.length;
  for (const f of feats) {
    const id = String(f.properties.id || '');
    if (id.startsWith(stem) && /^\d+$/.test(id.slice(stem.length))) n = Math.max(n, Number(id.slice(stem.length)));
  }
  while (taken.has(stem + (n + 1))) n++;
  return stem + (n + 1);
}

/** Adds an entrance point of a building without floor plans. o: { building, lngLat, access, label }. */
export function addEntrance(geo, o) {
  const building = text(o && o.building, 'building', 60);
  if (!building) throw new Error('entrance: the building it belongs to is required');
  if (!/^[A-Za-z0-9_.-]+$/.test(building)) throw new Error('entrance: a building id such as bld-nursing expected');
  const id = newEntranceId(geo, building);
  const props = clean({ layer: 'entrances', id, building, access: oneOf((o && o.access) || 'main', DOOR_ACCESS, 'access'), label: text(o.label, 'label') || 'Entrance', source: 'override' });
  const feature = { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: lngLat(o.lngLat, 'entrance position') } };
  return { geo: { ...geo, features: [...(geo.features || []), feature] }, id };
}

/** Edits a feature's properties (only the fields its layer allows); returns { geo, before, after } (old and new properties). */
export function updateFeature(geo, id, changes) {
  const i = findFeature(geo, id);
  const f = geo.features[i];
  const p = { ...f.properties };
  const c = changes || {};
  const layer = p.layer;
  const set = (k, v) => { if (v === undefined || v === '') delete p[k]; else p[k] = v; };
  if (layer === 'paths') {
    if ('access' in c) set('access', oneOf(c.access, PATH_ACCESS, 'access'));
    if ('name' in c) set('name', text(c.name, 'name'));
  } else if (layer === 'entrances') {
    if ('access' in c) set('access', oneOf(c.access, DOOR_ACCESS, 'access'));
    if ('label' in c) set('label', text(c.label, 'label') || 'Entrance');
    if ('building' in c) { const b = text(c.building, 'building', 60); if (!b) throw new Error('entrance: the building is required'); set('building', b); }
  } else if (layer === 'buildings') {
    if ('name' in c) { const n = text(c.name, 'name'); if (!n) throw new Error('building: a name is required'); set('name', n); }
    if ('code' in c) set('code', text(c.code, 'code', 12));
    if ('levels' in c) set('levels', optNumber(c.levels, 'levels', 1, 40, true));
    if ('height' in c) set('height', optNumber(c.height, 'height', 2, 200, false));
    if ('buildingId' in c) set('buildingId', text(c.buildingId, 'buildingId', 60));
  } else {
    throw new Error(`overrides.geojson: feature ${id} has no editable layer`);
  }
  const features = geo.features.slice();
  features[i] = { ...f, properties: p };
  return { geo: { ...geo, features }, before: f.properties, after: p };
}

/** Removes a feature; returns { geo, removed }. */
export function deleteFeature(geo, id) {
  const i = findFeature(geo, id);
  const features = geo.features.slice();
  const [removed] = features.splice(i, 1);
  return { geo: { ...geo, features }, removed };
}

/**
 * Whether a change to overrides.geojson can only add walking connections (no connectivity check needed): new
 * features, renames, path class changes (alt stays routable) and entrance changes that do not make one emergency.
 * Deleting a path or an entrance, or making an entrance emergency, can cut something off.
 */
export function geoEditIsAdditive(op, before, after) {
  if (op === 'add') return true;
  if (op === 'delete') return !before || before.layer === 'buildings';
  if (op === 'update') return !(before && before.layer === 'entrances' && after && after.access === 'emergency' && before.access !== 'emergency');
  return false;
}
