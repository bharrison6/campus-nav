"""
IT floor plan SVG reproduction — clean geometry from detected rooms.

Phase 6: Takes room JSON + door JSON from detect_rooms.py and generates
clean SVG floor plans with organized layers.

Input:  Maps/it-floor-reproduced/rooms_floor{1,2}.json
        Maps/it-floor-reproduced/doors_floor{1,2}.json
        Maps/it-floor-split-backup/it_floor{1,2}_split_locked.png  (for dimensions)
Output: Maps/it-floor-reproduced/it_floor{1,2}.svg
"""

import json
import math
from pathlib import Path
from typing import Dict, List, Set, Tuple

import svgwrite

ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-reproduced"
IMG_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-reproduced"

# SVG styling
WALL_COLOR = "#222222"
WALL_WIDTH = 2.5
DOOR_COLOR = "#888888"
DOOR_GAP_WIDTH = 3
ROOM_FILL_OPACITY = 0.08
LABEL_FONT_SIZE = 12
LABEL_FONT_FAMILY = "Arial, Helvetica, sans-serif"
STAIR_HATCH_COLOR = "#666666"

# Feature type colors
FEATURE_COLORS = {
    "room": "#e8e8ff",
    "hallway": "#fff8e0",
    "stairs": "#ffe0e0",
    "elevator": "#e0ffe0",
}

# Wall alignment snap threshold
SNAP_THRESHOLD = 4  # pixels


def load_json(path: Path) -> list:
    if not path.exists():
        print(f"WARNING: {path} not found")
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def get_image_dimensions(floor_label: str) -> Tuple[int, int]:
    """Get dimensions from the original floor plan image."""
    import cv2
    name = f"it_{floor_label}_split_locked.png"
    img_path = IMG_DIR / name
    if not img_path.exists():
        print(f"WARNING: {img_path} not found, using default dimensions")
        return (1600, 1000)
    img = cv2.imread(str(img_path))
    if img is None:
        return (1600, 1000)
    h, w = img.shape[:2]
    return (w, h)


def snap_colinear_walls(rooms: list, threshold: int = SNAP_THRESHOLD) -> list:
    """Snap nearly-colinear wall segments to exact alignment.

    Collects all X and Y coordinates from room polygons and snaps
    nearby values to a common value.
    """
    # Collect all x and y coords
    all_x = []
    all_y = []
    for room in rooms:
        for pt in room["polygon"]:
            all_x.append(pt[0])
            all_y.append(pt[1])

    # Cluster nearby values
    x_map = _snap_values(all_x, threshold)
    y_map = _snap_values(all_y, threshold)

    # Apply snapping
    for room in rooms:
        for pt in room["polygon"]:
            pt[0] = x_map.get(pt[0], pt[0])
            pt[1] = y_map.get(pt[1], pt[1])

    return rooms


def _snap_values(values: List[int], threshold: int) -> Dict[int, int]:
    """Map nearby values to their cluster center."""
    if not values:
        return {}

    sorted_vals = sorted(set(values))
    mapping = {}
    cluster = [sorted_vals[0]]

    for v in sorted_vals[1:]:
        if v - cluster[-1] <= threshold:
            cluster.append(v)
        else:
            # Finalize cluster
            center = int(round(sum(cluster) / len(cluster)))
            for cv in cluster:
                mapping[cv] = center
            cluster = [v]

    # Finalize last cluster
    center = int(round(sum(cluster) / len(cluster)))
    for cv in cluster:
        mapping[cv] = center

    return mapping


def extract_wall_edges(rooms: list) -> List[Tuple[Tuple[int, int], Tuple[int, int]]]:
    """Extract all wall edges from room polygons, deduplicating shared walls."""
    edges: Set[Tuple[Tuple[int, int], Tuple[int, int]]] = set()

    for room in rooms:
        poly = room["polygon"]
        n = len(poly)
        for i in range(n):
            p1 = tuple(poly[i])
            p2 = tuple(poly[(i + 1) % n])
            # Normalize edge direction for deduplication
            edge = tuple(sorted([p1, p2]))
            edges.add(edge)

    return list(edges)


def render_door_symbol(dwg, group, door: dict, wall_width: float):
    """Render a door as a gap in the wall with a small arc symbol."""
    x1, y1 = door["x1"], door["y1"]
    x2, y2 = door["x2"], door["y2"]
    mx = (x1 + x2) / 2
    my = (y1 + y2) / 2
    width = door["width"]

    # Door arc (quarter circle from hinge point)
    radius = width * 0.8
    # Draw a small arc to indicate door swing
    group.add(dwg.line(
        start=(x1, y1), end=(x2, y2),
        stroke=DOOR_COLOR, stroke_width=1,
        stroke_dasharray="4,3",
    ))

    # Small hinge dot
    group.add(dwg.circle(
        center=(x1, y1), r=2,
        fill=DOOR_COLOR,
    ))


def render_stair_hatch(dwg, group, room: dict):
    """Render a stair symbol (parallel lines) inside the room bounding box."""
    bx, by, bw, bh = room["bbox"]
    spacing = 6
    # Determine hatch direction based on room shape
    if bw > bh:
        # Horizontal room: vertical hatch lines
        x = bx + spacing
        while x < bx + bw:
            group.add(dwg.line(
                start=(x, by + 2), end=(x, by + bh - 2),
                stroke=STAIR_HATCH_COLOR, stroke_width=0.8,
            ))
            x += spacing
    else:
        # Vertical room: horizontal hatch lines
        y = by + spacing
        while y < by + bh:
            group.add(dwg.line(
                start=(bx + 2, y), end=(bx + bw - 2, y),
                stroke=STAIR_HATCH_COLOR, stroke_width=0.8,
            ))
            y += spacing


def generate_svg(floor_label: str) -> Path:
    """Generate a clean SVG floor plan from detected room data."""
    print(f"\nGenerating SVG for {floor_label}...")

    # Load data
    rooms = load_json(IN_DIR / f"rooms_{floor_label}.json")
    doors = load_json(IN_DIR / f"doors_{floor_label}.json")

    if not rooms:
        print(f"  No room data for {floor_label}, skipping")
        return None

    # Get dimensions
    width, height = get_image_dimensions(floor_label)
    print(f"  Dimensions: {width}x{height}")
    print(f"  Rooms: {len(rooms)}, Doors: {len(doors)}")

    # Snap colinear walls
    rooms = snap_colinear_walls(rooms)

    # Create SVG
    svg_path = OUT_DIR / f"it_{floor_label}.svg"
    dwg = svgwrite.Drawing(str(svg_path), size=(width, height))
    dwg.viewbox(0, 0, width, height)

    # White background
    dwg.add(dwg.rect(insert=(0, 0), size=(width, height), fill="white"))

    # Create layer groups
    rooms_group = dwg.g(id="rooms")
    walls_group = dwg.g(id="walls")
    doors_group = dwg.g(id="doors")
    labels_group = dwg.g(id="labels")
    features_group = dwg.g(id="features")

    # --- Rooms layer: filled polygons ---
    for room in rooms:
        poly = room["polygon"]
        if len(poly) < 3:
            continue

        fill_color = FEATURE_COLORS.get(room.get("feature_type", "room"), FEATURE_COLORS["room"])
        points = [(p[0], p[1]) for p in poly]

        room_id = room.get("matched_id") or f"detected-{room['room_id']}"
        rooms_group.add(dwg.polygon(
            points=points,
            fill=fill_color,
            fill_opacity=ROOM_FILL_OPACITY,
            id=room_id,
        ))

        # Stair hatching
        if room.get("feature_type") == "stairs":
            render_stair_hatch(dwg, features_group, room)

    # --- Walls layer: deduplicated edges ---
    wall_edges = extract_wall_edges(rooms)
    print(f"  Wall edges: {len(wall_edges)} (deduplicated)")

    for (p1, p2) in wall_edges:
        walls_group.add(dwg.line(
            start=p1, end=p2,
            stroke=WALL_COLOR,
            stroke_width=WALL_WIDTH,
            stroke_linecap="round",
        ))

    # --- Doors layer ---
    for door in doors:
        render_door_symbol(dwg, doors_group, door, WALL_WIDTH)

    # --- Labels layer ---
    for room in rooms:
        label = room.get("matched_number", "")
        if not label:
            continue
        cx = room["center_x"]
        cy = room["center_y"]

        labels_group.add(dwg.text(
            label,
            insert=(cx, cy + LABEL_FONT_SIZE * 0.35),
            fill="#333333",
            font_size=LABEL_FONT_SIZE,
            font_family=LABEL_FONT_FAMILY,
            font_weight="600",
            text_anchor="middle",
        ))

        # Room label (smaller, below number)
        room_label = room.get("matched_label", "")
        if room_label and len(room_label) < 30:
            labels_group.add(dwg.text(
                room_label,
                insert=(cx, cy + LABEL_FONT_SIZE * 0.35 + 14),
                fill="#666666",
                font_size=LABEL_FONT_SIZE - 2,
                font_family=LABEL_FONT_FAMILY,
                text_anchor="middle",
            ))

    # Assemble layers (order matters for rendering)
    dwg.add(rooms_group)
    dwg.add(features_group)
    dwg.add(walls_group)
    dwg.add(doors_group)
    dwg.add(labels_group)

    dwg.save()
    print(f"  Saved: {svg_path}")
    return svg_path


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    paths = []
    for floor in ("floor1", "floor2"):
        path = generate_svg(floor)
        if path:
            paths.append(path)

    print(f"\nDone. SVG files generated: {len(paths)}")
    for p in paths:
        print(f"  {p}")


if __name__ == "__main__":
    main()
