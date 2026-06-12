---
id: murray-state-campus-navigation-202606120642
title: MurrayStateCampusNavigation — source entity
type: reference
schema_version: 1
created: 2026-06-12T06:42:00Z
updated: 2026-06-12T06:42:00Z
path: C:\GitHub\MurrayStateCampusNavigation
status: dormant
account: school
reachable_via: local
tags: [gas, gcp, school, navigation, maps]
aliases: [mscn, campus nav, msu campus nav, murray state campus navigation]
---

# MurrayStateCampusNavigation — source entity

> GAS web app providing indoor A* pathfinding on digitized engineering building floor plans + campus-wide Google Maps walking directions for Murray State University; implementation complete through admin visual editors (v33) and floor plan vectorization, but room polygon drawing and the floor plan processing pipeline were still in progress when the project went dormant.

## Context

School project (`bharrison6` account). Built Feb–Apr 2026. Architecture: GAS web app (HtmlService + Sheets, 8 data tabs), clasp v3 deploy, Python/OpenCV floor plan processing, Playwright smoke tests. Targets EP and IT engineering buildings initially (89 total campus buildings seeded with GPS). Last functional commit 2026-04-02 (Playwright tooling); 2026-04-11/22 entries are bulk maintenance sweeps.

Status dormant: active development through 2026-02-20 (v33, SVG floor plans, admin tooling complete), Playwright setup 2026-04-02, then only maintenance. Room polygons were never drawn (all 102 blank); floor plan detection pipeline was mid-R&D.

## Mentioned by

<!-- accumulates linked notes -->
