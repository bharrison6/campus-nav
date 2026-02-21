# Floor Plan Vectorization Design

## Goal
Convert raster floor plan PNGs (extracted from PDFs) to clean B&W SVG vector files. Fix rotation alignment. Split IT combined image into two floors.

## Source Images
| Image | Size | Notes |
|-------|------|-------|
| EP Floor 1 | 1390x899 RGB | Color room fills (ignored — B&W trace) |
| EP Floor 2 | 1456x942 RGB | Same |
| IT Combined | 1699x2199 RGB | B&W line art, both floors stacked vertically |

## Pipeline
1. **Grayscale + threshold** (sharp): Convert to pure B&W bitmap
2. **Rotation detection**: Find dominant wall angle, compute deskew angle
3. **Deskew** (sharp): Rotate to align walls with axes
4. **Trace** (potrace npm): B&W bitmap → SVG vector paths
5. **IT split**: Crop combined trace into Floor 1 and Floor 2 SVGs by y-coordinate

## Output
4 SVG files: `ep-floor-1.svg`, `ep-floor-2.svg`, `it-floor-1.svg`, `it-floor-2.svg`

## Tools
- `sharp` (npm) — image preprocessing
- `potrace` (npm) — bitmap-to-vector tracing
- Temp Node.js script (not in repo)

## Decision: B&W only
Color room fills from EP originals are not preserved. Room type coloring can be applied via polygon overlays from database room type data.
