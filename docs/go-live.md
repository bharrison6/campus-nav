# Going live and keeping the site current

The public app is a static site on GitHub Pages: nobody signs in to use it, and nothing runs on a server.
`.github/workflows/pages.yml` tests, builds and deploys it on every push to `main`. This page is the operator's
whole checklist: the one-time steps (Pages, analytics, an optional domain), how deploys happen, and how to change
the data. The README covers the code, the drawings pipeline and the overrides format. There is no map key: the
campus map is drawn by the site itself (MapLibre on OpenStreetMap data committed to the repository).

## What is published

| File | What it is |
|---|---|
| `index.html` | the app (`src/web/WebApp.html` with its modules inlined) |
| `config.json` | `{analytics: {provider, site}, basePath, domain}`, made at build time |
| `data/campus.json`, `data/version.json` | campus data of the public floors and its version (the browser cache key) |
| `floors/<floorId>.svg` | public floor plans |
| `data/campus-map/**`, `data/georef/*.json`, `data/map-manifest.json` | the campus map: buildings, paths and other layers (OpenStreetMap), the outdoor walking graph, optional aerial photos (USDA NAIP, public domain), each indoor building's placement on the map |
| `vendor/` | MapLibre GL JS and the page's two small modules, served from the site itself |
| `sw.js` | the service worker: after a first visit the app works offline |
| `data/schedules/<id>.json`, `data/links.json` | official event schedules and the links they cite |
| `404.html` | sends a mistyped or old path back to the app, keeping `?room=`, `?qr=`, `?sched=` |
| `CNAME` | only when a custom domain is configured |

The facilities drawings are never published and never in the repository; only the plans derived from them
are. Hidden floors (`public: false`, today the IT mezzanine and the EP penthouse) are left out entirely: no plan,
rooms, nodes or QR locations of theirs are published; the local admin still shows them. Every URL inside the app is relative, so one build works at `https://bharrison6.github.io/campus-nav/`
and at a domain root.

## 1. Turn on Pages (once)

1. Repository **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Push to `main` (or run the workflow by hand: **Actions > Deploy site to GitHub Pages > Run workflow**).
3. The site is at `https://bharrison6.github.io/campus-nav/`. Pages on a free account requires a public
   repository.

## 2. Usage analytics (optional)

The app uses [GoatCounter](https://www.goatcounter.com/): no cookies and no personal data, so no consent
banner. It loads only when a site code is configured.

1. Create a GoatCounter account and a site; its code is the first part of its address
   (`msu-campus-nav` for `msu-campus-nav.goatcounter.com`). Check GoatCounter's current terms for this use.
2. Put the code in `build.config.json`: `"analytics": { "provider": "goatcounter", "site": "msu-campus-nav" }`,
   commit, push.
3. What is counted: one page view per visit (the bare path; deep-link query strings are never sent) and these
   events, shown in GoatCounter as paths:

| Event | When | Label sent |
|---|---|---|
| `search` | a search result is chosen | `room` or `building` |
| `route_start` | "Navigate here" | the destination building id |
| `route_reroute` | a Reroute choice on the route panel | `locked`, `blocked`, `here` or `clear` |
| `floor_change` | the visitor picks another floor | the floor id |
| `qr_scan` | a campus QR code is opened (camera or link) | `camera`/`link` and the code type |
| `sched_open` | an official schedule is opened | the schedule id |

What someone types into search is never sent.

## 3. The campus map (nothing to configure)

The Map tab is the site's own map: no Google Maps key, no billing, no tile server. Google Maps (Android and
desktop) or Apple Maps (iPhone, iPad) open only from the "Directions to campus" links, at the chosen door. If a
`MAPS_API_KEY` repository secret was ever created for v3, delete it under **Settings > Secrets and variables >
Actions**; nothing reads it any more, and the Google Cloud key can be deleted too. The map's data is refreshed by
the scripts that generate `data/campus-map/` (README, "The campus map data").

**Attribution.** The buildings, paths and walking graph come from OpenStreetMap under the Open Database License, which
requires the "© OpenStreetMap contributors" credit the map always shows (bottom corner, linking to
openstreetmap.org/copyright); keep it visible in any restyle. The optional aerial layer is USDA NAIP imagery (public
domain, served by USGS The National Map), credited in the same corner when the layer is on. Nothing else needs
crediting on the page; MapLibre's license file ships beside it in `vendor/`.

**OpenStreetMap contributions (your call).** The repository corrects two things OpenStreetMap gets wrong near IT
and EP (one polygon covering EP and its northern neighbor, and five missing walks; README, "OpenStreetMap
contribution candidates"). Contributing them to OpenStreetMap is optional public editing under your own account.

## 4. A custom domain (optional, later)

1. Buy the domain (keep university marks out of it until marketing agrees).
2. DNS: a `CNAME` record from the host (e.g. `nav.example.org`) to `bharrison6.github.io`.
3. `build.config.json`: `"domain": "nav.example.org"`, and set `siteUrl` to `https://nav.example.org/` (the
   address QR codes generated from then on point at, and the smoke test's default). The build then writes
   `CNAME` and serves from the root.
4. **Settings > Pages > Custom domain**: enter the same name, wait for the DNS check, tick **Enforce HTTPS**.
   With an Actions deployment this setting is what binds the domain; the `CNAME` file is kept for clarity.
Printed QR codes keep working only while their URL resolves: before switching, confirm the old
`bharrison6.github.io/campus-nav/` address redirects to the new domain.

## 5. How deploys happen

Every push to `main` runs the workflow: `npm ci`, `npm test` (unit and pipeline tests; the drawings are not on
the runner, so the tests that need them are skipped), `npm run build`, then the deploy. A failing test or a build check (a bad schedule, a broken link id, a hidden floor in the export)
stops the run before anything is published, and the live site stays as it was. Watch a run under **Actions**;
re-run one there by hand. Nothing else deploys the site.

Visitors' browsers keep a copy of the app and its data (the service worker) and check `data/version.json` on
each visit; a deploy with changed data has a new version and a new `sw.js`, so the browser fetches the new copy in
the background and the app offers "Campus Nav was updated. Reload".

## 6. Changing the data

Room names, buildings, entrances, door, hallway and path classes (main, alt, emergency), missing paths and buildings
(the Map Editor tab), the walking graph and QR locations are edited in the local admin and published by committing
the result:

1. `npm run admin` and open `http://localhost:8790/` (it runs only on your computer; there is no PIN).
2. Make the edits. Every save is written at once to `data/overrides/<collection>.json`.
3. `git diff data/overrides data/campus-map/overrides.geojson` to review, then commit and push. The workflow
   publishes it within minutes. A change to an entrance's class, a building's levels or height, or anything in the
   Map Editor also reruns the campus-map build in the background (the admin log says when it is done, about 6 s);
   commit what it regenerated (`data/campus-map`, `data/georef`, `data/floorplans`, `tools/admin/gs/SeedCampusMap.gs`)
   with the overrides. Every save that can change a route is checked on the complete data it would publish; one
   that would leave any room or building with no route is refused before anything is written, and the admin names
   what would be unreachable.

The nursing building is not on the map yet (not in OpenStreetMap, and a parking lot in the 2022 aerial): add it to
OpenStreetMap and run `npm run campus-map -- --refresh`, or draw it and its entrances in the Map Editor (README, "The
nursing building").

Optional before pushing: `npm run preview` builds the site and serves it at
`http://localhost:8787/campus-nav/`, so you can check the change locally. New or revised floor drawings go
through the pipeline instead (README, "New or revised drawings").

**Official event schedules.** Add `data/schedules/<id>.json` (`{id, title, date: "YYYY-MM-DD", events: [{time:
"HH:MM", title, buildingId, roomId?, note?, links: [linkId]}]}`) and any linked documents in `data/links.json`
(`{linkId: {title, url}}`), commit, push. The build refuses a schedule that names an unknown building, a room on
a hidden floor, or a missing link. Share it as `https://bharrison6.github.io/campus-nav/?sched=<id>` (or a QR
code of that URL): it opens in the Schedule tab, read-only, and visitors can add events to their own schedule.
`eday-sample` is a sample.

## 7. Check after each deploy

- `npm run test:smoke` (with `PW_CHANNEL=chrome` on a machine without Playwright's own browser): loads the live
  site, checks the campus data is fetched and a floor plan draws. `APP_URL=<address>` checks another address.
- The site opens with no sign-in; Map, Indoor, Schedule and Scan tabs work on a phone.
- `?room=room-it-2-0241&nav=1` opens a route, entering IT by a main door; with the Entrance choice on "Any door" it
  may take a side door, and a step through one says "side door". IT 157G (from EP 1332) enters by IT's South
  entrance 2 side door under "Best entrance", with a step that says why; "Front door only" keeps the main doors. `?sched=eday-sample` opens the sample schedule.
- The Map tab shows the 2.5D campus map with the OpenStreetMap credit; "View inside" on IT or EP shows its floors;
  "Navigate here" walks along the paths to a door and switches to the floor plan at the door step.
- With location allowed, the locate button shows the blue dot; with the network off after one visit, the app still
  opens (Chrome DevTools > Network > Offline, then reload).
- With analytics: the GoatCounter dashboard shows the visit within a few minutes.
