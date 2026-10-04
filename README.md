# Murray State Campus Navigation

A campus wayfinding web app for Murray State University. Visitors search for a room ("IT 141", "EP 2321"),
see it on a floor plan, and get turn-by-turn directions to it: across floors by stairs or elevator (with an
"Avoid stairs" option), and between buildings with an outdoor walking leg. It also reads QR codes posted in
buildings (they set "you are here"), keeps a personal class schedule, opens official event schedules, and
comes with an admin tool, run on the operator's own computer, for editing the data.

The app is a static site on GitHub Pages: nobody signs in, and nothing runs on a server. Going live and the
operator's one-time steps: [`docs/go-live.md`](docs/go-live.md).

Indoor coverage today: **Collins Industry and Technology Center (IT, building 0135)** and **Engineering and
Physics (EP, building 0174)**, floors 1 and 2 of each, drawn from the university's AutoCAD floor plans. The
IT mezzanine and the EP penthouse are in the data but hidden from visitors (their plans are not published).
The outdoor map covers 89 campus buildings.

## Architecture

```
 facilities drawings (DWG)  -- outside the repository, never published
        |  npm run pipeline                      (scripts/floorplan-pipeline)
        v
 data/floorplans/*, tools/admin/gs/SeedFloorData.gs, FP_floor_*.html          generated, committed
        |  + tools/admin/gs/SeedData.gs          (buildings)
        |  + data/overrides/*.json               (operator edits, made with npm run admin)
        v
 scripts/data/export-campus-data.mjs   campus.json, floors/<id>.svg, version.json
        |  + src/web/ (the app), data/schedules/, data/links.json, build.config.json, MAPS_API_KEY secret
        v
 scripts/build/build-site.mjs  ->  dist/
        |  .github/workflows/pages.yml on every push to main (npm test, build, deploy)
        v
 GitHub Pages  ->  visitor's phone or browser (relative URLs: works at /campus-nav/ or a domain root)
```

- **Data engine:** the v2 Apps Script backend (`tools/admin/gs/*.gs`) is no longer deployed anywhere. It runs
  in Node inside an Apps Script stand-in (`dev/gas-runtime.cjs`), used by the build-time export and the local
  admin. The schema is "data contract v2" (`Init.gs` `getSheetDefinitions_`): room and building numbers are
  text, so `0141` stays `0141`.
- **Floor plans:** one clean vector SVG per floor, generated from the drawings; the export publishes the plans
  of public floors as `floors/<floorId>.svg`. Coordinates are drawing units (inches) with the floor's extents
  starting at (0,0) and y pointing down; room polygons, room centers and navigation nodes share that space.
- **Web app** (`src/web/WebApp.html` and its `WebApp_*.html` modules, inlined by the build): an inline-SVG
  viewer that pans and zooms by rewriting the viewBox and draws its own screen-size room labels, room search,
  A* routing over the navigation graph (`WebApp_Pathfinding.html`), step cards, the Google Maps outdoor view,
  schedules and the QR scanner. Data comes from fetches (`WebApp_Data.html`), cached in the browser and keyed
  by `data/version.json`. Without a Maps key the Map tab lists buildings with "Open in Google Maps" walking
  links. Usage analytics (GoatCounter, no cookies) load only when configured. All browser code is ES5 (no
  `let`/`const`, arrow functions or template literals); a unit test enforces it.
- **Admin** (`tools/admin`, `npm run admin`, local only): QR code generator, floors, rooms, navigation graph and
  buildings editors; saves go to `data/overrides` (see "Editing the data" below).
- **Deep links:** `?qr=<base64 JSON>` (what the admin's QR generator prints: a location or a schedule entry),
  `?loc=<navNodeId>` (start here), `?room=<roomId>` (open a room; add `&nav=1` to start a route),
  `?sched=<scheduleId>` (an official schedule from `data/schedules/`). The site's `404.html` sends unknown
  paths back to the app with the query kept.

## Repository layout

| path | what |
|---|---|
| `src/web/` | the app: `WebApp.html` and its `WebApp_*.html` modules |
| `scripts/build/` | the site build: `build-site.mjs` (`npm run build`), `render-page.mjs` (inlines the modules) |
| `scripts/data/` | the build-time export (`export-campus-data.mjs`) and the overrides merge it shares with the admin |
| `scripts/floorplan-pipeline/` | the DWG to SVG / JSON / nav-graph / seed pipeline (Node); reads the drawings from outside the repo |
| `data/floorplans/` | generated per-floor JSON and SVG, `cross-floor-edges.json`, `pipeline-report.json` (committed) |
| `data/overrides/` | the operator's edits on top of the generated data, one JSON file per collection (committed) |
| `data/schedules/`, `data/links.json` | official event schedules by id and the documents they link to |
| `tools/admin/` | the local admin: `Admin.html`, `server.mjs` (`npm run admin`); `gs/` holds the backend `.gs` files and the floor-plan assets |
| `dev/` | `serve.mjs`, the local static server (`npm run serve`, `preview`); `gas-runtime.cjs`, the Apps Script stand-in |
| `build.config.json` | site settings: `basePath`, `domain`, `siteUrl`, `analytics.site` (no secrets) |
| `.github/workflows/pages.yml` | CI: tests, build and GitHub Pages deploy on push to `main` |
| `docs/go-live.md` | the operator's go-live and maintenance steps |
| `tests/unit/` | Node unit tests (pathfinding, search, ES5 check, backend, overrides, export, admin, build, data adapter, real campus data) |
| `tests/e2e/` | Playwright tests against a fresh build served at `/campus-nav/` |
| `tests/smoke/` | Playwright smoke test against the deployed site |
| `archive/` | retired code: the 2026-02 raster pipeline, `apps-script-v2/` (the Apps Script deployment) |

## Data flow

```
 drawings (DWG, outside the repo)            tools/admin/gs/SeedData.gs   (89 buildings, codes, numbers)
        |  npm run pipeline                          |
        v                                            |
 data/floorplans/*  +  tools/admin/gs/SeedFloorData.gs, FP_floor_*.html   (generated, committed)
        |                                            |
        +-------------------- base ------------------+
                                |   + data/overrides/*.json   (operator edits, committed; npm run admin)
                                v
   node scripts/data/export-campus-data.mjs --out <dir>       (run by the site build)
        -> <dir>/campus.json, <dir>/floors/<floorId>.svg, <dir>/version.json  ->  the static site
```

The export runs the backend `.gs` code in the Node stand-in, seeds it the way the v2 `initSystem()` seeded a
new sheet, merges the overrides, and writes exactly what `getAllCampusData` returns (the Maps key is never in
it; the site's `config.json` carries the key) plus the plans of public floors. `version` is a content hash, so
the same inputs give byte-identical files; `version.json` adds `builtAt` and `gitSha`. `npm run export:data`
writes it to `build/data` for a look.

## Where the drawings live

The six facilities drawings (IT `0135_1..3-bp.dwg`, EP `0174_1..3-bp.dwg`) are **not in this repository** and
must never be added: only the floor plans derived from them are published. They live in the project folder
beside the code repository, `../drawings/dwg/` (OneDrive-backed, university-controlled). The pipeline reads
`MSCN_DWG_DIR`, defaulting to that folder; `data/dwg/`, `*.dwg` and the pipeline's parse cache are gitignored.

Without the drawings (CI, a fresh clone) `npm test` still passes: the pipeline tests that need them are
skipped with one message, and `committed-outputs.test.mjs` still checks that the committed outputs agree with
each other.

## The floor-plan pipeline

`npm run pipeline` reads every DWG in `MSCN_DWG_DIR` (or `--in <dir>`), one per process (libredwg compiled to
WebAssembly, `@mlightcad/libredwg-web`), and writes:

- `data/floorplans/floor-<bldg>-<level>.json` and `.svg` for each floor;
- `data/floorplans/cross-floor-edges.json` (stair and elevator links) and `pipeline-report.json`;
- `tools/admin/gs/FP_floor_*.html` (the SVGs as the backend's plan assets) and `SeedFloorData.gs`.

How it reads the drawings: rooms are the `AREA-ROOM` polylines, numbered by the `FMGRM1` room tags; units come
from `$INSUNITS` (inches, checked against the tags' room areas); door swings and gaps in the walls between
room polygons become openings; corridor centerlines become the walking graph; stairs and elevators that stack
across floors become cross-floor links (stairs not step-free). The drawings carry no room-use text, so room
types (stair, elevator, restroom, corridor, storage, mechanical) come only from geometric evidence and the
rest are `other`. The run is deterministic: a rerun on the same drawings reproduces the committed outputs
byte for byte, and `npm run test:pipeline` (with the drawings present) fails if they drift.

### New or revised drawings

1. Put the DWG files in the drawings folder (`../drawings/dwg/`, or wherever `MSCN_DWG_DIR` points). A new
   floor or building also needs an entry in `scripts/floorplan-pipeline/config.mjs` (`FLOORS`, `BUILDINGS`),
   and a new building needs its row in `tools/admin/gs/SeedData.gs` (`getBuildingOverrides_`: code, number,
   `hasIndoor: true`).
2. `npm run pipeline`, then read the summary it prints (unreachable rooms, isolated entrances, vertical
   stacks) and `data/floorplans/pipeline-report.json`.
3. `npm test` (with the drawings present) and `npm run test:e2e`; update tests that name rooms which changed.
4. Check the overrides still fit: the export (and `npm run admin`) prints an `ORPHAN` line for every edit
   whose room, node or edge the new drawings no longer produce. Orphans are skipped, never applied, and stay in
   the file until you fix or remove them.
5. Commit the regenerated files and push; the site rebuilds.

## Editing the data (local admin)

```
npm run admin             # http://localhost:8790/  (runs only on this computer, never published; no PIN)
```

The admin page (QR codes, buildings and entrances, floors, room polygons, the navigation graph) runs against the
same engine as the export. Every save is written at once to `data/overrides/<collection>.json`, holding only
the difference from the generated data. To publish an edit: `git diff data/overrides` to review, commit, push.

Overrides format: one file per collection (`buildings`, `floors`, `rooms`, `navNodes`, `navEdges`, `photos`,
`qrLocations`, `config`), each an array of records merged by `id` (`config` by `key`) over the seed and pipeline
data, in that order:

```json
[
  {"id":"room-it-1-0141","label":"Dean of Engineering"},
  {"id":"room-ep-1-1322","_delete":true},
  {"id":"qrloc-1759572000000","_new":true,"buildingId":"bld-it","floorId":"floor-it-1","nodeId":"it-1-n0012","description":"Main lobby","permanent":true,"expires":"","createdDate":"2026-10-04T10:00:00.000Z"}
]
```

A partial record changes only the fields it names; `"_delete": true` removes the record; `"_new": true` marks a
record the operator added. Hand edits are fine (use **Settings > Reload from disk** in a running admin to pick
them up). `config` may not set `mapsApiKey` or `dataVersion`. The admin's Settings tab shows how many records
each file holds and lists orphans. Whole floors are not imported by hand any more: new drawings go through the
pipeline. QR codes link to `MSCN_SITE_URL`, else `siteUrl` in `build.config.json`; `MSCN_MAPS_API_KEY`
optionally enables the Buildings map in the admin (a key that allows localhost; kept in memory only).

## The site build

`npm run build` runs the export, then writes `dist/`: `index.html` (the app with its modules inlined),
`config.json` (`{mapsApiKey, analytics, basePath, domain}`), `data/campus.json`, `data/version.json`,
`floors/<floorId>.svg` (public floors only), `data/schedules/<id>.json`, `data/links.json`, `404.html`, and
`CNAME` when a domain is configured. The build refuses root-relative URLs in the page, a schedule that names an
unknown building, a room on a hidden floor or a missing link, and a hidden floor's plan in the export. The Maps
key comes only from the `MAPS_API_KEY` environment variable (the repository secret in CI).

## Development and tests

```
npm ci                    # Node dependencies (Playwright browsers are not downloaded)
npm test                  # unit + pipeline tests, no browser (what CI runs)
npm run build             # dist/
npm run preview           # build, then serve dist/ at http://localhost:8787/campus-nav/
npm run serve             # serve the last build without rebuilding
npm run admin             # the local admin at http://localhost:8790/
npm run pipeline          # drawings -> data/floorplans and the generated .gs files
npm run test:e2e          # Playwright against a fresh build (build/e2e-site) served at /campus-nav/
npm run test:smoke        # Playwright against the deployed site (APP_URL, default the address in build.config.json)
```

- Playwright needs a browser. Without Playwright's own download, use the installed Chrome:
  `PW_CHANNEL=chrome` (PowerShell: `$env:PW_CHANNEL = 'chrome'`). The e2e and smoke suites run locally only;
  CI runs `npm test` and the build.
- `dev/serve.mjs` serves like GitHub Pages: only under the base path (default `basePath` from
  `build.config.json`), with the site's `404.html` for misses, so a root-relative URL fails visibly. Options:
  `--dist <dir>`, `--base <path>`, `--port <n>`, `--build`. In Git Bash, prefix commands that pass
  `--base /campus-nav/` by hand with `MSYS_NO_PATHCONV=1`.
- `tests/unit/fixtures/` holds a small synthetic campus used only by the pathfinding and search unit tests.

## Deployment

[`docs/go-live.md`](docs/go-live.md): turning on Pages, the Maps key secret, analytics, a custom domain, how
deploys happen and how data edits reach the site. The v2 Apps Script deployment is retired (the university
Workspace blocks anonymous Apps Script web apps); its deploy script and notes are kept in
[`archive/apps-script-v2/`](archive/apps-script-v2/README.md).

## Secrets

There is no admin PIN: the admin runs only on the operator's computer. The Google Maps browser key is never in
this repository, the overrides or the exported data; the site build supplies it from the `MAPS_API_KEY`
repository secret. A key does not belong in a chat or a log either. `.clasp.json` (the archived Apps Script
deployment's script id) stays gitignored.

## Known data limits (open for the owner)

- IT elevators are inferred from the drawings (shafts at rooms 0129/0245 and 0101C/0200D); not yet confirmed.
- EP room 1322 has only an exterior door, so routes reach it from outside but not from inside the building.
- The IT mezzanine (0301) has no stair or elevator link in the drawings; it is hidden from visitors anyway.
- Building entrances on the outdoor map are the building's center point until entrance coordinates are added
  in the admin Buildings tab.
