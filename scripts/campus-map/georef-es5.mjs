// Derives src/shared/georef.es5.js (a browser global, MSCNGeoref, for the ES5-only web app) from
// src/shared/georef.mjs: the module body is already ES5; only the `export` keywords go and the functions are
// returned from an IIFE. npm run campus-map writes it; --check and a unit test keep it identical to the source.
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './config.mjs';

export const GEOREF_SRC = path.join(REPO, 'src', 'shared', 'georef.mjs');
export const GEOREF_ES5 = 'src/shared/georef.es5.js';

export function emitGeorefEs5(source = fs.readFileSync(GEOREF_SRC, 'utf8')) {
  const names = [];
  const body = source.replace(/^export function (\w+)/gm, (m, name) => {
    names.push(name);
    return `function ${name}`;
  });
  if (/^\s*(export|import)\b/m.test(body)) throw new Error('georef.mjs: only `export function` declarations can be derived to ES5');
  const indented = body
    .trimEnd()
    .split('\n')
    .map((l) => (l ? '  ' + l : l))
    .join('\n');
  return (
    `/* GENERATED from src/shared/georef.mjs by scripts/campus-map/georef-es5.mjs (npm run campus-map). Do not edit. */\n` +
    `var MSCNGeoref = (function () {\n  'use strict';\n\n${indented}\n\n  return {\n` +
    names.map((n) => `    ${n}: ${n}`).join(',\n') +
    `\n  };\n})();\n`
  );
}
