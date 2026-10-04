// The overrides layer: operator edits kept as committed JSON beside the generated data, merged at export.
//
//   data/overrides/<collection>.json   one file per collection, an array of records:
//     { "id": "room-it-1-0141", "label": "Dean's Office" }          partial edit of an existing record (merge by id)
//     { "id": "room-it-1-0141", "_delete": true }                   removes the record
//     { "id": "qrloc-1759...", "_new": true, "buildingId": ... }    a record the operator added (all its fields)
//   config.json is keyed by "key" instead of "id": { "key": "campusName", "value": "Murray State" }.
//   v5: navNodes and rooms records may set `access` ("main" | "alt" | "emergency"); a navNodes record with the retired
//   boolean `primary` and no `access` reads as access main (true) or alt (false), so v4 overrides keep working.
//   pathAccess.json ([{way, access}], outdoor path classes) is not a collection: the campus-map build reads it.
//
// Base = seed (SeedData.gs) + pipeline floor data (SeedFloorData.gs), as initSystem() writes them. A partial edit or a
// delete whose id is not in the base any more (the pipeline stopped emitting that room) is an ORPHAN: reported and
// skipped, never applied, and kept in the file so the operator decides. A `_new` record is applied whether or not the
// base has its id (if the base gained it, the record merges over it and the report says so).
//
// Pure functions over plain objects; the runtime bridge (campus-engine.mjs) feeds them the backend's tab definitions.

/** collection name -> backend tab name; the order is the file order and the export order. */
export const COLLECTIONS = {
  buildings: 'Buildings',
  floors: 'Floors',
  rooms: 'Rooms',
  navNodes: 'NavNodes',
  navEdges: 'NavEdges',
  photos: 'Photos',
  qrLocations: 'QRLocations',
  config: 'Config',
};

/** The record field that identifies a record in a collection. */
export const keyOf = (collection) => (collection === 'config' ? 'key' : 'id');

/** Config keys an override may never set: the Maps key is a build secret, dataVersion is computed by the export. */
export const RESERVED_CONFIG_KEYS = ['mapsApiKey', 'dataVersion'];

const FLAGS = ['_delete', '_new'];

/** The access classes of the v5 contract. */
export const ACCESS_CLASSES = ['main', 'alt', 'emergency'];
const truthy = (v) => v === true || /^(true|1|yes)$/i.test(String(v));

/**
 * The access class an override record sets: its `access` when valid, else a legacy `primary` flag (true main, false
 * alt), else null. Used for navNodes records by the engine merge (applyOverrides) and the campus-map build.
 */
export function overrideAccess(r) {
  if (!r) return null;
  if (ACCESS_CLASSES.includes(r.access)) return r.access;
  if ('primary' in r && r.primary !== '' && r.primary != null) return truthy(r.primary) ? 'main' : 'alt';
  return null;
}

/** JSON with object keys sorted, so equal values compare equal whatever order their keys were written in. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

const same = (a, b) => canonical(a) === canonical(b);

/** Throws on a malformed overrides object; returns the list of collections present. */
export function validateOverrides(overrides) {
  for (const [collection, records] of Object.entries(overrides)) {
    if (!(collection in COLLECTIONS)) throw new Error(`overrides: unknown collection "${collection}"`);
    if (!Array.isArray(records)) throw new Error(`overrides/${collection}.json: must be an array of records`);
    const key = keyOf(collection);
    records.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`overrides/${collection}.json[${i}]: not an object`);
      if (typeof r[key] !== 'string' || r[key] === '') throw new Error(`overrides/${collection}.json[${i}]: "${key}" (a non-empty string) is required`);
      if (r._delete && r._new) throw new Error(`overrides/${collection}.json[${i}] (${r[key]}): _delete and _new together`);
    });
  }
  return Object.keys(overrides);
}

function emptyReport() {
  return { applied: {}, orphans: [], newInBase: [], ignoredFields: [], refused: [], duplicates: [] };
}

/**
 * Merges overrides over the base.
 * @param {Object<string, Object[]>} base       collection -> records (objects keyed by header)
 * @param {Object<string, Object[]>} overrides  collection -> override records
 * @param {Object<string, string[]>} headers    collection -> the tab's header names (the fields a record may carry)
 * @return {{ data: Object<string, Object[]>, report: Object }} data: new arrays, base order then added records
 */
export function applyOverrides(base, overrides, headers) {
  validateOverrides(overrides);
  const report = emptyReport();
  const data = {};
  for (const collection of Object.keys(COLLECTIONS)) {
    const key = keyOf(collection);
    const rows = (base[collection] || []).map((r) => ({ ...r }));
    const index = new Map(rows.map((r, i) => [String(r[key]), i]));
    const baseIds = new Set(index.keys());
    const removed = new Set();
    const seen = new Set();
    const counts = { edited: 0, added: 0, deleted: 0 };
    const allowed = new Set(headers[collection] || []);
    for (const raw of overrides[collection] || []) {
      // A v4 navNodes override with only `primary` sets the access class it stands for (the column itself is gone).
      let o = raw;
      if (collection === 'navNodes' && 'primary' in raw) {
        o = { ...raw };
        if (!('access' in raw) && overrideAccess(raw)) o.access = overrideAccess(raw);
        delete o.primary;
      }
      const id = o[key];
      if (seen.has(id)) report.duplicates.push({ collection, id });
      seen.add(id);
      if (collection === 'config' && RESERVED_CONFIG_KEYS.includes(id)) {
        report.refused.push({ collection, id, why: id === 'mapsApiKey' ? 'the Maps key is a build secret, never an override' : 'computed by the export' });
        continue;
      }
      const fields = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === key || FLAGS.includes(k)) continue;
        if (!allowed.has(k)) { report.ignoredFields.push({ collection, id, field: k }); continue; }
        fields[k] = v;
      }
      const live = index.has(id) && !removed.has(id);
      if (o._delete) {
        if (!live) { report.orphans.push({ collection, id, op: 'delete' }); continue; }
        removed.add(id);
        counts.deleted++;
      } else if (o._new) {
        if (live) {
          if (baseIds.has(id)) report.newInBase.push({ collection, id });
          Object.assign(rows[index.get(id)], fields);
        } else {
          const rec = { [key]: id };
          for (const h of headers[collection] || []) if (h !== key) rec[h] = h in fields ? fields[h] : '';
          if (index.has(id)) {
            rows[index.get(id)] = rec; // deleted earlier in this file, added again: the new record takes its place
            removed.delete(id);
          } else {
            index.set(id, rows.length);
            rows.push(rec);
          }
        }
        counts.added++;
      } else {
        if (!live) { report.orphans.push({ collection, id, op: 'edit' }); continue; }
        Object.assign(rows[index.get(id)], fields);
        counts.edited++;
      }
    }
    data[collection] = rows.filter((r) => !removed.has(String(r[key])));
    if (counts.edited || counts.added || counts.deleted) report.applied[collection] = counts;
  }
  return { data, report };
}

/** Override records that applyOverrides could not apply (orphans): kept verbatim so a save never drops them. */
export function orphanRecords(overrides, report) {
  const out = {};
  for (const o of report.orphans) {
    const rec = (overrides[o.collection] || []).find((r) => r[keyOf(o.collection)] === o.id && !!r._delete === (o.op === 'delete'));
    if (rec) (out[o.collection] = out[o.collection] || []).push(rec);
  }
  return out;
}

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/**
 * The overrides that turn base into current: changed fields of kept records, `_new` records, `_delete` markers.
 * Records are sorted by key and their fields follow the header order, so the files diff well.
 * @param {Object<string, Object[]>} keep  records carried forward verbatim (orphans), merged in by key order
 */
export function diffOverrides(base, current, headers, keep = {}) {
  const out = {};
  for (const collection of Object.keys(COLLECTIONS)) {
    const key = keyOf(collection);
    const hs = (headers[collection] || []).filter((h) => h !== key);
    const skip = (r) => collection === 'config' && RESERVED_CONFIG_KEYS.includes(String(r[key]));
    const baseRows = (base[collection] || []).filter((r) => !skip(r));
    const curRows = (current[collection] || []).filter((r) => !skip(r));
    const baseById = new Map(baseRows.map((r) => [String(r[key]), r]));
    const curIds = new Set(curRows.map((r) => String(r[key])));
    const recs = [];
    for (const r of curRows) {
      const id = String(r[key]);
      const b = baseById.get(id);
      if (!b) {
        const rec = { [key]: id, _new: true };
        for (const h of hs) rec[h] = r[h] === undefined ? '' : r[h];
        recs.push(rec);
        continue;
      }
      const rec = { [key]: id };
      let changed = false;
      for (const h of hs) {
        if (!same(r[h] === undefined ? '' : r[h], b[h] === undefined ? '' : b[h])) { rec[h] = r[h]; changed = true; }
      }
      if (changed) recs.push(rec);
    }
    for (const id of baseById.keys()) if (!curIds.has(id)) recs.push({ [key]: id, _delete: true });
    for (const r of keep[collection] || []) recs.push(r);
    out[collection] = recs.sort(byKey(key));
  }
  return out;
}

/** One record per line: reviewable diffs without a polygon spread over hundreds of lines. */
export function formatOverrides(records) {
  if (!records.length) return '[]\n';
  return '[\n' + records.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n';
}
