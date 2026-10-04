// The committed OpenStreetMap extract (data/campus-map/source/osm-extract.json): the input of the campus-map build,
// so a rebuild needs no network and gives the same files. Only map features the build uses are kept (buildings,
// highways, parking, landuse, leisure, natural, water) with the nodes they reference and the tags the layers read.
// It is OpenStreetMap data: (c) OpenStreetMap contributors, ODbL 1.0. `npm run campus-map -- --refresh` re-downloads it.
import { ATTRIBUTION } from './config.mjs';

const FEATURE_KEY = /^(building|highway|amenity|landuse|leisure|natural|waterway)$/;
const KEEP_TAG = /^(name|building|building:levels|height|highway|footway|crossing|surface|service|oneway|foot|access|area|bridge|tunnel|layer|amenity|landuse|leisure|natural|waterway|sport|entrance|door|wheelchair|type|operator)$/;

const trim = (t) => {
  if (!t) return null;
  const o = {};
  for (const k of Object.keys(t).sort()) if (KEEP_TAG.test(k)) o[k] = t[k];
  return Object.keys(o).length ? o : null;
};

/** Elements (API/Overpass JSON) -> the compact extract object. */
export function toExtract(elements, meta) {
  const wanted = (e) => e.tags && Object.keys(e.tags).some((k) => FEATURE_KEY.test(k));
  const ways = elements.filter((e) => e.type === 'way' && wanted(e)).sort((a, b) => a.id - b.id);
  const relations = elements
    .filter((e) => e.type === 'relation' && e.tags && e.tags.type === 'multipolygon' && wanted(e))
    .sort((a, b) => a.id - b.id);
  const wayIds = new Set(ways.map((w) => w.id));
  const byId = new Map(elements.filter((e) => e.type === 'way').map((w) => [w.id, w]));
  const extraWays = [];
  for (const r of relations) {
    for (const m of r.members) {
      if (m.type === 'way' && !wayIds.has(m.ref) && byId.has(m.ref)) {
        wayIds.add(m.ref);
        extraWays.push(byId.get(m.ref));
      }
    }
  }
  const allWays = [...ways, ...extraWays].sort((a, b) => a.id - b.id);
  const need = new Set(allWays.flatMap((w) => w.nodes));
  const nodes = elements
    .filter((e) => e.type === 'node' && (need.has(e.id) || (e.tags && (e.tags.entrance || e.tags.highway === 'crossing'))))
    .sort((a, b) => a.id - b.id);
  return {
    meta: { ...meta, license: 'ODbL 1.0', attribution: ATTRIBUTION.osm },
    nodes: nodes.map((n) => {
      const t = trim(n.tags);
      return t ? [n.id, +n.lat.toFixed(7), +n.lon.toFixed(7), t] : [n.id, +n.lat.toFixed(7), +n.lon.toFixed(7)];
    }),
    ways: allWays.map((w) => [w.id, w.nodes, trim(w.tags) || {}]),
    relations: relations.map((r) => [r.id, r.members.map((m) => [m.type, m.ref, m.role]), trim(r.tags) || {}]),
  };
}

/** The extract -> elements in API JSON shape. */
export function fromExtract(x) {
  const out = [];
  for (const [id, lat, lon, tags] of x.nodes) out.push(tags ? { type: 'node', id, lat, lon, tags } : { type: 'node', id, lat, lon });
  for (const [id, nodes, tags] of x.ways) out.push({ type: 'way', id, nodes, tags });
  for (const [id, members, tags] of x.relations || []) out.push({ type: 'relation', id, members: members.map(([type, ref, role]) => ({ type, ref, role })), tags });
  return out;
}

/** One record per line, so a refresh diffs by feature. */
export function formatExtract(x) {
  const lines = (arr) => arr.map((r) => '  ' + JSON.stringify(r)).join(',\n');
  return `{"meta": ${JSON.stringify(x.meta)},\n"nodes": [\n${lines(x.nodes)}\n],\n"ways": [\n${lines(x.ways)}\n],\n"relations": [\n${lines(x.relations)}\n]}\n`;
}
