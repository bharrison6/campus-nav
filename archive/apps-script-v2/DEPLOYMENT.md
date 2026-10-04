# Apps Script Deployment

The v1 project, its spreadsheet and its Drive floor plans no longer exist (2026-10). A fresh project was
provisioned on 2026-10-03 under the Murray State Google account that `clasp` is logged in as
(bharrison6@murraystate.edu). Deployment history restarted at version 1.

## Status (2026-10-03)

- **Not live for visitors.** The deployment exists, but the Murray State Workspace refuses anonymous web
  apps: with the manifest's `"access": "ANYONE_ANONYMOUS"` a cookie-less request returns HTTP 403 "Access
  Denied". Every sign-in mode deploys and redirects to Google sign-in (probes, versions 3-6 below). Which
  account and access mode to use is an open owner decision (step (a) below).
- **The integrated v2 code is not deployed yet.** Version 6 holds the backend from before the integration;
  the code on `main` (all four build lanes merged, tested locally) goes out with the next `deploy.ps1`.
- **Not initialized.** `?action=init` has never run, so no spreadsheet exists and no admin PIN has been
  generated yet.

## Permanent web app URL (school-account project)

https://script.google.com/macros/s/AKfycbwK7uZ5SDu_PIDrUfWYj7866Y4gbs68cbQxxLZN4kQs0iv5EpiKeR62qBGOfk75CEo/exec

Every `deploy.ps1` run points this same deployment at a new version, so the URL does not change. If the app
moves to another Google account, it gets a new project and a new URL: record it here and in `deploy.ps1`
(`$DeployId`).

- Web app: `<exec URL>`
- Admin: `<exec URL>?action=admin`
- Health: `<exec URL>?action=ping` returns `{"ok":true,"data":"pong"}`
- One-time setup: `<exec URL>?action=init` creates the spreadsheet, seeds it, and generates the admin PIN
- Payload sizes: `<exec URL>?action=getCampusDataStats`

## Operator steps to go live

(a) **Decide the account and access mode** (open decision: deployment account and access mode). Options:
    the personal Google account with anonymous access (recommended: truly public; needs one `clasp login`
    as that account, then a new project via `clasp create --type webapp --rootDir ./src` run in
    `scripts/apps-script`, a first `clasp deploy` to get a deployment id, and that id in `deploy.ps1`); or stay
    on the school account and change `"access"` in `src/appsscript.json` to `"ANYONE"` (any signed-in Google
    account) or `"DOMAIN"` (murraystate.edu accounts only).

(b) **Deploy** from this folder:

    cd scripts/apps-script
    pwsh -File deploy.ps1 -Description "v2 integrated: CAD floor plans, routing, admin import and settings"

    The first run of new code may ask the project owner to authorize it. The manifest asks only for the
    Google Sheets scope (`spreadsheets`); Drive access was removed with the legacy Drive floor-plan code.

(c) **Initialize once.** Open `<exec URL>?action=init` in a browser while signed in as the project owner
    (or open the project in the Apps Script editor and run `initSystem`). It creates the spreadsheet
    "Murray State Campus Nav - Data", seeds 89 buildings, 6 floors, 491 rooms, 1,825 navigation nodes and
    1,945 edges, and generates the admin PIN. Read the PIN in the editor: **Project Settings > Script
    Properties > `ADMIN_PIN`**. Init is idempotent; running it again keeps existing data.

(d) **Enter the Maps key.** Open `<exec URL>?action=admin`, sign in with the PIN, open **Settings**, and paste
    the Google Maps browser key (restricted to the Maps JavaScript API and to the referrers
    `script.google.com/*` and `*.googleusercontent.com/*`). The page never displays it back. Without a key the
    app still works and lists buildings with "Open in Google Maps" walking links. Change the PIN in the same
    tab if you like (6 to 20 characters, no spaces).

(e) **Check it.** `<exec URL>?action=ping`, then the live smoke test from the repository root:
    `APP_URL=<exec URL> PW_CHANNEL=chrome npm run test:smoke`, then a walk-through on a phone and a desktop:
    floors render, search "IT 141" opens the room, a route from IT 141 to IT 241 draws on both floors and
    switches to the elevator with "Avoid stairs", the Map tab shows the map (or the building list without a
    key), and `?action=admin` asks for the PIN. Add a row to the history table below.

## Script editor

The script id is kept out of the repository. Open the editor from this folder with `clasp open` (clasp 2.x)
or `clasp open-script` (clasp 3.x), or find "Murray State Campus Navigation" at https://script.google.com/home.
`scripts/apps-script/.clasp.json` (gitignored) holds the id on a machine that has run `clasp create` or
`clasp clone <scriptId> --rootDir ./src`.

## Google Sheet

Created by the first `?action=init` (title "Murray State Campus Nav - Data"); its URL is in the init response
and its id in Script Property `SHEET_ID`. Admin edits write to it; **Settings > Reload Campus Data** in the
admin page replaces buildings, floors, rooms and the navigation graph with the seed in the deployed code
(after floor plans are regenerated from new drawings), keeping photos and QR locations.

## Secrets (Script Properties only)

Neither value belongs in this repository, a chat, or a log.

| Script Property | What | How it gets set |
|---|---|---|
| `ADMIN_PIN` | Admin page PIN | Generated (random 6 digits) by the first `?action=init`. Read it in the editor: Project Settings > Script Properties. Change it in the admin Settings tab, 6 to 20 characters with no spaces. |
| `mapsApiKey` | Google Maps JavaScript browser key | Admin Settings tab, or add the property in Project Settings > Script Properties. |
| `SHEET_ID` | Backing spreadsheet id | Written by `?action=init`. |

A Config sheet row `mapsApiKey` is read only when the Script Property is absent. Ten wrong PINs within 10
minutes lock PIN checks for 10 minutes.

## How to deploy changes

```
cd scripts/apps-script
pwsh -File deploy.ps1 -Description "what changed"
```

`deploy.ps1` pushes `src/`, creates a version, and points the permanent deployment at it. It works with clasp
2.x and 3.x (clasp 3.2's `update-deployment` is broken and is not used). Run `npm test` first.

## Deployment history

| Version | Date | Description |
|---------|------|-------------|
| 1 | 2026-10-03 | Provisioning: fresh project, pre-v2 code (ping check) |
| 2 | 2026-10-03 | v2 backend: data contract v2, settings, SVG floor plans, floor import; placeholder floor seed |
| 3 | 2026-10-03 | Access-mode probe: execute as owner, access ANYONE (any Google account): redirects to sign-in |
| 4 | 2026-10-03 | Access-mode probe: execute as owner, access DOMAIN: redirects to sign-in |
| 5 | 2026-10-03 | Access-mode probe: execute as visitor (USER_ACCESSING), access ANYONE: redirects to sign-in |
| 6 | 2026-10-03 | Access-mode probe: back to ANYONE_ANONYMOUS (the committed manifest): HTTP 403 Access Denied. Currently deployed. |
