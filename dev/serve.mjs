// Local server for the MSCN static site, plus the retiring Apps Script harness for the admin page.
//
//   node dev/serve.mjs --dist dist --base /campus-nav/ [--port 8787] [--build] [--quiet]
//       Serves a built site (npm run build) at a sub-path, the way GitHub Pages does: files under --base,
//       a directory URL serves its index.html, /campus-nav redirects to /campus-nav/, and any miss under
//       --base answers 404 with the site's 404.html. Requests outside --base get a plain 404 (so a
//       root-relative URL in the app shows up as a failure), except "/" which redirects to --base.
//       --build runs scripts/build/build-site.mjs into --dist first. MAPS_API_KEY in the environment
//       reaches the build only; nothing here stores it.
//   npm run preview  = build dist/ and serve it at http://localhost:8787/campus-nav/
//
//   node dev/serve.mjs [--port 8787]            (no --dist: the Apps Script harness, admin page only)
//       /admin or /exec?action=admin  the admin page (Admin.html) with google.script.run answered by the real
//       .gs backend in the runtime stand-in (dev/gas-runtime.cjs); /exec?action=<name> the JSON actions.
//       The public web app is no longer served here: it is a static site now (src/web, built by
//       npm run build). Admin PIN for this harness: MSCN_DEV_PIN, default 246810 (a local test value).
//       Lane G's local admin (tools/admin) replaces this mode.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../scripts/build/render-page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const require = createRequire(import.meta.url);

function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const PORT = Number(argValue('--port', process.env.PORT || 8787));

function send(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({ 'content-type': type, 'cache-control': 'no-cache' }, extra || {}));
  res.end(body);
}

// ------------------------------------------------------------------------------------------------
// Static mode
// ------------------------------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function normalizeBase(base) {
  let b = String(base || '/');
  if (!b.startsWith('/')) b = '/' + b;
  if (!b.endsWith('/')) b += '/';
  return b;
}

/** A static file server for a built site at a sub-path. onRequest(info) sees every request (tests, logs). */
export function createStaticServer({ dist, base = '/', onRequest } = {}) {
  const root = resolve(dist);
  const B = normalizeBase(base);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`no index.html in ${root}; run npm run build first`);
  const notFound = existsSync(join(root, '404.html')) ? readFileSync(join(root, '404.html')) : 'not found';

  return createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'text/plain', 'bad path'); }
    const info = { method: req.method, path, status: 0 };
    const done = (status, type, body, extra) => { info.status = status; if (onRequest) onRequest(info); send(res, status, type, body, extra); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return done(405, 'text/plain', 'method not allowed');
    if (B !== '/' && path === '/') return done(302, 'text/plain', 'see ' + B, { location: B });
    if (B !== '/' && path === B.slice(0, -1)) return done(301, 'text/plain', 'see ' + B, { location: B + url.search });
    if (!path.startsWith(B)) return done(404, 'text/plain', `outside the site base ${B}: ${path}`);
    let rel = path.slice(B.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) return done(404, 'text/html; charset=utf-8', notFound);
    if (existsSync(file) && statSync(file).isDirectory()) return done(301, 'text/plain', 'see ' + path + '/', { location: path + '/' + url.search });
    if (!existsSync(file)) return done(404, 'text/html; charset=utf-8', notFound);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    return done(200, type, req.method === 'HEAD' ? '' : readFileSync(file));
  });
}

// ------------------------------------------------------------------------------------------------
// Apps Script harness (admin page until lane G's tools/admin lands)
// ------------------------------------------------------------------------------------------------

function firstExisting(paths) { return paths.find((p) => existsSync(p)) || null; }
const GAS_SRC = firstExisting([join(ROOT, 'scripts', 'apps-script', 'src'), join(ROOT, 'archive', 'apps-script-v2', 'src')]);

/** HtmlService-style evaluation of a page in the Apps Script sources (the admin page). */
export function renderTemplate(name, appUrl) {
  return renderPage(GAS_SRC, name, { scriptlets: { 'ScriptApp.getService().getUrl()': appUrl }, onUnhandled: 'blank' });
}

/** The backend: the .gs files in the runtime stand-in, initialized like a first ?action=init. */
export function startBackend() {
  if (!GAS_SRC) throw new Error('the Apps Script sources are not in this checkout');
  const { makeRuntime } = require('./gas-runtime.cjs');
  const gas = makeRuntime(GAS_SRC);
  gas.props.ADMIN_PIN = process.env.MSCN_DEV_PIN || '246810';
  const init = JSON.parse(JSON.stringify(gas.ctx.initSystem()));
  return { gas, init };
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

export function createHarness() {
  const { gas, init } = startBackend();

  function page(res, req, file) {
    const appUrl = `http://${req.headers.host}/exec`;
    let html = renderTemplate(file, appUrl);
    const out = gas.ctx.doGet({ parameter: { action: 'admin' } });
    const head = [];
    for (const [name, content] of Object.entries(out.metaTags || {})) head.push(`<meta name="${name}" content="${content}">`);
    if (out.title) head.push(`<title>${out.title}</title>`);
    head.push('<script src="/__mock/gas.js"></script>');
    html = html.replace(/<head([^>]*)>/i, (m) => m + '\n' + head.join('\n'));
    return send(res, 200, 'text/html; charset=utf-8', html);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const action = url.searchParams.get('action') || '';
      if (url.pathname === '/admin' || (url.pathname === '/exec' && action === 'admin')) return page(res, req, 'Admin');
      if (url.pathname === '/exec' && action && action !== 'web') {
        const out = gas.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
        return send(res, 200, 'application/json', out.text);
      }
      if (url.pathname === '/' || url.pathname === '/exec' || url.pathname === '/index.html') {
        return send(res, 200, 'text/plain; charset=utf-8',
          'The public web app is a static site now: npm run preview (build + serve at /campus-nav/).\nAdmin page: /admin\n');
      }
      if (url.pathname === '/__mock/gas.js') {
        return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(here, 'mock-gas.js'), 'utf8'));
      }
      if (url.pathname.startsWith('/__mock/run/') && req.method === 'POST') {
        const fn = decodeURIComponent(url.pathname.slice('/__mock/run/'.length));
        const body = await readBody(req);
        const args = body ? JSON.parse(body) : [];
        let reply;
        try {
          reply = { ok: true, value: gas.run(fn, Array.isArray(args) ? args : []) };
        } catch (err) {
          reply = { ok: false, error: String((err && err.message) || err) };
        }
        return send(res, 200, 'application/json', JSON.stringify(reply));
      }
      if (url.pathname === '/favicon.ico') return send(res, 204, 'text/plain', '');
      return send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      console.error('[serve]', err);
      return send(res, 500, 'text/plain', String((err && err.stack) || err));
    }
  });
  return { server, gas, init };
}

// ------------------------------------------------------------------------------------------------

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const dist = argValue('--dist', null);
  if (dist) {
    const base = normalizeBase(argValue('--base', '/'));
    const distDir = resolve(dist);
    if (process.argv.includes('--build')) {
      const { buildSite } = await import('../scripts/build/build-site.mjs');
      buildSite({ out: distDir });
    }
    const quiet = process.argv.includes('--quiet');
    const server = createStaticServer({
      dist: distDir, base,
      onRequest: (r) => { if (!quiet && r.status >= 400) console.warn(`[serve] ${r.status} ${r.method} ${r.path}`); },
    });
    server.listen(PORT, '127.0.0.1', () => console.log(`[serve] static site ${distDir} on http://localhost:${PORT}${base}`));
  } else {
    const { server, init } = createHarness();
    server.listen(PORT, '127.0.0.1', () => {
      const s = init.seeded || {};
      console.log(`[serve] Apps Script harness (admin) on http://localhost:${PORT}/admin`);
      console.log(`[serve] seeded from the .gs files: ${Object.entries(s).map(([k, v]) => k + ' ' + v).join(', ')}`);
    });
  }
}
