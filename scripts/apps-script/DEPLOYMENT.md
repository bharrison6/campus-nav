# Apps Script Deployment Info

The v1 project, its spreadsheet and its Drive floor plans no longer exist (2026-10).
A fresh project was provisioned on 2026-10-03 under the Murray State Google account
that `clasp` is logged in as. Deployment history restarted at version 1.

## Status (2026-10-03)

**Anonymous access is refused.** The deployment exists and the manifest asks for
`"access": "ANYONE_ANONYMOUS"`, but a cookie-less request to the `/exec` URL
returns HTTP 403 "Access Denied / You need access" (checked at 14:06Z and again at 14:18Z).
The likely cause is a Murray State Workspace policy that does not allow web apps
to be shared with anyone outside the domain. To confirm, open the project in the Apps
Script editor and look at Deploy > Manage deployments > edit (pencil) > "Who has access":
if "Anyone" is not offered, the Workspace forbids it.
Until that is resolved, `?action=init` has not been run, so no spreadsheet exists yet.

## Permanent Web App URL

https://script.google.com/macros/s/AKfycbwK7uZ5SDu_PIDrUfWYj7866Y4gbs68cbQxxLZN4kQs0iv5EpiKeR62qBGOfk75CEo/exec

Every deploy (`deploy.ps1`) points this same deployment at a new version, so the URL does not change.

- Web app: `<exec URL>`
- Admin: `<exec URL>?action=admin`
- Health: `<exec URL>?action=ping` returns `{"ok":true,"data":"pong"}`
- One-time setup: `<exec URL>?action=init` creates the spreadsheet, seeds it, and generates the admin PIN

## Script editor

The script id is kept out of the repository. Open the editor from this folder with
`clasp open` (clasp 2.x) or `clasp open-script` (clasp 3.x), or find
"Murray State Campus Navigation" at https://script.google.com/home.
`scripts/apps-script/.clasp.json` (gitignored) holds the id on a machine that has run
`clasp create` or `clasp clone <scriptId> --rootDir ./src`.

## Google Sheet

Created by the first `?action=init` (title "Murray State Campus Nav - Data"); its URL is in
the init response. The sheet id is stored in Script Property `SHEET_ID`.

## Secrets (Script Properties only)

Neither value belongs in this repository, a chat, or a log.

| Script Property | What | How it gets set |
|---|---|---|
| `ADMIN_PIN` | Admin page PIN | Generated (random 6 digits) by the first `?action=init`. Read it in the editor: Project Settings > Script Properties. Change it in the admin Settings tab (`changeAdminPin`), 6 to 12 digits. |
| `mapsApiKey` | Google Maps JavaScript browser key | Enter it in the admin Settings tab (`setMapsApiKey`) or add the property in Project Settings > Script Properties. Restrict the key to the Maps JavaScript API and to the referrers `script.google.com/*` and `*.googleusercontent.com/*`. |
| `SHEET_ID` | Backing spreadsheet id | Written by `?action=init`. |

Without `mapsApiKey` the app shows a building list with "Open in Google Maps" links
instead of the map. A Config sheet row `mapsApiKey` is read only when the Script
Property is absent. Ten wrong PINs within 10 minutes lock PIN checks for 10 minutes.

## How to deploy changes

```
cd scripts/apps-script
pwsh -File deploy.ps1 -Description "what changed"
```

`deploy.ps1` runs push, then a new version, then points the permanent deployment at it. It works with
clasp 2.x and 3.x (clasp 3.2's `update-deployment` is broken and not used).

## Deployment history

| Version | Date | Description |
|---------|------|-------------|
| 1 | 2026-10-03 | Provisioning: fresh project, pre-v2 code (ping check) |
| 2 | 2026-10-03 | v2 backend: data contract v2, settings, SVG floor plans, floor import; placeholder floor seed |
