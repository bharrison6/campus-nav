from __future__ import annotations

from pathlib import Path

import cv2


ROOT = Path(__file__).resolve().parents[2]
IN_DIR = ROOT / "Maps" / "it-floor-split-backup"
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-external"


def process(name: str) -> None:
    src = IN_DIR / name
    img = cv2.imread(str(src))
    if img is None:
        raise FileNotFoundError(str(src))
    h, w = img.shape[:2]
    out = img.copy()

    # Name-agnostic external cleanup zones (safe outside floor geometry).
    # Collins block (if present)
    out[int(0.50 * h) : int(0.90 * h), 0 : int(0.44 * w)] = 255
    # Murray State wordmark area (if present)
    out[int(0.09 * h) : int(0.31 * h), int(0.42 * w) : int(0.90 * w)] = 255
    # Bottom-left "MARTHA LAYN" remnants
    out[int(0.88 * h) : h, int(0.00 * w) : int(0.80 * w)] = 255
    # Bottom-right "Rev..." remnants
    out[int(0.92 * h) : h, int(0.80 * w) : w] = 255
    # Right-side stray "E"/dash remnants
    out[int(0.20 * h) : int(0.45 * h), int(0.76 * w) : w] = 255

    stem = name.replace("_locked", "")
    cv2.imwrite(str(OUT_DIR / stem), out)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    process("it_floor1_split_locked.png")
    process("it_floor2_split_locked.png")
    print(f"Wrote outputs to: {OUT_DIR}")


if __name__ == "__main__":
    main()
