"""
IT floor plan room data export — format for SeedData.gs.

Phase 8: Takes verified room JSON and exports polygon data formatted
for the SeedData.gs room entries.

Input:  Maps/it-floor-reproduced/rooms_floor{1,2}.json
Output: Maps/it-floor-reproduced/seeddata_polygons.json
        Maps/it-floor-reproduced/seeddata_update.js     (copy-paste snippet)
"""

import json
from pathlib import Path
from typing import List

ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-reproduced"
OUT_DIR = ROOT / "Maps" / "it-floor-reproduced"


def load_rooms(floor_label: str) -> list:
    path = IN_DIR / f"rooms_{floor_label}.json"
    if not path.exists():
        print(f"WARNING: {path} not found")
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def polygon_to_seeddata(polygon: List[List[int]]) -> str:
    """Convert polygon [[x,y], ...] to the JSON string format used by SeedData.gs.

    The app stores polygons as JSON-stringified arrays of {x, y} objects:
    '[{"x":100,"y":200},{"x":300,"y":200},...]'
    """
    points = [{"x": pt[0], "y": pt[1]} for pt in polygon]
    return json.dumps(points, separators=(",", ":"))


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    all_updates = {}
    js_lines = []

    for floor_label in ("floor1", "floor2"):
        rooms = load_rooms(floor_label)
        if not rooms:
            continue

        matched = [r for r in rooms if r.get("matched_id")]
        print(f"\n{floor_label}: {len(matched)} matched rooms (of {len(rooms)} detected)")

        for room in matched:
            room_id = room["matched_id"]
            polygon = room["polygon"]
            center_x = round(room["center_x"])
            center_y = round(room["center_y"])

            polygon_str = polygon_to_seeddata(polygon)

            all_updates[room_id] = {
                "id": room_id,
                "number": room.get("matched_number", ""),
                "label": room.get("matched_label", ""),
                "polygon": polygon_str,
                "centerX": str(center_x),
                "centerY": str(center_y),
            }

            # JS snippet for SeedData.gs
            num = room.get("matched_number", "")
            label = room.get("matched_label", "").replace("'", "\\'")
            js_lines.append(
                f"    ['{room_id}', 'floor-it-{floor_label[-1]}', '{num}', "
                f"'{label}', '{polygon_str}', '{center_x}', '{center_y}'],"
            )

    # Save polygon JSON
    json_path = OUT_DIR / "seeddata_polygons.json"
    json_path.write_text(json.dumps(all_updates, indent=2), encoding="utf-8")
    print(f"\nSaved polygon data: {json_path} ({len(all_updates)} rooms)")

    # Save JS snippet
    js_path = OUT_DIR / "seeddata_update.js"
    js_content = (
        "// Copy-paste these lines into _getRoomsSeedData() in SeedData.gs\n"
        "// Each row: [id, floorId, number, label, polygon, centerX, centerY]\n\n"
    )
    js_content += "\n".join(js_lines)
    js_path.write_text(js_content, encoding="utf-8")
    print(f"Saved JS snippet: {js_path}")

    # Summary
    print(f"\nExport complete:")
    print(f"  Total rooms with polygons: {len(all_updates)}")
    print(f"  Polygon JSON: {json_path.name}")
    print(f"  SeedData.gs snippet: {js_path.name}")


if __name__ == "__main__":
    main()
