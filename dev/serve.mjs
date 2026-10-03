// Local preview harness for the MSCN web app and admin page.
//
//   node dev/serve.mjs [--port 8787]
//
// Pages are served the way Apps Script serves them after HtmlService.createTemplateFromFile(...).evaluate():
// <?!= include('X') ?> inlines src/X.html, the app-URL scriptlet resolves to this server, HTML comments
// are stripped, and the title and meta tags come from doGet's HtmlOutput (Code.gs PAGES_).
//   /  or /exec                    the public web app (WebApp.html)
//   /admin or /exec?action=admin   the admin page (Admin.html)
//   /exec?action=<name>            the JSON actions of doGet (ping, getCampusDataStats, ...)
//
// google.script.run is answered by the REAL backend: every scripts/apps-script/src/*.gs file runs in an
// Apps Script runtime stand-in (dev/gas-runtime.cjs) whose in-memory spreadsheet is created and seeded by
// initSystem() at startup, so the data is the generated SeedFloorData.gs (the floor-plan pipeline's
// output) and the floor plans are the embedded FP_*.html assets. Restart the server after changing .gs
// files. Admin writes change the in-memory sheet only; a restart reseeds.
//
// Admin PIN for this local harness: MSCN_DEV_PIN, default 246810 (a local test value; a deployed
// project generates its own).
//
// Page query flags (read by dev/mock-gas.js in the browser): mock_delay=<ms>, mock_fail=<fn,fn>,
// mock_offline=1, mock_key=<maps key typed by you for a manual check; never stored>.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { makeRuntime } = require('./gas-runtime.cjs');
const SRC = resolve(here, '..', 'scripts', 'apps-script', 'src');

function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PORT = Number(argValue('--port', process.env.PORT || 8787));

function readSrc(name) {
  const p = join(SRC, name.endsWith('.html') ? name : name + '.html');
  if (!existsSync(p)) throw new Error(`include not found: ${name}`);
  return readFileSync(p, 'utf8');
}

// Minimal HtmlService template evaluation for the scriptlets the pages use.
export function renderTemplate(name, appUrl, depth = 0) {
  if (depth > 5) throw new Error('include depth exceeded');
  let html = readSrc(name);
  html = html.replace(/<\?!=\s*include\(\s*['"]([\w-]+)['"]\s*\)\s*;?\s*\?>/g, (_, inc) => readSrc(inc));
  html = html.replace(/<\?=\s*ScriptApp\.getService\(\)\.getUrl\(\)\s*;?\s*\?>/g, appUrl);
  html = html.replace(/<\?[\s\S]*?\?>/g, (m) => {
    console.warn('[serve] unhandled scriptlet blanked:', m.slice(0, 60));
    return '';
  });
  // HtmlService strips HTML comments from served output; mirror it so the harness shows the same page.
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  return html;
}

/** The backend: the .gs files in the runtime stand-in, initialized like a first ?action=init. */
export function startBackend() {
  const gas = makeRuntime(SRC);
  gas.props.ADMIN_PIN = process.env.MSCN_DEV_PIN || '246810';
  const init = JSON.parse(JSON.stringify(gas.ctx.initSystem()));
  return { gas, init };
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
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
    // What doGet sets on the HtmlOutput (title, viewport); HtmlService ignores in-page viewport metas.
    const out = gas.ctx.doGet({ parameter: file === 'Admin' ? { action: 'admin' } : {} });
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
      if (url.pathname === '/' || url.pathname === '/exec' || url.pathname === '/index.html') return page(res, req, 'WebApp');
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

if (isMain) {
  const { server, init } = createHarness();
  server.listen(PORT, '127.0.0.1', () => {
    const s = init.seeded || {};
    console.log(`[serve] MSCN harness on http://localhost:${PORT}/  (admin: /admin)`);
    console.log(`[serve] seeded from the .gs files: ${Object.entries(s).map(([k, v]) => k + ' ' + v).join(', ')}`);
  });
}
