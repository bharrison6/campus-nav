---
id: mscn-google-maps-api
title: MSCN Google Maps API credential
type: reference
schema_version: 1
created: 2026-06-14T12:31:00Z
updated: 2026-06-14T12:31:00Z
valid_until: null
author: claude
session: null
tags: [gcp, maps, api-key, mscn, credential]
aliases: [mscn maps api, campus nav maps api, mscn google maps key]
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

# MSCN Google Maps API credential

> A referrer-restricted Maps JS + Maps Embed API key on a personal Google Cloud project, used for campus-level outdoor walking directions in the MSCN web app.

## Context

The Google Maps API key is owned by the personal Google Cloud account (not school). It is stored in the GAS Config sheet and GAS Script Properties — it must NOT live in repo files. As of 2026-02-19 the DEPLOYMENT.md file contained the key in plaintext (security exposure — see Open Questions).

## Observations

- [registry] API key: [REDACTED: Google Maps API key] — key was found in `scripts/apps-script/DEPLOYMENT.md` at seed time; if repo becomes public, remove from that file immediately #security
- [registry] Restrictions: Maps JavaScript API + Maps Embed API only; referrer-restricted to `script.google.com/*` and `*.googleusercontent.com/*` #gcp
- [registry] GCP project: personal account; shared project used across multiple GAS apps #gcp
- [registry] Runtime storage: GAS Script Properties + Config sheet tab in the Spreadsheet; the `DEPLOYMENT.md` copy should be treated as a documentation artifact, not the authoritative source #gas
- [gotcha] DEPLOYMENT.md contains the API key in plaintext — if repo is ever made public, this is a live secret exposure; rotate or restrict key before publishing #security

## Open Questions

- Has the key been rotated or further restricted since 2026-02-19?
- Is there a GCP budget alert on this project (Maps JS billing can escalate)?

## Relations

- relates-to [[murray-state-campus-navigation-202606120642]] (owning project)
- relates-to [[mscn-gas-deployment-config]] (GAS app that uses this key)
