// Stage "parse": read ONE DWG in this process and write normalized entities as JSON.
// Usage: node parse-worker.mjs <in.dwg> <out.json> [--raw <raw.json>]
// One file per process: libredwg-web's WASM instance crashed when a second file was read in the same process.
import fs from 'node:fs';
import path from 'node:path';
import { createModule, LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';
import { normalizeDb } from './lib/normalize.mjs';

const args = process.argv.slice(2);
const [inFile, outFile] = args;
const rawIdx = args.indexOf('--raw');
if (!inFile || !outFile) {
  console.error('usage: node parse-worker.mjs <in.dwg> <out.json> [--raw <raw.json>]');
  process.exit(2);
}

const mod = await createModule();
const lib = LibreDwg.createByWasmInstance(mod);
// libredwg reports "Open dwg file with error code: 64/68" for these AutoCAD 2018 files; those are
// non-fatal warning bits and the entity data is complete (room areas match their RMAREA tags).
const dwg = lib.dwg_read_data(fs.readFileSync(inFile), Dwg_File_Type.DWG);
const db = lib.convert(dwg);
const bigint = (k, v) => (typeof v === 'bigint' ? Number(v) : v);
if (rawIdx >= 0) fs.writeFileSync(args[rawIdx + 1], JSON.stringify(db, bigint));
const norm = normalizeDb(db, path.basename(inFile));
fs.writeFileSync(outFile, JSON.stringify(norm, bigint));
try { lib.dwg_free(dwg); } catch { /* best effort */ }
console.log(`parsed ${norm.source}: ${norm.entities.length} model-space entities, ${Object.keys(norm.blocks).length} blocks`);
