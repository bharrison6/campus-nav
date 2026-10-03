from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract


ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v5"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")


@dataclass
class OcrBox:
    x: int
    y: int
    w: int
    h: int
    conf: float
    text: str


def ocr_boxes(gray: np.ndarray) -> list[OcrBox]:
    boxes: list[OcrBox] = []
    for psm in (6, 11, 12, 13):
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
            if conf < 0:
                continue
            boxes.append(
                OcrBox(
                    x=int(data["left"][i]),
                    y=int(data["top"][i]),
                    w=int(data["width"][i]),
                    h=int(data["height"][i]),
                    conf=conf,
                    text=txt,
                )
            )
    # de-dup by center bucket
    seen: set[tuple[int, int]] = set()
    uniq: list[OcrBox] = []
    for b in boxes:
        key = (int((b.x + b.w * 0.5) // 4), int((b.y + b.h * 0.5) // 4))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(b)
    return uniq


def structural_line_mask(gray: np.ndarray) -> np.ndarray:
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    h = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (35, 1)))
    v = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 35)))
    lines = cv2.bitwise_or(h, v)
    raw = cv2.HoughLinesP(inv, 1, np.pi / 180, threshold=55, minLineLength=45, maxLineGap=4)
    if raw is not None:
        for r in raw:
            x1, y1, x2, y2 = map(int, r[0])
            if (x1 - x2) ** 2 + (y1 - y2) ** 2 < 40 * 40:
                continue
            cv2.line(lines, (x1, y1), (x2, y2), 255, 1, cv2.LINE_AA)
    return cv2.dilate(lines, np.ones((2, 2), np.uint8), iterations=1)


def external_brand_masks(name: str, h: int, w: int) -> list[tuple[int, int, int, int]]:
    # deterministic non-floor text cleanup regions only
    if "floor1" in name:
        return [
            (0, int(0.50 * h), int(0.44 * w), int(0.90 * h)),  # COLLINS block
            (int(0.86 * w), int(0.93 * h), w, h),  # footer rev
        ]
    return [
        (int(0.43 * w), int(0.09 * h), int(0.88 * w), int(0.30 * h)),  # MURRAY STATE wordmark area
        (int(0.04 * w), int(0.88 * h), int(0.76 * w), h),  # MARTHA LAYN remnant area
        (int(0.78 * w), int(0.22 * h), w, int(0.42 * h)),  # trailing "E" area
    ]


def remove_text_components(img: np.ndarray, file_name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[OcrBox]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    lines = structural_line_mask(gray)
    boxes = ocr_boxes(gray)

    remove = np.zeros_like(inv)

    # OCR guided component removal (only inside OCR windows)
    for b in boxes:
        x0 = max(0, b.x - 2)
        y0 = max(0, b.y - 2)
        x1 = min(gray.shape[1], b.x + b.w + 2)
        y1 = min(gray.shape[0], b.y + b.h + 2)
        roi = inv[y0:y1, x0:x1]
        if roi.size == 0:
            continue
        n, lab, st, _ = cv2.connectedComponentsWithStats(roi, connectivity=8)
        for i in range(1, n):
            rx, ry, rw, rh, ra = map(int, st[i])
            if ra < 3:
                continue
            long_h = rw >= 26 and rh <= 3
            long_v = rh >= 26 and rw <= 3
            if long_h or long_v:
                continue
            # treat likely glyph components as removable
            if ra <= 700 and rw <= 52 and rh <= 52:
                gx0, gy0 = x0 + rx, y0 + ry
                comp_mask = (lab == i)[ry : ry + rh, rx : rx + rw]
                # keep strong lines even inside OCR boxes
                line_roi = lines[gy0 : gy0 + rh, gx0 : gx0 + rw]
                rr = remove[gy0 : gy0 + rh, gx0 : gx0 + rw]
                rr[np.logical_and(comp_mask, line_roi == 0)] = 255
                remove[gy0 : gy0 + rh, gx0 : gx0 + rw] = rr

    # Explicit external branding masks
    h, w = gray.shape
    for x0, y0, x1, y1 in external_brand_masks(file_name, h, w):
        remove[y0:y1, x0:x1] = 255

    out = img.copy()
    out[remove > 0] = (255, 255, 255)
    return out, remove, lines, boxes


def process(file_name: str) -> None:
    src = IN_DIR / file_name
    img = cv2.imread(str(src))
    if img is None:
        raise FileNotFoundError(str(src))
    out, rmask, lmask, boxes = remove_text_components(img, file_name)

    stem = Path(file_name).stem.replace("_locked", "")
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_removed_v5.png"), out)
    cv2.imwrite(str(OUT_DIR / f"{stem}_remove_mask_v5.png"), rmask)
    cv2.imwrite(str(OUT_DIR / f"{stem}_line_mask_v5.png"), lmask)

    dbg = img.copy()
    for b in boxes:
        cv2.rectangle(dbg, (b.x, b.y), (b.x + b.w, b.y + b.h), (0, 170, 0), 1)
    cv2.imwrite(str(OUT_DIR / f"{stem}_ocr_boxes_v5.png"), dbg)
    (OUT_DIR / f"{stem}_ocr_boxes_v5.json").write_text(
        json.dumps([b.__dict__ for b in boxes], indent=2),
        encoding="utf-8",
    )


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process("it_floor1_split_locked.png")
    process("it_floor2_split_locked.png")
    print(f"Wrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
