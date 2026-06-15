---
id: mscn-opencv-floor-plan-pipeline
title: MSCN OpenCV floor plan processing pipeline
schema_version: 2
created: 2026-06-14T12:31:00Z
updated: 2026-06-14T12:31:00Z
valid_until: null
author: claude
session: null
tags: [python, opencv, floorplan, maps, mscn]
aliases: [mscn map processing, mscn floor plan pipeline, campus nav opencv, mscn python pipeline]
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
lifecycle: active
artifact_kind: memory
memory_class: semantic
semantic_kind: entity_profile
---

# MSCN OpenCV floor plan processing pipeline

> Python/OpenCV pipeline at `scripts/map-processing/` that ingests architectural floor plan PDFs and produces rotation-corrected, potrace-vectorized SVG floor plans for the MSCN indoor navigation system.

## Context

The floor plan pipeline converts raw engineering building PDF floor plans (EP and IT buildings) into navigable SVG assets. It has three logical stages: (1) isolation — strip branding/text from the raster floor plan images; (2) room detection — segment isolated images into room polygons; (3) vectorization — produce traceable SVG via potrace. Only stage 1 (isolation) was complete at dormancy; stage 2 was mid-R&D with over-segmentation issues.

## Pipeline scripts

- `isolate_floorplan.py` — Phase 0: strips external branding and text from raster floor plan images; outputs to `Maps/it-floor-reproduced/`; tunable params; Phase 0 complete
- `detect_rooms.py` — Phase 1 room segmentation; NOT yet updated to consume isolated images; currently over-segments (62–74 vs 29–30 expected) due to text artifacts in raw input
- `vectorize_rooms.py` / `reproduce_svg.py` — SVG vectorization using potrace; rotation-corrected (EP F1: −0.9°, EP F2: −0.8°, IT: +0.4°)
- `export_room_data.py` — exports room center coordinates
- `split_it_floors.py` — splits IT building PDF (covers both floors) into separate images
- `strip_split_text_v*.py`, `strip_external_text_only.py`, `strip_text_morphological.py` — archived text-removal R&D (v1–v8); superseded by isolation-first approach
- `ocr_detect_v8.py`, `ocr_remove_v8.py`, `ocr_review_v8.py` — OCR-based text removal v8; archived
- `tile_drafting_pilot.py`, `it_floor2_pilot.py` — tiling experiments
- `ai_parse_demo.py` — AI-assisted floor plan parsing demo

## Observations

- [registry] Source floor plans: EP and IT engineering buildings; PDF format with embedded raster images (not vector paths — confirmed via pdfjs-dist) #maps
- [registry] Floor plan source files in `Maps/` — gitignored (large binaries); authoritative copies on Google Drive and local `Maps/` directory #maps
- [registry] potrace is a required external binary for SVG vectorization #dependency
- [gotcha] `detect_rooms.py` must be updated to use isolated images from `Maps/it-floor-reproduced/` as input — currently reads raw floor plans and over-segments #maps
- [gotcha] IT room center coordinates are visual estimates only (IT PDF text is raster, not extractable by pdfjs-dist getTextContent); EP positions came from PDF text layer #maps
- [gotcha] SeedData room center coordinates need crop_offset correction from isolation_polygon JSON after isolation pipeline runs #maps
- [decision] Text removal pipeline (v1–v8) deprecated; isolation-first path chosen — isolation strips context before detection, bypassing text removal requirement #maps
- [registry] metersPerPixel estimates: EP≈0.045, IT≈0.040 — not calibrated; manual verification needed #maps

## Google Drive SVG assets (authoritative)

| Floor | Drive File ID |
|-------|---------------|
| EP F1 | `1ZiY0elQQWgTPjxQIUPNuYuLtA1iSgTOw` |
| EP F2 | `14njXbeWiq8y5VqedK08O2F7PMkTTCORR` |
| IT F1 | `1aRrMmSnr696JiI9FlSGbz2Q-MPxsVNbU` |
| IT F2 | `1pVW0MIXXIyYvdetAaJfl7wFqG87E_yb3` |

Files are publicly view-shared; loaded server-side via `getFloorPlanFile(fileId)` to bypass CORS (direct Drive URLs 403 from GAS client).

## Open Questions

- Is potrace installed locally and accessible on PATH?
- What is the current state of `Maps/it-floor-reproduced/` isolated outputs?
- Have the SVG Drive files been updated since the rotation-correction run (2026-02-20)?

## Relations

- relates-to [[murray-state-campus-navigation-202606120642]] (owning project)
- relates-to [[mscn-floor-plan-pipeline-state-202606120642]] (runtime state note at dormancy)
- relates-to [[mscn-google-sheets-datastore]] (room polygon data must flow back into Sheets via admin Room Editor)
