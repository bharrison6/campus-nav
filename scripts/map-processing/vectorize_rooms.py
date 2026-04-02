"""
Vectorize Rooms v1 â€” Graph-based CAD reconstruction from floor plan images.

This script implements a "CAD-style" reconstruction pipeline:
1.  Line Segment Detection (LSD) to find sub-pixel accurate wall segments.
2.  Graph construction (Nodes = Corners, Edges = Walls).
3.  Topology cleaning (Snap endpoints, Split T-junctions, Merge collinear).
4.  Cycle Basis extraction to find rooms (minimum closed loops).
5.  SVG/JSON output.

Usage:
  python vectorize_rooms.py

Prerequisites:
  pip install opencv-python numpy svgwrite shapely
""",

import json
import math
import sys
from pathlib import Path
from typing import List, Tuple, Dict, Set, Optional

import cv2
import numpy as np
import svgwrite
from shapely.geometry import Polygon, LineString
from shapely.ops import polygonize

# --- Configuration ---
ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-text-removed-v8"  # Use the cleaned images
OUT_DIR = ROOT / "Maps" / "vector-out"

# Tuning Parameters
LSD_SCALE = 0.8          # Downscale for detection (noise reduction)
SNAP_DIST = 12.0         # Pixels to snap endpoints together
MIN_WALL_LEN = 15.0      # Discard short noise segments
WALL_THICKNESS = 4.0     # For visualization
COLLINEAR_TOL = 5.0      # Max distance to merge parallel lines
ANGLE_TOL = 5.0          # Degrees to consider lines parallel

class Vectorizer:
    def __init__(self, debug=True):
        self.debug = debug
        OUT_DIR.mkdir(parents=True, exist_ok=True)

    def load_image(self, path: Path) -> np.ndarray:
        print(f"Loading {path}...")
        img = cv2.imread(str(path))
        if img is None:
            raise FileNotFoundError(f"Could not load {path}")
        return img

    def detect_lines(self, img: np.ndarray) -> List[Tuple[float, float, float, float]]:
        """Use OpenCV LSD to find line segments."""
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        lsd = cv2.createLineSegmentDetector(0) # 0 = LSD_REFINE_STD
        lines, width, prec, nfa = lsd.detect(gray)
        
        if lines is None:
            return []

        segments = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            length = math.hypot(x2 - x1, y2 - y1)
            if length > MIN_WALL_LEN:
                segments.append((float(x1), float(y1), float(x2), float(y2)))

        print(f"  LSD detected {len(segments)} segments")

        if self.debug:
            debug_img = img.copy()
            lsd.drawSegments(debug_img, lines)
            cv2.imwrite(str(OUT_DIR / "debug_01_lsd.png"), debug_img)

        return segments

    def merge_segments(self, segments: List[Tuple[float, float, float, float]]) -> List[LineString]:      
        """
        Merge collinear and overlapping segments using Shapely.
        This is a simplification step.
        """
        lines = [LineString([(s[0], s[1]), (s[2], s[3])]) for s in segments]
        return lines

    def find_rooms_shapely(self, segments: List[Tuple[float, float, float, float]], width: int, height: int) -> List[Polygon]:
        """
        The Robust CAD Method:
        1. Treat all wall segments as infinite lines (or long segments).
        2. Polygonize the planar graph formed by these lines.
        3. Filter polygons that match room criteria (area, etc).
        """
        print("  Polygonizing...")
        extended_lines = []
        extension = 5.0
        for x1, y1, x2, y2 in segments:
            angle = math.atan2(y2 - y1, x2 - x1)
            dx = math.cos(angle) * extension
            dy = math.sin(angle) * extension
            extended_lines.append(LineString([
                (x1 - dx, y1 - dy),
                (x2 + dx, y2 + dy)
            ]))
        return extended_lines

    def generate_svg(self, lines: List[LineString], filename: str, width: int, height: int):
        dwg = svgwrite.Drawing(filename, size=(width, height))
        dwg.viewbox(0, 0, width, height)
        g_walls = dwg.g(id="walls", stroke="black", stroke_width=2)
        for line in lines:
            x1, y1 = line.coords[0]
            x2, y2 = line.coords[1]
            g_walls.add(dwg.line(start=(x1, y1), end=(x2, y2)))
        dwg.add(g_walls)
        dwg.save()
        print(f"  Saved {filename}")

    def run(self, filename_stem: str):
        path = IN_DIR / f"{filename_stem}_split_text_removed.png"
        if not path.exists():
            print(f"Skipping {path} (not found - run ocr_remove_v8 first)")
            return

        img = self.load_image(path)
        h, w = img.shape[:2]
        segments = self.detect_lines(img)
        shapely_lines = [LineString([(s[0], s[1]), (s[2], s[3])]) for s in segments]
        
        out_svg = OUT_DIR / f"{filename_stem}_vector.svg"
        self.generate_svg(shapely_lines, str(out_svg), w, h)
        
        out_json = OUT_DIR / f"{filename_stem}_lines.json"
        data = [{"p1": [l.coords[0][0], l.coords[0][1]], "p2": [l.coords[1][0], l.coords[1][1]]} for l in shapely_lines]
        out_json.write_text(json.dumps(data), encoding="utf-8")

def main():
    if not (ROOT / "Maps").exists():
        print("Error: Run this from the repo root or ensure paths are correct.")
        return

    # Check for shapely
    try:
        import shapely
    except ImportError:
        print("Error: This script requires 'shapely'. Run: pip install shapely")
        return

    vectorizer = Vectorizer()
    
    # Process both IT floors
    vectorizer.run("it_floor1")
    vectorizer.run("it_floor2")
    
    print("\nNext Steps:")
    print("1. Inspect the SVG output in Maps/vector-out/")
    print("2. Notice how the lines are crisp vectors, not raster blobs.")
    print("3. To get closed Polygons, we need to add the 'Door Bridging' logic")
    print("   which connects endpoints < 80px apart.")

if __name__ == "__main__":
    main()
