// The shape of data/campus-map/overrides.geojson (v5, Codex review v5 finding 6), checked by everything that reads or
// writes it: the local admin before it saves (tools/admin/server.mjs), the campus-map build (build.mjs) and the export
// (scripts/data/campus-geo.mjs readDrawnEntrances). A malformed file fails with the offending feature's id instead of
// breaking somewhere downstream.
//
//   FeatureCollection with a features array; every feature a Feature with properties and a geometry, and a layer:
//     buildings  Polygon, its outer ring at least three distinct corners enclosing a nonzero area
//     paths      LineString of at least two distinct positions
//     entrances  Point, with properties.building
//   positions are [lng, lat] numbers in range; feature ids (properties.id) are unique.

export const GEO_LAYERS = ['buildings', 'paths', 'entrances'];

/** The id a feature is addressed by: properties.id, else override/<1-based index> (as the admin and the build name it). */
export const geoFeatureId = (f, i) => (f && f.properties && f.properties.id) || `override/${i + 1}`;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Why a position is not [lng, lat], or null. */
export function positionProblem(p) {
  if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return 'a position is not [lng, lat] numbers';
  if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return 'a position is not a longitude and latitude';
  return null;
}

/** Square meters enclosed by a lng/lat ring (local plane at its first corner). */
export function ringAreaM2(ring) {
  if (!ring.length) return 0;
  const k = Math.cos((ring[0][1] * Math.PI) / 180) * 111320;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += (p[0] * k) * (q[1] * 110540) - (q[0] * k) * (p[1] * 110540);
  }
  return Math.abs(a) / 2;
}

/** Why a building ring is not a footprint (open or closed), or null: three distinct corners, a nonzero area. */
export function ringProblem(ring) {
  if (!Array.isArray(ring)) return 'the ring is not a list of positions';
  for (const p of ring) { const why = positionProblem(p); if (why) return why; }
  const distinct = new Set(ring.map((p) => `${p[0]},${p[1]}`));
  if (distinct.size < 3) return `at least three distinct corners expected, got ${distinct.size}`;
  if (ringAreaM2(ring) < 1) return 'its corners enclose no area';
  return null;
}

/** Throws on a malformed overrides.geojson, naming the feature: "overrides.geojson feature building-x: ...". */
export function validateOverridesGeo(geo, file = 'overrides.geojson') {
  if (!geo || typeof geo !== 'object' || geo.type !== 'FeatureCollection') throw new Error(`${file}: a GeoJSON FeatureCollection expected`);
  if (!Array.isArray(geo.features)) throw new Error(`${file}: "features" must be an array`);
  const seen = new Set();
  geo.features.forEach((f, i) => {
    const id = geoFeatureId(f, i);
    const bad = (why) => { throw new Error(`${file} feature ${id}: ${why}`); };
    if (!f || typeof f !== 'object' || f.type !== 'Feature') bad('not a GeoJSON Feature');
    const p = f.properties;
    if (!p || typeof p !== 'object' || Array.isArray(p)) bad('no properties');
    if (p.id !== undefined && (typeof p.id !== 'string' || !p.id)) bad('properties.id must be a non-empty string');
    if (seen.has(id)) bad('the id is used by another feature');
    seen.add(id);
    if (!GEO_LAYERS.includes(p.layer)) bad(`layer: one of ${GEO_LAYERS.join(', ')} expected, got ${JSON.stringify(p.layer)}`);
    const g = f.geometry;
    if (!g || typeof g !== 'object') bad('no geometry');
    if (p.layer === 'buildings') {
      if (g.type !== 'Polygon' || !Array.isArray(g.coordinates) || !g.coordinates.length) bad('a building is a Polygon');
      const why = ringProblem(g.coordinates[0]);
      if (why) bad(why);
    } else if (p.layer === 'paths') {
      if (g.type !== 'LineString' || !Array.isArray(g.coordinates)) bad('a path is a LineString');
      for (const q of g.coordinates) { const why = positionProblem(q); if (why) bad(why); }
      if (new Set(g.coordinates.map((q) => `${q[0]},${q[1]}`)).size < 2) bad('a path needs at least two distinct positions');
    } else {
      if (g.type !== 'Point') bad('an entrance is a Point');
      const why = positionProblem(g.coordinates);
      if (why) bad(why);
      if (typeof p.building !== 'string' || !p.building) bad('an entrance names its building (properties.building)');
    }
  });
  return geo;
}
