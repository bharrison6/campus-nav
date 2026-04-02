"""
IT floor plan text detection v8 — OCR + heuristic filtering + contact sheets.

Pipeline:
  1. Remove external branding (reuse v7 coordinate rectangles)
  2. Run Tesseract OCR (PSM 6 + PSM 11) to detect text bounding boxes
  3. Deduplicate overlapping detections (center-bucket)
  4. Heuristic pre-filtering (single char, I/L flagging, confidence, size, font)
  5. Save detections JSON + contact sheets for AI visual review
"""

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np
import pytesseract

ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v8"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")

BINARIZE_THRESH = 200
# Contact sheet layout
CROP_PAD = 40          # px padding around each detection crop
CROP_SIZE = 200        # each crop cell in the contact sheet (square)
SHEET_COLS = 8         # crops per row
SHEET_ROWS = 6         # rows per sheet
CROPS_PER_SHEET = SHEET_COLS * SHEET_ROWS

# Single characters that are known valid room labels
KNOWN_SINGLE_CHARS = {"M", "W", "E", "N", "S"}
# Characters easily confused with wall lines
LINE_LIKE_CHARS = {"I", "L", "l", "1", "|", "!", "i", "T"}


@dataclass
class Detection:
    id: int
    x: int
    y: int
    w: int
    h: int
    conf: float
    text: str
    psm: int
    status: str = "REVIEW"      # ACCEPT, REJECT, REVIEW
    reason: str = ""


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


def run_ocr(gray, psm):
    """Run Tesseract with given PSM mode, return list of raw detections."""
    data = pytesseract.image_to_data(
        gray,
        output_type=pytesseract.Output.DICT,
        config=f"--oem 3 --psm {psm}",
    )
    boxes = []
    for i, raw in enumerate(data["text"]):
        txt = (raw or "").strip()
        if not txt:
            continue
        try:
            conf = float(data["conf"][i])
        except ValueError:
            conf = -1.0
        if conf < 0:
            continue
        boxes.append({
            "x": int(data["left"][i]),
            "y": int(data["top"][i]),
            "w": int(data["width"][i]),
            "h": int(data["height"][i]),
            "conf": conf,
            "text": txt,
            "psm": psm,
        })
    return boxes


def dedup_boxes(boxes):
    """Deduplicate by center-bucket (4px grid)."""
    seen = set()
    uniq = []
    for b in boxes:
        cx = int((b["x"] + b["w"] * 0.5) // 4)
        cy = int((b["y"] + b["h"] * 0.5) // 4)
        key = (cx, cy)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(b)
    return uniq


def apply_heuristics(detections, all_heights):
    """Apply heuristic filters to classify detections."""
    # Establish font baseline from multi-word, high-confidence detections
    baseline_heights = [d.h for d in detections
                        if d.conf >= 50 and len(d.text) >= 3 and 15 < d.h < 150]
    if baseline_heights:
        median_h = sorted(baseline_heights)[len(baseline_heights) // 2]
    else:
        median_h = 50  # fallback

    print(f"    Font baseline height: {median_h}px (from {len(baseline_heights)} samples)")

    for d in detections:
        txt = d.text.strip()

        # Very low confidence — noise
        if d.conf < 10:
            d.status = "REJECT"
            d.reason = f"low confidence ({d.conf:.0f})"
            continue

        # Oversized boxes — likely wall structures
        if d.w > 200 or d.h > 200:
            d.status = "REJECT"
            d.reason = f"oversized ({d.w}x{d.h})"
            continue

        # Tiny boxes — sub-character noise
        if d.w < 8 or d.h < 8:
            d.status = "REJECT"
            d.reason = f"tiny ({d.w}x{d.h})"
            continue

        # Single character handling
        if len(txt) == 1:
            if txt.upper() in LINE_LIKE_CHARS:
                d.status = "REJECT"
                d.reason = f"line-like single char '{txt}'"
                continue
            if txt.upper() not in KNOWN_SINGLE_CHARS:
                d.status = "REJECT"
                d.reason = f"unknown single char '{txt}'"
                continue
            # Known single char — still flag for review
            d.status = "REVIEW"
            d.reason = f"known single char '{txt}' — verify"
            continue

        # Font consistency check
        if median_h > 0:
            ratio = d.h / median_h
            if ratio > 2.5 or ratio < 0.3:
                d.status = "REJECT"
                d.reason = f"font size mismatch (h={d.h}, baseline={median_h}, ratio={ratio:.1f})"
                continue

        # High confidence multi-character — auto-accept
        if d.conf >= 60 and len(txt) >= 2:
            d.status = "ACCEPT"
            d.reason = f"high-conf multi-char ({d.conf:.0f}%)"
            continue

        # Medium confidence — needs review
        d.status = "REVIEW"
        d.reason = f"medium conf ({d.conf:.0f}%), needs visual check"


def create_contact_sheets(detections, img, floor_name):
    """Create contact sheet images for visual review."""
    # Filter to ACCEPT and REVIEW only
    reviewable = [d for d in detections if d.status in ("ACCEPT", "REVIEW")]
    n_sheets = math.ceil(len(reviewable) / CROPS_PER_SHEET) if reviewable else 0
    sheet_paths = []

    for sheet_idx in range(n_sheets):
        batch = reviewable[sheet_idx * CROPS_PER_SHEET:(sheet_idx + 1) * CROPS_PER_SHEET]
        n_rows = math.ceil(len(batch) / SHEET_COLS)
        # Each cell: CROP_SIZE x CROP_SIZE image + 30px text bar below
        cell_h = CROP_SIZE + 35
        sheet_w = SHEET_COLS * CROP_SIZE
        sheet_h = n_rows * cell_h
        sheet = np.ones((sheet_h, sheet_w, 3), dtype=np.uint8) * 240  # light gray bg

        h_img, w_img = img.shape[:2]

        for i, d in enumerate(batch):
            col = i % SHEET_COLS
            row = i // SHEET_COLS
            sx = col * CROP_SIZE
            sy = row * cell_h

            # Extract crop with padding
            cx0 = max(0, d.x - CROP_PAD)
            cy0 = max(0, d.y - CROP_PAD)
            cx1 = min(w_img, d.x + d.w + CROP_PAD)
            cy1 = min(h_img, d.y + d.h + CROP_PAD)
            crop = img[cy0:cy1, cx0:cx1].copy()

            # Draw detection box on crop
            bx0 = d.x - cx0
            by0 = d.y - cy0
            bx1 = bx0 + d.w
            by1 = by0 + d.h
            color = (0, 0, 255) if d.status == "REVIEW" else (0, 180, 0)
            cv2.rectangle(crop, (bx0, by0), (bx1, by1), color, 2)

            # Resize crop to fit cell
            crop_h, crop_w = crop.shape[:2]
            scale = min(CROP_SIZE / crop_w, CROP_SIZE / crop_h)
            new_w = max(1, int(crop_w * scale))
            new_h = max(1, int(crop_h * scale))
            resized = cv2.resize(crop, (new_w, new_h), interpolation=cv2.INTER_AREA)

            # Center in cell
            ox = sx + (CROP_SIZE - new_w) // 2
            oy = sy + (CROP_SIZE - new_h) // 2
            sheet[oy:oy + new_h, ox:ox + new_w] = resized

            # Text label below crop
            label = f"#{d.id} '{d.text}' c={d.conf:.0f} [{d.status}]"
            cv2.putText(sheet, label[:35], (sx + 3, sy + CROP_SIZE + 15),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)
            if len(label) > 35:
                cv2.putText(sheet, label[35:70], (sx + 3, sy + CROP_SIZE + 28),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)

        path = OUT_DIR / f"contact_sheet_{floor_name}_{sheet_idx + 1}.png"
        cv2.imwrite(str(path), sheet)
        sheet_paths.append(str(path))
        print(f"    Contact sheet {sheet_idx + 1}: {len(batch)} detections")

    return sheet_paths


def create_annotated_image(detections, img, floor_name):
    """Draw all detection boxes on full floor plan image."""
    annotated = img.copy()
    colors = {
        "ACCEPT": (0, 180, 0),    # green
        "REVIEW": (0, 140, 255),  # orange
        "REJECT": (0, 0, 200),    # red
    }
    for d in detections:
        color = colors.get(d.status, (128, 128, 128))
        cv2.rectangle(annotated, (d.x, d.y), (d.x + d.w, d.y + d.h), color, 2)
        cv2.putText(annotated, f"#{d.id}", (d.x, d.y - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

    path = OUT_DIR / f"annotated_{floor_name}.png"
    cv2.imwrite(str(path), annotated)
    print(f"    Annotated image saved: {path.name}")
    return str(path)


def process_floor(name, floor_label):
    """Full detection pipeline for one floor."""
    src_path = IN_DIR / name
    img = cv2.imread(str(src_path))
    if img is None:
        print(f"ERROR: Could not load {src_path}")
        return

    h, w = img.shape[:2]
    print(f"\nProcessing {name} ({w}x{h})")

    # Phase 1: Remove branding
    work = img.copy()
    for y0, y1, x0, x1 in get_branding_rects(name, h, w):
        work[y0:y1, x0:x1] = 255
    print("  Phase 1: Branding removed")

    # Phase 2: OCR detection
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    print("  Phase 2: Running Tesseract OCR...")
    raw_boxes = []
    for psm in (6, 11):
        boxes = run_ocr(gray, psm)
        print(f"    PSM {psm}: {len(boxes)} raw detections")
        raw_boxes.extend(boxes)

    # Deduplicate
    uniq = dedup_boxes(raw_boxes)
    print(f"    After dedup: {len(uniq)} unique detections")

    # Convert to Detection objects
    detections = []
    for i, b in enumerate(uniq):
        detections.append(Detection(
            id=i + 1,
            x=b["x"], y=b["y"], w=b["w"], h=b["h"],
            conf=b["conf"], text=b["text"], psm=b["psm"],
        ))

    # Phase 3: Heuristic filtering
    print("  Phase 3: Heuristic filtering...")
    all_heights = [d.h for d in detections]
    apply_heuristics(detections, all_heights)

    accept = sum(1 for d in detections if d.status == "ACCEPT")
    review = sum(1 for d in detections if d.status == "REVIEW")
    reject = sum(1 for d in detections if d.status == "REJECT")
    print(f"    ACCEPT: {accept}, REVIEW: {review}, REJECT: {reject}")

    # Phase 4: Generate outputs
    print("  Phase 4: Generating review outputs...")
    sheets = create_contact_sheets(detections, img, floor_label)
    annotated = create_annotated_image(detections, img, floor_label)

    # Save detections JSON
    json_path = OUT_DIR / f"detections_{floor_label}.json"
    json_data = [asdict(d) for d in detections]
    json_path.write_text(json.dumps(json_data, indent=2), encoding="utf-8")
    print(f"    Detections JSON: {json_path.name} ({len(detections)} entries)")

    # Summary
    print(f"\n  Summary for {floor_label}:")
    print(f"    Total detections: {len(detections)}")
    print(f"    Auto-ACCEPT: {accept}")
    print(f"    Needs review: {review}")
    print(f"    Auto-REJECT: {reject}")
    print(f"    Contact sheets: {len(sheets)}")


def main():
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    process_floor("it_floor1_split_locked.png", "floor1")
    process_floor("it_floor2_split_locked.png", "floor2")
    print(f"\nDone. All outputs in: {OUT_DIR}")


if __name__ == "__main__":
    main()
