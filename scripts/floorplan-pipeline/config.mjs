import fs from 'node:fs';
import path from 'node:path';

// Floor catalogue: which DWG is which floor, and the ids the data contract (plan mscn-v2-build) binds.
export const BUILDINGS = {
  it: { id: 'bld-it', code: 'IT', number: '0135', name: 'Industry and Technology' },
  ep: { id: 'bld-ep', code: 'EP', number: '0174', name: 'Engineering & Physics' },
};

export const FLOORS = [
  { file: '0135_1-bp.dwg', floorId: 'floor-it-1', bldg: 'it', level: 1, label: 'First Floor', public: true },
  { file: '0135_2-bp.dwg', floorId: 'floor-it-2', bldg: 'it', level: 2, label: 'Second Floor', public: true },
  { file: '0135_3-bp.dwg', floorId: 'floor-it-3', bldg: 'it', level: 3, label: 'Mezzanine', public: false },
  { file: '0174_1-bp.dwg', floorId: 'floor-ep-1', bldg: 'ep', level: 1, label: 'First Floor', public: true },
  { file: '0174_2-bp.dwg', floorId: 'floor-ep-2', bldg: 'ep', level: 2, label: 'Second Floor', public: true },
  { file: '0174_3-bp.dwg', floorId: 'floor-ep-3', bldg: 'ep', level: 3, label: 'Penthouse', public: false },
];

/** GAS HTML asset name for a floor: FP_<floorId with hyphens as underscores>. */
export function planAssetName(floorId) {
  return 'FP_' + floorId.replace(/-/g, '_');
}

/** INSUNITS code -> meters per drawing unit (AutoCAD $INSUNITS table, the subset that matters here). */
export const INSUNITS_METERS = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };

/** Layers that are never floor-plan content. */
export const EXCLUDED_LAYER = /^(BORDER|Defpoints$)/i;

/**
 * Where the facilities drawings live. They are never in the code repository (they must not be published): the
 * pipeline reads them from MSCN_DWG_DIR, or by default from `drawings/dwg` in the scope folder beside the code repo
 * (`<repo>/../drawings/dwg`). A relative MSCN_DWG_DIR is resolved against the repo root.
 */
export const DWG_DIR_ENV = 'MSCN_DWG_DIR';

export function resolveDwgDir(repoRoot, env = process.env) {
  const v = env[DWG_DIR_ENV];
  return v ? path.resolve(repoRoot, v) : path.resolve(repoRoot, '..', 'drawings', 'dwg');
}

/** True when the directory holds every catalogued DWG (the pipeline needs all of them). */
export function hasDrawings(dir, floors = FLOORS) {
  return fs.existsSync(dir) && floors.every((f) => fs.existsSync(path.join(dir, f.file)));
}

/** The floors the site never serves (public: false). */
export const HIDDEN_FLOORS = FLOORS.filter((f) => !f.public);

/**
 * Where the non-public floors' outputs live. The repository is public, so the pipeline writes everything of a hidden
 * floor (its plan JSON and SVG, its plan asset, its seed rows, the cross-floor edges that touch it and the full report)
 * outside it: MSCN_PRIVATE_DIR, else `derived` beside the drawings folder (`<scope>/drawings/derived`, next to
 * `<scope>/drawings/dwg`). A fresh clone and CI have no such folder, and nothing needs it there: the public build never
 * reads it; the local admin shows the hidden floors when it is present.
 *   <private>/floorplans/<floorId>.json|svg, cross-floor-edges.json, pipeline-report.json
 *   <private>/gs/FP_<floorId>.html, SeedFloorDataPrivate.gs
 */
export const PRIVATE_DIR_ENV = 'MSCN_PRIVATE_DIR';

export function resolvePrivateDir(repoRoot, env = process.env) {
  const v = env[PRIVATE_DIR_ENV];
  return v ? path.resolve(repoRoot, v) : path.resolve(resolveDwgDir(repoRoot, env), '..', 'derived');
}

/** The two folders of the private location. */
export function privatePaths(privateDir) {
  return { floorplans: path.join(privateDir, 'floorplans'), gs: path.join(privateDir, 'gs') };
}

/**
 * Patterns that name a hidden floor or anything on it: the floor id, its plan asset, its room ids
 * (room-<bldg>-<level>-...) and its node ids (<bldg>-<level>-n0001). The committed-files guard uses them.
 */
export function hiddenFloorPatterns(floors = HIDDEN_FLOORS) {
  return floors.flatMap((f) => {
    const tag = `${f.bldg}-${f.level}`;
    return [
      new RegExp(`\\b${f.floorId}\\b`),
      new RegExp(`\\b${planAssetName(f.floorId)}\\b`),
      new RegExp(`\\broom-${tag}-`),
      new RegExp(`(?<![\\w-])${tag}-n\\d`),
    ];
  });
}
