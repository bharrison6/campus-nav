#!/usr/bin/env node
// Regenerate floor-plan SVGs, floor JSON, the GAS floor-plan assets and SeedFloorData.gs from the DWGs.
//   node scripts/floorplan-pipeline/run.mjs --in data/dwg --out data/floorplans [--gas scripts/apps-script/src]
//        [--cache scripts/floorplan-pipeline/.cache] [--force-parse]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const started = Date.now();
const { report } = runPipeline({
  inDir: path.resolve(repo, opt('--in', 'data/dwg')),
  outDir: path.resolve(repo, opt('--out', 'data/floorplans')),
  gasDir: path.resolve(repo, opt('--gas', 'scripts/apps-script/src')),
  cacheDir: path.resolve(repo, opt('--cache', 'scripts/floorplan-pipeline/.cache')),
  forceParse: argv.includes('--force-parse'),
});

console.log('\nfloor          rooms labels doors open area infer entr vert nodes edges unreach  svgKB');
for (const [id, f] of Object.entries(report.floors)) {
  const c = f.counts;
  console.log(
    `${id.padEnd(14)} ${String(c.rooms).padStart(5)} ${String(c.matchedLabels).padStart(6)} ${String(c.doors).padStart(5)} ${String(c.openings).padStart(4)} ${String(c.areaLines).padStart(4)} ${String(c.inferredPassages).padStart(5)} ${String(c.entrances).padStart(4)} ${String(c.verticals).padStart(4)} ${String(c.nodes).padStart(5)} ${String(c.edges).padStart(5)} ${String(c.unreachableRooms).padStart(7)} ${String(Math.round(c.svgBytes / 1024)).padStart(6)}`
  );
}
console.log(`cross-floor edges: ${report.crossFloorEdges}; SeedFloorData.gs: ${Math.round(report.seedFloorDataBytes / 1024)} KB`);
for (const v of report.verticalStacks) console.log(`  ${v.linkId}: ${v.members.map((m) => `${m.floorId}/${m.number}`).join(' -> ')}`);
for (const [id, f] of Object.entries(report.floors)) {
  if (f.unreachable.length) console.log(`  unreachable on ${id}: ${f.unreachable.map((u) => u.number).join(', ')}`);
  if (f.isolatedEntrances.length) console.log(`  isolated entrances on ${id}: ${f.isolatedEntrances.map((e) => e.rooms.join('+')).join(', ')}`);
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
