# Archived: the Apps Script deployment (v2, retired 2026-10-04)

This folder is dead code, kept for reference. Nothing builds, tests or deploys from it.

## What it was

Through v2 the app ran as a Google Apps Script web app: `doGet` served the web app and the admin page as
HtmlService templates, the data lived in a Google Sheet created by `initSystem()`, admin writes were
PIN-checked server functions, and the Maps key and the admin PIN lived in Script Properties.

- `appsscript.json` - the project manifest (V8 runtime, Sheets scope only, anonymous web-app access).
- `deploy.ps1` - pushed with clasp and redeployed one fixed deployment id so the `/exec` URL never changed.
  It needs `.clasp.json` (the script id), which was never committed.
- `DEPLOYMENT.md` - the v2 go-live steps (init, PIN, Maps key, access mode).

## Why it was retired

The Murray State Google Workspace does not allow Apps Script web apps to be reached anonymously, and the
app's purpose (zero-friction campus navigation for every visitor) rules out a sign-in. v3 publishes the same
app as a static site on GitHub Pages instead: the campus data is exported at build time, edits are a
committed overrides layer, and the admin page runs only on the operator's machine.

## Where the pieces went

| v2 | v3 |
|---|---|
| `src/*.gs`, `src/FP_*.html` | `tools/admin/gs/` - still executed, in Node, by `dev/gas-runtime.cjs` (build-time export and local admin) |
| `src/Admin.html` | `tools/admin/Admin.html` - served by `npm run admin` on localhost, writes `data/overrides/*.json` |
| `src/WebApp*.html` | `src/web/` - the static site's app (data from `data/campus.json` instead of `google.script.run`) |
| Google Sheet | `tools/admin/gs/SeedData.gs` + the pipeline's `SeedFloorData.gs` + `data/overrides/*.json` |
| Script Properties (Maps key, PIN) | the Maps key comes from the build (repository secret); there is no PIN |
