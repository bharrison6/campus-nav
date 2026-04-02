from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract


ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v6"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")


@dataclass
class Box:
    x: int
    y: int
    w: int
    h: int
    conf: float


def structural_lines(gray: np.ndarray) -> np.ndarray:
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    h = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (35, 1)))
    v = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 35)))
    lines = cv2.bitwise_or(h, v)
    raw = cv2.HoughLinesP(inv, 1, np.pi / 180, threshold=50, minLineLength=45, maxLineGap=4)
    if raw is not None:
        for r in raw:
            x1, y1, x2, y2 = map(int, r[0])
            if (x1 - x2) ** 2 + (y1 - y2) ** 2 < 40 * 40:
                continue
            cv2.line(lines, (x1, y1), (x2, y2), 255, 1, cv2.LINE_AA)
    return cv2.dilate(lines, np.ones((2, 2), np.uint8), iterations=1)


def ocr_boxes_highres(gray: np.ndarray) -> list[Box]:
    scale = 2
    big = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    big = cv2.threshold(big, 210, 255, cv2.THRESH_BINARY)[1]
    boxes: list[Box] = []
    for psm in (6, 11, 12, 13):
        data = pytesseract.image_to_data(
            big,
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
            x = int(data["left"][i] / scale)
            y = int(data["top"][i] / scale)
            w = max(1, int(data["width"][i] / scale))
            h = max(1, int(data["height"][i] / scale))
            boxes.append(Box(x=x, y=y, w=w, h=h, conf=conf))
    # de-dup by center
    seen: set[tuple[int, int]] = set()
    uniq: list[Box] = []
    for b in boxes:
        key = (int((b.x + b.w * 0.5) // 3), int((b.y + b.h * 0.5) // 3))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(b)
    return uniq


def branding_rects(name: str, h: int, w: int) -> list[tuple[int, int, int, int]]:
    if "floor1" in name:
        return [
            (0, int(0.50 * h), int(0.45 * w), int(0.90 * h)),
            (int(0.84 * w), int(0.93 * h), w, h),
        ]
    return [
        (int(0.42 * w), int(0.08 * h), int(0.90 * w), int(0.31 * h)),
        (int(0.04 * w), int(0.88 * h), int(0.80 * w), h),
        (int(0.76 * w), int(0.20 * h), w, int(0.44 * h)),
    ]


def remove_text(img: np.ndarray, name: str) -> tuple[np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    inv = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)[1]
    lines = structural_lines(gray)
    boxes = ocr_boxes_highres(gray)
    h, w = gray.shape

    mask = np.zeros_like(inv)

    for b in boxes:
        x0 = max(0, b.x - 2)
        y0 = max(0, b.y - 2)
        x1 = min(w, b.x + b.w + 2)
        y1 = min(h, b.y + b.h + 2)
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
            if ra <= 820 and rw <= 60 and rh <= 60:
                gx0, gy0 = x0 + rx, y0 + ry
                comp = (lab == i)[ry : ry + rh, rx : rx + rw]
                line_roi = lines[gy0 : gy0 + rh, gx0 : gx0 + rw]
                tgt = mask[gy0 : gy0 + rh, gx0 : gx0 + rw]
                tgt[np.logical_and(comp, line_roi == 0)] = 255
                mask[gy0 : gy0 + rh, gx0 : gx0 + rw] = tgt

    for x0, y0, x1, y1 in branding_rects(name, h, w):
        mask[y0:y1, x0:x1] = 255

    out = img.copy()
    out[mask > 0] = (255, 255, 255)
    return out, mask


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("it_floor1_split_locked.png", "it_floor2_split_locked.png"):
        img = cv2.imread(str(IN_DIR / name))
        if img is None:
            continue
        out, mask = remove_text(img, name)
        stem = name.replace("_locked.png", "")
        cv2.imwrite(str(OUT_DIR / f"{stem}_text_removed_v6.png"), out)
        cv2.imwrite(str(OUT_DIR / f"{stem}_mask_v6.png"), mask)
    print(f"Wrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
