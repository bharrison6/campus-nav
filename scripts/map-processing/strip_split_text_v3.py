from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract


ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v3"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")


@dataclass
class Box:
    x: int
    y: int
    w: int
    h: int
    text: str
    conf: float


def ocr_boxes(gray: np.ndarray) -> list[Box]:
    boxes: list[Box] = []
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
            if conf < 5:
                continue
            boxes.append(
                Box(
                    x=int(data["left"][i]),
                    y=int(data["top"][i]),
                    w=int(data["width"][i]),
                    h=int(data["height"][i]),
                    text=txt,
                    conf=conf,
                )
            )
    # de-dup roughly by center point
    uniq: list[Box] = []
    seen: set[tuple[int, int]] = set()
    for b in boxes:
        key = (int((b.x + b.w * 0.5) // 4), int((b.y + b.h * 0.5) // 4))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(b)
    return uniq


def structural_line_mask(gray: np.ndarray) -> np.ndarray:
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    h = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (45, 1)))
    v = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 45)))
    line = cv2.bitwise_or(h, v)
    raw = cv2.HoughLinesP(inv, 1, np.pi / 180, threshold=60, minLineLength=70, maxLineGap=4)
    if raw is not None:
        for r in raw:
            x1, y1, x2, y2 = map(int, r[0])
            if (x1 - x2) ** 2 + (y1 - y2) ** 2 < 70 * 70:
                continue
            cv2.line(line, (x1, y1), (x2, y2), 255, 1, cv2.LINE_AA)
    return cv2.dilate(line, np.ones((2, 2), np.uint8), iterations=1)


def branding_mask(name: str, h: int, w: int) -> np.ndarray:
    m = np.zeros((h, w), dtype=np.uint8)
    if "floor1" in name:
        cv2.rectangle(m, (0, int(0.50 * h)), (int(0.43 * w), int(0.90 * h)), 255, -1)
    if "floor2" in name:
        cv2.rectangle(m, (int(0.40 * w), int(0.09 * h)), (int(0.88 * w), int(0.30 * h)), 255, -1)
        cv2.rectangle(m, (int(0.04 * w), int(0.88 * h)), (int(0.74 * w), h), 255, -1)
    return m


def char_component_mask(gray: np.ndarray, keep_line: np.ndarray) -> np.ndarray:
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    n, lab, st, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    mask = np.zeros_like(inv)
    for i in range(1, n):
        x, y, w, h, a = map(int, st[i])
        if a < 6:
            continue
        # text-like small blobs; avoid obvious long wall segments
        long_h = w >= 26 and h <= 3
        long_v = h >= 26 and w <= 3
        if long_h or long_v:
            continue
        if a <= 700 and w <= 55 and h <= 55:
            # if this region is mostly not structural line, treat as text/blob
            region = keep_line[y : y + h, x : x + w]
            if region.size == 0:
                continue
            line_ratio = float((region > 0).sum()) / float(region.size)
            if line_ratio < 0.40:
                mask[lab == i] = 255
    return mask


def text_mask(gray: np.ndarray, name: str) -> tuple[np.ndarray, np.ndarray, list[Box], np.ndarray]:
    h, w = gray.shape
    boxes = ocr_boxes(gray)
    lmask = structural_line_mask(gray)

    m_ocr_char = np.zeros((h, w), dtype=np.uint8)
    for b in boxes:
        x0 = max(0, b.x - 4)
        y0 = max(0, b.y - 4)
        x1 = min(w, b.x + b.w + 4)
        y1 = min(h, b.y + b.h + 4)
        cv2.rectangle(m_ocr_char, (x0, y0), (x1, y1), 255, -1)

    m_ocr_char = cv2.bitwise_or(m_ocr_char, char_component_mask(gray, lmask))
    m_brand = branding_mask(name, h, w)
    return m_ocr_char, m_brand, boxes, lmask


def process(file_name: str) -> None:
    src = IN_DIR / file_name
    img = cv2.imread(str(src))
    if img is None:
        raise FileNotFoundError(str(src))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    m_ocr_char, m_brand, boxes, lmask = text_mask(gray, file_name)
    tmask = cv2.bitwise_or(m_ocr_char, m_brand)
    out = img.copy()
    out[tmask > 0] = (255, 255, 255)
    # restore strong structure through removed areas
    restore = (m_ocr_char > 0) & (lmask > 0) & (m_brand == 0)
    out[restore] = img[restore]

    stem = Path(file_name).stem.replace("_locked", "")
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_removed_v3.png"), out)
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_mask_v3.png"), tmask)
    cv2.imwrite(str(OUT_DIR / f"{stem}_line_mask_v3.png"), lmask)

    dbg = img.copy()
    for b in boxes:
        cv2.rectangle(dbg, (b.x, b.y), (b.x + b.w, b.y + b.h), (0, 180, 0), 1)
    cv2.imwrite(str(OUT_DIR / f"{stem}_ocr_boxes_v3.png"), dbg)
    payload = [{"x": b.x, "y": b.y, "w": b.w, "h": b.h, "text": b.text, "conf": b.conf} for b in boxes]
    (OUT_DIR / f"{stem}_ocr_boxes_v3.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process("it_floor1_split_locked.png")
    process("it_floor2_split_locked.png")
    print(f"Wrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
