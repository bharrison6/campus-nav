from __future__ import annotations

from pathlib import Path
import re

import cv2
import fitz
import numpy as np
from PIL import Image
import pytesseract


ROOT = Path(__file__).resolve().parents[2]
INPUT_PDF = ROOT / "Maps" / "IT Floor Plan.pdf"
OUT_DIR = ROOT / "Maps" / "it-floor-split-review"
TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")

# Known anchors for side validation:
# upper/floor-2 anchor in 2xx region; lower/floor-1 anchor in 1xx region.
UPPER_ANCHOR = (2350, 1900)  # (x, y) in full-res render
LOWER_ANCHOR = (2500, 4700)


def render_first_page(pdf_path: Path, dpi: int = 600) -> np.ndarray:
    doc = fitz.open(pdf_path)
    page = doc[0]
    mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)


def find_whitespace_seam(gray: np.ndarray, scale: int = 6) -> np.ndarray:
    small = cv2.resize(gray, (gray.shape[1] // scale, gray.shape[0] // scale), interpolation=cv2.INTER_AREA)
    ink = (small < 228).astype(np.uint8)
    dist = cv2.distanceTransform(255 - (ink * 255), cv2.DIST_L2, 3)
    h, w = ink.shape

    # Base traversal cost: large penalty on ink, low in whitespace, plus near-ink penalty.
    base = np.full((h, w), 1.0, dtype=np.float64)
    base += np.where(ink > 0, 9000.0, 0.0)
    base += 40.0 / (dist + 1.0)

    # Encourage seam to run through central whitespace band between floors.
    y0 = int(h * 0.47)
    y1 = int(h * 0.58)
    y_pref = np.linspace(y0, y1, w, dtype=np.float64)
    yy = np.arange(h, dtype=np.float64)[:, None]
    base += 0.004 * np.abs(yy - y_pref[None, :]) ** 2

    dp = np.full((h, w), np.inf, dtype=np.float64)
    prev = np.zeros((h, w), dtype=np.int16)
    dp[:, 0] = base[:, 0]
    prev[:, 0] = np.arange(h, dtype=np.int16)

    for x in range(1, w):
        for y in range(h):
            best_cost = np.inf
            best_py = y
            for py in (y - 1, y, y + 1):
                if py < 0 or py >= h:
                    continue
                smooth_pen = 1.8 * abs(y - py)
                cand = dp[py, x - 1] + smooth_pen
                if cand < best_cost:
                    best_cost = cand
                    best_py = py
            dp[y, x] = base[y, x] + best_cost
            prev[y, x] = best_py

    y_end = int(np.argmin(dp[:, -1]))
    seam_small = np.zeros((w,), dtype=np.int32)
    seam_small[w - 1] = y_end
    for x in range(w - 1, 0, -1):
        seam_small[x - 1] = int(prev[seam_small[x], x])

    # Upsample seam back to full-res x-axis.
    xs_full = np.arange(gray.shape[1], dtype=np.int32)
    xs_small = np.linspace(0, gray.shape[1] - 1, w)
    seam_full = np.interp(xs_full, xs_small, seam_small.astype(np.float64) * scale).astype(np.int32)
    seam_full = np.clip(seam_full, 0, gray.shape[0] - 1)
    return seam_full


def split_by_seam(img: np.ndarray, seam_y_by_x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    h, w = img.shape[:2]
    yy = np.arange(h, dtype=np.int32)[:, None]
    seam_row = seam_y_by_x[None, :]

    upper_mask = (yy < seam_row).astype(np.uint8) * 255
    lower_mask = (yy >= seam_row).astype(np.uint8) * 255

    upper = np.full_like(img, 255)
    lower = np.full_like(img, 255)
    upper[upper_mask > 0] = img[upper_mask > 0]
    lower[lower_mask > 0] = img[lower_mask > 0]
    return upper, lower


def component_rect_gap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    dx = 0.0
    if ax1 < bx0:
        dx = float(bx0 - ax1)
    elif bx1 < ax0:
        dx = float(ax0 - bx1)
    dy = 0.0
    if ay1 < by0:
        dy = float(by0 - ay1)
    elif by1 < ay0:
        dy = float(ay0 - by1)
    return (dx * dx + dy * dy) ** 0.5


def hybrid_component_refine(img: np.ndarray, seam: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ink = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY_INV)[1]
    h, w = gray.shape
    yy = np.arange(h, dtype=np.int32)[:, None]
    seam_row = seam[None, :]
    upper_side = (yy < seam_row)
    lower_side = ~upper_side

    n, lab, st, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    upper_counts = np.bincount(lab[upper_side].ravel(), minlength=n)
    lower_counts = np.bincount(lab[lower_side].ravel(), minlength=n)
    comps = []
    for i in range(1, n):
        x, y, cw, ch, a = map(int, st[i])
        if a < 12:
            continue
        up_count = int(upper_counts[i])
        lo_count = int(lower_counts[i])
        side = 0 if up_count >= lo_count else 1  # 0=upper, 1=lower
        comps.append((i, x, y, x + cw, y + ch, a, up_count, lo_count, side))

    # Base assignment from seam side majority.
    upper_ids = {c[0] for c in comps if c[8] == 0}
    lower_ids = {c[0] for c in comps if c[8] == 1}

    # Refine: move small detached islands to the side whose largest core they are closer to.
    upper_large = [c for c in comps if c[0] in upper_ids and c[5] > 18000]
    lower_large = [c for c in comps if c[0] in lower_ids and c[5] > 18000]
    if upper_large and lower_large:
        upper_core = max(upper_large, key=lambda c: c[5])
        lower_core = max(lower_large, key=lambda c: c[5])
        urect = (upper_core[1], upper_core[2], upper_core[3], upper_core[4])
        lrect = (lower_core[1], lower_core[2], lower_core[3], lower_core[4])
        for c in comps:
            idx, x0, y0, x1, y1, area, _, _, side = c
            if area > 14000:
                continue
            rect = (x0, y0, x1, y1)
            du = component_rect_gap(rect, urect)
            dl = component_rect_gap(rect, lrect)
            if side == 0 and dl + 40.0 < du:
                upper_ids.discard(idx)
                lower_ids.add(idx)
            elif side == 1 and du + 40.0 < dl:
                lower_ids.discard(idx)
                upper_ids.add(idx)

    # Semantic refinement: room-number OCR vote for ambiguous/misleading islands.
    gray_for_ocr = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    for c in comps:
        idx, x0, y0, x1, y1, area, _, _, side = c
        if area < 7000 or area > 180000:
            continue
        crop = gray_for_ocr[max(0, y0 - 6) : min(gray_for_ocr.shape[0], y1 + 6), max(0, x0 - 6) : min(gray_for_ocr.shape[1], x1 + 6)]
        if crop.size == 0:
            continue
        ocr_img = cv2.threshold(crop, 215, 255, cv2.THRESH_BINARY)[1]
        text = pytesseract.image_to_string(ocr_img, config="--oem 3 --psm 6 -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
        t = text.replace("\n", " ")
        c1 = len(re.findall(r"\b1\d{2}[A-Z]?\b", t))
        c2 = len(re.findall(r"\b2\d{2}[A-Z]?\b", t))
        c3 = len(re.findall(r"\b3\d{2}[A-Z]?\b", t))
        # Lower floor should carry 1xx-heavy components; upper should carry 2xx/3xx-heavy.
        if c1 >= 2 and c1 > (c2 + c3):
            upper_ids.discard(idx)
            lower_ids.add(idx)
        elif (c2 + c3) >= 2 and (c2 + c3) > c1:
            lower_ids.discard(idx)
            upper_ids.add(idx)

    # Deterministic guardrails for this source map:
    # 1) Right detached wing (1xx) belongs with lower floor.
    # 2) Lower text-list fragments also belong with lower floor.
    for c in comps:
        idx, x0, y0, x1, y1, area, _, _, _ = c
        cx = 0.5 * (x0 + x1)
        cy = 0.5 * (y0 + y1)
        in_right_wing_band = (cx > 3000 and 2400 < cy < 4300)
        in_lower_text_band = (cy > 4100 and 1700 < cx < 3400)
        in_loading_dock_band = (2300 < cx < 3600 and 3600 < cy < 4550)
        if in_right_wing_band or in_lower_text_band or in_loading_dock_band:
            upper_ids.discard(idx)
            lower_ids.add(idx)

    upper_mask = (np.isin(lab, np.fromiter(upper_ids, dtype=np.int32))).astype(np.uint8) * 255
    lower_mask = (np.isin(lab, np.fromiter(lower_ids, dtype=np.int32))).astype(np.uint8) * 255

    upper = np.full_like(img, 255)
    lower = np.full_like(img, 255)
    upper[upper_mask > 0] = img[upper_mask > 0]
    lower[lower_mask > 0] = img[lower_mask > 0]

    dbg = img.copy()
    for c in comps:
        idx, x0, y0, x1, y1, area, _, _, _ = c
        if area < 1200:
            continue
        if idx in upper_ids:
            color = (0, 150, 255)
        elif idx in lower_ids:
            color = (255, 130, 0)
        else:
            color = (140, 140, 140)
        cv2.rectangle(dbg, (x0, y0), (x1, y1), color, 1)

    return upper, lower, dbg


def crop_to_content(img: np.ndarray, pad: int = 35) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ink = cv2.threshold(gray, 245, 255, cv2.THRESH_BINARY_INV)[1]
    pts = cv2.findNonZero(ink)
    if pts is None:
        return img.copy()
    x, y, w, h = cv2.boundingRect(pts)
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(img.shape[1], x + w + pad)
    y1 = min(img.shape[0], y + h + pad)
    return img[y0:y1, x0:x1].copy()


def save_png_and_pdf(img_bgr: np.ndarray, png_path: Path, pdf_path: Path) -> None:
    cv2.imwrite(str(png_path), img_bgr)
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    Image.fromarray(rgb).save(str(pdf_path), "PDF", resolution=300.0)


def main() -> None:
    if TESSERACT_EXE.exists():
        pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    full = render_first_page(INPUT_PDF, dpi=600)
    cv2.imwrite(str(OUT_DIR / "it_normal_full_page.png"), full)
    gray = cv2.cvtColor(full, cv2.COLOR_BGR2GRAY)

    seam = find_whitespace_seam(gray, scale=6)
    upper, lower = split_by_seam(full, seam)
    upper, lower, comp_dbg = hybrid_component_refine(full, seam)

    # Final guardrail: move full Loading Dock linework region to lower floor.
    x0, x1 = 2200, 3650
    y0, y1 = 3450, 5100
    lower[y0:y1, x0:x1] = full[y0:y1, x0:x1]
    upper[y0:y1, x0:x1] = 255

    # Validate opposite sides for known anchors; swap if needed.
    ux, uy = UPPER_ANCHOR
    lx, ly = LOWER_ANCHOR
    upper_anchor_in_upper = uy < seam[min(max(ux, 0), seam.shape[0] - 1)]
    lower_anchor_in_lower = ly >= seam[min(max(lx, 0), seam.shape[0] - 1)]
    if not (upper_anchor_in_upper and lower_anchor_in_lower):
        upper, lower = lower, upper

    # Naming per user: lower map is Floor 1, upper map is Floor 2.
    floor1 = crop_to_content(lower)
    floor2 = crop_to_content(upper)

    save_png_and_pdf(floor1, OUT_DIR / "it_floor1_split.png", OUT_DIR / "it_floor1_split.pdf")
    save_png_and_pdf(floor2, OUT_DIR / "it_floor2_split.png", OUT_DIR / "it_floor2_split.pdf")

    dbg = full.copy()
    xs = np.arange(full.shape[1], dtype=np.int32)
    pts = np.stack([xs, seam], axis=1).astype(np.int32).reshape(-1, 1, 2)
    cv2.polylines(dbg, [pts], False, (0, 0, 255), 4)
    cv2.circle(dbg, UPPER_ANCHOR, 10, (0, 160, 0), -1)
    cv2.circle(dbg, LOWER_ANCHOR, 10, (255, 120, 0), -1)
    cv2.putText(dbg, "Cut line", (40, 70), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2, cv2.LINE_AA)
    cv2.putText(dbg, "Upper anchor", (40, 110), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 160, 0), 2, cv2.LINE_AA)
    cv2.putText(dbg, "Lower anchor", (40, 145), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 120, 0), 2, cv2.LINE_AA)
    cv2.imwrite(str(OUT_DIR / "it_split_debug_overlay.png"), dbg)
    cv2.imwrite(str(OUT_DIR / "it_split_component_debug.png"), comp_dbg)
    print(f"Wrote split outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
