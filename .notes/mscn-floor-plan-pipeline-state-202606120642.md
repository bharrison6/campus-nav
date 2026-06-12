---
id: mscn-floor-plan-pipeline-state-202606120642
title: MSCN floor plan pipeline — current state and open decisions at dormancy
type: note
schema_version: 1
created: 2026-06-12T06:42:00Z
updated: 2026-06-12T06:42:00Z
valid_until: null
author: claude
session: phase7-onboarding-20260612
tags: [navigation, maps, decision, gotcha, gas, python]
aliases: [floor plan pipeline, mscn floor plans, campus nav floor plans, it floor plan processing]
status: active
supersedes: null
confidence: 55
source_basis: conversation
human_edited: false
sensitivity: normal
decisions: []
---

# MSCN floor plan pipeline — current state and open decisions at dormancy

> Floor plan processing reached vectorized SVGs and admin visual editors, but room polygons were never drawn and the isolation-based room detection pipeline was mid-R&D when the project paused.

## Context

Two parallel workstreams were active at dormancy: (1) GAS web app with admin visual editors ready to draw room polygons, and (2) Python/OpenCV map-processing pipeline trying to auto-detect rooms from isolated floor plan images. (source: .changelog.md 2026-02-20; .project-context.md 2026-04-11)

## Discussion

**Floor plan images — raster not vector:** Initial assumption was PDF vector paths; pdfjs-dist confirmed they are embedded raster images (EP: 1390×899 + 1456×942, IT split into two). Potrace vectorization pipeline was built (`scripts/map-processing/`). (source: .changelog.md 2026-02-20 10:00)

**SVG Drive files (authoritative):** EP F1=`1ZiY0elQQWgTPjxQIUPNuYuLtA1iSgTOw`, EP F2=`14njXbeWiq8y5VqedK08O2F7PMkTTCORR`, IT F1=`1aRrMmSnr696JiI9FlSGbz2Q-MPxsVNbU`, IT F2=`1pVW0MIXXIyYvdetAaJfl7wFqG87E_yb3`. Dimensions corrected for deskew (EP F1 −0.9°, EP F2 −0.8°, IT +0.4°). Room center coordinates recalculated to match deskewed coordinate space. (source: .changelog.md 2026-02-20 18:00)

**CORS bypass is mandatory:** Direct Google Drive URLs fail with 403 from GAS client. Server-side `getFloorPlanFile(fileId)` in AdminAPI.gs fetches via Drive API and returns base64. This applies to both WebApp.html and Admin.html canvas loaders. (source: .changelog.md 2026-02-20 10:00)

**Room detection over-segmentation:** 62–74 rooms detected vs 29–30 expected on engineering floors. Root cause: text artifacts in source images. The isolation pipeline (Phase 0, `Maps/it-floor-reproduced/`) strips branding/text before detection; the `.project-context.md` notes this "should improve with isolated input" but `detect_rooms.py` was never updated to consume isolated images. (source: .project-context.md; .changelog.md 2026-02-21)

**Text removal R&D (v1–v8):** Iterated through 8 versions (`strip_split_text_v*.py`, `strip_external_text_only.py`); archived, no longer on critical path. The isolation + direct room detection path bypasses text removal requirement. (source: .project-context.md)

**IT room center coordinates:** EP room positions extracted from PDF text layer (vector text) via pdfjs-dist getTextContent(). IT positions are visual estimates only (IT PDF text is raster, not extractable) — need refinement via admin Room Editor. (source: .changelog.md 2026-02-20 15:30)

**metersPerPixel:** EP≈0.045, IT≈0.040 — estimates, not calibrated against known dimensions. (source: .changelog.md 2026-02-20 10:00)

**Campus map center:** 36.6155/−88.3215 (corrected). Prior value 36.6622/−88.3253 was wrong and was updated in both WebApp.html and Admin.html. (source: .changelog.md 2026-02-19 02:00)

## Observations

- [constraint] Floor plan images must load via server-side `getFloorPlanFile()` CORS bypass — direct Drive URLs 403 from GAS #gas
- [constraint] All Admin.html and WebApp.html GAS JS must be ES5-compatible (var only) — Admin.html is ~4400 lines of ES5 #gas
- [decision] Isolation + direct room detection path chosen over text removal pipeline #navigation (text removal v1–v8 archived; isolated floor plan images bypass text removal requirement)
- [question] detect_rooms.py needs update to consume isolated images from `Maps/it-floor-reproduced/` as input instead of raw floor plans #navigation

## Open Questions

- [ ] Are room polygon coordinates still valid after the deskew corrections? (SVG dimensions changed; centerX/centerY were recalculated but IT room positions are approximate.)
- [ ] Is the admin PIN set in Script Properties on the live deployment?
- [ ] What is the current state of the deployed version vs the local uncommitted admin tab restructure?

## Actions

- [ ] Resume from `.project-context.md` TODO list; prioritize: integrate isolated floor plan images into detect_rooms.py, then draw room polygons for EP rooms via admin (IT can follow once positions are refined).

## Notes for Future Sessions

The admin visual tools are complete and functional (verified v15/v33). The blocking gap is that room polygons were never drawn — this is a human-in-the-loop task requiring the admin Room Editor. The pathfinding is wired up (A*) but useless without room polygons. Start there.

## Relations

[[murray-state-campus-navigation-202606120642]]
