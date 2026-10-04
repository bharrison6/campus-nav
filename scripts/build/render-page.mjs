// Resolves an HtmlService-style page template into one static HTML document.
//
//   renderPage(srcDir, 'WebApp', { scriptlets, onUnhandled })
//
// <?!= include('X') ?> inlines <srcDir>/X.html (recursively, depth-limited); each entry of `scriptlets`
// maps a printing scriptlet's expression (e.g. 'ScriptApp.getService().getUrl()') to its replacement
// text; HTML comments are stripped, as HtmlService does for served output. Any scriptlet left over is
// an error by default (a static site cannot run it); pass onUnhandled: 'blank' to blank it with a
// warning instead (what the Apps Script preview harness did). Shared by scripts/build/build-site.mjs
// and dev/serve.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const INCLUDE_RE = /<\?!=\s*include\(\s*['"]([\w-]+)['"]\s*\)\s*;?\s*\?>/g;
const PRINT_RE = /<\?=\s*([\s\S]*?)\s*;?\s*\?>/g;
const ANY_RE = /<\?[\s\S]*?\?>/g;
const MAX_DEPTH = 5;

export function readTemplate(srcDir, name) {
  if (!/^[\w-]+(\.html)?$/.test(name)) throw new Error(`invalid include name: ${name}`);
  const p = join(srcDir, name.endsWith('.html') ? name : name + '.html');
  if (!existsSync(p)) throw new Error(`include not found: ${name} (in ${srcDir})`);
  return readFileSync(p, 'utf8');
}

function inline(srcDir, html, depth, seen) {
  return html.replace(INCLUDE_RE, (_, inc) => {
    if (depth >= MAX_DEPTH) throw new Error(`include depth exceeded at ${inc}`);
    if (seen.includes(inc)) throw new Error(`include cycle: ${[...seen, inc].join(' -> ')}`);
    return inline(srcDir, readTemplate(srcDir, inc), depth + 1, [...seen, inc]);
  });
}

export function renderPage(srcDir, name, opts = {}) {
  const scriptlets = opts.scriptlets || {};
  const onUnhandled = opts.onUnhandled || 'error';
  let html = inline(srcDir, readTemplate(srcDir, name), 0, [name]);
  html = html.replace(PRINT_RE, (m, expr) => {
    const key = expr.replace(/\s+/g, '');
    for (const [k, v] of Object.entries(scriptlets)) if (k.replace(/\s+/g, '') === key) return v;
    return m;
  });
  const left = html.match(ANY_RE);
  if (left) {
    if (onUnhandled === 'blank') {
      for (const m of left) console.warn('[render] unhandled scriptlet blanked:', m.slice(0, 60));
      html = html.replace(ANY_RE, '');
    } else {
      throw new Error(`unhandled scriptlet in ${name}: ${left[0].slice(0, 80)}`);
    }
  }
  return html.replace(/<!--[\s\S]*?-->/g, '');
}
