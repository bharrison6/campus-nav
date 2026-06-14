---
id: mscn-gas-deployment-config
title: MSCN GAS deployment configuration
type: reference
schema_version: 1
created: 2026-06-14T12:31:00Z
updated: 2026-06-14T12:31:00Z
valid_until: null
author: claude
session: null
tags: [gas, clasp, deployment, mscn]
aliases: [mscn deployment, mscn exec url, mscn script id, campus nav deployment]
status: active
supersedes: null
confidence: 60
source_basis: document
human_edited: false
sensitivity: normal
decisions: []
model: claude-sonnet-4-6
model_basis: confirmed
provenance:
  harvest: deterministic
  recall-extract: claude-sonnet-4-6
  find-missing: claude-sonnet-4-6
  precision-judge: claude-sonnet-4-6
---

# MSCN GAS deployment configuration

> Stable identifiers and deploy workflow for the MurrayStateCampusNavigation Google Apps Script web app — the exec URL never changes across version deployments.

## Context

The MSCN web app is deployed as a GAS web app under the `bharrison6` (school) account. clasp v3 is the local dev/deploy toolchain. The correct deploy sequence is `push → create-version → deploy -i -V N`; the `update-deployment` subcommand was broken in clasp v3.2.0 (use `deploy.ps1` to avoid manual error). Script lives at `scripts/apps-script/` with rootDir `src/`.

## Stable identifiers

- **Exec URL (permanent):** `https://script.google.com/macros/s/AKfycbxM-sMOC8CQQf2ckPX6MgZHZsnWu-oAWKp0DeuqbEp3idjSKGZUY288zN_KhXlwbhy53Q/exec`
- **Script ID:** `1oEdoBjGZTmToLCCfW8Wyhn3uNJBQ-S9Zwvv8MmrHk2rDQ3XGfXUVbi7t`
- **Spreadsheet ID:** `1y_BCfyn-5AEauBcBuY2sPl1wc92bJ9t4mRoNemYkG_E`
- **Script Editor URL:** `https://script.google.com/d/1oEdoBjGZTmToLCCfW8Wyhn3uNJBQ-S9Zwvv8MmrHk2rDQ3XGfXUVbi7t/edit`
- **GitHub repo:** `bharrison6/MurrayStateCampusNavigation` (school account)

## Observations

- [registry] clasp config at `scripts/apps-script/.clasp.json`; deploy script at `scripts/apps-script/deploy.ps1` — use this, not manual clasp commands #gas
- [registry] `appsscript.json` oauthScopes: Spreadsheets + Drive + script.external_request; executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS #gas
- [registry] Playwright smoke tests use `APP_URL` env var pointing to the permanent exec URL above; iframe-aware (GAS double-iframe wrapper) #testing
- [gotcha] clasp v3.2.0 `update-deployment` is broken — `deploy.ps1` uses `create-version + deploy -i -V N` sequence correctly #gas

## Open Questions

- Is the current deployed version current with the local source as of last commit? (Admin tab restructure was noted as uncommitted as of 2026-02-19.)

## Relations

- relates-to [[murray-state-campus-navigation-202606120642]] (source entity for this deployment)
- relates-to [[mscn-google-sheets-datastore]] (data backend)
