// Local static server for the MSCN site: serves a built site (npm run build) at a sub-path, the way GitHub
// Pages does.
//
//   node dev/serve.mjs [--dist dist] [--base <basePath>] [--port 8787] [--build] [--quiet]
//       --dist  the built site (default dist/); --base the sub-path (default build.config.json basePath, else /).
//       Files are served under --base, a directory URL serves its index.html, /campus-nav redirects to
//       /campus-nav/, and any miss under --base answers 404 with the site's 404.html. Requests outside --base
//       get a plain 404 (so a root-relative URL in the app shows up as a failure), except "/" which redirects
//       to --base. --build runs scripts/build/build-site.mjs into --dist first.
//   npm run serve    = serve the last build (dist/) at http://localhost:8787/campus-nav/
//   npm run preview  = build dist/ first, then serve it
// The admin page is not served here: npm run admin (tools/admin/server.mjs).

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const PORT = Number(argValue('--port', process.env.PORT || 8787));

function send(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({ 'content-type': type, 'cache-control': 'no-cache' }, extra || {}));
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.geojson': 'application/geo+json', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
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

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { buildSite, loadBuildConfig } = await import('../scripts/build/build-site.mjs');
  const base = normalizeBase(argValue('--base', loadBuildConfig(join(ROOT, 'build.config.json')).basePath));
  const distDir = resolve(argValue('--dist', join(ROOT, 'dist')));
  if (process.argv.includes('--build')) buildSite({ out: distDir });
  const quiet = process.argv.includes('--quiet');
  let server;
  try {
    server = createStaticServer({
      dist: distDir, base,
      onRequest: (r) => { if (!quiet && r.status >= 400) console.warn(`[serve] ${r.status} ${r.method} ${r.path}`); },
    });
  } catch (e) {
    console.error(`[serve] ${e.message}`);
    process.exit(1);
  }
  server.listen(PORT, '127.0.0.1', () => console.log(`[serve] static site ${distDir} on http://localhost:${PORT}${base}`));
}
