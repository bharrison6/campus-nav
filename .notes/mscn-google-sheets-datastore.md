---
id: mscn-google-sheets-datastore
title: MSCN Google Sheets data store
type: reference
schema_version: 1
created: 2026-06-14T12:31:00Z
updated: 2026-06-14T12:31:00Z
valid_until: null
author: claude
session: null
tags: [gas, sheets, datastore, mscn]
aliases: [mscn sheets, campus nav sheets, mscn spreadsheet, mscn data model]
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

# MSCN Google Sheets data store

> The GAS web app's entire data layer lives in a single Google Spreadsheet (8 tabs), seeded by Init.gs/SeedData.gs with 89 buildings, 4 floors, and 102 rooms.

## Context

MSCN uses Google Sheets as its database, accessed from GAS via the Spreadsheets advanced service. The spreadsheet holds all campus data and is the source of truth for buildings, floors, rooms, navigation graph, photos, and QR locations. Init.gs creates tabs and schema; SeedData.gs seeds initial data.

## Stable identifiers

- **Spreadsheet ID:** `1y_BCfyn-5AEauBcBuY2sPl1wc92bJ9t4mRoNemYkG_E`
- **Spreadsheet URL:** `https://docs.google.com/spreadsheets/d/1y_BCfyn-5AEauBcBuY2sPl1wc92bJ9t4mRoNemYkG_E/edit`

## Observations

- [registry] 8 tabs: Config, Buildings, Floors, Rooms, NavNodes, NavEdges, Photos, QRLocations #sheets #datamodel
- [registry] 89 buildings seeded with GPS coordinates sourced from campus-maps.com #mscn
- [registry] 4 floors seeded (EP F1/F2, IT F1/F2); 102 rooms with center coordinates but NO polygon data drawn #mscn
- [registry] localStorage caching in the web app front-end with version-check; offline fallback uses cached data #gas
- [gotcha] Room polygon data is blank for all 102 rooms as of dormancy — A* pathfinding is wired but non-functional without polygons #mscn

## Open Questions

- Has the spreadsheet been modified manually since the last clasp deploy (2026-02-20)?

## Relations

- relates-to [[murray-state-campus-navigation-202606120642]] (owning project)
- relates-to [[mscn-gas-deployment-config]] (the GAS app that reads this datastore)
