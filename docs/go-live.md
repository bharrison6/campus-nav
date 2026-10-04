# Going live and keeping the site current

The public app is a static site on GitHub Pages: nobody signs in to use it, and nothing runs on a server.
`.github/workflows/pages.yml` tests, builds and deploys it on every push to `main`. This page is the operator's
whole checklist: the one-time steps (Pages, analytics, the Maps key, an optional domain), how deploys happen,
and how to change the data. The README covers the code, the drawings pipeline and the overrides format.

## What is published

| File | What it is |
|---|---|
| `index.html` | the app (`src/web/WebApp.html` with its modules inlined) |
| `config.json` | `{mapsApiKey, analytics: {provider, site}, basePath, domain}`, made at build time |
| `data/campus.json`, `data/version.json` | campus data of the public floors and its version (the browser cache key) |
| `floors/<floorId>.svg` | public floor plans |
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
| `floor_change` | the visitor picks another floor | the floor id |
| `qr_scan` | a campus QR code is opened (camera or link) | `camera`/`link` and the code type |
| `sched_open` | an official schedule is opened | the schedule id |

What someone types into search is never sent.

## 3. The Google Maps key (optional)

Without a key the Map tab shows a building list with "Open in Google Maps" walking links, which needs no key.
With a key it shows the interactive map.

1. In Google Cloud, create a **new** browser API key (the v2 key is retired; do not reuse it). Restrict it:
   - Application restriction: **Websites**, referrers `https://bharrison6.github.io/campus-nav/*` (add the custom
     domain's `https://<domain>/*` when there is one).
   - API restriction: **Maps JavaScript API** only.
2. Repository **Settings > Secrets and variables > Actions > New repository secret**: name `MAPS_API_KEY`,
   value the key.
3. Re-run the workflow. The build log says `Maps key set` (it never prints the key).

A browser key is visible to anyone who opens `config.json`; the referrer restriction is what protects it.
Never put the key in `build.config.json`, the overrides, or anywhere else in the repository.

## 4. A custom domain (optional, later)

1. Buy the domain (keep university marks out of it until marketing agrees).
2. DNS: a `CNAME` record from the host (e.g. `nav.example.org`) to `bharrison6.github.io`.
3. `build.config.json`: `"domain": "nav.example.org"`, and set `siteUrl` to `https://nav.example.org/` (the
   address QR codes generated from then on point at, and the smoke test's default). The build then writes
   `CNAME` and serves from the root.
4. **Settings > Pages > Custom domain**: enter the same name, wait for the DNS check, tick **Enforce HTTPS**.
   With an Actions deployment this setting is what binds the domain; the `CNAME` file is kept for clarity.
5. Add `https://nav.example.org/*` to the Maps key's referrers.

Printed QR codes keep working only while their URL resolves: before switching, confirm the old
`bharrison6.github.io/campus-nav/` address redirects to the new domain.

## 5. How deploys happen

Every push to `main` runs the workflow: `npm ci`, `npm test` (unit and pipeline tests; the drawings are not on
the runner, so the tests that need them are skipped), `npm run build` with the `MAPS_API_KEY` secret, then the
deploy. A failing test or a build check (a bad schedule, a broken link id, a hidden floor in the export)
stops the run before anything is published, and the live site stays as it was. Watch a run under **Actions**;
re-run one there by hand. Nothing else deploys the site.

Visitors' browsers keep a copy of the campus data and check `data/version.json` on each visit; a deploy with
changed data has a new version, so they download the new data on their next visit.

## 6. Changing the data

Room names, buildings, entrances, the walking graph and QR locations are edited in the local admin and
published by committing the result:

1. `npm run admin` and open `http://localhost:8790/` (it runs only on your computer; there is no PIN).
2. Make the edits. Every save is written at once to `data/overrides/<collection>.json`.
3. `git diff data/overrides` to review, then commit and push. The workflow publishes it within minutes.

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
- `?room=room-it-2-0241&nav=1` opens a route; `?sched=eday-sample` opens the sample schedule.
- With a key: the interactive map shows; without: the building list with walking links.
- With analytics: the GoatCounter dashboard shows the visit within a few minutes.
