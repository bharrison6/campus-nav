"""
IT floor plan text removal v8 — wall-protected OCR-guided removal.

Pipeline:
  1. Load locked floor plan + reviewed detection JSON
  2. Remove branding regions (reuse v7 rectangles)
  3. Generate conservative wall mask (morphological seed detection + generous dilation)
  4. For each ACCEPT detection: remove text pixels NOT in wall mask
  5. Small artifact cleanup
  6. Generate verification contact sheets (before/after per removal site)
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v8"

BINARIZE_THRESH = 200

# Wall seed detection parameters (from v7)
SEED_LEN_HV = 70
SEED_LEN_DIAG = 100
# Wall protection dilation — tight to allow text removal near walls
# Just enough to cover wall thickness (4-10px at this resolution)
WALL_PROTECT_RADIUS = 4

# Verification sheet layout
VCROP_SIZE = 250
VSHEET_COLS = 6
VSHEET_ROWS = 5
VCROPS_PER_SHEET = VSHEET_COLS * VSHEET_ROWS


def get_branding_rects(name, h, w):
    """Per-floor branding rectangles — reused from v7."""
    if "floor1" in name:
        return [
            (int(0.35 * h), h, 0, int(0.28 * w)),
            (int(0.90 * h), h, int(0.65 * w), w),
            (int(0.94 * h), h, 0, w),
        ]
    else:
        return [
            (0, int(0.20 * h), 0, int(0.26 * w)),
            (int(0.03 * h), int(0.33 * h), int(0.42 * w), w),
            (int(0.76 * h), h, 0, w),
        ]


def make_line_kernel(length, angle_deg):
    """Create a line structuring element at an arbitrary angle (from v7)."""
    angle_rad = np.radians(angle_deg)
    half = length // 2
    dx = int(half * np.cos(angle_rad))
    dy = int(half * np.sin(angle_rad))
    ksize = max(abs(dx), abs(dy)) * 2 + 3
    kernel = np.zeros((ksize, ksize), np.uint8)
    center = ksize // 2
    cv2.line(kernel, (center - dx, center + dy), (center + dx, center - dy), 1, 1)
    return kernel


def generate_wall_mask(gray):
    """Generate a CONSERVATIVE wall mask — errs toward protecting more pixels.

    Uses morphological seed detection (H/V + multi-angle diagonal) then
    generous dilation to create a wide protection zone around all walls.
    """
    _, binary = cv2.threshold(gray, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)

    # Wall seed detection via morphological opening with line-shaped kernels
    seeds = np.zeros_like(binary)

    # H/V walls
    seeds |= cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (SEED_LEN_HV, 1)))
    seeds |= cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (1, SEED_LEN_HV)))

    # Diagonal walls (every 15 degrees)
    for angle in [15, 30, 45, 60, 75, 105, 120, 135, 150, 165]:
        kernel = make_line_kernel(SEED_LEN_DIAG, angle)
        seeds |= cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    print(f"    Wall seeds: {np.count_nonzero(seeds):,} px")

    # Generous dilation to create wide protection zone
    dil_size = WALL_PROTECT_RADIUS * 2 + 1
    wall_mask = cv2.dilate(seeds, np.ones((dil_size, dil_size), np.uint8), iterations=1)

    # Clip to actual foreground — don't protect white areas
    wall_mask = cv2.bitwise_and(wall_mask, binary)

    print(f"    Wall mask (protected): {np.count_nonzero(wall_mask):,} px")
    return wall_mask, seeds, binary


def remove_text_in_box(result, wall_mask, wall_seeds, binary, detection, pad=5):
    """Remove text pixels within a detection box, protecting wall pixels.

    Strategy:
      1. Start with foreground pixels within the box
      2. Use erosion to break text-wall bridges (text strokes are 2-4px)
      3. Connected components on eroded image: components overlapping wall
         seeds are walls, others are text
      4. Map text components back to original (uneroded) pixels for removal
      5. Additional safety: protect thin+long components (wall lines)

    Returns number of pixels removed.
    """
    h_img, w_img = result.shape[:2]
    x0 = max(0, detection["x"] - pad)
    y0 = max(0, detection["y"] - pad)
    x1 = min(w_img, detection["x"] + detection["w"] + pad)
    y1 = min(h_img, detection["y"] + detection["h"] + pad)

    if x1 <= x0 or y1 <= y0:
        return 0

    # Get ROIs
    fg_roi = binary[y0:y1, x0:x1].copy()
    wall_roi = wall_mask[y0:y1, x0:x1]
    seed_roi = wall_seeds[y0:y1, x0:x1]

    if np.count_nonzero(fg_roi) == 0:
        return 0

    # Method 1: Simple mask subtraction (for areas with no wall overlap)
    simple_text = cv2.bitwise_and(fg_roi, cv2.bitwise_not(wall_roi))

    # Method 2: Erosion + component analysis (for text touching walls)
    # Erode to break text-wall bridges
    eroded = cv2.erode(fg_roi, np.ones((3, 3), np.uint8), iterations=1)
    n_comp, labels, stats, _ = cv2.connectedComponentsWithStats(eroded, connectivity=8)

    # Identify wall vs text components based on seed overlap
    text_component_mask = np.zeros_like(fg_roi)
    for i in range(1, n_comp):
        comp_pixels = (labels == i)
        # Check overlap with wall seeds
        overlap = np.count_nonzero(comp_pixels & (seed_roi > 0))
        if overlap > 0:
            continue  # This component touches wall seeds → protect

        # Check if component is very thin and long (wall-like)
        cw = stats[i, cv2.CC_STAT_WIDTH]
        ch = stats[i, cv2.CC_STAT_HEIGHT]
        ca = stats[i, cv2.CC_STAT_AREA]
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        if aspect > 8 and max(cw, ch) > 30:
            continue  # Thin long component → likely wall, protect

        # This component is text — mark for removal
        text_component_mask[comp_pixels] = 255

    # Dilate the text component mask to recover erosion losses
    text_component_mask = cv2.dilate(text_component_mask, np.ones((5, 5), np.uint8), iterations=1)
    # Clip to original foreground
    text_component_mask = cv2.bitwise_and(text_component_mask, fg_roi)

    # Combine both methods: remove pixels identified by either method
    text_pixels = cv2.bitwise_or(simple_text, text_component_mask)

    # Slight dilation to catch anti-aliasing
    text_pixels = cv2.dilate(text_pixels, np.ones((3, 3), np.uint8), iterations=1)
    # Re-clip to foreground
    text_pixels = cv2.bitwise_and(text_pixels, fg_roi)

    # Apply removal
    removed = np.count_nonzero(text_pixels)
    if removed > 0:
        result[y0:y1, x0:x1][text_pixels > 0] = (255, 255, 255)

    return removed


def create_verify_sheets(detections, original, result, floor_label):
    """Create before/after verification contact sheets."""
    accepted = [d for d in detections if d["status"] == "ACCEPT"]
    n_sheets = math.ceil(len(accepted) / VCROPS_PER_SHEET) if accepted else 0
    sheet_paths = []

    for sheet_idx in range(n_sheets):
        batch = accepted[sheet_idx * VCROPS_PER_SHEET:(sheet_idx + 1) * VCROPS_PER_SHEET]
        n_rows = math.ceil(len(batch) / VSHEET_COLS)
        # Each cell: two images side-by-side (before | after) + text bar
        cell_w = VCROP_SIZE * 2 + 4  # 4px divider
        cell_h = VCROP_SIZE + 30
        sheet_w = VSHEET_COLS * cell_w
        sheet_h = n_rows * cell_h
        sheet = np.ones((sheet_h, sheet_w, 3), dtype=np.uint8) * 220

        h_img, w_img = original.shape[:2]
        pad = 30

        for i, d in enumerate(batch):
            col = i % VSHEET_COLS
            row = i // VSHEET_COLS
            sx = col * cell_w
            sy = row * cell_h

            # Crop region with padding
            cx0 = max(0, d["x"] - pad)
            cy0 = max(0, d["y"] - pad)
            cx1 = min(w_img, d["x"] + d["w"] + pad)
            cy1 = min(h_img, d["y"] + d["h"] + pad)

            before_crop = original[cy0:cy1, cx0:cx1].copy()
            after_crop = result[cy0:cy1, cx0:cx1].copy()

            # Draw box on before crop
            bx0 = d["x"] - cx0
            by0 = d["y"] - cy0
            cv2.rectangle(before_crop, (bx0, by0),
                          (bx0 + d["w"], by0 + d["h"]), (0, 0, 255), 2)

            # Resize both crops
            crop_h, crop_w = before_crop.shape[:2]
            scale = min(VCROP_SIZE / crop_w, VCROP_SIZE / crop_h)
            nw = max(1, int(crop_w * scale))
            nh = max(1, int(crop_h * scale))
            before_resized = cv2.resize(before_crop, (nw, nh), interpolation=cv2.INTER_AREA)
            after_resized = cv2.resize(after_crop, (nw, nh), interpolation=cv2.INTER_AREA)

            # Place before on left, after on right
            oy = sy + (VCROP_SIZE - nh) // 2
            ox_before = sx + (VCROP_SIZE - nw) // 2
            ox_after = sx + VCROP_SIZE + 4 + (VCROP_SIZE - nw) // 2

            sheet[oy:oy + nh, ox_before:ox_before + nw] = before_resized
            sheet[oy:oy + nh, ox_after:ox_after + nw] = after_resized

            # Divider line
            sheet[sy:sy + VCROP_SIZE, sx + VCROP_SIZE + 1:sx + VCROP_SIZE + 3] = (150, 150, 150)

            # Label
            label = f"#{d['id']} '{d['text']}'"
            cv2.putText(sheet, label[:40], (sx + 3, sy + VCROP_SIZE + 18),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)

        path = OUT_DIR / f"verify_sheet_{floor_label}_{sheet_idx + 1}.png"
        cv2.imwrite(str(path), sheet)
        sheet_paths.append(str(path))
        print(f"    Verify sheet {sheet_idx + 1}: {len(batch)} removals")

    return sheet_paths


def process_floor(name, floor_label):
    """Full removal pipeline for one floor."""
    src_path = IN_DIR / name
    json_path = OUT_DIR / f"detections_{floor_label}.json"

    img = cv2.imread(str(src_path))
    if img is None:
        print(f"ERROR: Could not load {src_path}")
        return
    detections = json.loads(json_path.read_text(encoding="utf-8"))

    h, w = img.shape[:2]
    accepted = [d for d in detections if d["status"] == "ACCEPT"]
    print(f"\nProcessing {name} ({w}x{h}) — {len(accepted)} approved detections")

    result = img.copy()
    original = img.copy()

    # Phase 1: Remove branding
    for y0, y1, x0, x1 in get_branding_rects(name, h, w):
        result[y0:y1, x0:x1] = 255
    print("  Phase 1: Branding removed")

    # Phase 2: Generate conservative wall mask
    print("  Phase 2: Generating wall protection mask...")
    gray = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    wall_mask, wall_seeds, binary = generate_wall_mask(gray)

    # Phase 3: Remove text in each accepted detection
    print(f"  Phase 3: Removing text in {len(accepted)} detection boxes...")
    total_removed = 0
    for d in accepted:
        removed = remove_text_in_box(result, wall_mask, wall_seeds, binary, d)
        total_removed += removed
    print(f"    Total pixels removed: {total_removed:,}")

    # Phase 3b: Morphological second pass — catch text OCR missed
    # Uses v7's seed + erosion + component approach:
    #   1. Re-threshold the current result (branding + OCR text removed)
    #   2. Aggressively erode to break text-wall bridges
    #   3. Connected components → classify via wall seed overlap
    #   4. Remove text components, dilate to recover
    print("  Phase 3b: Morphological second pass (catch OCR misses)...")
    gray2 = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    _, remaining_fg = cv2.threshold(gray2, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)

    # Aggressive erosion: 3x3 kernel, 3 iterations (kills 2-4px text strokes)
    eroded_global = cv2.erode(remaining_fg, np.ones((3, 3), np.uint8), iterations=3)

    # Connected components on eroded image
    n_comp2, labels2, stats2, _ = cv2.connectedComponentsWithStats(eroded_global, 8)
    print(f"    Components (eroded): {n_comp2 - 1}")

    # Identify wall components (overlap with wall seeds, dilated slightly for erosion shift)
    seeds_check = cv2.dilate(wall_seeds, np.ones((9, 9), np.uint8), iterations=1)
    seed_ys, seed_xs = np.where(seeds_check > 0)
    wall_labels = set(labels2[seed_ys, seed_xs]) - {0}
    print(f"    Wall components: {len(wall_labels)}, Text components: {n_comp2 - 1 - len(wall_labels)}")

    # Build text mask from non-wall components
    wall_label_arr = np.zeros(n_comp2, dtype=np.uint8)
    for lid in wall_labels:
        wall_label_arr[lid] = 1
    is_wall = wall_label_arr[labels2]

    # Text components mask (on eroded image)
    text_eroded = ((is_wall == 0) & (labels2 > 0)).astype(np.uint8) * 255

    # Dilate to recover erosion losses + margin
    text_recovered = cv2.dilate(text_eroded, np.ones((9, 9), np.uint8), iterations=3)
    # Clip to remaining foreground
    text_recovered = cv2.bitwise_and(text_recovered, remaining_fg)

    morph_removed = np.count_nonzero(text_recovered)
    result[text_recovered > 0] = (255, 255, 255)
    print(f"    Morphological pass removed: {morph_removed:,} additional px")

    # Phase 3c: Targeted aggressive cleanup within OCR boxes
    # Text fragments touching walls survived Phase 3b because they're
    # connected to wall components. Within OCR boxes (where we KNOW text
    # exists), we can be more aggressive: remove any remaining small
    # foreground components that don't overlap wall seeds directly.
    print("  Phase 3c: Targeted cleanup in OCR detection areas...")
    gray3 = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    _, remaining_fg2 = cv2.threshold(gray3, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)
    targeted_removed = 0
    for d in accepted:
        pad_t = 3
        tx0 = max(0, d["x"] - pad_t)
        ty0 = max(0, d["y"] - pad_t)
        tx1 = min(w, d["x"] + d["w"] + pad_t)
        ty1 = min(h, d["y"] + d["h"] + pad_t)
        roi = remaining_fg2[ty0:ty1, tx0:tx1]
        seed_roi = wall_seeds[ty0:ty1, tx0:tx1]
        if roi.size == 0 or np.count_nonzero(roi) == 0:
            continue
        # Connected components within this detection box
        n_cc, lab_cc, st_cc, _ = cv2.connectedComponentsWithStats(roi, 8)
        for ci in range(1, n_cc):
            comp = (lab_cc == ci)
            ca = st_cc[ci, cv2.CC_STAT_AREA]
            cw_c = st_cc[ci, cv2.CC_STAT_WIDTH]
            ch_c = st_cc[ci, cv2.CC_STAT_HEIGHT]
            # Check direct overlap with wall seeds (not dilated mask)
            seed_overlap = np.count_nonzero(comp & (seed_roi > 0))
            if seed_overlap > 0:
                continue  # Directly overlaps wall seed — protect
            # Check if it's a thin long line (wall-like)
            aspect = max(cw_c, ch_c) / max(min(cw_c, ch_c), 1)
            if aspect > 6 and max(cw_c, ch_c) > 25:
                continue  # Thin long line — protect
            # Remove this component (it's text remnant in a known text area)
            comp_u8 = comp.astype(np.uint8) * 255
            result[ty0:ty1, tx0:tx1][comp_u8 > 0] = (255, 255, 255)
            targeted_removed += np.count_nonzero(comp)
    print(f"    Targeted cleanup removed: {targeted_removed:,} additional px")

    # Phase 4: Small artifact cleanup
    print("  Phase 4: Artifact cleanup...")
    gray_out = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    _, remaining = cv2.threshold(gray_out, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)
    n_comp, labels, stats, _ = cv2.connectedComponentsWithStats(remaining, 8)
    cleaned = 0
    for i in range(1, n_comp):
        area = stats[i, cv2.CC_STAT_AREA]
        cw = stats[i, cv2.CC_STAT_WIDTH]
        ch = stats[i, cv2.CC_STAT_HEIGHT]
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        # Remove tiny artifacts
        if area < 30:
            result[labels == i] = (255, 255, 255)
            cleaned += 1
        # Remove small text-shaped remnants (compact, not wall-like)
        elif area < 1500 and aspect < 4 and cw < 80 and ch < 80:
            result[labels == i] = (255, 255, 255)
            cleaned += 1
    print(f"    Removed {cleaned} small remnants")

    # Save outputs
    stem = name.replace("_locked.png", "")
    out_path = OUT_DIR / f"{stem}_text_removed.png"
    cv2.imwrite(str(out_path), result)
    print(f"  Saved: {out_path.name}")

    # Save wall mask for debugging
    cv2.imwrite(str(OUT_DIR / f"{stem}_wall_mask_v8.png"), wall_mask)

    # Phase 5: Generate verification sheets
    print("  Phase 5: Generating verification sheets...")
    sheets = create_verify_sheets(detections, original, result, floor_label)

    return result


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process_floor("it_floor1_split_locked.png", "floor1")
    process_floor("it_floor2_split_locked.png", "floor2")
    print(f"\nDone. All outputs in: {OUT_DIR}")


if __name__ == "__main__":
    main()
