// Resolves the web app's page template into one static HTML document.
//
//   renderPage(srcDir, 'WebApp')
//
// <?!= include('X') ?> inlines <srcDir>/X.html (recursively, depth-limited) and HTML comments are stripped,
// as Apps Script's HtmlService did for the v2 page. Any other scriptlet is an error: a static site cannot run
// it. Used by scripts/build/build-site.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const INCLUDE_RE = /<\?!=\s*include\(\s*['"]([\w-]+)['"]\s*\)\s*;?\s*\?>/g;
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

export function renderPage(srcDir, name) {
  const html = inline(srcDir, readTemplate(srcDir, name), 0, [name]);
  const left = html.match(ANY_RE);
  if (left) throw new Error(`unhandled scriptlet in ${name}: ${left[0].slice(0, 80)}`);
  return html.replace(/<!--[\s\S]*?-->/g, '');
}
