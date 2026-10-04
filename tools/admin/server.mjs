#!/usr/bin/env node
// The local admin: Admin.html on localhost, answered by the backend (tools/admin/gs) in the Apps Script stand-in,
// over seed + pipeline data + data/overrides. Every write is saved straight away as data/overrides/*.json (only the
// difference from the seed and pipeline data); commit and push those files to publish. Never deployed, so no PIN.
// A save that changes what the campus map is built from (an entrance's primary flag or position, a building's levels
// or height) reruns npm run campus-map in the background (offline, committed inputs), so data/campus-map, data/georef
// and the floors' entrance blocks match the overrides; the admin then reloads. getAdminStatus reports the last run.
//
//   npm run admin                       http://localhost:8790/
//   node tools/admin/server.mjs [--port 8790]
//
// Environment:
//   MSCN_SITE_URL      the public site QR codes link to (https, default https://bharrison6.github.io/campus-nav/,
//                      or build.config.json "siteUrl" when that file sets one)
//   MSCN_OVERRIDES_DIR where edits are saved (default data/overrides; tests point it elsewhere)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { OVERRIDES_DIR, REPO, describeReport, openCampus } from '../../scripts/data/campus-engine.mjs';
import { COLLECTIONS } from '../../scripts/data/overrides.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 8790;
export const DEFAULT_SITE_URL = 'https://bharrison6.github.io/campus-nav/';

/** Backend reads the admin page uses. */
export const READ_FNS = ['getAllCampusData', 'getFloorPlanSvg', 'getDataVersion'];
/** Backend writes: every public save/update/delete function; each one is followed by a save of the overrides. */
export const isWriteFn = (name) => /^(save|update|delete)[A-Z][A-Za-z]*$/.test(name);
/** Answered by this server, not by the backend. */
export const SERVER_FNS = ['getAdminStatus', 'reloadFromDisk'];

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
 * What the campus map is built from, of the admin's data: entrance nodes (primary, floor, position) and buildings'
 * levels and height. Two writes that leave this string unchanged need no rebuild.
 */
export function mapInputsOf(data) {
  const truthy = (v) => v === true || v === 'true';
  const ents = (data.navNodes || []).filter((n) => n.type === 'entrance')
    .map((n) => [n.id, n.floorId, Number(n.x), Number(n.y), truthy(n.primary)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
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

/**
 * @param {Function|null} [o.rebuildMap] runs the campus-map build after a map-relevant save (returns a promise);
 *   default: npm run campus-map when the overrides are the repository's own (it reads data/overrides), else none
 */
export function createAdmin({ overridesDir = OVERRIDES_DIR, gsDir, extraCode, env = process.env, log = console.log, rebuildMap } = {}) {
  const open = () => openCampus({ gsDir, overridesDir, extraCode });
  let campus = open();
  const rebuild = rebuildMap !== undefined ? rebuildMap
    : (path.resolve(overridesDir) === path.resolve(OVERRIDES_DIR) && !gsDir ? () => runCampusMap() : null);
  const map = { running: false, pending: false, last: null, idle: Promise.resolve() };

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
    return { overridesDir, files, report: describeReport(campus.report), mapRebuild: { running: map.running, last: map.last } };
  }

  /** One google.script.run call. Writes are saved to the overrides files before the reply. */
  function call(fn, args) {
    if (fn === 'getAdminStatus') return status();
    if (fn === 'reloadFromDisk') {
      campus = open();
      for (const l of describeReport(campus.report)) log(`[admin] ${l}`);
      return { reloaded: true };
    }
    if (READ_FNS.includes(fn)) return campus.gas.run(fn, args);
    if (isWriteFn(fn) && typeof campus.gas.ctx[fn] === 'function') {
      let value;
      const before = mapInputsOf(campus.gas.run('getAllCampusData', []));
      try {
        value = campus.gas.run(fn, args);
      } catch (e) {
        campus = open(); // a write that failed half-way must not linger in memory and ride along with the next save
        throw e;
      }
      const written = campus.save();
      log(`[admin] ${fn}: ${written.length ? 'saved ' + written.map(shown).join(', ') : 'no change to the overrides'}`);
      if (written.length && mapInputsOf(campus.gas.run('getAllCampusData', [])) !== before) rebuildCampusMap(fn);
      return value;
    }
    throw new Error('Script function not found: ' + fn);
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
  const admin = createAdmin({ overridesDir });
  admin.server.listen(port, '127.0.0.1', () => {
    console.log(`[admin] MSCN local admin on http://localhost:${port}/`);
    console.log(`[admin] edits are saved to ${overridesDir}; QR codes link to ${admin.siteUrl}`);
  });
}
