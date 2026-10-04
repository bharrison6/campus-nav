// The local campus-data engine: the backend .gs files (tools/admin/gs) run in the Apps Script stand-in, seeded the
// way initSystem() seeds a new sheet, with the overrides layer (data/overrides) merged over that base.
//
//   const campus = openCampus();              // seed + pipeline + overrides, in an in-memory sheet
//   campus.gas.run('getAllCampusData', []);   // what the app reads
//   campus.gas.run('updateRoom', [{...}]);    // any admin write changes the sheet...
//   campus.save();                            // ...and save() writes the overrides that reproduce it
//
// One engine for both consumers, so what the local admin shows is what the export publishes:
// scripts/data/export-campus-data.mjs and tools/admin/server.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS, applyOverrides, diffOverrides, formatOverrides, orphanRecords, validateOverrides } from './overrides.mjs';

const require = createRequire(import.meta.url);
const { makeRuntime, GS_DIR } = require('../../dev/gas-runtime.cjs');

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OVERRIDES_DIR = path.join(REPO, 'data', 'overrides');
export { GS_DIR };

/** Reads data/overrides/<collection>.json for every collection (a missing file is an empty list). */
export function readOverrides(dir = OVERRIDES_DIR) {
  const out = {};
  for (const c of Object.keys(COLLECTIONS)) {
    const p = path.join(dir, `${c}.json`);
    if (!fs.existsSync(p)) { out[c] = []; continue; }
    try {
      out[c] = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`${p}: ${e.message}`);
    }
  }
  validateOverrides(out);
  return out;
}

/** Writes every collection file whose content changed; returns the paths written. */
export function writeOverrides(dir, overrides) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const c of Object.keys(COLLECTIONS)) {
    const p = path.join(dir, `${c}.json`);
    const text = formatOverrides(overrides[c] || []);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) continue;
    fs.writeFileSync(p, text);
    written.push(p);
  }
  return written;
}

const clone = (v) => JSON.parse(JSON.stringify(v)); // also moves values out of the vm realm

/** collection -> header names, from the backend's own tab definitions (Init.gs, data contract v2). */
function tabHeaders(gas) {
  const out = {};
  for (const [c, tab] of Object.entries(COLLECTIONS)) out[c] = clone(gas.ctx.getSheetDefinition_(tab).headers);
  return out;
}

/** Every collection as the backend reads it (sheetToObjects_: JSON columns parsed, booleans normalized). */
function readTabs(gas) {
  const ss = gas.ctx.getSpreadsheet_();
  const out = {};
  for (const [c, tab] of Object.entries(COLLECTIONS)) out[c] = clone(gas.ctx.sheetToObjects_(ss, tab));
  return out;
}

/** Replaces every tab's data rows with the given records, through the backend's own row writer. */
function writeTabs(gas, data) {
  const ss = gas.ctx.getSpreadsheet_();
  for (const [c, tab] of Object.entries(COLLECTIONS)) {
    const def = gas.ctx.getSheetDefinition_(tab);
    const rows = (data[c] || []).map((o) => gas.ctx.objectToRow_(def, o, null));
    gas.ctx.rewriteRows_(ss.getSheetByName(tab), def, rows);
  }
}

/**
 * Opens the campus: runtime, seeded base, overrides applied.
 * @param {Object} [o]
 * @param {string} [o.gsDir]         backend folder (default tools/admin/gs)
 * @param {string} [o.overridesDir]  default data/overrides
 * @param {string} [o.extraCode]     code evaluated after the .gs files (tests replace the generated seed this way)
 * @param {Object} [o.props]         Script Properties to preset (for example a local mapsApiKey for the admin map)
 */
export function openCampus({ gsDir, overridesDir = OVERRIDES_DIR, extraCode, props } = {}) {
  const gas = makeRuntime(gsDir, extraCode);
  if (props) for (const [k, v] of Object.entries(props)) if (v) gas.props[k] = String(v);
  gas.ctx.initSystem();
  const headers = tabHeaders(gas);
  const base = readTabs(gas);
  const overrides = readOverrides(overridesDir);
  const { data, report } = applyOverrides(base, overrides, headers);
  writeTabs(gas, data);
  const keep = orphanRecords(overrides, report);
  return {
    gas,
    base,
    headers,
    report,
    overridesDir,
    /** The merged data as the backend reads it now. */
    current: () => readTabs(gas),
    /** The overrides that reproduce the current sheet from the base (orphans kept). */
    diff: () => diffOverrides(base, readTabs(gas), headers, keep),
    /** Writes those overrides to overridesDir; returns the files that changed. */
    save() {
      return writeOverrides(overridesDir, this.diff());
    },
  };
}

/** One line per finding, for the export summary and the admin server log. */
export function describeReport(report) {
  const lines = [];
  for (const [c, n] of Object.entries(report.applied)) lines.push(`overrides ${c}: ${n.edited} edited, ${n.added} added, ${n.deleted} deleted`);
  for (const o of report.orphans) lines.push(`ORPHAN ${o.collection} ${o.id} (${o.op}): not in the seed or pipeline data any more; skipped, kept in the file`);
  for (const o of report.newInBase) lines.push(`note ${o.collection} ${o.id}: added by an override and now also produced by the seed or pipeline; the override wins`);
  for (const o of report.refused) lines.push(`REFUSED ${o.collection} ${o.id}: ${o.why}`);
  for (const o of report.ignoredFields) lines.push(`ignored field ${o.collection} ${o.id}.${o.field}: not a column of the data contract`);
  for (const o of report.duplicates) lines.push(`duplicate ${o.collection} ${o.id}: listed more than once; applied in file order`);
  return lines;
}
