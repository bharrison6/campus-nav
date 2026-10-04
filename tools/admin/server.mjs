#!/usr/bin/env node
// The local admin: Admin.html on localhost, answered by the backend (tools/admin/gs) in the Apps Script stand-in,
// over seed + pipeline data + data/overrides. Every write is saved straight away as data/overrides/*.json (only the
// difference from the seed and pipeline data); commit and push those files to publish. Never deployed, so no PIN.
// A save that changes what the campus map is built from (an entrance's class or position, a building's
// levels or height, a map-editor edit) reruns npm run campus-map in the background (offline, committed inputs), so
// data/campus-map, data/georef and the floors' entrance blocks match the overrides; the admin then reloads.
// getAdminStatus reports the last run and its duration.
//
// v5 editors (tools/admin/map-overrides.mjs has the file shapes):
//   Map tab          path classes (data/overrides/pathAccess.json), drawn paths, buildings and entrances
//                    (data/campus-map/overrides.geojson), floor-plan entrance classes (navNodes access)
//   Doors & halls    door and entrance classes (navNodes access), room type and hallway class (rooms type, access),
//                    the data lane's hallway suggestions (data/review/corridor-candidates.json) accepted or rejected
//                    (data/overrides/corridorReview.json)
// Save check: before a save that touches rooms, nav nodes, nav edges or floors (or one that removes an outdoor
// path or entrance, or makes an entrance emergency), the effective data is built and checkConnectivity run on it
// (tools/admin/connectivity-gate.mjs); a save that cuts off a room or a building is refused, nothing is written, and
// the reply lists what it would cut off.
//
//   npm run admin                       http://localhost:8790/
//   node tools/admin/server.mjs [--port 8790]
//
// Environment:
//   MSCN_SITE_URL      the public site QR codes link to (https, default https://bharrison6.github.io/campus-nav/,
//                      or build.config.json "siteUrl" when that file sets one)
//   MSCN_OVERRIDES_DIR where edits are saved (default data/overrides; tests point it elsewhere)
//   MSCN_CAMPUS_MAP_DIR the campus-map directory the Map tab reads and whose overrides.geojson it writes (default
//                      data/campus-map; a copy elsewhere keeps a trial run off the committed files)
//   MSCN_REVIEW_DIR    where corridor-candidates.json is read (default data/review)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { OVERRIDES_DIR, REPO, describeReport, openCampus, writeOverrides } from '../../scripts/data/campus-engine.mjs';
import { COLLECTIONS, canonical } from '../../scripts/data/overrides.mjs';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';
import {
  DOOR_ACCESS, addBuilding, addEntrance, addPath, deleteFeature, featureId, formatGeo, formatPathAccess, geoEditIsAdditive,
  setPathAccess, updateFeature, validatePathAccess,
} from './map-overrides.mjs';
import { CONNECTIVITY, cutOffs, describeCutOffs, refusal, runCheck } from './connectivity-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 8790;
export const DEFAULT_SITE_URL = 'https://bharrison6.github.io/campus-nav/';

/** Backend reads the admin page uses. */
export const READ_FNS = ['getAllCampusData', 'getFloorPlanSvg', 'getDataVersion'];
/** Backend writes: every public save/update/delete function; each one is followed by a save of the overrides. */
export const isWriteFn = (name) => /^(save|update|delete)[A-Z][A-Za-z]*$/.test(name);
/** Answered by this server, not by the backend. */
export const SERVER_FNS = [
  'getAdminStatus', 'reloadFromDisk', 'getMapEditorData', 'setPathAccess', 'saveMapPath', 'saveMapBuilding', 'saveMapEntrance',
  'updateMapFeature', 'deleteMapFeature', 'getCorridorReview', 'setCorridorReview', 'checkConnectivityNow',
];
/** The campus-map directory (basemap layers, aerial tiles, outdoor graph, overrides.geojson). */
export const CAMPUS_MAP_DIR = path.join(REPO, 'data', 'campus-map');
/** The data lane's hallway suggestions. */
export const REVIEW_DIR = path.join(REPO, 'data', 'review');
/** The MapLibre files the admin map loads (no CDN): the npm package's ES module build. */
export const MAPLIBRE_DIR = path.join(REPO, 'node_modules', 'maplibre-gl', 'dist');
const MAPLIBRE_FILES = ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'];
/** Campus-map files the admin map may read, relative to CAMPUS_MAP_DIR. */
const CAMPUS_MAP_FILE = /^(buildings\.geojson|manifest\.json|aerial\.json|layers\/[a-z]+\.geojson|aerial\/\d{1,2}\/\d{1,7}\/\d{1,7}\.(jpg|png))$/;
const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };

// The campus-map build, for the save check's in-memory outdoor graph (loaded ahead: saves are synchronous).
const [{ loadInputs: loadMapInputs }, { buildCampusMap }] = await Promise.all([import('../../scripts/campus-map/inputs.mjs'), import('../../scripts/campus-map/build.mjs')]);

/** The site address for QR codes: MSCN_SITE_URL, else build.config.json siteUrl, else the planned Pages URL. */
export function resolveSiteUrl(env = process.env) {
  let url = env.MSCN_SITE_URL;
  if (!url) {
    try {
      url = JSON.parse(fs.readFileSync(path.join(REPO, 'build.config.json'), 'utf8')).siteUrl;
    } catch {
      url = '';
    }
  }
  url = url || DEFAULT_SITE_URL;
  return url.endsWith('/') ? url : url + '/';
}

/**
 * What the campus map is built from, of the admin's data: entrance nodes (access, floor, position) and buildings'
 * levels and height. Two writes that leave this string unchanged need no rebuild.
 */
export function mapInputsOf(data) {
  const ents = (data.navNodes || []).filter((n) => n.type === 'entrance')
    .map((n) => [n.id, n.floorId, Number(n.x), Number(n.y), n.access || '']).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const blds = (data.buildings || []).map((b) => [b.id, String(b.levels ?? ''), String(b.height ?? '')]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([ents, blds]);
}

/** npm run campus-map (offline): resolves with its last output line, rejects with its error output. */
export function runCampusMap({ timeoutMs = 180_000 } = {}) {
  return new Promise((ok, fail) => {
    execFile(process.execPath, [path.join(REPO, 'scripts', 'campus-map', 'run.mjs')], { cwd: REPO, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return fail(new Error(String(stderr || err.message).trim().split(/\r?\n/).slice(-3).join(' ')));
        const lines = String(stdout).trim().split(/\r?\n/);
        return ok(lines[lines.length - 1].trim());
      });
  });
}

/** A path as the log shows it: repo-relative inside the repository, absolute elsewhere. */
const shown = (p) => (path.relative(REPO, p).startsWith('..') ? p : path.relative(REPO, p));

/** Reads a JSON file, or dflt when it does not exist. */
const readJson = (p, dflt) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt);
/** Writes a file through a temporary sibling, so a reader never sees half of it. */
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}
const GATED = ['rooms', 'navNodes', 'navEdges', 'floors'];
const truthy = (v) => v === true || String(v).toLowerCase() === 'true';

/**
 * The outdoor graph the campus-map build gives with these map overrides, built in memory (about 10 s): the save
 * check uses it for a map edit that can cut something off.
 */
export function outdoorGraphInMemory(overridesGeo, overridesDir) {
  return buildCampusMap({ ...loadMapInputs({ overridesDir }), overridesGeo }).graph;
}

/**
 * @param {Function|null} [o.rebuildMap] runs the campus-map build after a map-relevant save (returns a promise);
 *   default: npm run campus-map when the overrides and the campus-map directory are the repository's own (it reads
 *   data/overrides and data/campus-map/overrides.geojson), else none
 * @param {string} [o.campusMapDir]  basemap, outdoor graph and overrides.geojson (default data/campus-map)
 * @param {string} [o.reviewDir]     corridor-candidates.json (default data/review)
 * @param {{check: Function, source: string}|null} [o.connectivity]  the save check (default: the shared check,
 *   scripts/data/connectivity.mjs); null turns the check off
 * @param {Function} [o.outdoorGraphFor]  (overridesGeo, overridesDir) -> outdoor graph, for map edits that can cut
 *   something off (default: the campus-map build in memory)
 */
export function createAdmin({
  overridesDir = OVERRIDES_DIR, gsDir, extraCode, env = process.env, log = console.log, rebuildMap,
  campusMapDir = CAMPUS_MAP_DIR, reviewDir = REVIEW_DIR, connectivity = CONNECTIVITY, outdoorGraphFor = outdoorGraphInMemory,
} = {}) {
  const open = () => openCampus({ gsDir, overridesDir, extraCode });
  let campus = open();
  const rebuild = rebuildMap !== undefined ? rebuildMap
    : (path.resolve(overridesDir) === path.resolve(OVERRIDES_DIR) && path.resolve(campusMapDir) === path.resolve(CAMPUS_MAP_DIR) && !gsDir ? () => runCampusMap() : null);
  const map = { running: false, pending: false, last: null, idle: Promise.resolve() };
  const geoPath = path.join(campusMapDir, 'overrides.geojson');
  const pathAccessPath = path.join(overridesDir, 'pathAccess.json');
  const reviewPath = path.join(overridesDir, 'corridorReview.json');
  let checked = null; // { campus, result } of the data as saved; cleared by every change

  /** Reruns the campus-map build in the background; edits saved meanwhile queue one more run. */
  function rebuildCampusMap(why) {
    if (!rebuild) { log(`[admin] ${why}: the campus map is not rebuilt (overrides outside data/overrides)`); return; }
    if (map.running) { map.pending = true; return; }
    map.running = true;
    const t0 = Date.now();
    log(`[admin] ${why}: rebuilding the campus map (npm run campus-map)`);
    const run = map.idle = new Promise((ok) => ok(rebuild())).then(
      (out) => {
        map.last = { ok: true, ms: Date.now() - t0, at: new Date().toISOString(), output: out || '' };
        log(`[admin] campus map rebuilt in ${(map.last.ms / 1000).toFixed(1)} s${out ? ': ' + out : ''}`);
        campus = open(); // the build rewrites the floors' entrance blocks and the generated seed the admin reads
        checked = null;
      },
      (err) => {
        map.last = { ok: false, ms: Date.now() - t0, at: new Date().toISOString(), error: String((err && err.message) || err) };
        log(`[admin] campus map rebuild FAILED after ${(map.last.ms / 1000).toFixed(1)} s: ${map.last.error}`);
      },
    ).then(() => {
      map.running = false;
      if (map.pending) { map.pending = false; rebuildCampusMap('edits saved during the last rebuild'); }
      return map.idle === run ? undefined : map.idle; // settles when the queued run (if any) has settled too
    });
  }
  const siteUrl = resolveSiteUrl(env);
  for (const l of describeReport(campus.report)) log(`[admin] ${l}`);

  function status() {
    const files = Object.keys(COLLECTIONS).map((c) => {
      const p = path.join(overridesDir, `${c}.json`);
      let records = 0;
      try { records = JSON.parse(fs.readFileSync(p, 'utf8')).length; } catch { records = 0; }
      return { name: `${c}.json`, records };
    });
    return {
      overridesDir, files, report: describeReport(campus.report), mapRebuild: { running: map.running, pending: map.pending, last: map.last },
      connectivity: connectivity ? connectivity.source : 'off',
    };
  }

  // ---- the save check ----
  const outdoorGraph = () => readJson(path.join(campusMapDir, 'outdoor-graph.json'), { nodes: [], edges: [] });
  /** The published campus for a set of overrides (a temporary directory holds them for the exporter). */
  function exportWith(overrides) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-gate-'));
    try {
      writeOverrides(tmp, overrides);
      return buildExport({ gsDir, overridesDir: tmp, extraCode }).campus;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  /** The check on the data as saved now (cached until the next change). */
  function checkSaved() {
    if (!checked) {
      const c = buildExport({ gsDir, overridesDir, extraCode }).campus;
      checked = { campus: c, result: connectivity ? runCheck(connectivity.check, c, outdoorGraph()) : null };
    }
    return checked;
  }
  /** Throws a refusal when the proposed campus or graph cuts off something reachable now. */
  function gate(what, { campus: proposedCampus, graph: proposedGraph } = {}) {
    if (!connectivity) return;
    const now = checkSaved();
    const result = runCheck(connectivity.check, proposedCampus || now.campus, proposedGraph || outdoorGraph());
    const cut = cutOffs(now.result, result, now.campus);
    if (cut.rooms.length || cut.buildings.length) {
      const err = refusal(describeCutOffs(cut, now.campus), what);
      log(`[admin] ${err.message}`);
      throw err;
    }
  }

  // ---- map editor files ----
  const readGeo = () => readJson(geoPath, { type: 'FeatureCollection', features: [] });
  const readPathAccess = () => validatePathAccess(readJson(pathAccessPath, []));
  function writeGeo(geo, why) {
    writeAtomic(geoPath, formatGeo(geo));
    log(`[admin] ${why}: saved ${shown(geoPath)}`);
    checked = null;
    rebuildCampusMap(why);
  }
  /** Snap targets for a drawn path: walkable lines (basemap paths and roads, drawn paths) and every entrance. */
  function snapTargets(geo) {
    const lines = [];
    for (const f of ['paths', 'roads']) {
      for (const x of readJson(path.join(campusMapDir, 'layers', `${f}.geojson`), { features: [] }).features) {
        if (x.geometry && x.geometry.type === 'LineString') lines.push({ id: x.properties.osmId || x.properties.id || f, coordinates: x.geometry.coordinates });
      }
    }
    const entrances = [];
    (geo.features || []).forEach((x, i) => {
      const p = x.properties || {};
      if (p.layer === 'paths' && x.geometry && x.geometry.type === 'LineString') lines.push({ id: featureId(x, i), coordinates: x.geometry.coordinates });
      if (p.layer === 'entrances' && x.geometry && x.geometry.type === 'Point') entrances.push({ id: featureId(x, i), lngLat: x.geometry.coordinates });
    });
    for (const n of outdoorGraph().nodes || []) if (n.type === 'entrance') entrances.push({ id: n.id, lngLat: [n.lng, n.lat] });
    return { lines, entrances };
  }
  /** A map edit that can cut something off is checked on the outdoor graph those overrides give. */
  function gateGeo(what, op, before, after, geo) {
    if (!connectivity || geoEditIsAdditive(op, before, after)) return;
    gate(what, { graph: outdoorGraphFor(geo, overridesDir) });
  }

  /** The Map tab's data: overrides, path classes, every entrance with its class, buildings, aerial presence. */
  function mapEditorData() {
    const pub = checkSaved().campus;
    const floorB = new Map(pub.floors.map((f) => [f.id, f.buildingId]));
    const labels = new Map();
    for (const b of pub.buildings) for (const e of Array.isArray(b.entrances) ? b.entrances : []) if (e && e.nodeId) labels.set(e.nodeId, e.label);
    const entrances = pub.navNodes.filter((n) => n.type === 'entrance' && n.lat !== undefined && n.lng !== undefined).map((n) => ({
      id: n.id, buildingId: floorB.get(n.floorId) || '', floorId: n.floorId, lat: n.lat, lng: n.lng, label: labels.get(n.id) || n.id,
      access: n.access || 'main', explicit: !!n.access,
    }));
    const geo = readGeo();
    return {
      geo: { ...geo, features: (geo.features || []).map((f, i) => ({ ...f, properties: { ...f.properties, id: featureId(f, i) } })) },
      pathAccess: readPathAccess(),
      entrances,
      buildings: pub.buildings.map((b) => ({ id: b.id, name: b.name, code: b.code, hasIndoor: truthy(b.hasIndoor), levels: b.levels, height: b.height, lat: b.lat, lng: b.lng })),
      aerial: fs.existsSync(path.join(campusMapDir, 'aerial.json')),
      mapRebuild: status().mapRebuild,
      connectivity: connectivity ? connectivity.source : 'off',
    };
  }

  // ---- corridor review ----
  function corridorReview() {
    const file = path.join(reviewDir, 'corridor-candidates.json');
    const raw = readJson(file, []);
    const list = Array.isArray(raw) ? raw : raw.candidates || [];
    const decided = new Map(readJson(reviewPath, []).map((d) => [d.room, d.decision]));
    const rooms = new Map(campus.gas.run('getAllCampusData', []).rooms.map((r) => [r.id, r]));
    const candidates = list.map((c) => {
      const id = c.roomId || c.room || c.id;
      const r = rooms.get(id);
      return {
        roomId: id, floorId: c.floorId || c.floor || (r && r.floorId) || '', label: c.label || (r && (r.label || r.number)) || id,
        evidence: c.evidence, confidence: c.confidence, decision: decided.get(id) || (r && r.type === 'corridor' ? 'accepted' : ''),
      };
    }).filter((c) => c.roomId);
    return { candidates, source: fs.existsSync(file) ? shown(file) : '' };
  }
  /** Accept (the room becomes a hallway of the given class, through updateRoom and the save check) or reject. */
  function setCorridorReview({ roomId, decision, access } = {}) {
    if (!roomId || typeof roomId !== 'string') throw new Error('roomId is required');
    if (!['accepted', 'rejected', ''].includes(decision)) throw new Error('decision: accepted, rejected or "" (undecided)');
    if (decision === 'accepted') call('updateRoom', [{ id: roomId, type: 'corridor', access: DOOR_ACCESS.includes(access) ? access : 'main' }]);
    const list = readJson(reviewPath, []).filter((d) => d.room !== roomId);
    if (decision) list.push({ room: roomId, decision });
    list.sort((a, b) => (a.room < b.room ? -1 : 1));
    writeAtomic(reviewPath, list.length ? '[\n' + list.map((d) => '  ' + JSON.stringify(d)).join(',\n') + '\n]\n' : '[]\n');
    log(`[admin] corridor review ${roomId}: ${decision || 'undecided'}`);
    return corridorReview();
  }

  const gatedData = (d) => GATED.map((c) => canonical(d[c] || [])).join('\n');

  /** One google.script.run call. Writes are checked, then saved to the overrides files before the reply. */
  function call(fn, args) {
    const a = args && args[0];
    if (fn === 'getAdminStatus') return status();
    if (fn === 'reloadFromDisk') {
      campus = open();
      checked = null;
      for (const l of describeReport(campus.report)) log(`[admin] ${l}`);
      return { reloaded: true };
    }
    if (fn === 'getMapEditorData') return mapEditorData();
    if (fn === 'checkConnectivityNow') {
      if (!connectivity) return { source: 'off' };
      checked = null;
      return { source: connectivity.source, ...checkSaved().result };
    }
    if (fn === 'getCorridorReview') return corridorReview();
    if (fn === 'setCorridorReview') return setCorridorReview(a);
    if (fn === 'setPathAccess') {
      const { way, access } = a || {};
      const geo = readGeo();
      const drawn = (geo.features || []).some((f, k) => featureId(f, k) === way && (f.properties || {}).layer === 'paths');
      if (drawn) { // a drawn path keeps its class on its feature
        writeGeo(updateFeature(geo, way, { access: !access || access === 'auto' ? 'main' : access }).geo, `path ${way} ${access}`);
        return { way, access, file: shown(geoPath) };
      }
      const list = setPathAccess(readPathAccess(), way, access);
      writeAtomic(pathAccessPath, formatPathAccess(list));
      log(`[admin] path ${way} ${access}: saved ${shown(pathAccessPath)}`);
      rebuildCampusMap(`path ${way} ${access}`);
      return { way, access, file: shown(pathAccessPath) };
    }
    if (fn === 'saveMapPath') {
      const geo = readGeo();
      const r = addPath(geo, a, snapTargets(geo));
      writeGeo(r.geo, `new path ${r.id}`);
      return { id: r.id, snaps: r.snaps };
    }
    if (fn === 'saveMapBuilding') {
      const r = addBuilding(readGeo(), a);
      writeGeo(r.geo, `new building ${r.id}`);
      return { id: r.id };
    }
    if (fn === 'saveMapEntrance') {
      const r = addEntrance(readGeo(), a);
      writeGeo(r.geo, `new entrance ${r.id}`);
      return { id: r.id };
    }
    if (fn === 'updateMapFeature') {
      const { id, changes } = a || {};
      const r = updateFeature(readGeo(), id, changes);
      gateGeo(`changing ${id}`, 'update', r.before, r.after, r.geo);
      writeGeo(r.geo, `edit ${id}`);
      return { id };
    }
    if (fn === 'deleteMapFeature') {
      const { id } = a || {};
      const r = deleteFeature(readGeo(), id);
      gateGeo(`deleting ${id}`, 'delete', r.removed.properties, null, r.geo);
      writeGeo(r.geo, `delete ${id}`);
      return { id };
    }
    if (READ_FNS.includes(fn)) return campus.gas.run(fn, args);
    if (isWriteFn(fn) && typeof campus.gas.ctx[fn] === 'function') {
      let value;
      const beforeData = campus.gas.run('getAllCampusData', []);
      const before = mapInputsOf(beforeData);
      const beforeGated = gatedData(beforeData);
      try {
        value = campus.gas.run(fn, args);
        if (connectivity && gatedData(campus.gas.run('getAllCampusData', [])) !== beforeGated) gate(describeWrite(fn, a), { campus: exportWith(campus.diff()) });
      } catch (e) {
        campus = open(); // a write that failed half-way (or was refused) must not linger in memory and ride along with the next save
        throw e;
      }
      const written = campus.save();
      if (written.length) checked = null;
      log(`[admin] ${fn}: ${written.length ? 'saved ' + written.map(shown).join(', ') : 'no change to the overrides'}`);
      if (written.length && mapInputsOf(campus.gas.run('getAllCampusData', [])) !== before) rebuildCampusMap(fn);
      return value;
    }
    throw new Error('Script function not found: ' + fn);
  }

  /** The refusal's subject: "setting ep-1-n0365 to emergency", "deleting it-1-n0490", "updateRoom room-...". */
  function describeWrite(fn, a) {
    const id = a && a.id ? a.id : '';
    if (/^update/.test(fn) && a && a.access) return `setting ${id} to ${a.access}`;
    if (/^update/.test(fn) && a && a.type) return `making ${id} a ${a.type}`;
    if (/^delete/.test(fn)) return `deleting ${id}`;
    return `${fn}${id ? ' ' + id : ''}`;
  }

  /** A static file the admin map reads: MapLibre from node_modules, basemap layers and aerial tiles. */
  function staticFile(pathname) {
    let file = null;
    if (pathname.startsWith('/__admin/vendor/')) {
      const name = pathname.slice('/__admin/vendor/'.length);
      if (MAPLIBRE_FILES.includes(name)) file = path.join(MAPLIBRE_DIR, name);
    } else if (pathname.startsWith('/__admin/campus-map/')) {
      const rel = pathname.slice('/__admin/campus-map/'.length);
      if (CAMPUS_MAP_FILE.test(rel)) file = path.join(campusMapDir, ...rel.split('/'));
    }
    if (!file || !fs.existsSync(file)) return null;
    return { type: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) };
  }

  function page() {
    let html = fs.readFileSync(path.join(HERE, 'Admin.html'), 'utf8');
    html = html.replace('__MSCN_SITE_URL__', siteUrl.replace(/"/g, '&quot;'));
    return html.replace(/<head([^>]*)>/i, (m) => `${m}\n<script src="/__admin/gas-client.js"></script>`);
  }

  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  const readBody = (req) => new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
  // Localhost only: refuse other Host names (DNS rebinding) and cross-site requests.
  const localHost = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h || '');

  const server = createServer(async (req, res) => {
    try {
      if (!localHost(req.headers.host)) return send(res, 403, 'text/plain', 'local admin: localhost only');
      const origin = req.headers.origin;
      if (origin && !localHost(origin.replace(/^https?:\/\//, ''))) return send(res, 403, 'text/plain', 'cross-site request refused');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && ['/', '/admin', '/index.html'].includes(url.pathname)) return send(res, 200, 'text/html; charset=utf-8', page());
      if (req.method === 'GET' && url.pathname === '/__admin/gas-client.js') {
        return send(res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(HERE, 'gas-client.js'), 'utf8'));
      }
      if (req.method === 'GET' && (url.pathname.startsWith('/__admin/vendor/') || url.pathname.startsWith('/__admin/campus-map/'))) {
        const f = staticFile(url.pathname);
        return f ? send(res, 200, f.type, f.body) : send(res, 404, 'text/plain', 'not found');
      }
      if (req.method === 'POST' && url.pathname.startsWith('/__admin/run/')) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, 'text/plain', 'application/json only');
        const fn = decodeURIComponent(url.pathname.slice('/__admin/run/'.length));
        const body = await readBody(req);
        const args = body ? JSON.parse(body) : [];
        let reply;
        try {
          reply = { ok: true, value: call(fn, Array.isArray(args) ? args : []) };
        } catch (err) {
          reply = { ok: false, error: String((err && err.message) || err) };
          if (err && err.refused) reply.refused = err.refused;
        }
        return send(res, 200, 'application/json', JSON.stringify(reply));
      }
      if (url.pathname === '/favicon.ico') return send(res, 204, 'text/plain', '');
      return send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      console.error('[admin]', err);
      return send(res, 500, 'text/plain', String((err && err.message) || err));
    }
  });
  return { server, call, status, siteUrl, campus: () => campus, mapRebuildIdle: () => map.idle };
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const i = process.argv.indexOf('--port');
  const port = Number(i > -1 ? process.argv[i + 1] : process.env.PORT || DEFAULT_PORT);
  const overridesDir = process.env.MSCN_OVERRIDES_DIR ? path.resolve(process.env.MSCN_OVERRIDES_DIR) : OVERRIDES_DIR;
  const campusMapDir = process.env.MSCN_CAMPUS_MAP_DIR ? path.resolve(process.env.MSCN_CAMPUS_MAP_DIR) : CAMPUS_MAP_DIR;
  const reviewDir = process.env.MSCN_REVIEW_DIR ? path.resolve(process.env.MSCN_REVIEW_DIR) : REVIEW_DIR;
  const admin = createAdmin({ overridesDir, campusMapDir, reviewDir });
  admin.server.listen(port, '127.0.0.1', () => {
    console.log(`[admin] MSCN local admin on http://localhost:${port}/`);
    console.log(`[admin] edits are saved to ${overridesDir}; QR codes link to ${admin.siteUrl}`);
  });
}
