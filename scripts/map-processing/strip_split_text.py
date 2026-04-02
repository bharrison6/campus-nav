from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract


ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-review"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed"
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
        if conf < 28:
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


def text_mask(shape: tuple[int, int], boxes: list[Box]) -> np.ndarray:
    h, w = shape
    m = np.zeros((h, w), dtype=np.uint8)
    for b in boxes:
        x0 = max(0, b.x - 6)
        y0 = max(0, b.y - 6)
        x1 = min(w, b.x + b.w + 6)
        y1 = min(h, b.y + b.h + 6)
        cv2.rectangle(m, (x0, y0), (x1, y1), 255, -1)
    m = cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=1)
    return m


def manual_branding_mask(name: str, shape: tuple[int, int]) -> np.ndarray:
    h, w = shape
    m = np.zeros((h, w), dtype=np.uint8)
    rects: list[tuple[int, int, int, int]] = []
    if name == "it_floor1_split.png":
        # COLLINS logo block on left.
        rects.extend(
            [
                (0, int(0.52 * h), int(0.42 * w), int(0.86 * h)),
            ]
        )
    if name == "it_floor2_split.png":
        # Murray State wordmark/shield + bottom leftover text.
        rects.extend(
            [
                (int(0.44 * w), int(0.11 * h), int(0.83 * w), int(0.27 * h)),
                (int(0.08 * w), int(0.88 * h), int(0.68 * w), h),
            ]
        )
    for x0, y0, x1, y1 in rects:
        cv2.rectangle(m, (x0, y0), (x1, y1), 255, -1)
    return m


def strip_text(img: np.ndarray) -> tuple[np.ndarray, np.ndarray, list[Box]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boxes = ocr_boxes(gray)
    mask = text_mask(gray.shape, boxes)
    stripped = img.copy()
    stripped[mask > 0] = (255, 255, 255)
    return stripped, mask, boxes


def process(name: str) -> None:
    src = IN_DIR / name
    img = cv2.imread(str(src))
    if img is None:
        raise FileNotFoundError(str(src))

    stripped, mask, boxes = strip_text(img)
    brand_mask = manual_branding_mask(name, mask.shape)
    if np.any(brand_mask):
        mask = cv2.bitwise_or(mask, brand_mask)
        stripped = img.copy()
        stripped[mask > 0] = (255, 255, 255)

    stem = Path(name).stem
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_removed.png"), stripped)
    cv2.imwrite(str(OUT_DIR / f"{stem}_text_mask.png"), mask)

    dbg = img.copy()
    for b in boxes:
        cv2.rectangle(dbg, (b.x, b.y), (b.x + b.w, b.y + b.h), (0, 170, 0), 1)
    cv2.imwrite(str(OUT_DIR / f"{stem}_ocr_boxes.png"), dbg)

    meta = [
        {"text": b.text, "conf": b.conf, "x": b.x, "y": b.y, "w": b.w, "h": b.h}
        for b in boxes
    ]
    (OUT_DIR / f"{stem}_ocr_boxes.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process("it_floor1_split.png")
    process("it_floor2_split.png")
    print(f"Wrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
