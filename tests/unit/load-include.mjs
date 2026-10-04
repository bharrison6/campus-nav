// Loads a web-app include (src/web/*.html) that holds plain <script> code into a fresh VM context
// and returns the named global it defines. The include must not touch the DOM at load time.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
export const SRC = join(ROOT, 'src', 'web');

// The retiring Apps Script backend and its Node stand-in (lane G archives them; either location works).
const firstExisting = (paths) => paths.find((p) => existsSync(p)) || null;
export const GAS_SRC = firstExisting([join(ROOT, 'scripts', 'apps-script', 'src'), join(ROOT, 'archive', 'apps-script-v2', 'src')]);
export const GAS_RUNTIME = firstExisting([join(ROOT, 'dev', 'gas-runtime.cjs'), join(ROOT, 'tools', 'admin', 'gas-runtime.cjs')]);

export function scriptBodies(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

export function loadInclude(fileName, globalName) {
  const html = readFileSync(join(SRC, fileName), 'utf8');
  const code = scriptBodies(html).join('\n;\n');
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx, { filename: fileName });
  const value = vm.runInContext(globalName, ctx);
  if (!value) throw new Error(`${fileName} did not define ${globalName}`);
  return value;
}

// Small hand-checkable campus (tests/unit/fixtures/build-fixtures.mjs). Real-data tests use real-campus.mjs.
export function loadFixture() {
  const p = join(here, 'fixtures', 'campus-data.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}
