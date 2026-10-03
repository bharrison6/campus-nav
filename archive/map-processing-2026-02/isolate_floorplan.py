"""
Phase 0: Isolate floor plan from surrounding branding/logos/text.

Algorithm: Downscale -> Binary threshold -> Heavy morphological closing ->
Largest connected component -> Dilate for margin -> Contour polygon -> Mask & crop.

The floor plan is the largest dense cluster of dark pixels. Branding, compass rose,
and title text are smaller isolated clusters separated by wide whitespace gaps.

Input:  Maps/it-floor-split-backup/it_floor{1,2}_split_locked.png
Output: Maps/it-floor-reproduced/
        - isolated_floor{1,2}.png              (cropped floor plan, outside masked white)
        - isolation_overlay_floor{1,2}.png      (debug: red polygon on original)
        - isolation_polygon_floor{1,2}.json     (polygon coordinates)
"""

import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-reproduced"

# --- Tunable parameters ---
DOWNSCALE = 4          # processing scale factor
THRESH = 200           # binary threshold (dark ink -> foreground)
CLOSE_KERNEL = 40      # closing kernel size at downscaled resolution
MARGIN_DILATE = 20     # margin dilation at downscaled resolution
POLY_EPSILON = 0.005   # Douglas-Peucker simplification factor (relative to perimeter)
CROP_PAD = 10          # padding around bounding box in full-res pixels


def isolate_floor(name: str) -> None:
    """Isolate floor plan from branding for a single floor image."""
    in_path = IN_DIR / f"it_{name}_split_locked.png"
    print(f"\n{'='*60}")
    print(f"Isolating {name}: {in_path}")

    # Load full-resolution image
    img = cv2.imread(str(in_path))
    if img is None:
        raise FileNotFoundError(f"Cannot load {in_path}")
    h_full, w_full = img.shape[:2]
    print(f"  Full resolution: {w_full}x{h_full}")

    # Step 1: Downscale
    h_ds = h_full // DOWNSCALE
    w_ds = w_full // DOWNSCALE
    small = cv2.resize(img, (w_ds, h_ds), interpolation=cv2.INTER_AREA)
    print(f"  Downscaled {DOWNSCALE}x: {w_ds}x{h_ds}")

    # Step 2: Binary threshold
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, THRESH, 255, cv2.THRESH_BINARY_INV)
    fg_px = np.count_nonzero(binary)
    print(f"  Foreground pixels (thresh={THRESH}): {fg_px:,}")

    # Step 3: Heavy morphological closing
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (CLOSE_KERNEL, CLOSE_KERNEL)
    )
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    closed_px = np.count_nonzero(closed)
    print(f"  After closing (kernel={CLOSE_KERNEL}): {closed_px:,} px")

    # Step 4: Largest connected component
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(
        closed, connectivity=8
    )
    # Label 0 is background; find largest foreground component
    areas = stats[1:, cv2.CC_STAT_AREA]  # skip background
    largest_label = np.argmax(areas) + 1  # +1 because we skipped index 0
    largest_area = stats[largest_label, cv2.CC_STAT_AREA]
    blob_mask = (labels == largest_label).astype(np.uint8) * 255
    print(f"  Components: {num_labels - 1}, largest: label {largest_label} "
          f"({largest_area:,} px, {100*largest_area/closed_px:.1f}% of closed)")

    # Print all component areas for debugging
    for i in range(1, min(num_labels, 8)):
        a = stats[i, cv2.CC_STAT_AREA]
        cx, cy = centroids[i]
        print(f"    Component {i}: {a:,} px at ({cx:.0f}, {cy:.0f})")

    # Step 5: Dilate for generous margin
    dilate_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (MARGIN_DILATE * 2 + 1, MARGIN_DILATE * 2 + 1)
    )
    blob_dilated = cv2.dilate(blob_mask, dilate_kernel)
    print(f"  After margin dilation ({MARGIN_DILATE}px): "
          f"{np.count_nonzero(blob_dilated):,} px")

    # Step 6: Extract contour polygon
    contours, _ = cv2.findContours(
        blob_dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    # Take the largest contour (should be only one after largest-component selection)
    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    poly = cv2.approxPolyDP(contour, POLY_EPSILON * perimeter, True)
    print(f"  Contour: {len(contour)} pts -> simplified to {len(poly)} pts "
          f"(epsilon={POLY_EPSILON})")

    # Scale polygon back to full resolution
    poly_full = poly * DOWNSCALE
    poly_full_list = poly_full.reshape(-1, 2).tolist()

    # Step 7: Apply mask and crop at full resolution
    mask_full = np.zeros((h_full, w_full), dtype=np.uint8)
    cv2.fillPoly(mask_full, [poly_full.reshape(-1, 1, 2)], 255)

    # Set everything outside polygon to white
    isolated = img.copy()
    isolated[mask_full == 0] = 255

    # Crop to polygon bounding box with padding
    x, y, bw, bh = cv2.boundingRect(poly_full.reshape(-1, 1, 2))
    x0 = max(0, x - CROP_PAD)
    y0 = max(0, y - CROP_PAD)
    x1 = min(w_full, x + bw + CROP_PAD)
    y1 = min(h_full, y + bh + CROP_PAD)
    cropped = isolated[y0:y1, x0:x1]
    print(f"  Crop box: ({x0},{y0}) to ({x1},{y1}) = {x1-x0}x{y1-y0}")

    # Step 8: Save outputs
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Isolated (cropped) floor plan
    out_isolated = OUT_DIR / f"isolated_{name}.png"
    cv2.imwrite(str(out_isolated), cropped)
    print(f"  Saved: {out_isolated}")

    # Debug overlay: red polygon on original
    overlay = img.copy()
    cv2.polylines(overlay, [poly_full.reshape(-1, 1, 2)], True, (0, 0, 255), 6)
    out_overlay = OUT_DIR / f"isolation_overlay_{name}.png"
    cv2.imwrite(str(out_overlay), overlay)
    print(f"  Saved: {out_overlay}")

    # Polygon coordinates JSON
    polygon_data = {
        "name": name,
        "full_resolution": [w_full, h_full],
        "crop_offset": [x0, y0],
        "crop_size": [x1 - x0, y1 - y0],
        "polygon_points": poly_full_list,
        "parameters": {
            "downscale": DOWNSCALE,
            "threshold": THRESH,
            "close_kernel": CLOSE_KERNEL,
            "margin_dilate": MARGIN_DILATE,
            "poly_epsilon": POLY_EPSILON,
        },
    }
    out_json = OUT_DIR / f"isolation_polygon_{name}.json"
    with open(out_json, "w") as f:
        json.dump(polygon_data, f, indent=2)
    print(f"  Saved: {out_json}")


def main():
    print("Phase 0: Floor plan isolation from surrounding content")
    print(f"Input:  {IN_DIR}")
    print(f"Output: {OUT_DIR}")

    for name in ["floor1", "floor2"]:
        isolate_floor(name)

    print(f"\n{'='*60}")
    print("Done! Check isolation_overlay_floor*.png to verify polygon placement.")


if __name__ == "__main__":
    main()
