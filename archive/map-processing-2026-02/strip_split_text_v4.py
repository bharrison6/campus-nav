from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract


ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v4"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")


@dataclass
class Box:
    x: int
    y: int
    w: int
    h: int
    conf: float
    text: str


def get_boxes(gray: np.ndarray) -> list[Box]:
    out: list[Box] = []
    for psm in (6, 11):
        data = pytesseract.image_to_data(
            gray,
            output_type=pytesseract.Output.DICT,
            config=f"--oem 3 --psm {psm}",
        )
        for i, raw in enumerate(data["text"]):
            txt = (raw or "").strip()
            if not txt:
                continue
            try:
                conf = float(data["conf"][i])
            except ValueError:
                conf = -1.0
            if conf < 20:
                continue
            out.append(
                Box(
                    x=int(data["left"][i]),
                    y=int(data["top"][i]),
                    w=int(data["width"][i]),
                    h=int(data["height"][i]),
                    conf=conf,
                    text=txt,
                )
            )
    # rough dedupe
    seen: set[tuple[int, int]] = set()
    uniq: list[Box] = []
    for b in out:
        key = (int((b.x + b.w * 0.5) // 5), int((b.y + b.h * 0.5) // 5))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(b)
    return uniq


def branding_regions(name: str, h: int, w: int, page_text: str) -> list[tuple[int, int, int, int]]:
    regs: list[tuple[int, int, int, int]] = []
    t = page_text.lower()

    # Collins block (left-lower branding).
    if ("collins" in t) or ("martha" in t) or ("floor1" in name):
        regs.append((0, int(0.50 * h), int(0.44 * w), int(0.90 * h)))

    # Murray State wordmark/shield and trailing remnants on right.
    if ("state" in t) or ("university" in t) or ("floor2" in name):
        regs.append((int(0.43 * w), int(0.09 * h), int(0.88 * w), int(0.30 * h)))
        regs.append((int(0.04 * w), int(0.88 * h), int(0.76 * w), h))
        regs.append((int(0.78 * w), int(0.24 * h), int(0.96 * w), int(0.40 * h)))

    # Footer revision remnants
    regs.append((int(0.84 * w), int(0.93 * h), w, h))
    return regs


def in_any_region(cx: int, cy: int, regs: list[tuple[int, int, int, int]]) -> bool:
    for x0, y0, x1, y1 in regs:
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            return True
    return False


def remove_text_components(img: np.ndarray, file_name: str) -> tuple[np.ndarray, np.ndarray, list[Box]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    boxes = get_boxes(gray)
    h, w = gray.shape
    page_text = pytesseract.image_to_string(gray, config="--oem 3 --psm 6")
    brand_regs = branding_regions(file_name, h, w, page_text)

    # Determine which split this is by ink centroid for safe extra cleanup masks.
    ys, xs = np.where(inv > 0)
    cy = float(np.mean(ys)) if ys.size else 0.0
    is_upper_split = cy < (0.52 * h)
    if is_upper_split:
        # trailing "E" / right-side logo remnant on upper split
        brand_regs.append((int(0.78 * w), int(0.22 * h), int(0.98 * w), int(0.42 * h)))

    remove_mask = np.zeros_like(inv)

    # component-level removal inside OCR boxes
    for b in boxes:
        x0 = max(0, b.x - 3)
        y0 = max(0, b.y - 3)
        x1 = min(w, b.x + b.w + 3)
        y1 = min(h, b.y + b.h + 3)
        roi = inv[y0:y1, x0:x1]
        if roi.size == 0:
            continue
        n, lab, st, _ = cv2.connectedComponentsWithStats(roi, connectivity=8)
        for i in range(1, n):
            rx, ry, rw, rh, ra = map(int, st[i])
            if ra < 3:
                continue
            cx = x0 + rx + rw // 2
            cy = y0 + ry + rh // 2
            in_brand = in_any_region(cx, cy, brand_regs)
            long_h = rw >= 28 and rh <= 3
            long_v = rh >= 28 and rw <= 3
            if long_h or long_v:
                continue
            # aggressive inside branding, conservative elsewhere
            if in_brand:
                if ra <= 2400:
                    remove_mask[y0:y1, x0:x1][lab == i] = 255
            else:
                if ra <= 520 and rw <= 38 and rh <= 38:
                    remove_mask[y0:y1, x0:x1][lab == i] = 255

    # ensure branding gets fully removed
    for x0, y0, x1, y1 in brand_regs:
        cv2.rectangle(remove_mask, (x0, y0), (x1, y1), 255, -1)

    # Global cleanup: remove small text-like components across map (after OCR-seeded removal).
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    for i in range(1, n2):
        x, y, w2, h2, a = map(int, st2[i])
        if a < 4:
            continue
        long_h = w2 >= 30 and h2 <= 3
        long_v = h2 >= 30 and w2 <= 3
        if long_h or long_v:
            continue
        if a <= 1100 and w2 <= 70 and h2 <= 70:
            remove_mask[lab2 == i] = 255

    out = img.copy()
    out[remove_mask > 0] = (255, 255, 255)

    # Final cleanup: remove tiny isolated blobs far outside main map body.
    out_gray = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)
    out_inv = cv2.threshold(out_gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    n3, lab3, st3, _ = cv2.connectedComponentsWithStats(out_inv, connectivity=8)
    # Main map body from largest connected component.
    main_idx = 1
    main_area = 0
    for i in range(1, n3):
        a = int(st3[i, cv2.CC_STAT_AREA])
        if a > main_area:
            main_area = a
            main_idx = i
    mx = int(st3[main_idx, cv2.CC_STAT_LEFT])
    my = int(st3[main_idx, cv2.CC_STAT_TOP])
    mw = int(st3[main_idx, cv2.CC_STAT_WIDTH])
    mh = int(st3[main_idx, cv2.CC_STAT_HEIGHT])
    pad = 140
    x0 = max(0, mx - pad)
    y0 = max(0, my - pad)
    x1 = min(w - 1, mx + mw + pad)
    y1 = min(h - 1, my + mh + pad)
    for i in range(1, n3):
        if i == main_idx:
            continue
        cx = int(st3[i, cv2.CC_STAT_LEFT] + st3[i, cv2.CC_STAT_WIDTH] // 2)
        cy = int(st3[i, cv2.CC_STAT_TOP] + st3[i, cv2.CC_STAT_HEIGHT] // 2)
        a = int(st3[i, cv2.CC_STAT_AREA])
        inside = (x0 <= cx <= x1) and (y0 <= cy <= y1)
        if (not inside) and a <= 2600:
            out[lab3 == i] = (255, 255, 255)

    return out, remove_mask, boxes


def process(file_name: str) -> None:
    src = IN_DIR / file_name
    img = cv2.imread(str(src))
    if img is None:
        raise FileNotFoundError(str(src))
    out, mask, boxes = remove_text_components(img, file_name)
    stem = Path(file_name).stem.replace("_locked", "")
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_removed_v4.png"), out)
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_mask_v4.png"), mask)
    dbg = img.copy()
    for b in boxes:
        cv2.rectangle(dbg, (b.x, b.y), (b.x + b.w, b.y + b.h), (0, 170, 0), 1)
    cv2.imwrite(str(OUT_DIR / f"{stem}_ocr_boxes_v4.png"), dbg)
    payload = [{"x": b.x, "y": b.y, "w": b.w, "h": b.h, "conf": b.conf, "text": b.text} for b in boxes]
    (OUT_DIR / f"{stem}_ocr_boxes_v4.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process("it_floor1_split_locked.png")
    process("it_floor2_split_locked.png")
    print(f"Wrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
