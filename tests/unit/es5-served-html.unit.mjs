// Guards every served page file (src/web/WebApp*.html and tools/admin/Admin.html): client JS stays
// ES5 syntax (no let/const, arrow functions, template literals, classes, spread, async) so older phones keep
// working, includes carry no template scriptlets, and no Google Maps key literal ever lands in a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import vm from 'node:vm';
import { ROOT, SRC, scriptBodies } from './load-include.mjs';

const ADMIN = join(ROOT, 'tools', 'admin', 'Admin.html');
const paths = readdirSync(SRC).filter((f) => /^WebApp.*\.html$/.test(f)).map((f) => join(SRC, f)).concat([ADMIN]);
const files = paths.map((p) => basename(p));
const pathOf = Object.fromEntries(paths.map((p) => [basename(p), p]));
const shells = ['WebApp.html']; // the page template: the only file that may hold (include) scriptlets

// Blank out comments, strings and regex literals well enough to scan the remaining code tokens.
function codeOnly(js) {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  while (i < js.length) {
    const c = js[i];
    const n = js[i + 1];
    if (c === '/' && n === '/') { while (i < js.length && js[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < js.length && !(js[i] === '*' && js[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < js.length && js[i] !== c) { if (js[i] === '\\') i++; i++; }
      i++; out += '""'; prevSignificant = '"'; continue;
    }
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]|^$/.test(prevSignificant)) {
      i++;
      let inClass = false;
      while (i < js.length) {
        if (js[i] === '\\') { i += 2; continue; }
        if (js[i] === '[') inClass = true; else if (js[i] === ']') inClass = false;
        else if (js[i] === '/' && !inClass) break;
        i++;
      }
      i++; while (/[a-z]/i.test(js[i] || '')) i++;
      out += '/r/'; prevSignificant = '/'; continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

const forbidden = [
  [/=>/, 'arrow function'],
  [/`/, 'template literal'],
  [/\blet\s+[A-Za-z_$[{]/, 'let'],
  [/\bconst\s+[A-Za-z_$[{]/, 'const'],
  [/\bclass\s+[A-Za-z_$]/, 'class'],
  [/\.\.\.[A-Za-z_$[(]/, 'spread/rest'],
  [/\basync\s+function\b/, 'async function'],
  [/\bawait\s/, 'await'],
  [/\bfor\s*\([^;)]*\bof\b/, 'for...of'],
  [/function\s*\*/, 'generator'],
];

test('served WebApp files exist', () => {
  for (const f of ['WebApp.html', 'WebApp_Pathfinding.html', 'WebApp_Search.html', 'WebApp_Viewer.html', 'WebApp_Data.html', 'WebApp_Analytics.html', 'WebApp_Core.html',
    'WebApp_Indoor.html', 'WebApp_Map.html', 'WebApp_Schedule.html', 'WebApp_Main.html', 'WebApp_Styles.html']) {
    assert.ok(files.includes(f), f);
  }
});

for (const f of files) {
  test(`${f}: client JS is ES5`, () => {
    const html = readFileSync(pathOf[f], 'utf8');
    for (const body of scriptBodies(html)) {
      const code = codeOnly(body);
      for (const [re, what] of forbidden) {
        const m = code.match(re);
        assert.equal(m, null, `${f}: ${what} near "${m && code.slice(Math.max(0, m.index - 40), m.index + 40)}"`);
      }
      // Syntax must at least parse.
      assert.doesNotThrow(() => new vm.Script(body, { filename: f }));
    }
  });

  test(`${f}: no scriptlets except in the page shell, no key literals`, () => {
    const html = readFileSync(pathOf[f], 'utf8');
    if (!shells.includes(f)) assert.equal(/<\?/.test(html), false, 'includes are inlined verbatim; scriptlets would not run');
    assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(html), false, 'Google API key literal');
  });
}

test('page shell includes every module', () => {
  const html = readFileSync(pathOf['WebApp.html'], 'utf8');
  for (const f of files.filter((x) => !shells.includes(x) && pathOf[x].startsWith(SRC))) {
    assert.ok(html.includes(`include('${f.replace(/\.html$/, '')}')`), `WebApp.html includes ${f}`);
  }
});

test('the ES5 scanner itself catches violations (positive control)', () => {
  const bad = ['var f = (a) => a;', 'let x = 1;', 'const y = 2;', 'var s = `t`;', 'class A {}', 'f(...xs);'];
  for (const b of bad) {
    const code = codeOnly(b);
    assert.ok(forbidden.some(([re]) => re.test(code)), b);
  }
  // and does not flag look-alikes inside strings, comments, or regexes (negative control)
  const ok = ["var s = 'let x = 1 => `';", '// const z = 1', 'var r = /=>/g;', 'var o = { classy: 1 };'];
  for (const g of ok) {
    const code = codeOnly(g);
    assert.ok(!forbidden.some(([re]) => re.test(code)), g);
  }
});
