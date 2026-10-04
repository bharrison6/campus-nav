// Builds the static site.
//
//   npm run build                                  -> dist/
//   node scripts/build/build-site.mjs --out <dir> [--config build.config.json]
//
// dist/
//   index.html               src/web/WebApp.html with every include resolved (scripts/build/render-page.mjs)
//   404.html                 sends unknown paths to the app root with the query kept (GitHub Pages serves it for any miss)
//   config.json              {analytics: {provider, site}, basePath, domain} (no map key of any kind: the map is MapLibre
//                            drawing committed OpenStreetMap data, decision mscn-v4-gps-offline-and-google-as-exit-only)
//   vendor/                  MapLibre GL JS (ESM build + worker + CSS, from node_modules, for offline use; no CDN),
//                            modules.mjs (src/web/modules.mjs: loads MapLibre and the georef module for the classic page),
//                            georef.mjs (src/shared/georef.mjs, the SVG <-> lng/lat transform shared with the exporter)
//   data/campus-map/**       the committed campus map (buildings, basemap layers, outdoor graph, optional aerial tiles)
//   data/georef/<id>.json    each indoor building's floor-frame transform
//   data/map-manifest.json   what of the above exists: {buildings, basemap[], outdoorGraph, aerial, georef{id: doc}}
//   sw.js                    the service worker with its precache manifest (scripts/build/service-worker.mjs)
//   data/campus.json         \
//   data/version.json         } the campus-data export (scripts/data/export-campus-data.mjs): public floors only;
//   floors/<floorId>.svg     /  the build fails if a hidden floor or a plan without a published floor is in it
//   data/schedules/<id>.json official schedules (data/schedules/*.json), checked against the campus data
//   data/links.json          {linkId: {title, url}}
//   CNAME                    only when build.config.json names a domain
// Every URL the page uses is relative, so the same dist/ serves at /campus-nav/ and at a domain root.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublicFloor } from '../data/export-campus-data.mjs';
import { renderPage } from './render-page.mjs';
import { precacheEntries, serviceWorkerSource } from './service-worker.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_SRC = join(ROOT, 'src', 'web');
const EXPORTER = join(ROOT, 'scripts', 'data', 'export-campus-data.mjs');
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/[^\s"'<>]+$/;

function fail(msg) { throw new Error('[build] ' + msg); }
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function loadBuildConfig(path) {
  const raw = path && existsSync(path) ? readJson(path) : {};
  const basePath = raw.basePath === undefined ? '/' : String(raw.basePath);
  if (!/^\/([A-Za-z0-9._-]+\/)*$/.test(basePath)) fail(`basePath must start and end with "/" (got ${JSON.stringify(basePath)})`);
  const domain = String(raw.domain || '').trim().toLowerCase();
  if (domain && !/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(`domain must be a bare host name such as nav.example.org (got ${JSON.stringify(domain)})`);
  const a = raw.analytics || {};
  return {
    basePath: domain ? '/' : basePath, // a custom domain serves the site at its root
    domain,
    siteUrl: String(raw.siteUrl || ''),
    analytics: { provider: String(a.provider || 'goatcounter'), site: String(a.site || '').trim() },
  };
}

/** The public config.json. There is no map key: v4 draws its own map (MapLibre + committed OSM data). */
export function siteConfig(cfg) {
  return { analytics: cfg.analytics, basePath: cfg.basePath, domain: cfg.domain };
}

/** MapLibre's browser files (ESM build, its shared chunk and worker, CSS), copied for offline use. */
export const MAPLIBRE_FILES = ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'];

export function maplibreDir(root = ROOT) {
  const dir = join(root, 'node_modules', 'maplibre-gl', 'dist');
  for (const f of MAPLIBRE_FILES) if (!existsSync(join(dir, f))) fail(`maplibre-gl is not installed (missing ${f}); run npm ci`);
  return dir;
}

function copyTree(from, to, filter) {
  let n = 0;
  if (!existsSync(from)) return 0;
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) { n += copyTree(src, dst, filter); continue; }
    if (filter && !filter(src)) continue;
    mkdirSync(to, { recursive: true });
    copyFileSync(src, dst);
    n++;
  }
  return n;
}

function readJsonChecked(p, what) {
  try { return readJson(p); } catch (e) { return fail(`${what}: ${e.message}`); }
}

/**
 * The campus map (lane J's data; contract in plan mscn-v4-campus-map-2-5d) copied into the site, and its manifest.
 * mapRoot is the repository root, or a fixture tree with the same layout (MSCN_CAMPUS_MAP_ROOT; tests only).
 *   <mapRoot>/data/campus-map/{buildings.geojson, basemap.geojson | layers/*.geojson, outdoor-graph.json, aerial.json, aerial/**}
 *   <mapRoot>/data/georef/<buildingId>.json, <mapRoot>/src/shared/georef.mjs
 * Every piece is optional; the app draws what exists (no buildings file: the building-list fallback).
 */
export function copyCampusMap(mapRoot, out) {
  const srcMap = join(mapRoot, 'data', 'campus-map');
  const srcRef = join(mapRoot, 'data', 'georef');
  const manifest = { buildings: null, basemap: [], outdoorGraph: null, aerial: null, georef: {}, georefModule: false, fixture: false };
  const dstMap = join(out, 'data', 'campus-map');
  copyTree(srcMap, dstMap, (p) => !/\.(md|txt)$/i.test(p));
  const has = (p) => existsSync(join(dstMap, p));
  if (has('buildings.geojson')) {
    const fc = readJsonChecked(join(dstMap, 'buildings.geojson'), 'campus-map/buildings.geojson');
    if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) fail('campus-map/buildings.geojson is not a FeatureCollection');
    manifest.buildings = 'data/campus-map/buildings.geojson';
    manifest.fixture = !!fc.fixture;
  }
  if (has('basemap.geojson')) manifest.basemap.push('data/campus-map/basemap.geojson');
  if (has('layers')) {
    for (const f of readdirSync(join(dstMap, 'layers')).filter((n) => n.endsWith('.geojson')).sort()) manifest.basemap.push('data/campus-map/layers/' + f);
  }
  for (const b of manifest.basemap) {
    const fc = readJsonChecked(join(out, b), b);
    if (fc.type !== 'FeatureCollection') fail(`${b} is not a FeatureCollection`);
  }
  if (has('outdoor-graph.json')) {
    const g = readJsonChecked(join(dstMap, 'outdoor-graph.json'), 'campus-map/outdoor-graph.json');
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) fail('campus-map/outdoor-graph.json lacks nodes/edges');
    manifest.outdoorGraph = 'data/campus-map/outdoor-graph.json';
  }
  if (has('aerial.json') && has('aerial')) {
    const a = readJsonChecked(join(dstMap, 'aerial.json'), 'campus-map/aerial.json');
    manifest.aerial = Object.assign({ tiles: 'data/campus-map/aerial/{z}/{x}/{y}.jpg' }, a);
  }
  if (existsSync(srcRef)) {
    mkdirSync(join(out, 'data', 'georef'), { recursive: true });
    for (const f of readdirSync(srcRef).filter((n) => n.endsWith('.json')).sort()) {
      const doc = readJsonChecked(join(srcRef, f), 'georef/' + f);
      const id = doc.buildingId || f.replace(/\.json$/, '');
      if (!doc.transform) fail(`georef/${f} has no transform`);
      copyFileSync(join(srcRef, f), join(out, 'data', 'georef', f));
      manifest.georef[id] = doc;
    }
  }
  const mod = join(mapRoot, 'src', 'shared', 'georef.mjs');
  if (existsSync(mod)) {
    mkdirSync(join(out, 'vendor'), { recursive: true });
    copyFileSync(mod, join(out, 'vendor', 'georef.mjs'));
    manifest.georefModule = true;
  }
  return manifest;
}

export function notFoundPage(basePath) {
  const base = JSON.stringify(basePath);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Murray State Campus Nav</title>
<script>
(function () {
  var base = ${base};
  var path = window.location.pathname;
  if (path.indexOf(base) !== 0) {
    var m = /^\\/[^\\/]+\\//.exec(path);
    base = (/\\.github\\.io$/.test(window.location.hostname) && m) ? m[0] : '/';
  }
  window.location.replace(base + window.location.search + window.location.hash);
})();
</script>
</head>
<body><p style="font-family:system-ui,sans-serif;padding:16px">Opening <a href="${basePath}">Campus Nav</a>&hellip;</p></body>
</html>
`;
}

/** Absolute-path URLs break the sub-path deployment; refuse them in the built page. */
export function findRootRelativeUrls(html) {
  const hits = [];
  const re = /\b(?:src|href|action)\s*=\s*["']\/(?!\/)[^"']*["']|\b(?:fetch|open)\(\s*["']\/(?!\/)[^"']*["']|["']\/(?:data|floors|config\.json)\b[^"']*["']/g;
  let m;
  while ((m = re.exec(html))) hits.push(m[0]);
  return hits;
}

export function validateLinks(links) {
  const errors = [];
  if (!links || typeof links !== 'object' || Array.isArray(links)) return ['links.json must be an object {linkId: {title, url}}'];
  for (const [id, l] of Object.entries(links)) {
    if (!ID_RE.test(id)) errors.push(`links.json: bad link id ${JSON.stringify(id)}`);
    if (!l || typeof l.title !== 'string' || !l.title.trim()) errors.push(`links.json ${id}: title is required`);
    if (!l || typeof l.url !== 'string' || !URL_RE.test(l.url)) errors.push(`links.json ${id}: url must be http(s)`);
  }
  return errors;
}

/** Checks one official schedule against the campus data and the link table. Returns error strings. */
export function validateSchedule(sched, fileId, campus, links) {
  const where = `schedules/${fileId}.json`;
  const errors = [];
  if (!sched || typeof sched !== 'object') return [`${where}: not an object`];
  if (!ID_RE.test(fileId)) errors.push(`${where}: file name must be an id (letters, digits, - and _)`);
  if (sched.id !== fileId) errors.push(`${where}: id ${JSON.stringify(sched.id)} must match the file name`);
  if (typeof sched.title !== 'string' || !sched.title.trim()) errors.push(`${where}: title is required`);
  if (typeof sched.date !== 'string' || !DATE_RE.test(sched.date)) errors.push(`${where}: date must be YYYY-MM-DD`);
  if (!Array.isArray(sched.events) || !sched.events.length) return errors.concat(`${where}: events must be a non-empty array`);
  const buildings = new Map((campus.buildings || []).map((b) => [b.id, b]));
  const floors = new Map((campus.floors || []).map((f) => [f.id, f]));
  const rooms = new Map((campus.rooms || []).map((r) => [r.id, r]));
  sched.events.forEach((ev, i) => {
    const at = `${where} event ${i + 1}`;
    if (!ev || typeof ev !== 'object') { errors.push(`${at}: not an object`); return; }
    if (typeof ev.time !== 'string' || !TIME_RE.test(ev.time)) errors.push(`${at}: time must be HH:MM (24 h)`);
    if (typeof ev.title !== 'string' || !ev.title.trim()) errors.push(`${at}: title is required`);
    if (!buildings.has(ev.buildingId)) errors.push(`${at}: unknown buildingId ${JSON.stringify(ev.buildingId)}`);
    if (ev.roomId !== undefined && ev.roomId !== null && ev.roomId !== '') {
      const r = rooms.get(ev.roomId);
      const f = r && floors.get(r.floorId);
      if (!r) errors.push(`${at}: unknown roomId ${JSON.stringify(ev.roomId)}`);
      else if (!f || !isPublicFloor(f)) errors.push(`${at}: room ${ev.roomId} is on a floor that is not public`);
      else if (f.buildingId !== ev.buildingId) errors.push(`${at}: room ${ev.roomId} is in ${f.buildingId}, not ${ev.buildingId}`);
    }
    if (ev.note !== undefined && typeof ev.note !== 'string') errors.push(`${at}: note must be text`);
    if (ev.links !== undefined) {
      if (!Array.isArray(ev.links)) errors.push(`${at}: links must be an array of link ids`);
      else for (const l of ev.links) if (!Object.prototype.hasOwnProperty.call(links, l)) errors.push(`${at}: link id ${JSON.stringify(l)} is not in data/links.json`);
    }
  });
  return errors;
}

function cleanOut(out) {
  const rel = relative(out, ROOT);
  if (out === ROOT || (rel && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel))) fail(`refusing to build into ${out}: it contains the repository`);
  if (!existsSync(out)) return;
  if (!statSync(out).isDirectory()) fail(`${out} exists and is not a directory`);
  const entries = readdirSync(out);
  if (entries.length && !entries.includes('index.html')) fail(`refusing to clean ${out}: it is not empty and holds no index.html (not a site build)`);
  rmSync(out, { recursive: true, force: true });
}

function runExporter(dataDir, log) {
  const r = spawnSync(process.execPath, [EXPORTER, '--out', dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180_000 });
  if (r.stdout) log(r.stdout.trimEnd());
  if (r.status !== 0) fail(`exporter failed (${r.status ?? r.signal}): ${(r.stderr || '').trim()}`);
}

export function buildSite({ out = join(ROOT, 'dist'), configPath = join(ROOT, 'build.config.json'), env = process.env, log = console.log } = {}) {
  out = resolve(out);
  const cfg = loadBuildConfig(configPath);
  cleanOut(out);
  mkdirSync(join(out, 'data', 'schedules'), { recursive: true });

  // 1. campus data via the exporter (writes data/campus.json, data/version.json, data/floors/*.svg)
  const dataDir = join(out, 'data');
  runExporter(dataDir, log);
  for (const f of ['campus.json', 'version.json']) if (!existsSync(join(dataDir, f))) fail(`exporter wrote no data/${f}`);
  const campus = readJson(join(dataDir, 'campus.json'));
  if (!Array.isArray(campus.buildings) || !Array.isArray(campus.floors) || !Array.isArray(campus.rooms)) fail('campus.json lacks buildings/floors/rooms');
  const keyRows = (campus.config || []).filter((c) => c && c.key === 'mapsApiKey');
  if (keyRows.length) {
    campus.config = campus.config.filter((c) => !(c && c.key === 'mapsApiKey'));
    writeFileSync(join(dataDir, 'campus.json'), JSON.stringify(campus));
    log('[build] warning: removed a mapsApiKey row from campus.json (the key belongs in config.json only)');
  }
  const version = readJson(join(dataDir, 'version.json'));
  if (version.version === undefined || version.version === null || version.version === '') fail('data/version.json has no version');
  const hidden = campus.floors.filter((f) => !isPublicFloor(f)).map((f) => f.id);
  if (hidden.length) fail(`campus.json carries hidden floor(s) ${hidden.join(', ')}; only public floors are published`);
  if (existsSync(join(dataDir, 'floors'))) renameSync(join(dataDir, 'floors'), join(out, 'floors'));
  else mkdirSync(join(out, 'floors'));
  const published = new Set(campus.floors.map((f) => `${f.id}.svg`));
  const stray = readdirSync(join(out, 'floors')).filter((n) => !published.has(n));
  if (stray.length) fail(`floor plans for floors that are not published: ${stray.join(', ')}`);
  const missing = campus.floors.map((f) => f.id).filter((id) => !existsSync(join(out, 'floors', `${id}.svg`)));
  if (missing.length) log(`[build] warning: no floor plan SVG for floor(s) ${missing.join(', ')}; the app draws a simplified plan`);

  // 2. official schedules and links, checked against the data they point into
  const linksPath = join(ROOT, 'data', 'links.json');
  const links = existsSync(linksPath) ? readJson(linksPath) : {};
  const errors = validateLinks(links);
  const schedDir = join(ROOT, 'data', 'schedules');
  const schedules = existsSync(schedDir) ? readdirSync(schedDir).filter((f) => f.endsWith('.json')).sort() : [];
  for (const f of schedules) {
    const id = f.replace(/\.json$/, '');
    let sched;
    try { sched = readJson(join(schedDir, f)); } catch (e) { errors.push(`schedules/${f}: ${e.message}`); continue; }
    errors.push(...validateSchedule(sched, id, campus, links));
    writeFileSync(join(out, 'data', 'schedules', f), JSON.stringify(sched));
  }
  if (errors.length) fail('official schedules / links:\n  ' + errors.join('\n  '));
  writeFileSync(join(out, 'data', 'links.json'), JSON.stringify(links));

  // 3. the map: MapLibre (vendored), the module loader, the campus map data and its manifest
  const vendor = join(out, 'vendor');
  mkdirSync(vendor, { recursive: true });
  const mlDir = maplibreDir();
  for (const f of MAPLIBRE_FILES) copyFileSync(join(mlDir, f), join(vendor, f));
  const mlLicense = join(mlDir, '..', 'LICENSE.txt');
  if (existsSync(mlLicense)) copyFileSync(mlLicense, join(vendor, 'maplibre-gl-LICENSE.txt'));
  copyFileSync(join(WEB_SRC, 'modules.mjs'), join(vendor, 'modules.mjs'));
  const mapRoot = env.MSCN_CAMPUS_MAP_ROOT ? resolve(ROOT, env.MSCN_CAMPUS_MAP_ROOT) : ROOT;
  const map = copyCampusMap(mapRoot, out);
  writeFileSync(join(out, 'data', 'map-manifest.json'), JSON.stringify(map));
  if (map.fixture) log(`[build] campus map from the FIXTURE ${relative(ROOT, mapRoot)} (MSCN_CAMPUS_MAP_ROOT); not for deployment`);

  // 4. the page, its config, 404 and CNAME
  const html = renderPage(WEB_SRC, 'WebApp');
  const rootUrls = findRootRelativeUrls(html);
  if (rootUrls.length) fail('root-relative URLs would break the sub-path site: ' + rootUrls.slice(0, 5).join(' | '));
  writeFileSync(join(out, 'index.html'), html);
  const site = siteConfig(cfg);
  writeFileSync(join(out, 'config.json'), JSON.stringify(site, null, 2) + '\n');
  writeFileSync(join(out, '404.html'), notFoundPage(cfg.basePath));
  if (cfg.domain) writeFileSync(join(out, 'CNAME'), cfg.domain + '\n');

  // 5. the service worker, last: its precache manifest hashes every file above
  const precache = precacheEntries(out);
  writeFileSync(join(out, 'sw.js'), serviceWorkerSource({ version: version.version, entries: precache }));

  const bytes = (p) => (existsSync(p) ? statSync(p).size : 0);
  const summary = {
    out, version: version.version, basePath: cfg.basePath, domain: cfg.domain || null,
    analytics: cfg.analytics.site ? cfg.analytics.provider : 'off',
    floors: readdirSync(join(out, 'floors')).length, schedules: schedules.length, indexBytes: Buffer.byteLength(html),
    maplibreBytes: MAPLIBRE_FILES.reduce((n, f) => n + bytes(join(vendor, f)), 0),
    map: { buildings: !!map.buildings, basemap: map.basemap.length, outdoorGraph: !!map.outdoorGraph, aerial: !!map.aerial,
      georef: Object.keys(map.georef), fixture: map.fixture },
    precache: precache.length,
  };
  log(`[build] ${relative(ROOT, out) || out}: index.html ${summary.indexBytes} B, MapLibre ${summary.maplibreBytes} B, ${summary.floors} floor plans, ` +
    `${summary.schedules} schedule(s), data ${summary.version}, base ${summary.basePath}${summary.domain ? ', CNAME ' + summary.domain : ''}, ` +
    `map ${map.buildings ? 'buildings' : 'NO buildings'}/${map.basemap.length} basemap/${map.outdoorGraph ? 'graph' : 'no graph'}/` +
    `${map.aerial ? 'aerial' : 'no aerial'}/georef ${summary.map.georef.join(',') || 'none'}, sw ${precache.length} files, analytics ${summary.analytics}`);
  return summary;
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
  try {
    buildSite({ out: arg('--out') ? resolve(arg('--out')) : undefined, configPath: arg('--config') ? resolve(arg('--config')) : undefined });
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
