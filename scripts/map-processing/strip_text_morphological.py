"""
IT floor plan text removal — v5: Seed + component + morphological refinement.

Strategy:
  1. Remove external branding (per-floor coordinate rectangles)
  2. Detect wall seeds + component-based text removal (Phase 2)
  3. Morphological refinement: strict wall skeleton on remaining foreground
     to catch text that survived Phase 2 by touching walls (Phase 2b)
  4. Small-component cleanup (Phase 3)
"""

import cv2
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v7"

BINARIZE_THRESH = 200
SEED_LEN_HV = 70
SEED_LEN_DIAG = 100
# More aggressive erosion: 3x3 kernel, 2 iterations ≈ removes 3px per edge
EROSION_ITERS = 2


def make_line_kernel(length, angle_deg):
    """Create a line structuring element at an arbitrary angle."""
    angle_rad = np.radians(angle_deg)
    half = length // 2
    dx = int(half * np.cos(angle_rad))
    dy = int(half * np.sin(angle_rad))
    ksize = max(abs(dx), abs(dy)) * 2 + 3
    kernel = np.zeros((ksize, ksize), np.uint8)
    center = ksize // 2
    cv2.line(kernel, (center - dx, center + dy), (center + dx, center - dy), 1, 1)
    return kernel


def get_branding_rects(name, h, w):
    """Per-floor rectangles (y0, y1, x0, x1) — expanded to fully cover branding."""
    if "floor1" in name:
        return [
            # "COLLINS CENTER" + "E" — entire lower-left below floor plan
            (int(0.35 * h), h, 0, int(0.28 * w)),
            # "Revised July 2009" — bottom right
            (int(0.90 * h), h, int(0.65 * w), w),
            # Bottom strip below floor plan
            (int(0.94 * h), h, 0, w),
        ]
    else:  # floor2
        return [
            # Compass rose + labels — top left (generous)
            (0, int(0.20 * h), 0, int(0.26 * w)),
            # "MURRAY STATE UNIVERSITY" + shield + surrounding area
            (int(0.03 * h), int(0.33 * h), int(0.42 * w), w),
            # "MARTHA LAYN" + all bottom text (start earlier at 76%)
            (int(0.76 * h), h, 0, w),
        ]


def detect_wall_seeds(binary):
    """Detect wall seed pixels using multi-angle morphological line detection."""
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
    return seeds


def detect_walls_via_components(gray):
    """Seed-based wall detection with aggressive erosion for text separation."""
    _, binary = cv2.threshold(gray, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)

    # Step 1: Detect wall seeds
    seeds = detect_wall_seeds(binary)

    # Step 2: Aggressive erosion — 3x3 kernel, 2 iterations
    # Removes ~3px per edge. Text strokes (2-4px) disappear.
    # Wall lines (4-10px) survive as thin remnants.
    binary_eroded = cv2.erode(binary, np.ones((3, 3), np.uint8), iterations=EROSION_ITERS)

    # Step 3: Connected components on eroded binary
    n_comp, labels, stats, _ = cv2.connectedComponentsWithStats(binary_eroded, connectivity=8)
    print(f"    Components (eroded): {n_comp - 1}")

    # Step 4: Find components that overlap with wall seeds
    # Dilate seeds to ensure overlap despite erosion shift
    seeds_for_check = cv2.dilate(seeds, np.ones((7, 7), np.uint8), iterations=1)
    seed_ys, seed_xs = np.where(seeds_for_check > 0)
    seed_label_values = labels[seed_ys, seed_xs]
    wall_label_set = set(seed_label_values) - {0}
    print(f"    Wall components: {len(wall_label_set)}")
    print(f"    Text components: {n_comp - 1 - len(wall_label_set)}")

    # Step 5: Build wall mask — use vectorized label lookup
    wall_label_array = np.zeros(n_comp, dtype=np.uint8)
    for lid in wall_label_set:
        wall_label_array[lid] = 1
    wall_mask = wall_label_array[labels] * 255

    # Step 6: Dilate to recover erosion losses + margin
    wall_mask = cv2.dilate(wall_mask, np.ones((7, 7), np.uint8), iterations=EROSION_ITERS + 1)

    # Clip to original foreground
    wall_mask = cv2.bitwise_and(wall_mask, binary)

    return wall_mask, binary


def process_floor(name):
    src_path = IN_DIR / name
    img = cv2.imread(str(src_path))
    if img is None:
        print(f"ERROR: Could not load {src_path}")
        return

    h, w = img.shape[:2]
    print(f"Processing {name} ({w}x{h})")
    result = img.copy()

    # Phase 1: Remove external branding
    branding = get_branding_rects(name, h, w)
    for y0, y1, x0, x1 in branding:
        result[y0:y1, x0:x1] = 255
    print(f"  Phase 1: {len(branding)} branding regions blanked")

    # Phase 2: Seed-based wall detection + component filtering
    gray = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    wall_mask, foreground = detect_walls_via_components(gray)

    text_mask = cv2.bitwise_and(foreground, cv2.bitwise_not(wall_mask))
    result[text_mask > 0] = (255, 255, 255)

    fg_px = np.count_nonzero(foreground)
    wall_px = np.count_nonzero(wall_mask)
    text_px = np.count_nonzero(text_mask)
    print(f"  Phase 2: FG={fg_px:,}  Wall={wall_px:,}  Text={text_px:,} ({100*text_px/max(fg_px,1):.1f}%)")

    # Phase 2b: Morphological refinement on remaining foreground
    # Phase 2 removed isolated text components but text characters touching
    # walls survived (they're part of wall components). Now use very strict
    # morphological detection to build a tight wall skeleton and remove
    # foreground pixels outside that skeleton.
    print("  Phase 2b: Morphological refinement...")
    gray2 = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    _, remaining_fg = cv2.threshold(gray2, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)

    # Very strict wall skeleton: only long continuous line segments
    STRICT_HV = 120      # H/V: >= 120px (room numbers/names max ~60px stroke)
    STRICT_DIAG = 160    # Diagonal: >= 160px (conservative for angled wing)
    strict_walls = np.zeros_like(remaining_fg)
    strict_walls |= cv2.morphologyEx(remaining_fg, cv2.MORPH_OPEN,
                                      cv2.getStructuringElement(cv2.MORPH_RECT, (STRICT_HV, 1)))
    strict_walls |= cv2.morphologyEx(remaining_fg, cv2.MORPH_OPEN,
                                      cv2.getStructuringElement(cv2.MORPH_RECT, (1, STRICT_HV)))
    for angle in [15, 30, 45, 60, 75, 105, 120, 135, 150, 165]:
        kernel = make_line_kernel(STRICT_DIAG, angle)
        strict_walls |= cv2.morphologyEx(remaining_fg, cv2.MORPH_OPEN, kernel)

    # Generous dilation to protect walls + adjacent structural features
    # ~20px radius covers wall thickness + small features near walls
    strict_walls = cv2.dilate(strict_walls, np.ones((11, 11), np.uint8), iterations=2)
    strict_walls = cv2.bitwise_and(strict_walls, remaining_fg)

    # Remove foreground outside the strict wall protection zone
    text_mask_2b = cv2.bitwise_and(remaining_fg, cv2.bitwise_not(strict_walls))
    result[text_mask_2b > 0] = (255, 255, 255)
    print(f"    Strict skeleton: {np.count_nonzero(strict_walls):,} px protected")
    print(f"    Additional text removed: {np.count_nonzero(text_mask_2b):,} px")

    # Phase 3: Final cleanup — remove tiny artifacts and text-shaped remnants
    gray3 = cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
    _, remaining = cv2.threshold(gray3, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)
    n_rem, labels_rem, stats_rem, _ = cv2.connectedComponentsWithStats(remaining, 8)
    cleaned = 0
    for i in range(1, n_rem):
        area = stats_rem[i, cv2.CC_STAT_AREA]
        cw = stats_rem[i, cv2.CC_STAT_WIDTH]
        ch = stats_rem[i, cv2.CC_STAT_HEIGHT]
        aspect = max(cw, ch) / max(min(cw, ch), 1)
        if area < 50:
            result[labels_rem == i] = (255, 255, 255)
            cleaned += 1
        elif area < 2000 and aspect < 4 and cw < 100 and ch < 100:
            result[labels_rem == i] = (255, 255, 255)
            cleaned += 1
    print(f"  Phase 3: Removed {cleaned} small remnants")

    # Save
    stem = name.replace("_locked.png", "")
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_removed.png"), result)
    cv2.imwrite(str(OUT_DIR / f"{stem}_wall_mask.png"), wall_mask)
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_mask.png"), text_mask)
    print(f"  Saved to {OUT_DIR}")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process_floor("it_floor1_split_locked.png")
    print()
    process_floor("it_floor2_split_locked.png")
    print(f"\nDone. Outputs in: {OUT_DIR}")


if __name__ == "__main__":
    main()
