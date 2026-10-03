// Stage "parse": one child process per DWG (the WASM parser is not safe for two files in one process).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, '..', 'parse-worker.mjs');

export function parseAll(floors, inDir, cacheDir, { force = false, log = console.log } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = {};
  for (const f of floors) {
    const src = path.join(inDir, f.file);
    const dst = path.join(cacheDir, f.file.replace(/\.dwg$/i, '.entities.json'));
    if (!fs.existsSync(src)) throw new Error(`missing DWG: ${src}`);
    const fresh = fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs && fs.statSync(dst).mtimeMs >= fs.statSync(worker).mtimeMs;
    if (force || !fresh) {
      const r = spawnSync(process.execPath, [worker, src, dst], { encoding: 'utf8', timeout: 180000 });
      if (r.status !== 0) throw new Error(`parse failed for ${f.file}: ${r.stderr || r.stdout || r.error}`);
      log(`  ${(r.stdout || '').trim()}`);
    } else {
      log(`  cached ${f.file}`);
    }
    out[f.floorId] = JSON.parse(fs.readFileSync(dst, 'utf8'));
  }
  return out;
}
