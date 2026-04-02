# IT Split Status And Playbook (2026-02-21)

## Locked Split Baseline
- Source file: `Maps/IT Floor Plan.pdf`
- Locked outputs:
  - `Maps/it-floor-split-backup/it_floor1_split_locked.png`
  - `Maps/it-floor-split-backup/it_floor2_split_locked.png`
  - `Maps/it-floor-split-backup/it_floor1_split_locked.pdf`
  - `Maps/it-floor-split-backup/it_floor2_split_locked.pdf`

## Recommended Split Workflow (Reusable)
1. Start from original non-annotated source (avoid event/overlay variants).
2. Compute a whitespace seam that spans left-to-right and splits the page into two sides.
3. Validate seam with two known anchors (one guaranteed on each floor) to ensure opposite sides.
4. Perform side-of-seam split on original raster (preserve linework).
5. Apply minimal hybrid reassignment only for specific leaked islands (do not global-prune components).
6. Lock accepted split files and never overwrite them; do all downstream processing from locked copies.

## Current Text-Removal Status
- Multiple automated OCR/component iterations were attempted.
- Common failure modes observed:
  - Over-aggressive masks removed structural map lines.
  - Over-conservative masks left external branding remnants.
  - Assumptions tied to floor filename/order caused wrong-region cleanup.
- Current conclusion:
  - Locked split is acceptable.
  - Text removal still requires a more controlled/surgical workflow before vectorization.

## Next Steps
1. Use locked split as immutable input.
2. Build controlled text-removal pass (external-branding removal first, interior labels second).
3. Approve text-removed pair before any vectorization/relabeling.
