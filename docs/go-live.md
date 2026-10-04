# Going live: the web side (draft)

The public app is a static site: `npm run build` writes `dist/`, and the workflow
`.github/workflows/pages.yml` builds and deploys it to GitHub Pages on every push to `main`. Nobody signs in
to use it, and nothing runs on a server. This page covers the operator's one-time steps for the web side:
Pages, the Maps key, analytics, and a custom domain. The data side (drawings, overrides, the local admin)
is documented in the README.

## What is published

| File | What it is |
|---|---|
| `index.html` | the app (`src/web/WebApp.html` with its modules inlined) |
| `config.json` | `{mapsApiKey, analytics: {provider, site}, basePath, domain}`, made at build time |
| `data/campus.json`, `data/version.json` | campus data and its version (the browser cache key) |
| `floors/<floorId>.svg` | public floor plans (hidden floors are not published) |
| `data/schedules/<id>.json`, `data/links.json` | official event schedules and the links they cite |
| `404.html` | sends a mistyped or old path back to the app, keeping `?room=`, `?qr=`, `?sched=` |
| `CNAME` | only when a custom domain is configured |

Every URL inside the app is relative, so one build works at `https://bharrison6.github.io/campus-nav/` and
at a domain root.

## 1. Turn on Pages (once)

1. Repository **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Push to `main` (or run the workflow by hand: **Actions > Deploy site to GitHub Pages > Run workflow**).
   The `build` job runs `npm test` and `npm run build`; the `deploy` job publishes `dist/`.
3. The site is at `https://bharrison6.github.io/campus-nav/`. Pages on a free account requires a public
   repository.

## 2. The Google Maps key (optional)

Without a key the Map tab shows a building list with "Open in Google Maps" walking links, which needs no key.
With a key it shows the interactive map.

1. In Google Cloud, create a **new** API key (the old one is retired, see the key-rotation task). Restrict it:
   - Application restriction: **Websites**, referrers `https://bharrison6.github.io/campus-nav/*` (add the custom
     domain's `https://<domain>/*` when there is one).
   - API restriction: **Maps JavaScript API** only.
2. Repository **Settings > Secrets and variables > Actions > New repository secret**: name `MAPS_API_KEY`,
   value the key.
3. Re-run the workflow. The build log says `Maps key set` (it never prints the key).

A browser key is visible to anyone who opens `config.json`; the referrer restriction is what protects it.
Never put the key in `build.config.json` or anywhere else in the repository.

## 3. Usage analytics (optional)

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

## 4. A custom domain (optional, later)

1. Buy the domain (keep university marks out of it until marketing agrees).
2. DNS: a `CNAME` record from the host (e.g. `nav.example.org`) to `bharrison6.github.io`.
3. `build.config.json`: `"domain": "nav.example.org"`. The build then writes `CNAME` and serves from the root.
4. **Settings > Pages > Custom domain**: enter the same name, wait for the DNS check, tick **Enforce HTTPS**.
   With an Actions deployment this setting is what binds the domain; the `CNAME` file is kept for clarity.
5. Add `https://nav.example.org/*` to the Maps key's referrers, and update `siteUrl` in `build.config.json`
   (the public address; QR codes generated from then on should point at it).

Printed QR codes keep working only while their URL resolves: before switching, confirm the old
`bharrison6.github.io/campus-nav/` address redirects to the new domain.

## 5. Official event schedules

Add `data/schedules/<id>.json` (`{id, title, date: "YYYY-MM-DD", events: [{time: "HH:MM", title, buildingId,
roomId?, note?, links: [linkId]}]}`) and any linked documents in `data/links.json` (`{linkId: {title, url}}`).
The build refuses a schedule that names an unknown building, a room on a hidden floor, or a missing link.
Share it as `https://bharrison6.github.io/campus-nav/?sched=<id>` (or a QR code of that URL): it opens in the
Schedule tab, read-only, and visitors can add events to their own schedule. `eday-sample` is a sample.

## 6. Check after each deploy

- The site opens with no sign-in; Map, Indoor, Schedule and Scan tabs work on a phone.
- `?room=room-it-2-0241&nav=1` opens a route; `?sched=eday-sample` opens the sample schedule.
- With a key: the interactive map shows; without: the building list with walking links.
- With analytics: the GoatCounter dashboard shows the visit within a few minutes.

## Local preview

```
npm run build                      # dist/ (MAPS_API_KEY in the environment is used if set)
npm run preview                    # build + serve at http://localhost:8787/campus-nav/
npm run test:e2e                   # builds build/e2e-site and tests it at /campus-nav/ (PW_CHANNEL=chrome locally)
```

In Git Bash, prefix commands that pass `--base /campus-nav/` by hand with `MSYS_NO_PATHCONV=1`, or Git Bash
rewrites the path.
