"""
IT floor plan room detection — CV-based room extraction pipeline.

Phases:
  1. Wall skeleton extraction (morphological seed detection + thinning)
  2. Door detection & temporary closure (endpoint pairing)
  3. Room segmentation (flood fill on closed boundaries)
  4. Room labeling via OCR (match to SeedData room numbers)
  5. Feature detection (stairs, hallways, elevators)

Input:  Maps/it-floor-split-backup/it_floor{1,2}_split_locked.png
Output: Maps/it-floor-reproduced/
        - rooms_floor{1,2}.json          (room polygons, labels, features)
        - doors_floor{1,2}.json          (door positions and widths)
        - debug_overlay_floor{1,2}.png   (numbered rooms on original)
        - wall_skeleton_floor{1,2}.png   (extracted wall skeleton)
"""

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

try:
    import pytesseract
    HAS_TESSERACT = True
except ImportError:
    HAS_TESSERACT = False

ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-reproduced"

TESSERACT_EXE = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")

# --- Tunable parameters ---
BINARIZE_THRESH = 200
SEED_LEN_HV = 70          # min wall seed length for H/V lines
SEED_LEN_DIAG = 100       # min wall seed length for diagonal lines
EROSION_ITERS = 2          # erosion iterations for text separation
DOOR_MAX_GAP = 120         # max door opening width in pixels
DOOR_MIN_GAP = 15          # min door opening (smaller = noise)
MIN_ROOM_AREA = 800        # min room area in pixels^2
MIN_ROOM_WIDTH = 20        # min room bounding box dimension
SPUR_MAX_LEN = 12          # max spur length to prune from skeleton
POLY_EPSILON_FACTOR = 0.008  # Douglas-Peucker simplification factor
GAP_BRIDGE_DIST = 8        # max distance to bridge skeleton gaps

# Known room data from SeedData.gs for spatial matching
IT_ROOMS = {
    "floor1": [
        {"id": "room-it-1-121",  "number": "121",  "label": "Materials and Process Lab",             "cx": 505, "cy": 426},
        {"id": "room-it-1-122",  "number": "122",  "label": "Phone Room",                            "cx": 405, "cy": 325},
        {"id": "room-it-1-123",  "number": "123",  "label": "Interior Design Studio",                "cx": 655, "cy": 427},
        {"id": "room-it-1-124",  "number": "124",  "label": "Architectural/Construction Design Lab", "cx": 805, "cy": 428},
        {"id": "room-it-1-125",  "number": "125",  "label": "Engineering Graphics and Design Lab",   "cx": 955, "cy": 429},
        {"id": "room-it-1-126",  "number": "126",  "label": "Emergency Medical Training Lab",        "cx": 1105, "cy": 380},
        {"id": "room-it-1-127",  "number": "127",  "label": "Design and Painting Lab",               "cx": 1255, "cy": 381},
        {"id": "room-it-1-130",  "number": "130",  "label": "Classroom/Student Lounge",              "cx": 704, "cy": 577},
        {"id": "room-it-1-131",  "number": "131",  "label": "OSH Lab",                               "cx": 554, "cy": 576},
        {"id": "room-it-1-132",  "number": "132",  "label": "Classroom",                             "cx": 853, "cy": 628},
        {"id": "room-it-1-133",  "number": "133",  "label": "Industrial Hygiene and Acoustics Lab",  "cx": 703, "cy": 677},
        {"id": "room-it-1-134",  "number": "134",  "label": "Machine Tool Processes",                "cx": 453, "cy": 675},
        {"id": "room-it-1-135",  "number": "135",  "label": "Fire Safety Lab",                       "cx": 354, "cy": 574},
        {"id": "room-it-1-141",  "number": "141",  "label": "Office",                                "cx": 1304, "cy": 461},
        {"id": "room-it-1-142",  "number": "142",  "label": "Office",                                "cx": 1354, "cy": 511},
        {"id": "room-it-1-144",  "number": "144",  "label": "Office",                                "cx": 1404, "cy": 462},
        {"id": "room-it-1-145",  "number": "145",  "label": "Office",                                "cx": 1454, "cy": 512},
        {"id": "room-it-1-146",  "number": "146",  "label": "OSH Training Center",                   "cx": 1204, "cy": 560},
        {"id": "room-it-1-147",  "number": "147",  "label": "Office",                                "cx": 1303, "cy": 611},
        {"id": "room-it-1-148",  "number": "148",  "label": "Office",                                "cx": 1353, "cy": 661},
        {"id": "room-it-1-149",  "number": "149",  "label": "Office",                                "cx": 1403, "cy": 612},
        {"id": "room-it-1-150",  "number": "150",  "label": "Office",                                "cx": 1453, "cy": 662},
        {"id": "room-it-1-153",  "number": "153",  "label": "Office",                                "cx": 1504, "cy": 563},
        {"id": "room-it-1-155",  "number": "155",  "label": "Classroom",                             "cx": 1102, "cy": 760},
        {"id": "room-it-1-156",  "number": "156",  "label": "Classroom",                             "cx": 952, "cy": 759},
        {"id": "room-it-1-157",  "number": "157",  "label": "Office Suite (Chair OSH)",              "cx": 1302, "cy": 811},
        {"id": "room-it-1-161",  "number": "161",  "label": "Office",                                "cx": 1202, "cy": 860},
        {"id": "room-it-1-rr-w", "number": "RR-W", "label": "Women's Restroom",                     "cx": 1004, "cy": 459},
        {"id": "room-it-1-rr-m", "number": "RR-M", "label": "Men's Restroom",                       "cx": 1054, "cy": 459},
    ],
    "floor2": [
        {"id": "room-it-2-215",  "number": "215",  "label": "Information Systems Operations",        "cx": 213, "cy": 381},
        {"id": "room-it-2-217",  "number": "217",  "label": "Grad Assistants",                       "cx": 212, "cy": 441},
        {"id": "room-it-2-221",  "number": "221",  "label": "Industrial Networks and Communications","cx": 363, "cy": 283},
        {"id": "room-it-2-222",  "number": "222",  "label": "Telecommunications Electronics",        "cx": 493, "cy": 283},
        {"id": "room-it-2-223",  "number": "223",  "label": "Network/Security Lab",                  "cx": 613, "cy": 284},
        {"id": "room-it-2-224",  "number": "224",  "label": "CyberCave",                             "cx": 733, "cy": 285},
        {"id": "room-it-2-225",  "number": "225",  "label": "Telecommunications Networking",          "cx": 863, "cy": 286},
        {"id": "room-it-2-226",  "number": "226",  "label": "Telephony/Wireless",                    "cx": 993, "cy": 287},
        {"id": "room-it-2-227",  "number": "227",  "label": "ICT Technician",                        "cx": 1113, "cy": 288},
        {"id": "room-it-2-228",  "number": "228",  "label": "ENV Research",                           "cx": 1013, "cy": 387},
        {"id": "room-it-2-229",  "number": "229",  "label": "Classroom",                             "cx": 572, "cy": 404},
        {"id": "room-it-2-230",  "number": "230",  "label": "General Computer Lab",                  "cx": 712, "cy": 405},
        {"id": "room-it-2-231",  "number": "231",  "label": "Fred M. Card Auditorium",               "cx": 494, "cy": 133},
        {"id": "room-it-2-233",  "number": "233",  "label": "Fluid Power and Motion Control",        "cx": 862, "cy": 406},
        {"id": "room-it-2-234",  "number": "234",  "label": "Environmental Lab",                     "cx": 462, "cy": 523},
        {"id": "room-it-2-235",  "number": "235",  "label": "Radio Comm. Lab",                       "cx": 612, "cy": 524},
        {"id": "room-it-2-237",  "number": "237",  "label": "Classroom",                             "cx": 762, "cy": 525},
        {"id": "room-it-2-241",  "number": "241",  "label": "Office",                                "cx": 1262, "cy": 409},
        {"id": "room-it-2-243",  "number": "243",  "label": "Classroom",                             "cx": 912, "cy": 526},
        {"id": "room-it-2-244",  "number": "244",  "label": "Power and Motor Control",               "cx": 1062, "cy": 527},
        {"id": "room-it-2-247",  "number": "247",  "label": "Student Lounge (IET)",                   "cx": 1312, "cy": 529},
        {"id": "room-it-2-253a", "number": "253A", "label": "Chair IET Office",                      "cx": 1362, "cy": 470},
        {"id": "room-it-2-253r", "number": "253R", "label": "Student Work Area",                     "cx": 1412, "cy": 530},
        {"id": "room-it-2-255",  "number": "255",  "label": "Computer Aided Design Lab",             "cx": 212, "cy": 521},
        {"id": "room-it-2-259",  "number": "259",  "label": "Computer Graphics Lab",                 "cx": 211, "cy": 641},
        {"id": "room-it-2-263a", "number": "263A", "label": "Student Lounge",                        "cx": 1361, "cy": 610},
        {"id": "room-it-2-251",  "number": "251",  "label": "Men's Restroom",                        "cx": 762, "cy": 465},
        {"id": "room-it-2-252",  "number": "252",  "label": "Women's Restroom",                      "cx": 812, "cy": 466},
        {"id": "room-it-2-242",  "number": "242",  "label": "Office",                                "cx": 1212, "cy": 458},
        {"id": "room-it-2-rr-w", "number": "RR-W", "label": "Women's Restroom (South)",             "cx": 1011, "cy": 557},
    ],
}


@dataclass
class Door:
    x1: int
    y1: int
    x2: int
    y2: int
    width: float
    cluster: int = -1

    def midpoint(self) -> Tuple[int, int]:
        return ((self.x1 + self.x2) // 2, (self.y1 + self.y2) // 2)


@dataclass
class Room:
    room_id: int  # detection index
    polygon: List[List[int]]  # [[x,y], ...]
    area: float
    center_x: float
    center_y: float
    bbox: Tuple[int, int, int, int]  # x, y, w, h
    matched_id: str = ""
    matched_number: str = ""
    matched_label: str = ""
    ocr_text: str = ""
    feature_type: str = "room"  # room, hallway, stairs, elevator, exterior


@dataclass
class Feature:
    feature_type: str  # stairs, elevator, exterior_door
    x: int
    y: int
    w: int
    h: int
    details: str = ""


# ============================================================
# Phase 1: Wall Skeleton Extraction
# ============================================================

def make_line_kernel(length: int, angle_deg: float) -> np.ndarray:
    """Create a line structuring element at an arbitrary angle."""
    angle_rad = np.radians(angle_deg)
    half = length // 2
    dx = int(half * np.cos(angle_rad))
    dy = int(half * np.sin(angle_rad))
    ksize = max(abs(dx), abs(dy)) * 2 + 3
    kernel = np.zeros((ksize, ksize), np.uint8)
    center = ksize // 2
    cv2.line(kernel, (center - dx, center + dy), (center + dx, center - dy), 1, 1)
    return kernel


def get_branding_rects(name: str, h: int, w: int) -> List[Tuple[int, int, int, int]]:
    """Per-floor branding rectangles (y0, y1, x0, x1) to blank out."""
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


def detect_wall_seeds(binary: np.ndarray) -> np.ndarray:
    """Detect wall seed pixels using multi-angle morphological line detection."""
    seeds = np.zeros_like(binary)
    # H/V walls
    seeds |= cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (SEED_LEN_HV, 1)))
    seeds |= cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (1, SEED_LEN_HV)))
    # Diagonal walls (every 15 degrees)
    for angle in [15, 30, 45, 60, 75, 105, 120, 135, 150, 165]:
        kernel = make_line_kernel(SEED_LEN_DIAG, angle)
        seeds |= cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return seeds


def extract_wall_mask(gray: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Extract wall pixels using seed-based component detection.

    Returns: (wall_mask, binary_foreground)
    """
    _, binary = cv2.threshold(gray, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)

    # Detect wall seeds
    seeds = detect_wall_seeds(binary)
    print(f"    Wall seeds: {np.count_nonzero(seeds):,} px")

    # Erode to separate text from walls
    binary_eroded = cv2.erode(binary, np.ones((3, 3), np.uint8), iterations=EROSION_ITERS)

    # Connected components on eroded image
    n_comp, labels, stats, _ = cv2.connectedComponentsWithStats(binary_eroded, connectivity=8)
    print(f"    Components (eroded): {n_comp - 1}")

    # Find components overlapping wall seeds
    seeds_dilated = cv2.dilate(seeds, np.ones((7, 7), np.uint8), iterations=1)
    seed_ys, seed_xs = np.where(seeds_dilated > 0)
    seed_labels = labels[seed_ys, seed_xs]
    wall_label_set = set(seed_labels) - {0}
    print(f"    Wall components: {len(wall_label_set)}")

    # Build wall mask
    wall_label_array = np.zeros(n_comp, dtype=np.uint8)
    for lid in wall_label_set:
        wall_label_array[lid] = 1
    wall_mask = wall_label_array[labels] * 255

    # Dilate to recover erosion + margin
    wall_mask = cv2.dilate(wall_mask, np.ones((7, 7), np.uint8), iterations=EROSION_ITERS + 1)
    wall_mask = cv2.bitwise_and(wall_mask, binary)

    return wall_mask, binary


def thin_to_skeleton(wall_mask: np.ndarray) -> np.ndarray:
    """Thin wall mask to 1px skeleton using Zhang-Suen thinning."""
    # cv2.ximgproc.thinning requires binary input (0/255)
    try:
        skeleton = cv2.ximgproc.thinning(wall_mask, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    except AttributeError:
        # Fallback: manual iterative thinning if ximgproc not available
        print("    WARNING: cv2.ximgproc not available, using manual thinning")
        skeleton = _manual_thinning(wall_mask)
    return skeleton


def _manual_thinning(binary: np.ndarray) -> np.ndarray:
    """Fallback thinning using iterative morphological erosion."""
    skel = np.zeros_like(binary)
    temp = binary.copy()
    kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    while True:
        eroded = cv2.erode(temp, kernel)
        opened = cv2.dilate(eroded, kernel)
        diff = cv2.subtract(temp, opened)
        skel = cv2.bitwise_or(skel, diff)
        temp = eroded.copy()
        if cv2.countNonZero(temp) == 0:
            break
    return skel


def clean_skeleton(skeleton: np.ndarray) -> np.ndarray:
    """Remove spurs, small fragments, and bridge small gaps in the skeleton."""
    cleaned = skeleton.copy()

    # Step 1: Remove small connected components (text remnants, noise)
    n_comp, labels, stats, _ = cv2.connectedComponentsWithStats(
        (cleaned > 0).astype(np.uint8), connectivity=8
    )
    removed_frags = 0
    for i in range(1, n_comp):
        area = stats[i, cv2.CC_STAT_AREA]
        bw = stats[i, cv2.CC_STAT_WIDTH]
        bh = stats[i, cv2.CC_STAT_HEIGHT]
        # Remove fragments shorter than ~40px in both dimensions
        # Real walls are long in at least one direction
        if area < 60 or (bw < 40 and bh < 40):
            cleaned[labels == i] = 0
            removed_frags += 1
    print(f"    Removed {removed_frags} small skeleton fragments")

    # Step 2: Remove short spurs (endpoints with short branches)
    for _ in range(SPUR_MAX_LEN // 2):
        endpoints = _find_endpoints(cleaned)
        if len(endpoints) == 0:
            break
        for ey, ex in endpoints:
            patch = cleaned[max(0, ey-1):ey+2, max(0, ex-1):ex+2].copy()
            if np.count_nonzero(patch) <= 2:
                cleaned[ey, ex] = 0

    # Step 3: Bridge small gaps
    cleaned = _bridge_gaps(cleaned, GAP_BRIDGE_DIST)

    return cleaned


def _find_endpoints(skeleton: np.ndarray) -> List[Tuple[int, int]]:
    """Find skeleton pixels with exactly 1 neighbor (endpoints)."""
    kernel = np.array([[1, 1, 1],
                       [1, 0, 1],
                       [1, 1, 1]], dtype=np.uint8)
    neighbor_count = cv2.filter2D((skeleton > 0).astype(np.uint8), -1, kernel)
    endpoints_mask = (skeleton > 0) & (neighbor_count == 1)
    ys, xs = np.where(endpoints_mask)
    return list(zip(ys.tolist(), xs.tolist()))


def _bridge_gaps(skeleton: np.ndarray, max_dist: int) -> np.ndarray:
    """Bridge small gaps between nearby skeleton endpoints."""
    result = skeleton.copy()
    endpoints = _find_endpoints(result)
    if len(endpoints) < 2:
        return result

    ep_array = np.array(endpoints)  # (N, 2) - (y, x)
    used = set()

    for i, (y1, x1) in enumerate(endpoints):
        if i in used:
            continue
        best_j = -1
        best_dist = max_dist + 1
        for j, (y2, x2) in enumerate(endpoints):
            if j <= i or j in used:
                continue
            d = math.hypot(x2 - x1, y2 - y1)
            if d < best_dist:
                best_dist = d
                best_j = j
        if best_j >= 0 and best_dist <= max_dist:
            y2, x2 = endpoints[best_j]
            cv2.line(result, (x1, y1), (x2, y2), 255, 1)
            used.add(i)
            used.add(best_j)

    return result


def phase1_wall_skeleton(img: np.ndarray, name: str) -> Tuple[np.ndarray, np.ndarray]:
    """Phase 1: Extract wall skeleton from floor plan image.

    Returns: (skeleton, wall_mask)
    """
    h, w = img.shape[:2]
    print(f"  Phase 1: Wall skeleton extraction ({w}x{h})")

    # Remove branding
    work = img.copy()
    for y0, y1, x0, x1 in get_branding_rects(name, h, w):
        work[y0:y1, x0:x1] = 255

    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)

    # Extract wall mask
    wall_mask, binary = extract_wall_mask(gray)
    wall_px = np.count_nonzero(wall_mask)
    print(f"    Wall mask: {wall_px:,} px")

    # Thin to skeleton
    skeleton = thin_to_skeleton(wall_mask)
    skel_px = np.count_nonzero(skeleton)
    print(f"    Raw skeleton: {skel_px:,} px")

    # Clean skeleton
    skeleton = clean_skeleton(skeleton)
    skel_px = np.count_nonzero(skeleton)
    print(f"    Cleaned skeleton: {skel_px:,} px")

    return skeleton, wall_mask


# ============================================================
# Phase 2: Door Detection & Temporary Closure
# ============================================================

def _trace_from_endpoint(skeleton: np.ndarray, ey: int, ex: int, trace_len: int = 30) -> List[Tuple[int, int]]:
    """Trace the skeleton path from an endpoint, returning the path."""
    h, w = skeleton.shape
    visited = set()
    visited.add((ey, ex))
    path = [(ey, ex)]
    cy, cx = ey, ex

    for _ in range(trace_len):
        found = False
        for dy in [-1, 0, 1]:
            for dx in [-1, 0, 1]:
                if dy == 0 and dx == 0:
                    continue
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and (ny, nx) not in visited and skeleton[ny, nx] > 0:
                    visited.add((ny, nx))
                    path.append((ny, nx))
                    cy, cx = ny, nx
                    found = True
                    break
            if found:
                break
        if not found:
            break

    return path


def _get_endpoint_direction(skeleton: np.ndarray, ey: int, ex: int, trace_len: int = 30) -> Tuple[float, float]:
    """Get the wall direction at an endpoint by tracing back along the skeleton."""
    path = _trace_from_endpoint(skeleton, ey, ex, trace_len)

    if len(path) < 2:
        return (0.0, 0.0)

    # Direction from endpoint back along wall (use point ~15 steps back for stability)
    idx = min(15, len(path) - 1)
    ref = path[idx]
    dy = ref[0] - ey
    dx = ref[1] - ex
    length = math.hypot(dx, dy)
    if length < 1:
        return (0.0, 0.0)
    return (dx / length, dy / length)


# Minimum wall length at endpoint to be considered a real door edge
MIN_WALL_AT_DOOR = 25  # pixels of skeleton traced from the endpoint


def phase2_door_detection(skeleton: np.ndarray) -> Tuple[np.ndarray, List[Door]]:
    """Phase 2: Detect door openings and create closed boundaries.

    Returns: (closed_skeleton, doors)
    """
    print("  Phase 2: Door detection & closure")

    endpoints = _find_endpoints(skeleton)
    print(f"    Skeleton endpoints: {len(endpoints)}")

    # For each endpoint, compute wall direction AND wall length
    ep_dirs = []
    valid_count = 0
    for ey, ex in endpoints:
        path = _trace_from_endpoint(skeleton, ey, ex, trace_len=50)
        wall_len = len(path)
        dx, dy = (0.0, 0.0)
        if wall_len >= 2:
            idx = min(15, wall_len - 1)
            ref = path[idx]
            ddy = ref[0] - ey
            ddx = ref[1] - ex
            length = math.hypot(ddx, ddy)
            if length >= 1:
                dx, dy = ddx / length, ddy / length

        # Only consider endpoints on walls of minimum length
        if wall_len >= MIN_WALL_AT_DOOR:
            ep_dirs.append((ey, ex, dx, dy, wall_len))
            valid_count += 1

    print(f"    Valid endpoints (wall >= {MIN_WALL_AT_DOOR}px): {valid_count}/{len(endpoints)}")

    # Pair endpoints across gaps
    doors: List[Door] = []
    used = set()

    for i, (y1, x1, dx1, dy1, wl1) in enumerate(ep_dirs):
        if i in used:
            continue
        best_j = -1
        best_score = float('inf')

        for j, (y2, x2, dx2, dy2, wl2) in enumerate(ep_dirs):
            if j <= i or j in used:
                continue

            gap = math.hypot(x2 - x1, y2 - y1)
            if gap < DOOR_MIN_GAP or gap > DOOR_MAX_GAP:
                continue

            # Check that wall directions are roughly parallel
            has_dir = (abs(dx1) + abs(dy1) > 0.1 and abs(dx2) + abs(dy2) > 0.1)
            if has_dir:
                dot = abs(dx1 * dx2 + dy1 * dy2)
                if dot < 0.5:  # Stricter: walls must be more parallel
                    continue
            else:
                continue  # Skip endpoints without clear wall direction

            # Check that the gap direction is roughly perpendicular to the walls
            gap_dx = x2 - x1
            gap_dy = y2 - y1
            gap_len = math.hypot(gap_dx, gap_dy)
            if gap_len > 0:
                gap_dx /= gap_len
                gap_dy /= gap_len
                # Gap should be perpendicular to wall direction
                perp1 = abs(dx1 * gap_dx + dy1 * gap_dy)
                perp2 = abs(dx2 * gap_dx + dy2 * gap_dy)
                # Low dot product = perpendicular (good)
                if perp1 > 0.7 or perp2 > 0.7:
                    continue  # Gap is parallel to walls, not a door

            # Score: prefer shorter gaps with more parallel walls
            score = gap * (2.0 - dot)
            if score < best_score:
                best_score = score
                best_j = j

        if best_j >= 0:
            y2, x2, _, _, _ = ep_dirs[best_j]
            gap = math.hypot(x2 - x1, y2 - y1)
            doors.append(Door(x1=x1, y1=y1, x2=x2, y2=y2, width=gap))
            used.add(i)
            used.add(best_j)

    print(f"    Doors detected: {len(doors)}")

    # Cluster door widths
    if doors:
        widths = sorted([d.width for d in doors])
        clusters = _cluster_widths(widths)
        for d in doors:
            d.cluster = _assign_cluster(d.width, clusters)
        cluster_info = {c: [d.width for d in doors if d.cluster == c] for c in set(d.cluster for d in doors)}
        for c, ws in sorted(cluster_info.items()):
            print(f"    Door cluster {c}: {len(ws)} doors, width range {min(ws):.0f}-{max(ws):.0f}px")

    # Create closed skeleton by drawing lines across door gaps
    closed = skeleton.copy()
    for d in doors:
        cv2.line(closed, (d.x1, d.y1), (d.x2, d.y2), 255, 1)

    # Also close remaining small gaps by dilating and re-thinning
    # This catches gaps missed by door detection (e.g., at wall corners)
    gap_closed = cv2.dilate(closed, np.ones((3, 3), np.uint8), iterations=1)
    try:
        gap_closed = cv2.ximgproc.thinning(gap_closed, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    except AttributeError:
        gap_closed = _manual_thinning(gap_closed)
    # Merge: keep original skeleton plus any new bridging pixels
    closed = cv2.bitwise_or(closed, gap_closed)

    return closed, doors


def _cluster_widths(widths: List[float], max_clusters: int = 4) -> List[float]:
    """Simple 1D k-means clustering for door widths."""
    if not widths:
        return []

    # Initialize centers evenly across range
    wmin, wmax = min(widths), max(widths)
    if wmax - wmin < 10:
        return [sum(widths) / len(widths)]

    k = min(max_clusters, len(set(int(w) for w in widths)))
    centers = [wmin + (wmax - wmin) * (i + 0.5) / k for i in range(k)]

    for _ in range(20):
        # Assign
        assignments = [min(range(k), key=lambda c: abs(w - centers[c])) for w in widths]
        # Update centers
        new_centers = []
        for c in range(k):
            cluster_widths = [w for w, a in zip(widths, assignments) if a == c]
            if cluster_widths:
                new_centers.append(sum(cluster_widths) / len(cluster_widths))
            else:
                new_centers.append(centers[c])
        if new_centers == centers:
            break
        centers = new_centers

    return centers


def _assign_cluster(width: float, centers: List[float]) -> int:
    if not centers:
        return 0
    return min(range(len(centers)), key=lambda c: abs(width - centers[c]))


# ============================================================
# Phase 3: Room Segmentation
# ============================================================

def phase3_room_segmentation(closed_skeleton: np.ndarray, wall_mask: np.ndarray) -> List[Room]:
    """Phase 3: Segment enclosed rooms using thick wall mask with morphological closure.

    Uses the wall_mask (full thickness) instead of thin skeleton for segmentation,
    because thick walls tolerate small gaps better. Aggressive morphological closing
    seals door-width gaps and corner breaks.

    Returns: list of Room objects
    """
    print("  Phase 3: Room segmentation")

    h, w = wall_mask.shape

    # Use thick wall mask as the boundary (not the thin skeleton).
    # The building is mostly orthogonal (H/V walls) with only the top-right
    # wing at an angle. Use aggressive H/V closing + moderate elliptical closing.

    # Step 1: H/V closing — the building is rectangular, so most door gaps
    # are along horizontal or vertical walls. Large kernel in one direction only.
    h_close = cv2.morphologyEx(
        wall_mask, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, 35))  # vertical bridge
    )
    v_close = cv2.morphologyEx(
        wall_mask, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (35, 1))  # horizontal bridge
    )
    boundary = cv2.bitwise_or(wall_mask, cv2.bitwise_or(h_close, v_close))

    # Step 2: Moderate elliptical close for diagonal/corner gaps
    boundary = cv2.morphologyEx(
        boundary, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)),
        iterations=1
    )

    print(f"    Boundary pixels after closing: {np.count_nonzero(boundary):,}")

    # Invert: rooms become foreground
    inverted = cv2.bitwise_not(boundary)

    # Connected components
    n_comp, labels, stats, centroids = cv2.connectedComponentsWithStats(inverted, connectivity=4)
    print(f"    Raw components: {n_comp - 1}")

    # Filter components
    rooms: List[Room] = []
    room_id = 0

    # Find the exterior (usually the largest component)
    if n_comp <= 1:
        print("    WARNING: No rooms found!")
        return rooms

    areas = [(i, stats[i, cv2.CC_STAT_AREA]) for i in range(1, n_comp)]
    areas.sort(key=lambda x: x[1], reverse=True)
    exterior_label = areas[0][0]  # Largest is exterior

    for i in range(1, n_comp):
        if i == exterior_label:
            continue

        area = stats[i, cv2.CC_STAT_AREA]
        bx = stats[i, cv2.CC_STAT_LEFT]
        by = stats[i, cv2.CC_STAT_TOP]
        bw = stats[i, cv2.CC_STAT_WIDTH]
        bh = stats[i, cv2.CC_STAT_HEIGHT]
        cx = centroids[i][0]
        cy = centroids[i][1]

        # Filter tiny regions
        if area < MIN_ROOM_AREA:
            continue
        # Filter very narrow regions
        if bw < MIN_ROOM_WIDTH or bh < MIN_ROOM_WIDTH:
            continue

        # Extract contour for this component
        comp_mask = (labels == i).astype(np.uint8) * 255
        contours, _ = cv2.findContours(comp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        if not contours:
            continue

        # Take largest contour
        contour = max(contours, key=cv2.contourArea)

        # Simplify polygon
        epsilon = POLY_EPSILON_FACTOR * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        polygon = approx.reshape(-1, 2).tolist()

        room_id += 1
        rooms.append(Room(
            room_id=room_id,
            polygon=polygon,
            area=area,
            center_x=float(cx),
            center_y=float(cy),
            bbox=(bx, by, bw, bh),
        ))

    print(f"    Rooms after filtering: {len(rooms)}")
    return rooms


# ============================================================
# Phase 4: Room Labeling via OCR
# ============================================================

def phase4_room_labeling(rooms: List[Room], img: np.ndarray, floor_key: str) -> None:
    """Phase 4: Match rooms to known room IDs via OCR + spatial matching."""
    print(f"  Phase 4: Room labeling ({floor_key})")

    known_rooms = IT_ROOMS.get(floor_key, [])
    if not known_rooms:
        print(f"    WARNING: No known rooms for {floor_key}")
        return

    # SeedData centers are at the display dimensions (widthPx/heightPx from floors table).
    # The actual images are higher resolution. Compute scale factors.
    # IT Floor 1: display 1714x1127, IT Floor 2: display 1714x1084
    img_h, img_w = img.shape[:2]
    if floor_key == "floor1":
        display_w, display_h = 1714, 1127
    else:
        display_w, display_h = 1714, 1084
    scale_x = img_w / display_w
    scale_y = img_h / display_h
    print(f"    Scale factors: x={scale_x:.2f}, y={scale_y:.2f} "
          f"(image {img_w}x{img_h}, display {display_w}x{display_h})")

    # Scale known room centers to image coordinates
    scaled_known = []
    for kr in known_rooms:
        scaled_known.append({
            **kr,
            "cx_scaled": kr["cx"] * scale_x,
            "cy_scaled": kr["cy"] * scale_y,
        })

    # Try OCR on each room region
    ocr_matches = 0
    if HAS_TESSERACT:
        if TESSERACT_EXE.exists():
            pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        for room in rooms:
            bx, by, bw, bh = room.bbox
            pad = 10
            x0 = max(0, bx - pad)
            y0 = max(0, by - pad)
            x1 = min(gray.shape[1], bx + bw + pad)
            y1 = min(gray.shape[0], by + bh + pad)
            crop = gray[y0:y1, x0:x1]

            if crop.size == 0:
                continue

            try:
                text = pytesseract.image_to_string(
                    crop, config="--oem 3 --psm 6"
                ).strip()
                room.ocr_text = text

                for kr in scaled_known:
                    if kr["number"].lower() in text.lower():
                        room.matched_id = kr["id"]
                        room.matched_number = kr["number"]
                        room.matched_label = kr["label"]
                        ocr_matches += 1
                        break
            except Exception:
                pass

    print(f"    OCR matches: {ocr_matches}/{len(rooms)}")

    # Spatial matching for unmatched rooms (using scaled coordinates)
    unmatched_rooms = [r for r in rooms if not r.matched_id]
    unmatched_known = [kr for kr in scaled_known
                       if not any(r.matched_id == kr["id"] for r in rooms)]

    spatial_matches = 0
    max_spatial_dist = 200  # px tolerance at full image resolution
    for room in unmatched_rooms:
        best_kr = None
        best_dist = float('inf')
        for kr in unmatched_known:
            d = math.hypot(room.center_x - kr["cx_scaled"],
                           room.center_y - kr["cy_scaled"])
            if d < best_dist:
                best_dist = d
                best_kr = kr

        if best_kr and best_dist < max_spatial_dist:
            room.matched_id = best_kr["id"]
            room.matched_number = best_kr["number"]
            room.matched_label = best_kr["label"]
            unmatched_known.remove(best_kr)
            spatial_matches += 1

    print(f"    Spatial matches: {spatial_matches}")
    print(f"    Total matched: {ocr_matches + spatial_matches}/{len(rooms)}")
    if unmatched_known:
        print(f"    Unmatched known rooms: {[kr['number'] for kr in unmatched_known]}")


# ============================================================
# Phase 5: Feature Detection
# ============================================================

def phase5_features(rooms: List[Room], wall_mask: np.ndarray, img: np.ndarray) -> List[Feature]:
    """Phase 5: Classify rooms as stairs, hallways, elevators, etc."""
    print("  Phase 5: Feature detection")

    features: List[Feature] = []

    for room in rooms:
        bx, by, bw, bh = room.bbox
        aspect = max(bw, bh) / max(min(bw, bh), 1)

        # Hallway detection: long narrow regions
        if aspect > 5 and room.area > 2000:
            room.feature_type = "hallway"
            features.append(Feature("hallway", bx, by, bw, bh, f"aspect={aspect:.1f}"))
            continue

        # Stair detection: look for hatched patterns (many parallel lines)
        crop_gray = cv2.cvtColor(img[by:by+bh, bx:bx+bw], cv2.COLOR_BGR2GRAY)
        if crop_gray.size > 0:
            _, crop_bin = cv2.threshold(crop_gray, BINARIZE_THRESH, 255, cv2.THRESH_BINARY_INV)
            fg_density = np.count_nonzero(crop_bin) / max(crop_bin.size, 1)

            # Stairs have high line density (hatched pattern)
            if 0.15 < fg_density < 0.60 and room.area < 15000:
                # Check for parallel line pattern using Hough transform
                lines = cv2.HoughLinesP(crop_bin, 1, np.pi / 180, threshold=10,
                                        minLineLength=15, maxLineGap=3)
                if lines is not None and len(lines) > 8:
                    # Many short parallel lines = stairs
                    angles = []
                    for line in lines:
                        lx1, ly1, lx2, ly2 = line[0]
                        angle = math.degrees(math.atan2(ly2 - ly1, lx2 - lx1)) % 180
                        angles.append(angle)
                    # Check if most lines are roughly the same angle
                    if angles:
                        median_angle = sorted(angles)[len(angles) // 2]
                        near_median = sum(1 for a in angles if abs(a - median_angle) < 20)
                        if near_median / len(angles) > 0.5:
                            room.feature_type = "stairs"
                            features.append(Feature("stairs", bx, by, bw, bh,
                                                    f"lines={len(lines)}, density={fg_density:.2f}"))
                            continue

        # Small rooms near stairs might be elevators
        if room.area < 3000 and bw < 80 and bh < 80:
            # Check if near any detected stairwell
            for f in features:
                if f.feature_type == "stairs":
                    d = math.hypot(bx + bw/2 - (f.x + f.w/2), by + bh/2 - (f.y + f.h/2))
                    if d < 150:
                        room.feature_type = "elevator"
                        features.append(Feature("elevator", bx, by, bw, bh))
                        break

    stair_count = sum(1 for f in features if f.feature_type == "stairs")
    hall_count = sum(1 for f in features if f.feature_type == "hallway")
    elev_count = sum(1 for f in features if f.feature_type == "elevator")
    print(f"    Stairs: {stair_count}, Hallways: {hall_count}, Elevators: {elev_count}")

    return features


# ============================================================
# Debug Overlay Generation
# ============================================================

def generate_debug_overlay(img: np.ndarray, rooms: List[Room], doors: List[Door],
                           floor_label: str) -> np.ndarray:
    """Generate a numbered overlay showing detected rooms on the original image."""
    overlay = img.copy()

    # Color palette for rooms
    colors = [
        (255, 100, 100), (100, 255, 100), (100, 100, 255),
        (255, 255, 100), (255, 100, 255), (100, 255, 255),
        (200, 150, 100), (100, 200, 150), (150, 100, 200),
        (200, 200, 100), (100, 200, 200), (200, 100, 200),
    ]

    # Draw room polygons with semi-transparent fill
    for room in rooms:
        color = colors[room.room_id % len(colors)]
        pts = np.array(room.polygon, dtype=np.int32)

        # Semi-transparent fill
        room_overlay = overlay.copy()
        cv2.fillPoly(room_overlay, [pts], color)
        cv2.addWeighted(room_overlay, 0.3, overlay, 0.7, 0, overlay)

        # Polygon outline
        cv2.polylines(overlay, [pts], True, color, 2)

        # Room number label at centroid
        cx, cy = int(room.center_x), int(room.center_y)
        label = room.matched_number or f"#{room.room_id}"
        # Background for text
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(overlay, (cx - 2, cy - th - 4), (cx + tw + 2, cy + 4), (255, 255, 255), -1)
        cv2.putText(overlay, label, (cx, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)

        # Feature type indicator
        if room.feature_type != "room":
            ft_label = room.feature_type.upper()
            cv2.putText(overlay, ft_label, (cx, cy + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.4,
                        (0, 0, 180), 1)

    # Draw detected doors
    for door in doors:
        cv2.line(overlay, (door.x1, door.y1), (door.x2, door.y2), (0, 200, 0), 3)
        mx, my = door.midpoint()
        cv2.circle(overlay, (mx, my), 4, (0, 200, 0), -1)

    return overlay


# ============================================================
# Main Pipeline
# ============================================================

def process_floor(name: str, floor_key: str, floor_label: str) -> Optional[dict]:
    """Run full detection pipeline on one floor."""
    src_path = IN_DIR / name
    img = cv2.imread(str(src_path))
    if img is None:
        print(f"ERROR: Could not load {src_path}")
        return None

    h, w = img.shape[:2]
    print(f"\n{'='*60}")
    print(f"Processing {name} ({w}x{h})")
    print(f"{'='*60}")

    # Phase 1: Wall skeleton
    skeleton, wall_mask = phase1_wall_skeleton(img, name)

    # Phase 2: Door detection
    closed_skeleton, doors = phase2_door_detection(skeleton)

    # Phase 3: Room segmentation
    rooms = phase3_room_segmentation(closed_skeleton, wall_mask)

    # Phase 4: Room labeling
    phase4_room_labeling(rooms, img, floor_key)

    # Phase 5: Feature detection
    features = phase5_features(rooms, wall_mask, img)

    # Generate outputs
    print(f"\n  Generating outputs...")

    # Save skeleton
    cv2.imwrite(str(OUT_DIR / f"wall_skeleton_{floor_label}.png"), skeleton)

    # Save closed skeleton (for debugging)
    cv2.imwrite(str(OUT_DIR / f"closed_skeleton_{floor_label}.png"), closed_skeleton)

    # Save debug overlay
    overlay = generate_debug_overlay(img, rooms, doors, floor_label)
    cv2.imwrite(str(OUT_DIR / f"debug_overlay_{floor_label}.png"), overlay)

    # Save rooms JSON
    rooms_data = []
    for r in rooms:
        rooms_data.append({
            "room_id": r.room_id,
            "polygon": [[int(p[0]), int(p[1])] for p in r.polygon],
            "area": int(r.area),
            "center_x": round(float(r.center_x), 1),
            "center_y": round(float(r.center_y), 1),
            "bbox": [int(v) for v in r.bbox],
            "matched_id": r.matched_id,
            "matched_number": r.matched_number,
            "matched_label": r.matched_label,
            "ocr_text": r.ocr_text,
            "feature_type": r.feature_type,
        })

    rooms_json = OUT_DIR / f"rooms_{floor_label}.json"
    rooms_json.write_text(json.dumps(rooms_data, indent=2), encoding="utf-8")

    # Save doors JSON
    doors_data = []
    for d in doors:
        doors_data.append({
            "x1": int(d.x1), "y1": int(d.y1),
            "x2": int(d.x2), "y2": int(d.y2),
            "width": round(float(d.width), 1),
            "cluster": int(d.cluster),
        })

    doors_json = OUT_DIR / f"doors_{floor_label}.json"
    doors_json.write_text(json.dumps(doors_data, indent=2), encoding="utf-8")

    # Summary
    matched = sum(1 for r in rooms if r.matched_id)
    print(f"\n  Summary for {floor_label}:")
    print(f"    Rooms detected: {len(rooms)}")
    print(f"    Rooms matched: {matched}/{len(rooms)}")
    print(f"    Doors detected: {len(doors)}")
    print(f"    Features: {len(features)}")
    print(f"    Outputs: {OUT_DIR}")

    return {
        "floor": floor_label,
        "rooms": len(rooms),
        "matched": matched,
        "doors": len(doors),
        "features": len(features),
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    results = []
    r1 = process_floor("it_floor1_split_locked.png", "floor1", "floor1")
    if r1:
        results.append(r1)
    r2 = process_floor("it_floor2_split_locked.png", "floor2", "floor2")
    if r2:
        results.append(r2)

    print(f"\n{'='*60}")
    print("DETECTION COMPLETE")
    print(f"{'='*60}")
    for r in results:
        print(f"  {r['floor']}: {r['rooms']} rooms ({r['matched']} matched), "
              f"{r['doors']} doors, {r['features']} features")
    print(f"\nAll outputs in: {OUT_DIR}")


if __name__ == "__main__":
    main()
