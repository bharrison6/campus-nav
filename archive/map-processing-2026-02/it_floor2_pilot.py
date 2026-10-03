from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Tuple

import cv2
import fitz
import numpy as np
import pytesseract
import svgwrite
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
INPUT_PDF = ROOT / "Maps" / "IT Floor Plan for EDay 2022docx.pdf"
OUT_DIR = ROOT / "Maps" / "pilot-it-floor2"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")


@dataclass
class OcrBox:
    text: str
    conf: float
    x: int
    y: int
    w: int
    h: int


def ensure_dirs() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)


def render_pdf_page(pdf_path: Path, page_index: int = 0, dpi: int = 400) -> np.ndarray:
    doc = fitz.open(pdf_path)
    page = doc[page_index]
    mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    data = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    return cv2.cvtColor(data, cv2.COLOR_RGB2BGR)


def split_floor_image(page_img: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(page_img, cv2.COLOR_BGR2GRAY)
    bin_inv = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY_INV)[1]
    row_energy = bin_inv.sum(axis=1)
    h = row_energy.shape[0]
    mid_lo = int(h * 0.30)
    mid_hi = int(h * 0.70)
    valley = int(np.argmin(row_energy[mid_lo:mid_hi]) + mid_lo)
    top = page_img[:valley, :]
    bottom = page_img[valley:, :]
    return top, bottom


def crop_to_content(img: np.ndarray, margin: int = 24) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = cv2.threshold(gray, 245, 255, cv2.THRESH_BINARY_INV)[1]
    points = cv2.findNonZero(mask)
    if points is None:
        return img
    x, y, w, h = cv2.boundingRect(points)
    x0 = max(0, x - margin)
    y0 = max(0, y - margin)
    x1 = min(img.shape[1], x + w + margin)
    y1 = min(img.shape[0], y + h + margin)
    return img[y0:y1, x0:x1].copy()


def isolate_floorplan_region(img: np.ndarray, margin: int = 24) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    inv = cv2.threshold(gray, 232, 255, cv2.THRESH_BINARY_INV)[1]
    inv = cv2.morphologyEx(inv, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8), iterations=2)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    best_idx = -1
    best_score = -1.0
    h, w = gray.shape
    for i in range(1, num):
        x, y, bw, bh, area = stats[i]
        if area < 25000:
            continue
        if bw < int(w * 0.12) or bh < int(h * 0.25):
            continue
        density = area / float(max(1, bw * bh))
        # Prefer large tall/rectangular regions (actual floor plan body).
        score = area * (1.0 + density)
        if score > best_score:
            best_idx = i
            best_score = score
    if best_idx < 0:
        return crop_to_content(img, margin=margin)
    x, y, bw, bh, _ = stats[best_idx]
    x0 = max(0, x - margin)
    y0 = max(0, y - margin)
    x1 = min(w, x + bw + margin)
    y1 = min(h, y + bh + margin)
    return img[y0:y1, x0:x1].copy()


def tesseract_boxes(gray_img: np.ndarray, psm: int = 6) -> List[OcrBox]:
    data = pytesseract.image_to_data(
        gray_img,
        output_type=pytesseract.Output.DICT,
        config=f"--oem 3 --psm {psm}",
    )
    boxes: List[OcrBox] = []
    for i, text in enumerate(data["text"]):
        txt = (text or "").strip()
        if not txt:
            continue
        try:
            conf = float(data["conf"][i])
        except ValueError:
            conf = -1.0
        if conf < 35:
            continue
        boxes.append(
            OcrBox(
                text=txt,
                conf=conf,
                x=int(data["left"][i]),
                y=int(data["top"][i]),
                w=int(data["width"][i]),
                h=int(data["height"][i]),
            )
        )
    return boxes


def build_text_mask(shape: Tuple[int, int], boxes: Iterable[OcrBox], pad: int = 10) -> np.ndarray:
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    for b in boxes:
        x0 = max(0, b.x - pad)
        y0 = max(0, b.y - pad)
        x1 = min(w, b.x + b.w + pad)
        y1 = min(h, b.y + b.h + pad)
        cv2.rectangle(mask, (x0, y0), (x1, y1), 255, -1)
    return mask


def strip_text(img: np.ndarray) -> Tuple[np.ndarray, np.ndarray, List[OcrBox]]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boxes = tesseract_boxes(gray, psm=6)
    mask = build_text_mask(gray.shape, boxes, pad=12)
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=1)
    cleaned = img.copy()
    cleaned[mask > 0] = (255, 255, 255)
    return cleaned, mask, boxes


def preprocess_for_lines(img: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    den = cv2.bilateralFilter(gray, 9, 50, 50)
    bw = cv2.adaptiveThreshold(
        den, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 41, 7
    )
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=1)
    bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8), iterations=1)
    return bw


def snap_line(x1: int, y1: int, x2: int, y2: int, deg_thresh: float = 10.0) -> Tuple[int, int, int, int]:
    dx = x2 - x1
    dy = y2 - y1
    angle = abs(math.degrees(math.atan2(dy, dx)))
    if angle <= deg_thresh or angle >= (180.0 - deg_thresh):
        y = int(round((y1 + y2) / 2.0))
        return x1, y, x2, y
    if abs(angle - 90.0) <= deg_thresh:
        x = int(round((x1 + x2) / 2.0))
        return x, y1, x, y2
    return x1, y1, x2, y2


def estimate_width_class(binary_inv: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> float:
    dt = cv2.distanceTransform(binary_inv, cv2.DIST_L2, 3)
    mx = int(round((x1 + x2) / 2.0))
    my = int(round((y1 + y2) / 2.0))
    my = max(0, min(binary_inv.shape[0] - 1, my))
    mx = max(0, min(binary_inv.shape[1] - 1, mx))
    w_est = max(1.0, 2.0 * float(dt[my, mx]))
    if w_est < 2.2:
        return 1.0
    if w_est < 4.0:
        return 1.8
    return 2.8


def detect_lines(binary_inv: np.ndarray) -> List[Tuple[int, int, int, int, float]]:
    raw = cv2.HoughLinesP(
        binary_inv,
        rho=1,
        theta=np.pi / 180,
        threshold=16,
        minLineLength=8,
        maxLineGap=2,
    )
    if raw is None:
        return []
    lines: List[Tuple[int, int, int, int, float]] = []
    for r in raw:
        x1, y1, x2, y2 = map(int, r[0])
        length = math.hypot(x2 - x1, y2 - y1)
        if length < 12:
            continue
        sx1, sy1, sx2, sy2 = snap_line(x1, y1, x2, y2)
        sw = estimate_width_class(binary_inv, sx1, sy1, sx2, sy2)
        lines.append((sx1, sy1, sx2, sy2, sw))
    return lines


def detect_contour_segments(binary_inv: np.ndarray) -> List[Tuple[int, int, int, int, float]]:
    contours, _ = cv2.findContours(binary_inv, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return []
    dt = cv2.distanceTransform(binary_inv, cv2.DIST_L2, 3)
    segs: List[Tuple[int, int, int, int, float]] = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < 12:
            continue
        epsilon = 1.0
        approx = cv2.approxPolyDP(c, epsilon, closed=True)
        pts = approx.reshape(-1, 2)
        if pts.shape[0] < 2:
            continue
        for i in range(pts.shape[0]):
            x1, y1 = map(int, pts[i])
            x2, y2 = map(int, pts[(i + 1) % pts.shape[0]])
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 6:
                continue
            sx1, sy1, sx2, sy2 = snap_line(x1, y1, x2, y2, deg_thresh=12.0)
            mx = max(0, min(binary_inv.shape[1] - 1, int(round((sx1 + sx2) / 2.0))))
            my = max(0, min(binary_inv.shape[0] - 1, int(round((sy1 + sy2) / 2.0))))
            w_est = max(1.0, 2.0 * float(dt[my, mx]))
            if w_est < 2.0:
                sw = 1.0
            elif w_est < 3.8:
                sw = 1.8
            else:
                sw = 2.8
            segs.append((sx1, sy1, sx2, sy2, sw))
    return segs


def merge_duplicate_lines(lines: List[Tuple[int, int, int, int, float]]) -> List[Tuple[int, int, int, int, float]]:
    seen = set()
    merged: List[Tuple[int, int, int, int, float]] = []
    for x1, y1, x2, y2, w in lines:
        key = tuple(sorted(((x1, y1), (x2, y2))))
        if key in seen:
            continue
        seen.add(key)
        merged.append((x1, y1, x2, y2, w))
    return merged


BANNED_TEXT_PATTERNS = [
    r"murray",
    r"state",
    r"logo",
    r"mezz",
    r"third",
    r"floor\s*3",
]


def keep_label(text: str) -> bool:
    t = text.strip()
    if not t:
        return False
    if len(t) == 1 and not t.isdigit():
        return False
    for pat in BANNED_TEXT_PATTERNS:
        if re.search(pat, t, flags=re.IGNORECASE):
            return False
    if re.fullmatch(r"[-_=]+", t):
        return False
    return True


def font_size_for_text(text: str) -> int:
    if re.fullmatch(r"[A-Za-z]?\d{3,4}[A-Za-z]?", text):
        return 18
    if re.fullmatch(r"\d{1,2}", text):
        return 16
    return 13


def render_svg(
    width: int,
    height: int,
    lines: List[Tuple[int, int, int, int, float]],
    labels: List[OcrBox],
    out_path: Path,
    with_text: bool,
) -> None:
    dwg = svgwrite.Drawing(str(out_path), size=(width, height))
    dwg.viewbox(0, 0, width, height)
    dwg.add(dwg.rect(insert=(0, 0), size=(width, height), fill="white"))

    for x1, y1, x2, y2, sw in lines:
        dwg.add(
            dwg.line(
                start=(x1, y1),
                end=(x2, y2),
                stroke="#111111",
                stroke_width=sw,
                stroke_linecap="round",
            )
        )

    if with_text:
        for b in labels:
            if not keep_label(b.text):
                continue
            x = b.x + 1
            y = b.y + b.h - 1
            fs = font_size_for_text(b.text)
            dwg.add(
                dwg.text(
                    b.text,
                    insert=(x, y),
                    fill="#111111",
                    font_size=fs,
                    font_family="Arial, Helvetica, sans-serif",
                    font_weight="700" if fs >= 16 else "500",
                )
            )

    dwg.save()


def render_lines_preview(
    width: int, height: int, lines: List[Tuple[int, int, int, int, float]]
) -> np.ndarray:
    canvas = np.full((height, width, 3), 255, dtype=np.uint8)
    for x1, y1, x2, y2, sw in lines:
        cv2.line(canvas, (x1, y1), (x2, y2), (20, 20, 20), max(1, int(round(sw))))
    return canvas


def render_text_preview(base: np.ndarray, labels: List[OcrBox]) -> np.ndarray:
    canvas = base.copy()
    font = cv2.FONT_HERSHEY_SIMPLEX
    for b in labels:
        if not keep_label(b.text):
            continue
        fs = font_size_for_text(b.text)
        scale = 0.38 if fs <= 13 else 0.55
        thickness = 1 if fs <= 13 else 2
        cv2.putText(
            canvas,
            b.text,
            (b.x, b.y + b.h),
            font,
            scale,
            (20, 20, 20),
            thickness,
            cv2.LINE_AA,
        )
    return canvas


def save_side_by_side(images: List[np.ndarray], captions: List[str], out_path: Path) -> None:
    pil_images = []
    for img in images:
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        pil_images.append(Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
    max_h = max(i.height for i in pil_images)
    cap_h = 36
    total_w = sum(i.width for i in pil_images)
    board = Image.new("RGB", (total_w, max_h + cap_h), (255, 255, 255))
    draw = ImageDraw.Draw(board)
    x = 0
    for i, cap in zip(pil_images, captions):
        board.paste(i, (x, cap_h))
        draw.text((x + 8, 8), cap, fill=(25, 25, 25))
        x += i.width
    board.save(out_path)


def select_it_floor2(top: np.ndarray, bottom: np.ndarray) -> np.ndarray:
    top_gray = cv2.cvtColor(top, cv2.COLOR_BGR2GRAY)
    bot_gray = cv2.cvtColor(bottom, cv2.COLOR_BGR2GRAY)
    top_boxes = tesseract_boxes(top_gray, psm=6)
    bot_boxes = tesseract_boxes(bot_gray, psm=6)
    top_text = " ".join([b.text for b in top_boxes]).lower()
    bot_text = " ".join([b.text for b in bot_boxes]).lower()
    if "2" in top_text and "floor" in top_text:
        return top
    if "2" in bot_text and "floor" in bot_text:
        return bottom
    return bottom


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)

    ensure_dirs()
    page = render_pdf_page(INPUT_PDF, dpi=450)
    top, bottom = split_floor_image(page)
    cv2.imwrite(str(OUT_DIR / "it_split_top.png"), top)
    cv2.imwrite(str(OUT_DIR / "it_split_bottom.png"), bottom)

    floor2 = select_it_floor2(top, bottom)
    floor2 = crop_to_content(floor2, margin=18)
    floor2 = isolate_floorplan_region(floor2, margin=18)
    cv2.imwrite(str(OUT_DIR / "it_floor2_original.png"), floor2)

    stripped, text_mask, ocr_boxes = strip_text(floor2)
    cv2.imwrite(str(OUT_DIR / "it_floor2_text_mask.png"), text_mask)
    cv2.imwrite(str(OUT_DIR / "it_floor2_stripped.png"), stripped)

    binary_inv = preprocess_for_lines(stripped)
    cv2.imwrite(str(OUT_DIR / "it_floor2_binary.png"), binary_inv)
    hough_lines = detect_lines(binary_inv)
    contour_lines = detect_contour_segments(binary_inv)
    lines = merge_duplicate_lines(hough_lines + contour_lines)

    h, w = stripped.shape[:2]
    svg_no_text = OUT_DIR / "it_floor2_vector_no_text.svg"
    svg_with_text = OUT_DIR / "it_floor2_vector_with_text.svg"
    render_svg(w, h, lines, ocr_boxes, svg_no_text, with_text=False)
    render_svg(w, h, lines, ocr_boxes, svg_with_text, with_text=True)

    lines_preview = render_lines_preview(w, h, lines)
    cv2.imwrite(str(OUT_DIR / "it_floor2_lines_preview.png"), lines_preview)
    text_readded_preview = render_text_preview(lines_preview, ocr_boxes)
    cv2.imwrite(str(OUT_DIR / "it_floor2_vector_with_text_preview.png"), text_readded_preview)

    text_overlay = floor2.copy()
    for b in ocr_boxes:
        color = (0, 180, 0) if keep_label(b.text) else (0, 0, 220)
        cv2.rectangle(text_overlay, (b.x, b.y), (b.x + b.w, b.y + b.h), color, 1)
    cv2.imwrite(str(OUT_DIR / "it_floor2_ocr_boxes.png"), text_overlay)

    save_side_by_side(
        images=[floor2, stripped, lines_preview, text_readded_preview, text_overlay],
        captions=[
            "Original (IT Floor 2)",
            "Text Stripped",
            "Vector Linework Preview",
            "Vector + Re-added Text Preview",
            "OCR Boxes (green keep / red drop)",
        ],
        out_path=OUT_DIR / "it_floor2_side_by_side.png",
    )

    labels = [
        {
            "text": b.text,
            "conf": b.conf,
            "x": b.x,
            "y": b.y,
            "w": b.w,
            "h": b.h,
            "keep": keep_label(b.text),
        }
        for b in ocr_boxes
    ]
    (OUT_DIR / "it_floor2_ocr_labels.json").write_text(json.dumps(labels, indent=2), encoding="utf-8")
    print(f"Done. Outputs in: {OUT_DIR}")


if __name__ == "__main__":
    main()
