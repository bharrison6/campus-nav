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
    building's main doors (side doors when they save a lot, never emergency exits; see Access classes below); one
    step list ("Walk 120 m along the path, enter by the east entrance, take the
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
| `scripts/campus-map/` | the campus map build (`npm run campus-map`): OpenStreetMap extract to map layers, georeference, entrance classes, outdoor walking graph with path classes, optional aerial tiles |
| `data/campus-map/` | the campus map data (OpenStreetMap-derived, ODbL): `buildings.geojson`, `layers/*.geojson`, `outdoor-graph.json`, `manifest.json`, `aerial/` + `aerial.json`; inputs `source/osm-extract.json` and `overrides.geojson` (committed) |
| `data/georef/` | one georeference per indoor building: its floor plans' frame fitted to its map footprint (committed) |
| `src/shared/` | `georef.mjs`, the floor-plan to map transform shared by the data build and the app (served to the page as `vendor/georef.mjs`) |
| `data/overrides/` | the operator's edits on top of the generated data, one JSON file per collection (committed) |
| `data/schedules/`, `data/links.json` | official event schedules by id and the documents they link to |
| `tools/admin/` | the local admin: `Admin.html`, `server.mjs` (`npm run admin`); `gs/` holds the backend `.gs` files and the floor-plan assets |
| `dev/` | `serve.mjs`, the local static server (`npm run serve`, `preview`); `gas-runtime.cjs`, the Apps Script stand-in |
| `build.config.json` | site settings: `basePath`, `domain`, `siteUrl`, `analytics.site` (no secrets) |
| `.github/workflows/pages.yml` | CI: tests, build and GitHub Pages deploy on push to `main` |
| `docs/go-live.md` | the operator's go-live and maintenance steps |
| `tests/unit/` | Node unit tests (pathfinding, unified door-to-room routing, search, map style, campus map data, ES5 check, backend, overrides, export, admin, build, data adapter, real campus data) |
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
floors and everything on them (rooms, nodes, the edges into them, indoor photos, QR locations). No map key exists
anywhere (v4 draws its own map). It adds the map fields (`scripts/data/campus-geo.mjs`): entrance nodes gain `lat`,
`lng` (through `data/georef` and `src/shared/georef.mjs`); doors, entrances, waypoints and hallways carry `access`
(`scripts/data/access.mjs`: a hallway's class reaches the waypoints inside it); the config carries `routing.altFactor`
and `routing.altDoorCost`; the indoor buildings' `entrances` become `[{nodeId, lat, lng, label, access}]` ("West
entrance", "East entrance, level 2"), main first, and a building with entrances drawn on the map lists those; buildings carry `levels`
(and `height` when set). It adds the plans of the published floors. The local admin reads `getAllCampusData`, so it still shows and edits hidden floors. `version` is a content hash, so
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
for public floors, an `entrances` block written by `npm run campus-map` (each exterior door's main-entrance score and class;
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
   residuals and entrance classes (main, alt, emergency).
6. Commit the regenerated files and push; the site rebuilds.

## The campus map data

`npm run campus-map` regenerates the map side of the app from committed inputs, with no network:

- inputs: `data/campus-map/source/osm-extract.json` (an OpenStreetMap extract of the campus box: buildings, highways,
  parking, landuse, with only the tags the layers read), `data/campus-map/overrides.geojson` (hand-made corrections),
  the floor JSON in `data/floorplans` and the operator's overrides (`data/overrides`: entrance `access`, building
  `levels`/`height`, `pathAccess.json` for path classes);
- `data/campus-map/buildings.geojson`: every building footprint with `{osmId, buildingId, name, height, levels, source}`;
  `buildingId` is the seeded building it matches (the seed point inside the footprint, or the names agreeing within
  150 m); `height` is the operator's height, else the operator's levels x 3.5 m, else OpenStreetMap `height` or
  `building:levels` x 3.5 m, else a default by type (academic 3 levels, residence 4, other 2);
- `data/campus-map/layers/`: `paths` (footway, path, pedestrian, steps, crossing; `steps` true for stairs), `roads`,
  `parking`, `landuse` (grass, parks, pitches...), `water`, `labels` (named buildings and areas);
- `data/georef/<buildingId>.json`: for each indoor building, the similarity transform (scale fixed by the drawing units;
  rotation and translation solved, a mirrored drawing tried too) that fits the union of its public floors' outlines to
  its footprint, the per-floor SVG offsets, and the fit's residual (`residualMeters`, RMS of the boundary distances;
  the tests require under 3 m). `src/shared/georef.mjs` (`svgToLngLat(buildingId, x, y, floorId)`, `lngLatToSvg`, and
  the record-taking `svgToLngLatWith(record, x, y, floorId)` the app uses) applies it; the export and the app use that
  one module. Always pass the floor id: each floor's SVG origin is its own extents, up to a meter off the fitted floor's;
- entrance classes: every exterior door on a public floor is scored (the space it opens into, its width, the distance
  to the nearest walking path, whether it faces that path) and the best 2 to 4 per building, on different faces, are
  `main`; a door out of a stair tower is `emergency`; every other exterior door is `alt` (see
  [Access classes](#access-classes-main-alt-emergency)). The scores go to the floor JSON's `entrances` block, the
  classes to `tools/admin/gs/SeedCampusMap.gs`; the operator's `access` in `data/overrides/navNodes.json` wins;
- `data/campus-map/outdoor-graph.json`: the walking network (`{nodes: [{id, lat, lng, type, access}], edges: [{id,
  from, to, distance, accessible, kind, access, way}]}`, meters): footways, crossings, the roads a walker uses where no
  sidewalk is mapped, the override walks, and every main and alt entrance joined to the nearest path by a short
  connector (emergency exits are left off). Each edge carries `access` (`road` is `alt`, every pedestrian kind
  `main`, `data/overrides/pathAccess.json` and a drawn path's own `access` override that) and `way`, what it was drawn
  from (`way/123`, an override feature id, or `connector/<entrance id>`). Entrance nodes keep their indoor ids, so the
  outdoor and indoor graphs join by id; an entrance drawn on the map for a building without floor plans is
  `entrance-<building>-<n>`. `steps` edges are not accessible;
- `data/campus-map/manifest.json`: sources, attribution, counts, residuals.

`npm run campus-map -- --check` writes nothing and fails when a committed output is out of date (a unit test does the
same). The local admin reruns the build by itself after a save that changes an entrance's class, a building's levels
or height, or anything in the Map Editor (about 6 s, in the background); run it by hand after `npm run pipeline` or
after editing `overrides.geojson` or `pathAccess.json` by hand.

**Refreshing the OpenStreetMap data.** `npm run campus-map -- --refresh` downloads the campus box again (the main
OpenStreetMap API `map` call, split into tiles if refused, Overpass mirrors as the fallback), rewrites the extract and
rebuilds. Review the diff: footprints, paths and the residuals can move. Corrections OpenStreetMap lacks go into
`data/campus-map/overrides.geojson` (features with `layer: "buildings"`, optionally `replaces: "way/<id>"` or
`buildingId`, `layer: "paths"` with `access`, or `layer: "entrances"`; the admin's Map Editor writes them); each is
also a candidate to contribute to OpenStreetMap itself. Today it splits the one OSM polygon
that draws Engineering and Physics together with the building north of it, and adds five walks visible in the NAIP
imagery (the North 16th Street west sidewalk, EP's north and south walks, IT's east terrace walks).

**Aerial imagery (optional).** `npm run campus-map -- --aerial` cuts USDA NAIP orthoimagery (public domain) into
256 px JPEG tiles for zooms 15 to 18 over the campus, `data/campus-map/aerial/{z}/{x}/{y}.jpg` with `aerial.json`
(bounds, zooms, attribution, acquisition date); `--aerial-refresh` rebuilds. It tries the USDA APFO service, then the
USGS National Map NAIP service, uses no other imagery provider, and publishes nothing when neither answers or the
tiles pass 25 MB. Downloads are cached in `scripts/campus-map/.cache` and resume after an error. Today's layer: 466
tiles, 5.6 MB, NAIP acquired 2022-07-22, served by USGS The National Map (the USDA service refused connections).

### Data sources and attribution

| data | source | license and credit |
|---|---|---|
| buildings, map layers, outdoor walking graph | OpenStreetMap (`source/osm-extract.json`) plus `overrides.geojson` | Open Database License 1.0: the map always shows "© OpenStreetMap contributors" linking to https://www.openstreetmap.org/copyright |
| aerial tiles (optional) | USDA NAIP via USGS The National Map | public domain; credited in the map's attribution as `aerial.json` says |
| floor plans, rooms, indoor graph | the university's facilities drawings, through the pipeline | published as derived plans only; the drawings never leave `../drawings/dwg` |
| map renderer | MapLibre GL JS (npm `maplibre-gl`), vendored into `dist/vendor` | BSD-3-Clause; its license ships as `vendor/maplibre-gl-LICENSE.txt` |

Nothing is fetched from a third party at run time: no tiles, fonts, scripts or keys.

### OpenStreetMap contribution candidates (the operator's call)

The corrections in `overrides.geojson` are also missing from OpenStreetMap itself. Contributing them is public content
under the operator's OpenStreetMap account, so it is the operator's decision; nothing here submits anything:

- split the one OSM polygon that draws Engineering and Physics together with the building north of it;
- add the five walks visible in the NAIP imagery: the North 16th Street west sidewalk, EP's north and south walks, and
  IT's two east terrace walks.

## Access classes (main, alt, emergency)

Every door, entrance and hallway is **main**, **alt** or **emergency**; every outdoor path is **main** or **alt**:

- **main**: the normal way. Routes walk main doors, hallways and paths at their real length.
- **alt** (a side door, a back hallway, a road with no sidewalk): usable, not preferred. An alt hallway or path costs
  its length times `routing.altFactor` (default 3), and each alt door or entrance a route passes through adds
  `routing.altDoorCost` meters (default 300). A route takes a side door only when it saves that much, or when nothing
  main gets there (EP 1322 opens only to the outside, through an alt door). A step through an alt door names it: "Enter
  by the side door (South entrance 2, level 2)".
- **emergency** (doors and hallways only): drawn on the floor plan (a red EXIT marker, a hatched hallway) and never
  on a route, not even as its start or end. If the only way is through one, the app says "No route without an
  emergency exit". A QR code scanned at an emergency exit starts the route at the nearest hallway, and the first step
  says so.

The route panel's **Use side doors and paths** switch (off by default, remembered on the phone) walks alt at its plain
length with no side-door cost, so the shortest way wins. The two numbers live in the campus config (an alt factor
below 1 reads as 1, in the export and the app alike); change them in
`data/overrides/config.json`, for example `[{"key": "routing.altDoorCost", "value": 200}]`. Why 300: with the alt
factor alone, or a small door cost, routes from across campus still entered IT by its northwest side door, because
the main doors' approach walks more road (alt, 3x); below about 280 m that still happens.

The classes start automatic (entrances as described under [The campus map data](#the-campus-map-data); hallways are
`main`; roads `alt`, other paths `main`) and the operator corrects them in the admin's Map Editor and Doors & Halls
tabs. A hallway's class reaches the waypoints inside it at export, so routing sees the change.

**Hallway detection.** The pipeline types a room as a hallway (`corridor`) from its shape (narrow and long) or a
circulation-style number (such as 1300D); 58 public hallways today. Rooms that look like circulation but are not
certain are listed in `data/review/corridor-candidates.json` (32 today, each with its evidence and a confidence); the
Doors & Halls tab shows them as suggested hallways to accept or reject.

**Connectivity check.** `scripts/data/connectivity.mjs` (`checkConnectivity(campus, outdoorGraph)`) checks that, with
emergency doors, hallways and edges removed and alt allowed (exactly what the app's router walks), every searchable
room reaches every other and every building with mapped entrances is reachable from every other. `npm test` runs it
on the real data (`tests/unit/connectivity.unit.mjs`). The admin runs it before every save that can change a route
(rooms, doors and nodes, edges, floors, buildings, path classes, drawn paths, buildings and entrances, footprint
redraws and deletions), on the complete public data the save would publish: the campus and the outdoor graph built
in memory from the same proposed files (a few seconds the first time; a save that changes no map input reuses the
last build). A save after which any searchable room or building with entrances has no route is refused, nothing is
written, and the admin lists what would be unreachable (for example making EP 1322's only door emergency, giving the
nursing building's main entrance to another building, or adding a searchable room with no node). The admin also
refuses malformed values (an unknown class, a non-number coordinate, a polygon of fewer than three points, an id that
names nothing, a footprint without three distinct corners), and the export stops on a hand-edited override or
`overrides.geojson` feature with such a value, naming the file and record.

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
them up). `config` may not set `mapsApiKey` or `dataVersion`. Class fields: `navNodes` and `rooms` `access`
(`main`, `alt`, `emergency`) and `rooms` `type: "corridor"` for a room made a hallway. (A v4 `primary` true/false on
an entrance override still reads as main/alt.) Map fields: an entrance's `access` and `buildings` `levels` / `height`
(meters; the Buildings tab). Saving either reruns `npm run campus-map` in the background so the map files match; the
admin log prints the run and its duration, `getAdminStatus` reports the last run, and the regenerated files
(`data/campus-map`, `data/georef`, the floors' entrance blocks) are committed with the overrides. The admin's
Settings tab shows how many records each file holds and lists orphans. Whole floors are not imported by hand any
more: new drawings go through the pipeline. QR codes link to `MSCN_SITE_URL`, else `siteUrl` in
`build.config.json`.

**Map Editor tab** (MapLibre over the committed campus map and, when present, the NAIP aerial; nothing from the
internet). Paths are colored by class (main teal, alt orange dashed, drawn purple), entrances by class.

- **Select**, then click a path: set it main or alt (`data/overrides/pathAccess.json`, by OpenStreetMap way), or rename
  or delete a path drawn here. Click an entrance: set its class (`navNodes.json` for a floor-plan door, the feature
  itself for a drawn entrance).
- **Draw path**: click its points, **Save path** with a class and an optional name. Its two ends snap to an entrance,
  a path vertex or a path within 4 m, so it joins the walking network. This is how missing sidewalks get in.
- **Draw building**: click the corners, name it, give a short code, levels or a height, and link it to a campus
  building (the directory record) so search and routes find it. Redrawing an OpenStreetMap building writes a
  `replaces` feature.
- **Place entrance**: on a building without floor plans, with a class and a label. These become the building's
  doors: routes to the building end at its main entrance.

These write `data/campus-map/overrides.geojson` (every feature gets an `id`) and rebuild the map data.

**Doors & Halls tab** (a floor plan per building and floor). Click a door or an entrance to make it main, alt or
emergency (`navNodes.json`); click a room to make it a hallway, or not, and set the hallway's class (`rooms.json`).
The **Suggested hallways** list shows the pipeline's corridor candidates (dashed pink on the plan) with their evidence;
**Accept** makes the room a hallway, **Reject** is remembered (`data/overrides/corridorReview.json`). Every change here
goes through the connectivity check before it is written.

**The nursing building.** The School of Nursing and Health Professions (`bld-nursing`, in the directory) is not in
OpenStreetMap yet, and the 2022 NAIP aerial still shows a parking lot there, so the map has no footprint for it.
Either add it to OpenStreetMap (any OSM editor with current imagery; then `npm run campus-map -- --refresh`; this is
the recommended way, it also helps every other map) or draw it in the Map Editor: **Draw building** linked to
"School of Nursing and Health Professions", then **Place entrance** at its main door (and any side doors or emergency
exits). Either way the campus-map build takes it as it is.

**Sidewalks.** OpenStreetMap maps few campus sidewalks, so many routes follow roads (alt). Each sidewalk the operator
draws in the Map Editor (or adds to OpenStreetMap) gives routes a main way to walk; this is the operator's
contribution, nothing draws them automatically.

## The site build

`npm run build` runs the export, then writes `dist/`: `index.html` (the app with its modules inlined),
`config.json` (`{analytics, basePath, domain}`; there is no map key), `data/campus.json`, `data/version.json`,
`floors/<floorId>.svg` (public floors only), `data/schedules/<id>.json`, `data/links.json`, the campus map
(`data/campus-map/**`, `data/georef/*.json`, and `data/map-manifest.json` listing what exists), `vendor/`
(MapLibre's browser files from `node_modules/maplibre-gl`, `modules.mjs`, `georef.mjs`), `sw.js` (the service
worker with a hashed precache list, `scripts/build/service-worker.mjs`), `404.html`, and `CNAME` when a domain is
configured. The build refuses root-relative URLs in the page, a schedule that names an unknown building, a room
that is not published or a missing link, and a hidden floor (or its plan) in the export. The campus-map build inputs
(`data/campus-map/source/`, `overrides.geojson`) are not published.

Sizes (2026-10-04 build; gzip is what a browser downloads from Pages): MapLibre 1.2 MB raw, 314 KB gzip; the page
256 KB, 68 KB gzip; campus data 603 KB, 78 KB gzip; floor plans 871 KB, 223 KB gzip; campus map data 677 KB, 97 KB
gzip (the outdoor graph is 49 KB of it). The service worker precaches 30 files, 3.7 MB raw. The aerial tiles (5.6 MB)
are never precached (the precache holds the app, data, plans and vector map); they are cached as they are seen, up to
1,200 tiles (`AERIAL_MAX_TILES`).

## Development and tests

```
npm ci                    # Node dependencies (Playwright browsers are not downloaded)
npm test                  # unit + pipeline tests, no browser (what CI runs)
npm run build             # dist/
npm run preview           # build, then serve dist/ at http://localhost:8787/campus-nav/
npm run serve             # serve the last build without rebuilding
npm run admin             # the local admin at http://localhost:8790/
npm run pipeline          # drawings -> data/floorplans and the generated .gs files
npm run campus-map        # map layers, georeference, entrance classes, outdoor graph (--refresh, --aerial, --check)
npm run test:e2e          # Playwright against a fresh build (build/e2e-site) served at /campus-nav/
npm run test:admin        # Playwright against the local admin over a copy of the data (Map Editor, Doors & Halls)
npm run test:smoke        # Playwright against the deployed site (APP_URL, default the address in build.config.json)
```

- Playwright needs a browser. Without Playwright's own download, use the installed Chrome:
  `PW_CHANNEL=chrome` (PowerShell: `$env:PW_CHANNEL = 'chrome'`). The e2e and smoke suites run locally only;
  CI runs `npm test` and the build. The campus map needs WebGL 2: the e2e config starts Chrome with SwiftShader
  (`--use-angle=swiftshader --enable-unsafe-swiftshader`) and runs 4 workers, because software rendering is slow.
  `MSCN_E2E_PORT` picks another port when 8788 is taken (the config reuses a running server on that port).
- The unit and e2e suites run on the real committed campus map (`data/campus-map`). OpenStreetMap has no steps
  near IT and EP, so the avoid-stairs tests add one synthetic steps edge where the real walk detours most. GPS is
  mocked with Playwright's `setGeolocation`, starting at the outdoor node farthest from IT and EP.
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
- EP room 1322 has only an exterior door (`ep-1-n0365`, an alt door). It stays joined to the paths as a sole door, so
  routes reach it from outside, and a route from inside EP leaves the building and comes back in by it.
- The IT mezzanine (0301) has no stair or elevator link in the drawings; it is hidden from visitors anyway.
- Main entrances are a heuristic (the drawings carry no door names or uses), and so is "a door out of a stair tower
  is an emergency exit" (one today, EP's `ep-1-n0359`); review them in the admin's Doors & Halls tab. IT's level-2
  east doors are taken to open onto the terrace at grade, as the floor data suggests; not surveyed.
- The IT footprint fit leaves 2.4 m RMS (mean 1.0 m): OpenStreetMap includes a one-storey structure at the
  southeast corner that no floor drawing has.
- With the default costs, routes enter IT and EP by their main doors, plus a sole door such as EP 1322's (a door the
  main doors cannot reach indoors); a visitor already standing at a side door is routed through it. A building
  without indoor maps is reached at its drawn main entrance, else at the path point nearest its center. The real
  paths make some routes cut through a building (in by one main door, out by another); the main doors, the side and
  emergency doors, and the IT terrace assumption still need the operator's walk-through.
- No hallway is marked emergency in the real data yet, and none of the 58 hallways is alt; that is the operator's
  call in the Doors & Halls tab.
