from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract


ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v2"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")


@dataclass
class Box:
    text: str
    conf: float
    x: int
    y: int
    w: int
    h: int


def ocr_boxes(gray: np.ndarray) -> list[Box]:
    data = pytesseract.image_to_data(
        gray,
        output_type=pytesseract.Output.DICT,
        config="--oem 3 --psm 6",
    )
    out: list[Box] = []
    for i, raw in enumerate(data["text"]):
        txt = (raw or "").strip()
        if not txt:
            continue
        try:
            conf = float(data["conf"][i])
        except ValueError:
            conf = -1.0
        if conf < 30:
            continue
        out.append(
            Box(
                text=txt,
                conf=conf,
                x=int(data["left"][i]),
                y=int(data["top"][i]),
                w=int(data["width"][i]),
                h=int(data["height"][i]),
            )
        )
    return out


def line_mask(gray: np.ndarray) -> np.ndarray:
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    lines = np.zeros_like(inv)

    # Horizontal and vertical wall-like segments.
    k_h = cv2.getStructuringElement(cv2.MORPH_RECT, (31, 1))
    k_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 31))
    h = cv2.morphologyEx(inv, cv2.MORPH_OPEN, k_h)
    v = cv2.morphologyEx(inv, cv2.MORPH_OPEN, k_v)
    lines = cv2.bitwise_or(h, v)

    # Long diagonals/connectors.
    raw = cv2.HoughLinesP(inv, 1, np.pi / 180, threshold=45, minLineLength=26, maxLineGap=3)
    if raw is not None:
        for r in raw:
            x1, y1, x2, y2 = map(int, r[0])
            if (x1 - x2) ** 2 + (y1 - y2) ** 2 < 22 * 22:
                continue
            cv2.line(lines, (x1, y1), (x2, y2), 255, 1, cv2.LINE_AA)

    lines = cv2.dilate(lines, np.ones((2, 2), np.uint8), iterations=1)
    return lines


def text_mask(shape: tuple[int, int], boxes: list[Box], file_name: str) -> np.ndarray:
    h, w = shape
    m = np.zeros((h, w), dtype=np.uint8)
    for b in boxes:
        # Keep padding tight to avoid cutting walls.
        x0 = max(0, b.x - 3)
        y0 = max(0, b.y - 3)
        x1 = min(w, b.x + b.w + 3)
        y1 = min(h, b.y + b.h + 3)
        cv2.rectangle(m, (x0, y0), (x1, y1), 255, -1)

    # Explicit branding masks.
    if "floor1" in file_name:
        cv2.rectangle(m, (0, int(0.52 * h)), (int(0.43 * w), int(0.88 * h)), 255, -1)
    if "floor2" in file_name:
        cv2.rectangle(m, (int(0.45 * w), int(0.10 * h)), (int(0.84 * w), int(0.27 * h)), 255, -1)
        cv2.rectangle(m, (int(0.08 * w), int(0.90 * h)), (int(0.70 * w), h), 255, -1)
    return m


def remove_text_preserve_lines(img: np.ndarray, file_name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[Box]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boxes = ocr_boxes(gray)
    tmask = text_mask(gray.shape, boxes, file_name)
    lmask = line_mask(gray)

    out = img.copy()
    out[tmask > 0] = (255, 255, 255)

    # Restore linework if text mask removed it.
    restore = (tmask > 0) & (lmask > 0)
    out[restore] = img[restore]
    return out, tmask, lmask, boxes


def process(file_name: str) -> None:
    src = IN_DIR / file_name
    img = cv2.imread(str(src))
    if img is None:
        raise FileNotFoundError(str(src))

    cleaned, tmask, lmask, boxes = remove_text_preserve_lines(img, file_name)
    stem = Path(file_name).stem.replace("_locked", "")

    cv2.imwrite(str(OUT_DIR / f"{stem}_text_removed_v2.png"), cleaned)
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_mask_v2.png"), tmask)
    cv2.imwrite(str(OUT_DIR / f"{stem}_line_mask_v2.png"), lmask)

    dbg = img.copy()
    for b in boxes:
        cv2.rectangle(dbg, (b.x, b.y), (b.x + b.w, b.y + b.h), (0, 170, 0), 1)
    cv2.imwrite(str(OUT_DIR / f"{stem}_ocr_boxes_v2.png"), dbg)

    payload = [{"text": b.text, "conf": b.conf, "x": b.x, "y": b.y, "w": b.w, "h": b.h} for b in boxes]
    (OUT_DIR / f"{stem}_ocr_boxes_v2.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process("it_floor1_split_locked.png")
    process("it_floor2_split_locked.png")
    print(f"Wrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
