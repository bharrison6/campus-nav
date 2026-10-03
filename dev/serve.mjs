// Local preview harness for the MSCN public web app.
//
//   node dev/serve.mjs [--port 8787]
//
// Serves scripts/apps-script/src/WebApp.html the way Apps Script would after
// HtmlService.createTemplateFromFile('WebApp').evaluate(): <?!= include('X') ?> inlines
// src/X.html, the app-URL scriptlet resolves to this server, HTML comments are stripped.
// A mocked google.script.run (dev/mock-gas.js) answers from fixture data:
//   - dev/fixtures/campus-data.json, dev/fixtures/svg/<planAsset>.svg  (default)
//   - or MSCN_FIXTURES=<dir> holding the same layout (campus-data.json, svg/)
//   - floor SVGs fall back to src/<planAsset>.html, the embedded GAS asset lane A generates.
//
// Page query flags (read by the mock): mock_delay=<ms>, mock_fail=<fn,fn>, mock_offline=1,
// mock_key=<maps key typed by you for a manual check; never stored>.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'scripts', 'apps-script', 'src');
const FIXTURES = resolve(process.env.MSCN_FIXTURES || join(here, 'fixtures'));

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

// Minimal HtmlService template evaluation for the scriptlets the web app uses.
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

function loadData() {
  return JSON.parse(readFileSync(join(FIXTURES, 'campus-data.json'), 'utf8'));
}

function floorSvg(floorId) {
  const data = loadData();
  const floor = (data.floors || []).find((f) => f.id === floorId);
  if (!floor) return null;
  const asset = floor.planAsset || 'FP_' + floorId.replace(/-/g, '_');
  const candidates = [join(FIXTURES, 'svg', asset + '.svg'), join(SRC, asset + '.html')];
  for (const p of candidates) if (existsSync(p)) return readFileSync(p, 'utf8');
  return null;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/' || url.pathname === '/exec' || url.pathname === '/index.html') {
      const appUrl = `http://${req.headers.host}/exec`;
      let html = renderTemplate('WebApp', appUrl);
      const mock = '<script src="/__mock/gas.js"></script>';
      html = html.replace(/<head([^>]*)>/i, (m) => m + '\n' + mock);
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    if (url.pathname === '/__mock/gas.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(here, 'mock-gas.js'), 'utf8'));
    }
    if (url.pathname === '/__mock/data') {
      return send(res, 200, 'application/json', JSON.stringify(loadData()));
    }
    if (url.pathname.startsWith('/__mock/svg/')) {
      const svg = floorSvg(decodeURIComponent(url.pathname.slice('/__mock/svg/'.length)));
      if (svg === null) return send(res, 404, 'text/plain', 'Floor plan not found');
      return send(res, 200, 'text/plain; charset=utf-8', svg);
    }
    if (url.pathname === '/favicon.ico') return send(res, 204, 'text/plain', '');
    return send(res, 404, 'text/plain', 'not found');
  } catch (err) {
    console.error('[serve]', err);
    return send(res, 500, 'text/plain', String(err && err.stack || err));
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[serve] MSCN web app harness on http://localhost:${PORT}/  (fixtures: ${FIXTURES})`);
  });
}
