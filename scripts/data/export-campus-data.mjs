#!/usr/bin/env node
// Build-time export of the campus data for the static site.
//
//   node scripts/data/export-campus-data.mjs --out <dir> [--overrides data/overrides] [--quiet]
//
// Runs the backend (tools/admin/gs) in the Apps Script stand-in, seeds it as initSystem() does (SeedData.gs + the
// pipeline's SeedFloorData.gs), merges data/overrides/*.json, and writes:
//   <dir>/campus.json            what getPublicCampusData returns: { contractVersion, version, config,
//                                buildings, floors, rooms, navNodes, navEdges, photos, qrLocations } without the hidden
//                                floors (public = false) and everything on them (rooms, nodes, edges touching those
//                                nodes, indoor photos, QR locations); config is key/value rows and never holds
//                                mapsApiKey (the site's config.json carries the key). The local admin still reads
//                                getAllCampusData, hidden floors included (from the private location outside the
//                                repository; this export never reads it, so the published files never depend on
//                                it; tests pass a synthetic one as privateDir to check the filter). v4 map fields (campus-geo.mjs): entrance
//                                nodes gain lat/lng from data/georef, indoor buildings' entrances are derived
//                                from them, buildings carry levels (and height when set).
//   <dir>/floors/<floorId>.svg   each public floor's plan (the FP_<floorId>.html asset, via getFloorPlanSvg)
//   <dir>/version.json           { version, builtAt, gitSha }
// version is a content hash of campus.json and the plans, so the same inputs give the same files; builtAt is the
// build time (SOURCE_DATE_EPOCH when set) and gitSha the commit (GITHUB_SHA, else git rev-parse HEAD, else '').
// Files are overwritten, never removed: point --out at a fresh directory.
// Exit 1 on a malformed overrides file or a public floor without a plan; orphaned overrides are reported, not fatal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OVERRIDES_DIR, REPO, describeReport, openCampus } from './campus-engine.mjs';
import { addCampusGeo, readDrawnEntrances, readEntranceFacing, readGeoref } from './campus-geo.mjs';
import { applyAccess, publishAltDoorCost, publishAltFactor } from './access.mjs';

export const GEOREF_DIR = path.join(REPO, 'data', 'georef');
export const FLOORPLANS_DIR = path.join(REPO, 'data', 'floorplans');
export const CAMPUS_MAP_DIR = path.join(REPO, 'data', 'campus-map');

/** A floor is public unless its public flag is false (boolean or text), as the web app and the build read it. */
export const isPublicFloor = (f) => !(f && (f.public === false || String(f.public).toLowerCase() === 'false'));

/** The export as data (no files): { campus, floors: [{ id, svg }] (public floors only), missingPlans, report }. */
export function buildExport({ gsDir, overridesDir = OVERRIDES_DIR, georefDir = GEOREF_DIR, campusMapDir = CAMPUS_MAP_DIR, extraCode, props, privateDir } = {}) {
  const engine = openCampus({ gsDir, overridesDir, extraCode, props, privateDir });
  const campus = engine.gas.run('getPublicCampusData', []);
  campus.config = campus.config.filter((c) => c.key !== 'mapsApiKey');
  const altFactor = publishAltFactor(campus);
  const altDoorCost = publishAltDoorCost(campus);
  const access = applyAccess(campus);
  const geo = addCampusGeo(campus, readGeoref(georefDir), readEntranceFacing(georefDir === GEOREF_DIR ? FLOORPLANS_DIR : null), readDrawnEntrances(campusMapDir));
  geo.classes = access;
  geo.altFactor = altFactor;
  geo.altDoorCost = altDoorCost;
  const leaked = campus.floors.filter((f) => !isPublicFloor(f)).map((f) => f.id);
  if (leaked.length) throw new Error(`getPublicCampusData kept hidden floor(s) ${leaked.join(', ')}`);
  const floors = [];
  const missingPlans = [];
  for (const f of campus.floors) {
    try {
      floors.push({ id: f.id, svg: engine.gas.run('getFloorPlanSvg', [f.id]) });
    } catch (e) {
      missingPlans.push({ id: f.id, error: e.message });
    }
  }
  // version: hash of everything published except the version itself.
  const h = crypto.createHash('sha256');
  campus.version = '';
  for (const c of campus.config) if (c.key === 'dataVersion') c.value = '';
  h.update(JSON.stringify(campus));
  for (const f of floors) h.update('\0' + f.id + '\0' + f.svg);
  const version = h.digest('hex').slice(0, 12);
  campus.version = version;
  for (const c of campus.config) if (c.key === 'dataVersion') c.value = version;
  return { campus, floors, missingPlans, report: engine.report, version, geo };
}

function gitSha(env) {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Writes the export into outDir; returns { version, files, report, missingPlans, counts }. */
export function exportCampusData({ outDir, overridesDir = OVERRIDES_DIR, georefDir = GEOREF_DIR, gsDir, extraCode, privateDir, env = process.env, now = new Date() }) {
  const x = buildExport({ gsDir, overridesDir, georefDir, extraCode, privateDir });
  const builtAt = env.SOURCE_DATE_EPOCH ? new Date(Number(env.SOURCE_DATE_EPOCH) * 1000).toISOString() : now.toISOString();
  fs.mkdirSync(path.join(outDir, 'floors'), { recursive: true });
  const files = [];
  const write = (rel, text) => {
    fs.writeFileSync(path.join(outDir, rel), text);
    files.push(rel);
  };
  write('campus.json', JSON.stringify(x.campus));
  for (const f of x.floors) write(`floors/${f.id}.svg`, f.svg);
  write('version.json', JSON.stringify({ version: x.version, builtAt, gitSha: gitSha(env) }) + '\n');
  const counts = {};
  for (const k of ['buildings', 'floors', 'rooms', 'navNodes', 'navEdges', 'photos', 'qrLocations', 'config']) counts[k] = x.campus[k].length;
  return { version: x.version, files, report: x.report, missingPlans: x.missingPlans, counts, geo: x.geo };
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = opt('--out');
  if (!out) {
    console.error('usage: node scripts/data/export-campus-data.mjs --out <dir> [--overrides <dir>] [--quiet]');
    process.exit(2);
  }
  const quiet = argv.includes('--quiet');
  try {
    const r = exportCampusData({
      outDir: path.resolve(out),
      overridesDir: opt('--overrides') ? path.resolve(opt('--overrides')) : OVERRIDES_DIR,
    });
    const lines = describeReport(r.report);
    if (!quiet) {
      console.log(`campus data ${r.version} -> ${path.resolve(out)}`);
      console.log('  ' + Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', '));
      console.log(`  ${r.files.length} files (campus.json, version.json, ${r.files.length - 2} floor plans)`);
      console.log(`  entrances: ${r.geo.entrances} (${r.geo.located} with coordinates; by access ${JSON.stringify(r.geo.access)}); building entrances derived for ${r.geo.buildingsWithEntrances.join(', ') || 'none'}`);
      console.log(`  access: corridors ${JSON.stringify(r.geo.classes.rooms)}, nodes ${JSON.stringify(r.geo.classes.nodes)}; ${r.geo.classes.waypointsInherited} waypoints inherit their hallway's class${r.geo.classes.hubsMadeWaypoints.length ? `; hubs made hallway points: ${r.geo.classes.hubsMadeWaypoints.join(', ')}` : ''}; routing.altFactor ${r.geo.altFactor}, altDoorCost ${r.geo.altDoorCost}`);
      for (const id of r.geo.drawnUnknownBuildings) console.warn(`  drawn entrances name building ${id}, which is not in the campus data (add the building in the admin)`);
      for (const l of lines) console.log('  ' + l);
    } else {
      for (const l of lines.filter((s) => /^(ORPHAN|REFUSED)/.test(s))) console.warn(l);
    }
    for (const m of r.missingPlans) console.error(`floor ${m.id} has no plan: ${m.error}`);
    process.exit(r.missingPlans.length ? 1 : 0);
  } catch (e) {
    console.error(`export failed: ${e.message}`);
    process.exit(1);
  }
}
