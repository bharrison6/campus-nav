// The repository is public and the hidden floors (scripts/floorplan-pipeline/config.mjs public: false: the IT mezzanine
// and the EP penthouse) are not: their outputs live in the private location outside it (config.mjs resolvePrivateDir).
// This guard fails when a committed file under data/, tools/admin/gs/ or dist/ (and the built dist/ on disk, when
// there is one) names a hidden floor, its plan asset, its room ids or its node ids. History before v5.1 still holds
// them; this keeps them out of the tree from here on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HIDDEN_FLOORS, hiddenFloorPatterns } from '../../scripts/floorplan-pipeline/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARDED = ['data', 'tools/admin/gs', 'dist'];
const PATTERNS = hiddenFloorPatterns();

/** Every file under dir (repository-relative paths). */
function walk(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((d) => {
    const r = `${rel}/${d.name}`;
    return d.isDirectory() ? walk(r) : [r];
  });
}

/** The committed files under the guarded folders (git ls-files; every file there when git is unavailable). */
function committedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...GUARDED], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    return GUARDED.flatMap(walk);
  }
}

/** [{ file, match }] for every pattern hit in the given repository-relative files. */
function hits(files) {
  const found = [];
  for (const f of files) {
    const abs = path.join(REPO, f);
    if (!fs.existsSync(abs)) continue; // deleted in the working tree, not yet committed
    const text = fs.readFileSync(abs, 'latin1');
    for (const re of PATTERNS) {
      const m = text.match(re);
      if (m) found.push({ file: f, match: m[0] });
    }
  }
  return found;
}

test('the patterns name the hidden floors and nothing public', () => {
  assert.deepEqual(HIDDEN_FLOORS.map((f) => f.floorId), ['floor-it-3', 'floor-ep-3']);
  const named = (s) => PATTERNS.some((re) => re.test(s));
  for (const s of ['"floor-it-3"', 'FP_floor_ep_3', '"room-it-3-0301"', '"room-ep-3-3300F"', '"ep-3-n0001"', '["it-3-n0001",']) assert.ok(named(s), s);
  for (const s of ['"floor-it-2"', 'floor-it-30', 'FP_floor_it_2', '"room-it-1-0141"', '"it-1-n0047"', '"ep-x007"', '"it-stair-1"', 'edit-3-n1', '"room-ep-2-2300F"']) {
    assert.ok(!named(s), s);
  }
});

test('no committed file under data/, tools/admin/gs/ or dist/ names a hidden floor or anything on it', () => {
  const files = committedFiles();
  assert.ok(files.some((f) => f.startsWith('data/floorplans/')) && files.some((f) => f.startsWith('tools/admin/gs/')), 'the guarded folders were listed');
  assert.deepEqual(hits(files), [], 'hidden-floor data is committed: move it to the private location (npm run pipeline writes it there)');
});

test('the built site (dist/ on disk), when there is one, names no hidden floor', (t) => {
  const files = walk('dist');
  if (!files.length) return t.skip('no dist/ (npm run build)');
  assert.deepEqual(hits(files), []);
});
