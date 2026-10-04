# Murray State Campus Navigation

A campus wayfinding web app for Murray State University. Visitors search for a room ("IT 141", "EP 2321"),
see it on a floor plan, and get one route to it, door to room: along the campus footpaths on the app's own
2.5D campus map to a specific door, then across floors by stairs or elevator (with an "Avoid stairs" option that
applies outdoors too), with the blue dot from the phone's GPS when it is allowed. It also reads QR codes posted in
buildings (they set "you are here"), keeps a personal class schedule, opens official event schedules, and
comes with an admin tool, run on the operator's own computer, for editing the data.

The app is a static site on GitHub Pages: nobody signs in, and nothing runs on a server. Going live and the
operator's one-time steps: [`docs/go-live.md`](docs/go-live.md).

Indoor coverage today: **Collins Industry and Technology Center (IT, building 0135)** and **Engineering and
Physics (EP, building 0174)**, floors 1 and 2 of each, drawn from the university's AutoCAD floor plans. The
IT mezzanine and the EP penthouse are in the admin's data but not published: neither their plans nor anything
on them reaches the site.
The campus map (MapLibre, drawing OpenStreetMap data committed to this repository) covers the campus; 89 buildings
are in the directory. It works offline after the first visit; Google or Apple Maps appear only as "Directions to
campus" links.

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
        |  + src/web/ (the app), data/schedules/, data/links.json, build.config.json,
        |    data/campus-map/** + data/georef/** + src/shared/georef.mjs (the campus map), maplibre-gl (npm)
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
- **Web app** (`src/web/WebApp.html` and its `WebApp_*.html` modules, inlined by the build):
  - the **campus map** (`WebApp_Map.html`, style from the app's CSS tokens in `WebApp_MapStyle.html`, light and
    dark): MapLibre GL JS, vendored into `dist/vendor/` and loaded by `src/web/modules.mjs` (no CDN, no key);
    extruded buildings with tilt and rotate; IT and EP open into a "building view" of their real floors, stacked,
    through each building's georeference (`data/georef/<id>.json`, `src/shared/georef.mjs`); search flies there;
    the optional aerial layer has a toggle when `data/campus-map/aerial.json` exists; OpenStreetMap attribution
    is always shown. Without WebGL 2 the tab is a building list; routes still work.
  - **one route, door to room** (`WebApp_Pathfinding.html` + `WebApp_Route.html`): A* over the indoor graph and
    the outdoor footpath graph (`data/campus-map/outdoor-graph.json`), joined at entrance node ids, through the
    building's primary doors; one step list ("Walk 120 m along the path, enter by the east entrance, take the
    stairs up to Second Floor, arrive at IT 241"); the route panel is shared by the Map and Indoor tabs and each
    step switches to its view (the walk on the map, the door and the floors on the plan, back to the map when
    leaving a building). Starts: the blue dot, a scanned QR code, a room, or a chosen building.
  - **GPS** (`WebApp_Gps.html`): the browser's position, snapped to the paths, with accuracy and heading;
    re-routes when the walker is about 15 m off the path; inside a building it asks for a QR code instead.
  - the **floor plan** viewer (`WebApp_Viewer.html`): inline SVG, pans and zooms by rewriting the viewBox, draws
    its own screen-size room labels, colored from the same tokens (room fills by type, dark mode).
  - room search, schedules, the QR scanner; data from fetches (`WebApp_Data.html`) cached in the browser and keyed
    by `data/version.json`; a service worker (`sw.js`, generated by the build) precaches the app, data, floor
    plans and the campus map for offline use and caches aerial tiles as they are seen.
  - Usage analytics (GoatCounter, no cookies) load only when configured. The app's own browser code is ES5 (no
    `let`/`const`, arrow functions or template literals) and a unit test enforces it; MapLibre (vendored) and
    the two small ES modules are exempt.
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
| `scripts/campus-map/` | the campus map build (`npm run campus-map`): OpenStreetMap extract to map layers, georeference, primary entrances, outdoor walking graph, optional aerial tiles |
| `data/campus-map/` | the campus map data (OpenStreetMap-derived, ODbL): `buildings.geojson`, `layers/*.geojson`, `outdoor-graph.json`, `manifest.json`, `aerial/` + `aerial.json`; inputs `source/osm-extract.json` and `overrides.geojson` (committed) |
| `data/georef/` | one georeference per indoor building: its floor plans' frame fitted to its map footprint (committed) |
| `src/shared/` | `georef.mjs`, the floor-plan to map transform shared by the data build and the app, and its generated ES5 copy `georef.es5.js` |
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
new sheet, merges the overrides, and writes exactly what `getPublicCampusData` returns: the data without hidden
floors and everything on them (rooms, nodes, the edges into them, indoor photos, QR locations). The Maps key is
never in it (the site's `config.json` carries the key). It adds the map fields (`scripts/data/campus-geo.mjs`):
entrance nodes gain `lat`, `lng` (through `data/georef` and `src/shared/georef.mjs`) and a boolean `primary`; the
indoor buildings' `entrances` become `[{nodeId, lat, lng, label, primary}]` ("West entrance", "East entrance, level
2"); buildings carry `levels` (and `height` when set). It adds the plans of the published floors. The local
floors and everything on them (rooms, nodes, the edges into them, indoor photos, QR locations). No map key
exists anywhere (v4 draws its own map). It adds the plans of the published floors. The local
admin reads `getAllCampusData`, so it still shows and edits hidden floors. `version` is a content hash, so
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

The floor JSON also carries the floor's `gross` outline (what the campus map fits to the building's footprint) and,
for public floors, an `entrances` block written by `npm run campus-map` (each exterior door's primary-entrance score;
the pipeline keeps it when it regenerates the floor, and `npm run campus-map` re-scores).

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
5. Run `npm run campus-map` (the georeference and the entrances depend on the floor outlines and doors) and check its
   residuals and primary entrances.
6. Commit the regenerated files and push; the site rebuilds.

## The campus map data

`npm run campus-map` regenerates the map side of the app from committed inputs, with no network:

- inputs: `data/campus-map/source/osm-extract.json` (an OpenStreetMap extract of the campus box: buildings, highways,
  parking, landuse, with only the tags the layers read), `data/campus-map/overrides.geojson` (hand-made corrections),
  the floor JSON in `data/floorplans` and the operator's overrides (`data/overrides`: entrance `primary`, building
  `levels`/`height`);
- `data/campus-map/buildings.geojson`: every building footprint with `{osmId, buildingId, name, height, levels, source}`;
  `buildingId` is the seeded building it matches (the seed point inside the footprint, or the names agreeing within
  150 m); `height` is the operator's height, else the operator's levels x 3.5 m, else OpenStreetMap `height` or
  `building:levels` x 3.5 m, else a default by type (academic 3 levels, residence 4, other 2);
- `data/campus-map/layers/`: `paths` (footway, path, pedestrian, steps, crossing; `steps` true for stairs), `roads`,
  `parking`, `landuse` (grass, parks, pitches...), `water`, `labels` (named buildings and areas);
- `data/georef/<buildingId>.json`: for each indoor building, the similarity transform (scale fixed by the drawing units;
  rotation and translation solved, a mirrored drawing tried too) that fits the union of its public floors' outlines to
  its footprint, the per-floor SVG offsets, and the fit's residual (`residualMeters`, RMS of the boundary distances;
  the tests require under 3 m). `src/shared/georef.mjs` (`svgToLngLat(buildingId, x, y, floorId)`, `lngLatToSvg`)
  applies it; the export and the app use that one module (`src/shared/georef.es5.js` is its generated ES5 copy);
- primary entrances: every exterior door on a public floor is scored (the space it opens into, its width, the distance
  to the nearest walking path, whether it faces that path) and the best 2 to 4 per building, on different faces, are
  primary. The scores go to the floor JSON's `entrances` block, the choice to `tools/admin/gs/SeedCampusMap.gs`;
- `data/campus-map/outdoor-graph.json`: the walking network (`{nodes: [{id, lat, lng, type}], edges: [{id, from, to,
  distance, accessible, kind}]}`, meters): footways, crossings, the roads a walker uses where no sidewalk is mapped,
  the override walks, and the entrances visitors may use (the primary ones, plus a door that is the only way into a
  room, as EP 1322's) joined to the nearest path by a short connector. Entrance nodes keep their indoor ids, so the
  outdoor and indoor graphs join by id; `steps` edges are not accessible;
- `data/campus-map/manifest.json`: sources, attribution, counts, residuals.

`npm run campus-map -- --check` writes nothing and fails when a committed output is out of date (a unit test does the
same). Re-run the build after changing a primary entrance or a building's levels or height in the admin, after
`npm run pipeline`, or after editing `overrides.geojson`.

**Refreshing the OpenStreetMap data.** `npm run campus-map -- --refresh` downloads the campus box again (the main
OpenStreetMap API `map` call, split into tiles if refused, Overpass mirrors as the fallback), rewrites the extract and
rebuilds. Review the diff: footprints, paths and the residuals can move. Corrections OpenStreetMap lacks go into
`data/campus-map/overrides.geojson` (features with `layer: "buildings"`, optionally `replaces: "way/<id>"`, or
`layer: "paths"`); each is also a candidate to contribute to OpenStreetMap itself. Today it splits the one OSM polygon
that draws Engineering and Physics together with the building north of it, and adds five walks visible in the NAIP
imagery (the North 16th Street west sidewalk, EP's north and south walks, IT's east terrace walks).

**Aerial imagery (optional).** `npm run campus-map -- --aerial` cuts USDA NAIP orthoimagery (public domain) into
256 px JPEG tiles for zooms 15 to 18 over the campus, `data/campus-map/aerial/{z}/{x}/{y}.jpg` with `aerial.json`
(bounds, zooms, attribution, acquisition date); `--aerial-refresh` rebuilds. It tries the USDA APFO service, then the
USGS National Map NAIP service, uses no other imagery provider, and publishes nothing when neither answers or the
tiles pass 25 MB. Downloads are cached in `scripts/campus-map/.cache` and resume after an error.

**Attribution (required).** The buildings, layers and outdoor graph are derived from OpenStreetMap and published under
the Open Database License: the map must show "© OpenStreetMap contributors" with a link to
https://www.openstreetmap.org/copyright. The aerial tiles are public domain; credit "USDA NAIP" as `aerial.json` says.

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
them up). `config` may not set `mapsApiKey` or `dataVersion`. Map fields: `navNodes` `primary` (true/false on entrance
nodes: the doors visitors are routed to; the Nav Graph panel's "Primary entrance" box) and `buildings` `levels` /
`height` (meters; the Buildings tab), both applied to the map by `npm run campus-map`. The admin's Settings tab shows how many records
each file holds and lists orphans. Whole floors are not imported by hand any more: new drawings go through the
pipeline. QR codes link to `MSCN_SITE_URL`, else `siteUrl` in `build.config.json`; `MSCN_MAPS_API_KEY`
optionally enables the Buildings map in the admin (a key that allows localhost; kept in memory only).

## The site build

`npm run build` runs the export, then writes `dist/`: `index.html` (the app with its modules inlined),
`config.json` (`{analytics, basePath, domain}`; there is no map key), `data/campus.json`, `data/version.json`,
`floors/<floorId>.svg` (public floors only), `data/schedules/<id>.json`, `data/links.json`, the campus map
(`data/campus-map/**`, `data/georef/*.json`, and `data/map-manifest.json` listing what exists), `vendor/`
(MapLibre's browser files from `node_modules/maplibre-gl`, `modules.mjs`, `georef.mjs`), `sw.js` (the service
worker with a hashed precache list, `scripts/build/service-worker.mjs`), `404.html`, and `CNAME` when a domain is
configured. The build refuses root-relative URLs in the page, a schedule that names an unknown building, a room
that is not published or a missing link, and a hidden floor (or its plan) in the export. `MSCN_CAMPUS_MAP_ROOT`
points the build at another tree holding `data/campus-map`, `data/georef` and `src/shared/georef.mjs` (the e2e
suite uses the small fixture in `tests/fixtures/campus-map`); the build log says so, and the smoke test refuses a
deployed fixture.

## Development and tests

```
npm ci                    # Node dependencies (Playwright browsers are not downloaded)
npm test                  # unit + pipeline tests, no browser (what CI runs)
npm run build             # dist/
npm run preview           # build, then serve dist/ at http://localhost:8787/campus-nav/
npm run serve             # serve the last build without rebuilding
npm run admin             # the local admin at http://localhost:8790/
npm run pipeline          # drawings -> data/floorplans and the generated .gs files
npm run campus-map        # map layers, georeference, primary entrances, outdoor graph (--refresh, --aerial, --check)
npm run test:e2e          # Playwright against a fresh build (build/e2e-site) served at /campus-nav/
npm run test:smoke        # Playwright against the deployed site (APP_URL, default the address in build.config.json)
```

- Playwright needs a browser. Without Playwright's own download, use the installed Chrome:
  `PW_CHANNEL=chrome` (PowerShell: `$env:PW_CHANNEL = 'chrome'`). The e2e and smoke suites run locally only;
  CI runs `npm test` and the build. The campus map needs WebGL 2: the e2e config starts Chrome with SwiftShader
  (`--use-angle=swiftshader --enable-unsafe-swiftshader`) and runs 4 workers, because software rendering is slow.
  `MSCN_E2E_PORT` picks another port when 8788 is taken (the config reuses a running server on that port).
- The e2e suite builds with the campus-map fixture (`tests/fixtures/campus-map`, regenerated by
  `node tests/fixtures/campus-map/make-fixture.mjs`): IT and EP footprints from their floor plans, a few
  neighbors, a small path network with one flight of steps and a longer ramp, and a far-corner node. GPS is
  mocked with Playwright's `setGeolocation`.
- `dev/serve.mjs` serves like GitHub Pages: only under the base path (default `basePath` from
  `build.config.json`), with the site's `404.html` for misses, so a root-relative URL fails visibly. Options:
  `--dist <dir>`, `--base <path>`, `--port <n>`, `--build`. In Git Bash, prefix commands that pass
  `--base /campus-nav/` by hand with `MSYS_NO_PATHCONV=1`.
- `tests/unit/fixtures/` holds a small synthetic campus used only by the pathfinding and search unit tests.

## Deployment

[`docs/go-live.md`](docs/go-live.md): turning on Pages, analytics, a custom domain, how
deploys happen and how data edits reach the site. The v2 Apps Script deployment is retired (the university
Workspace blocks anonymous Apps Script web apps); its deploy script and notes are kept in
[`archive/apps-script-v2/`](archive/apps-script-v2/README.md).

## Secrets

There is no admin PIN: the admin runs only on the operator's computer. The public site needs no secret at all:
the campus map is MapLibre on committed OpenStreetMap data, and the Google Maps key and its `MAPS_API_KEY`
repository secret are gone (delete the secret from the repository settings if it was ever created). A key does
not belong in a chat or a log either. `.clasp.json` (the archived Apps Script deployment's script id) stays
gitignored.

## Known data limits (open for the owner)

- IT elevators are inferred from the drawings (shafts at rooms 0129/0245 and 0101C/0200D); not yet confirmed.
- EP room 1322 has only an exterior door, so routes reach it from outside but not from inside the building.
- The IT mezzanine (0301) has no stair or elevator link in the drawings; it is hidden from visitors anyway.
- Primary entrances are a heuristic (the drawings carry no door names or uses); review them in the admin Nav Graph
  tab. IT's level-2 east doors are taken to open onto the terrace at grade, as the floor data suggests; not surveyed.
- The IT footprint fit leaves 2.4 m RMS (mean 1.0 m): OpenStreetMap includes a one-storey structure at the
  southeast corner that no floor drawing has.
- Routes enter IT and EP only by their primary doors (the outdoor graph joins only those); a building without
  indoor maps is reached at the path point nearest its center.
