// TEMPORARY stand-in for lane G's scripts/data/export-campus-data.mjs (plan mscn-v3-static-migration,
// F/G interface contract). Delete at integration; build-site.mjs prefers the real exporter when it exists.
//
//   node scripts/build/temp-export-campus-data.mjs --out <dir>
//
// Writes <dir>/campus.json (what getAllCampusData returns, minus any mapsApiKey row), <dir>/floors/<floorId>.svg
// for every public floor, and <dir>/version.json ({version, builtAt, gitSha}; version is a content hash so a
// rebuild with changed data invalidates every client cache). Data source: the .gs backend run in the Apps
// Script stand-in (dev/gas-runtime.cjs), seeded like a first init. No overrides layer (that is lane G's).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

function firstExisting(paths) { return paths.find((p) => existsSync(p)) || null; }

export function exportCampusData(outDir) {
  const gasSrc = firstExisting([join(ROOT, 'scripts', 'apps-script', 'src'), join(ROOT, 'archive', 'apps-script-v2', 'src')]);
  const runtime = firstExisting([join(ROOT, 'dev', 'gas-runtime.cjs'), join(ROOT, 'tools', 'admin', 'gas-runtime.cjs')]);
  if (!gasSrc || !runtime) throw new Error('temp exporter: the Apps Script sources or dev/gas-runtime.cjs are gone; use scripts/data/export-campus-data.mjs');
  const { makeRuntime } = require(runtime);
  const gas = makeRuntime(gasSrc);
  gas.ctx.initSystem();
  const data = gas.run('getAllCampusData', []);
  data.config = (data.config || []).filter((c) => c && c.key !== 'mapsApiKey');

  mkdirSync(join(outDir, 'floors'), { recursive: true });
  const hash = createHash('sha256');
  const campusJson = JSON.stringify(data);
  hash.update(campusJson);
  const floors = [];
  for (const f of data.floors || []) {
    if (f.public === false || String(f.public).toLowerCase() === 'false') continue;
    const svg = gas.run('getFloorPlanSvg', [f.id]);
    writeFileSync(join(outDir, 'floors', `${f.id}.svg`), svg);
    hash.update(f.id).update(svg);
    floors.push(f.id);
  }
  writeFileSync(join(outDir, 'campus.json'), campusJson);
  let gitSha = process.env.GITHUB_SHA || '';
  if (!gitSha) {
    try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { gitSha = ''; }
  }
  const version = { version: hash.digest('hex').slice(0, 16), builtAt: new Date().toISOString(), gitSha };
  writeFileSync(join(outDir, 'version.json'), JSON.stringify(version, null, 2) + '\n');
  return { floors, version, bytes: campusJson.length };
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const i = process.argv.indexOf('--out');
  if (i < 0 || !process.argv[i + 1]) { console.error('usage: temp-export-campus-data.mjs --out <dir>'); process.exit(2); }
  const r = exportCampusData(resolve(process.argv[i + 1]));
  console.log(`[temp-export] campus.json ${r.bytes} bytes, ${r.floors.length} floor plans, version ${r.version.version}`);
}
