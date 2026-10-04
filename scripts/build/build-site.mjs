// Builds the static site (plan mscn-v3-static-migration, lane F).
//
//   npm run build                                  -> dist/
//   node scripts/build/build-site.mjs --out <dir> [--config build.config.json]
//
// dist/
//   index.html               src/web/WebApp.html with every include resolved (scripts/build/render-page.mjs)
//   404.html                 sends unknown paths to the app root with the query kept (GitHub Pages serves it for any miss)
//   config.json              {mapsApiKey, analytics: {provider, site}, basePath, domain}; the key comes ONLY from the
//                            MAPS_API_KEY environment variable at build time (repository secret in CI), never from a file
//   data/campus.json         \
//   data/version.json         } the campus-data export (scripts/data/export-campus-data.mjs); plans of public
//   floors/<floorId>.svg     /  floors only (the build fails if a hidden floor's plan is in the export)
//   data/schedules/<id>.json official schedules (data/schedules/*.json), checked against the campus data
//   data/links.json          {linkId: {title, url}}
//   CNAME                    only when build.config.json names a domain
// Every URL the page uses is relative, so the same dist/ serves at /campus-nav/ and at a domain root.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublicFloor } from '../data/export-campus-data.mjs';
import { renderPage } from './render-page.mjs';

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

/** The public config.json. The Maps key is read from the environment here and nowhere else. */
export function siteConfig(cfg, env) {
  const key = String((env && env.MAPS_API_KEY) || '').trim();
  if (key && !/^[A-Za-z0-9_-]{20,}$/.test(key)) fail('MAPS_API_KEY is set but does not look like a Google API key');
  return { mapsApiKey: key, analytics: cfg.analytics, basePath: cfg.basePath, domain: cfg.domain };
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
  if (existsSync(join(dataDir, 'floors'))) renameSync(join(dataDir, 'floors'), join(out, 'floors'));
  else mkdirSync(join(out, 'floors'));
  const missing = campus.floors.filter(isPublicFloor).map((f) => f.id).filter((id) => !existsSync(join(out, 'floors', `${id}.svg`)));
  if (missing.length) log(`[build] warning: no floor plan SVG for public floor(s) ${missing.join(', ')}; the app draws a simplified plan`);
  const hidden = campus.floors.filter((f) => !isPublicFloor(f)).map((f) => f.id).filter((id) => existsSync(join(out, 'floors', `${id}.svg`)));
  if (hidden.length) fail(`the export published the plan of hidden floor(s) ${hidden.join(', ')}`);

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

  // 3. the page, its config, 404 and CNAME
  const html = renderPage(WEB_SRC, 'WebApp');
  const rootUrls = findRootRelativeUrls(html);
  if (rootUrls.length) fail('root-relative URLs would break the sub-path site: ' + rootUrls.slice(0, 5).join(' | '));
  writeFileSync(join(out, 'index.html'), html);
  const site = siteConfig(cfg, env);
  writeFileSync(join(out, 'config.json'), JSON.stringify(site, null, 2) + '\n');
  writeFileSync(join(out, '404.html'), notFoundPage(cfg.basePath));
  if (cfg.domain) writeFileSync(join(out, 'CNAME'), cfg.domain + '\n');

  const summary = {
    out, version: version.version, basePath: cfg.basePath, domain: cfg.domain || null,
    mapsKey: site.mapsApiKey ? 'set' : 'none (key-free fallback)', analytics: cfg.analytics.site ? cfg.analytics.provider : 'off',
    floors: readdirSync(join(out, 'floors')).length, schedules: schedules.length, indexBytes: Buffer.byteLength(html),
  };
  log(`[build] ${relative(ROOT, out) || out}: index.html ${summary.indexBytes} B, ${summary.floors} floor plans, ${summary.schedules} schedule(s), ` +
    `data ${summary.version}, base ${summary.basePath}${summary.domain ? ', CNAME ' + summary.domain : ''}, Maps key ${summary.mapsKey}, analytics ${summary.analytics}`);
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
