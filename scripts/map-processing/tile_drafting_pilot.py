"""
Tile-based drafting pilot runner for IT floor plans using Gemini multimodal models.

Workflow:
  1) prep    -> generate tile crops + macro images + manifest
  2) draft   -> run pass-1 model extraction (macro + micro)
  3) refine  -> render QA overlay and run pass-2 refinement (macro + micro + QA)
  4) stitch  -> convert tile-local vectors to global coords, dedupe, render overlay

Outputs are written under Maps/tile-drafting-pilot-floor{N}/ by default.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import cv2
import jsonschema
import numpy as np
from PIL import Image, ImageDraw

try:
    from google import genai
    from google.genai import types as genai_types
except Exception:  # pragma: no cover - import failure handled at runtime
    genai = None
    genai_types = None


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / "Maps" / "it-floor-reproduced" / "isolated_floor2.png"
DEFAULT_OUT = ROOT / "Maps" / "tile-drafting-pilot-floor2"

TILES_DIR = "tiles"
MACRO_DIR = "macro"
QA_DIR = "qa"
RESP_DIR = "responses"
STITCH_DIR = "stitched"
REPORT_DIR = "reports"

MANIFEST_NAME = "tiles_manifest.json"
STITCHED_JSON = "stitched_floor_vectors.json"
STITCHED_OVERLAY = "stitched_overlay.png"

DEFAULT_TILE_SIZE = 1024
DEFAULT_OVERLAP = 128

VECTOR_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": True,
    "required": ["status", "methodology_used", "vectors", "reasoning"],
    "properties": {
        "status": {
            "type": "string",
            "enum": ["DRAFTING", "REFINED", "FLAG_FOR_MANUAL_REVIEW"],
        },
        "methodology_used": {"type": "string"},
        "vectors": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": True,
                "required": ["type", "nodes"],
                "properties": {
                    "type": {"type": "string", "enum": ["wall", "doorway_gap"]},
                    "nodes": {
                        "type": "array",
                        "minItems": 2,
                        "items": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 2,
                            "items": {"type": "number"},
                        },
                    },
                },
            },
        },
        "reasoning": {"type": "string"},
    },
}


PROMPT_BASE = """You are an expert Architectural Drafting Agent equipped with advanced spatial reasoning.
Your objective is to extract mathematically precise, vector-based wall coordinates from a noisy bitmap floor-plan tile.

You will receive:
1) A macro-map image showing the full floor with the current tile bounding box.
2) A micro-tile image (the working area).
3) Optionally a QA-tile image with your previously proposed vectors overlaid in bright neon green.

Rules:
- Work in MICRO-TILE pixel coordinates only, origin at top-left (0,0).
- Do not output any coordinates outside the tile bounds.
- Default to long straight orthogonal centerlines where visually supported.
- If geometry is angled/curved, increase node density only as needed.
- Distinguish structural linework (walls/openings) from labels/text/noise artifacts.
- Use doorway_gap vectors only for visible wall interruptions/openings.
- If a joint is obscured by text/noise, use trajectory extrapolation instead of snapping to letters.
- If the tile is ambiguous/illegible, output FLAG_FOR_MANUAL_REVIEW instead of guessing.

Respond ONLY with JSON matching this schema shape:
{
  "status": "DRAFTING" | "REFINED" | "FLAG_FOR_MANUAL_REVIEW",
  "methodology_used": "...",
  "vectors": [
    {"type": "wall", "nodes": [[x1,y1],[x2,y2], ...]},
    {"type": "doorway_gap", "nodes": [[x1,y1],[x2,y2]]}
  ],
  "reasoning": "brief explanation"
}
"""


@dataclass
class TileRef:
    tile_id: str
    bbox: Tuple[int, int, int, int]  # x0, y0, x1, y1
    row: int
    col: int


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dirs(base: Path) -> None:
    for name in [TILES_DIR, MACRO_DIR, QA_DIR, RESP_DIR, STITCH_DIR, REPORT_DIR]:
        (base / name).mkdir(parents=True, exist_ok=True)


def _load_image(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def _save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _grid_starts(full: int, tile: int, stride: int) -> List[int]:
    if full <= tile:
        return [0]
    starts = list(range(0, max(1, full - tile + 1), stride))
    last = full - tile
    if starts[-1] != last:
        starts.append(last)
    return starts


def _build_tiles(img_w: int, img_h: int, tile_size: int, overlap: int) -> List[TileRef]:
    stride = max(1, tile_size - overlap)
    xs = _grid_starts(img_w, tile_size, stride)
    ys = _grid_starts(img_h, tile_size, stride)
    tiles: List[TileRef] = []
    for r, y0 in enumerate(ys):
        for c, x0 in enumerate(xs):
            x1 = min(img_w, x0 + tile_size)
            y1 = min(img_h, y0 + tile_size)
            tile_id = f"r{r:02d}_c{c:02d}"
            tiles.append(TileRef(tile_id=tile_id, bbox=(x0, y0, x1, y1), row=r, col=c))
    return tiles


def _neighbors(tile: TileRef, all_tiles: Sequence[TileRef]) -> List[str]:
    out: List[str] = []
    for other in all_tiles:
        if other.tile_id == tile.tile_id:
            continue
        if abs(other.row - tile.row) <= 1 and abs(other.col - tile.col) <= 1:
            out.append(other.tile_id)
    return sorted(out)


def _tile_nonwhite_ratio(tile_img: Image.Image, threshold: int = 245) -> float:
    arr = np.array(tile_img)
    return float(np.mean(np.any(arr < threshold, axis=2)))


def _tile_geometry_priority(tile_img: Image.Image) -> str:
    gray = cv2.cvtColor(np.array(tile_img), cv2.COLOR_RGB2GRAY)
    _, bw = cv2.threshold(gray, 220, 255, cv2.THRESH_BINARY_INV)
    lines = cv2.HoughLinesP(bw, 1, np.pi / 180.0, threshold=40, minLineLength=40, maxLineGap=8)
    if lines is None:
        return "sparse"
    non_ortho = 0
    ortho = 0
    for line in lines[: min(len(lines), 200)]:
        x1, y1, x2, y2 = line[0]
        ang = abs(math.degrees(math.atan2(y2 - y1, x2 - x1))) % 180.0
        if min(abs(ang - 0), abs(ang - 90), abs(ang - 180)) <= 8:
            ortho += 1
        else:
            non_ortho += 1
    if non_ortho >= 6:
        return "angled_wing"
    if ortho >= 10:
        return "orthogonal"
    return "mixed"


def prep_tiles(
    source: Path,
    out_dir: Path,
    tile_size: int,
    overlap: int,
    macro_max: int,
    select_count: int,
) -> None:
    _ensure_dirs(out_dir)
    img = _load_image(source)
    w, h = img.size
    tiles = _build_tiles(w, h, tile_size, overlap)

    macro_base = img.copy()
    macro_base.thumbnail((macro_max, macro_max))
    sx = macro_base.size[0] / w
    sy = macro_base.size[1] / h

    tile_records: List[Dict[str, Any]] = []
    candidates: List[Tuple[str, float, str]] = []
    for t in tiles:
        x0, y0, x1, y1 = t.bbox
        crop = img.crop((x0, y0, x1, y1))
        crop_path = out_dir / TILES_DIR / f"{t.tile_id}.png"
        crop.save(crop_path)

        macro = macro_base.copy()
        draw = ImageDraw.Draw(macro)
        draw.rectangle(
            [x0 * sx, y0 * sy, x1 * sx, y1 * sy],
            outline=(255, 0, 0),
            width=max(2, int(6 * max(sx, sy))),
        )
        macro_path = out_dir / MACRO_DIR / f"{t.tile_id}.png"
        macro.save(macro_path)

        nonwhite_ratio = _tile_nonwhite_ratio(crop)
        priority = _tile_geometry_priority(crop) if nonwhite_ratio > 0.01 else "blank"
        candidates.append((t.tile_id, nonwhite_ratio, priority))
        tile_records.append(
            {
                "tile_id": t.tile_id,
                "row": t.row,
                "col": t.col,
                "x0": x0,
                "y0": y0,
                "x1": x1,
                "y1": y1,
                "neighbors": _neighbors(t, tiles),
                "priority": priority,
                "nonwhite_ratio": round(nonwhite_ratio, 4),
                "status": "pending" if priority != "blank" else "skipped",
            }
        )

    selected = _auto_select_tiles(tile_records, select_count)
    selected_ids = {t["tile_id"] for t in selected}
    for rec in tile_records:
        rec["selected"] = rec["tile_id"] in selected_ids

    manifest = {
        "created_at": _now_iso(),
        "floor": "floor2",
        "source_image": str(source),
        "source_width": w,
        "source_height": h,
        "tile_size_px": tile_size,
        "overlap_px": overlap,
        "stride_px": max(1, tile_size - overlap),
        "macro_max_px": macro_max,
        "tiles": tile_records,
    }
    _save_json(out_dir / MANIFEST_NAME, manifest)

    report = {
        "created_at": _now_iso(),
        "total_tiles": len(tile_records),
        "selected_tiles": [r["tile_id"] for r in tile_records if r.get("selected")],
        "selection_summary": [
            {
                "tile_id": r["tile_id"],
                "priority": r["priority"],
                "nonwhite_ratio": r["nonwhite_ratio"],
            }
            for r in tile_records
            if r.get("selected")
        ],
    }
    _save_json(out_dir / REPORT_DIR / "prep_summary.json", report)
    print(f"Prepared {len(tile_records)} tiles in {out_dir}")
    print(f"Selected tiles: {', '.join(report['selected_tiles']) or '(none)'}")


def _auto_select_tiles(tile_records: List[Dict[str, Any]], select_count: int) -> List[Dict[str, Any]]:
    nonblank = [r for r in tile_records if r["priority"] != "blank"]
    if not nonblank:
        return []
    by_id = {r["tile_id"]: r for r in nonblank}
    selected: List[Dict[str, Any]] = []

    def pick(predicate) -> None:
        for r in sorted(nonblank, key=lambda x: (-x["nonwhite_ratio"], x["tile_id"])):
            if r in selected:
                continue
            if predicate(r):
                selected.append(r)
                return

    pick(lambda r: r["priority"] == "angled_wing")
    pick(lambda r: r["priority"] == "mixed")
    pick(lambda r: r["priority"] == "orthogonal")
    pick(lambda r: r["nonwhite_ratio"] > 0.18)

    for r in sorted(nonblank, key=lambda x: (-x["nonwhite_ratio"], x["tile_id"])):
        if len(selected) >= select_count:
            break
        if r not in selected:
            selected.append(r)
    return selected[:select_count]


def _require_genai() -> None:
    if genai is None or genai_types is None:
        raise RuntimeError("google-genai SDK is not installed")
    if not os.environ.get("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY environment variable is required")


def _get_client():
    _require_genai()
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def _load_manifest(out_dir: Path) -> Dict[str, Any]:
    path = out_dir / MANIFEST_NAME
    if not path.exists():
        raise FileNotFoundError(f"Manifest not found: {path}")
    return _load_json(path)


def _save_manifest(out_dir: Path, manifest: Dict[str, Any]) -> None:
    manifest["updated_at"] = _now_iso()
    _save_json(out_dir / MANIFEST_NAME, manifest)


def _selected_tiles(manifest: Dict[str, Any], tile_ids: Optional[Sequence[str]], only_selected: bool) -> List[Dict[str, Any]]:
    tiles = manifest["tiles"]
    if tile_ids:
        wanted = set(tile_ids)
        return [t for t in tiles if t["tile_id"] in wanted]
    if only_selected:
        return [t for t in tiles if t.get("selected")]
    return [t for t in tiles if t["status"] != "skipped"]


def _img_bytes(path: Path) -> bytes:
    return path.read_bytes()


def _call_gemini(
    client: Any,
    model: str,
    prompt_text: str,
    image_paths: Sequence[Path],
) -> str:
    parts = [prompt_text]
    for p in image_paths:
        parts.append(genai_types.Part.from_bytes(data=_img_bytes(p), mime_type="image/png"))
    resp = client.models.generate_content(
        model=model,
        contents=parts,
        config=genai_types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.1,
        ),
    )
    return (resp.text or "").strip()


def _parse_model_json(text: str) -> Dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try extracting fenced JSON or substring.
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


def _coerce_payload_shape(parsed: Any) -> Dict[str, Any]:
    # Some model runs return a single-element array despite JSON-mode prompts.
    if isinstance(parsed, list):
        if len(parsed) == 1 and isinstance(parsed[0], dict):
            return parsed[0]
        raise ValueError("Model returned JSON array; expected single object payload")
    if not isinstance(parsed, dict):
        raise ValueError(f"Model returned {type(parsed).__name__}; expected object payload")
    return parsed


def _sanitize_vectors(payload: Dict[str, Any], tile_w: int, tile_h: int) -> Tuple[Dict[str, Any], List[str]]:
    warnings: List[str] = []
    vectors = payload.get("vectors", [])
    sanitized: List[Dict[str, Any]] = []
    for i, vec in enumerate(vectors):
        vtype = vec.get("type")
        nodes = vec.get("nodes")
        if vtype not in ("wall", "doorway_gap") or not isinstance(nodes, list) or len(nodes) < 2:
            warnings.append(f"vector[{i}] dropped: invalid type/nodes")
            continue
        out_nodes: List[List[int]] = []
        for j, node in enumerate(nodes):
            if not isinstance(node, list) or len(node) != 2:
                warnings.append(f"vector[{i}].nodes[{j}] dropped: invalid node")
                continue
            try:
                x = int(round(float(node[0])))
                y = int(round(float(node[1])))
            except Exception:
                warnings.append(f"vector[{i}].nodes[{j}] dropped: non-numeric")
                continue
            clamped_x = min(max(0, x), max(0, tile_w - 1))
            clamped_y = min(max(0, y), max(0, tile_h - 1))
            if (clamped_x, clamped_y) != (x, y):
                warnings.append(f"vector[{i}].nodes[{j}] clamped from [{x},{y}]")
            out_nodes.append([clamped_x, clamped_y])
        if len(out_nodes) >= 2:
            sanitized.append({"type": vtype, "nodes": out_nodes})
        else:
            warnings.append(f"vector[{i}] dropped: <2 valid nodes")
    payload["vectors"] = sanitized
    return payload, warnings


def _validate_payload(payload: Dict[str, Any]) -> None:
    jsonschema.validate(instance=payload, schema=VECTOR_SCHEMA)


def _response_wrapper(tile: Dict[str, Any], pass_index: int, model: str, payload: Dict[str, Any], warnings: List[str], raw_text: str) -> Dict[str, Any]:
    return {
        "tile_id": tile["tile_id"],
        "pass_index": pass_index,
        "coord_space": "tile_px",
        "source_tile_bbox_global": [tile["x0"], tile["y0"], tile["x1"], tile["y1"]],
        "model_name": model,
        "timestamp": _now_iso(),
        "warnings": warnings,
        "payload": payload,
        "raw_text": raw_text,
    }


def _make_tile_prompt(tile: Dict[str, Any], tile_size: Tuple[int, int], refinement: bool) -> str:
    w, h = tile_size
    phase_text = (
        "This is a REFINEMENT pass. Critically evaluate the neon green overlay and correct any line that snaps to text, misses wall centers, or adds false geometry."
        if refinement
        else "This is a DRAFT pass. Extract the best initial wall centerlines and doorway gaps."
    )
    return (
        PROMPT_BASE
        + "\n"
        + phase_text
        + f"\nTile metadata: tile_id={tile['tile_id']}, tile_size={w}x{h}, priority={tile.get('priority','normal')}."
    )


def draft_tiles(
    out_dir: Path,
    model: str,
    tile_ids: Optional[List[str]],
    only_selected: bool,
    limit: Optional[int],
    overwrite: bool,
    retry_once: bool,
) -> None:
    client = _get_client()
    manifest = _load_manifest(out_dir)
    tiles = _selected_tiles(manifest, tile_ids, only_selected)
    if limit:
        tiles = tiles[:limit]

    for tile in tiles:
        tile_id = tile["tile_id"]
        out_path = out_dir / RESP_DIR / f"{tile_id}.pass1.json"
        if out_path.exists() and not overwrite:
            print(f"[draft] skip {tile_id}: response exists")
            continue
        micro_path = out_dir / TILES_DIR / f"{tile_id}.png"
        macro_path = out_dir / MACRO_DIR / f"{tile_id}.png"
        img = _load_image(micro_path)
        prompt = _make_tile_prompt(tile, img.size, refinement=False)

        raw_text = ""
        payload: Optional[Dict[str, Any]] = None
        errors: List[str] = []
        attempts = 2 if retry_once else 1
        for attempt in range(1, attempts + 1):
            try:
                call_prompt = prompt
                if attempt > 1:
                    call_prompt += "\nReturn strict JSON only. Do not include markdown fences."
                raw_text = _call_gemini(client, model, call_prompt, [macro_path, micro_path])
                payload = _coerce_payload_shape(_parse_model_json(raw_text))
                payload, warnings = _sanitize_vectors(payload, img.size[0], img.size[1])
                _validate_payload(payload)
                wrapped = _response_wrapper(tile, 1, model, payload, warnings, raw_text)
                _save_json(out_path, wrapped)
                tile["status"] = "drafted"
                print(f"[draft] ok {tile_id}: {len(payload.get('vectors', []))} vectors")
                break
            except Exception as exc:
                errors.append(f"attempt {attempt}: {exc}")
                payload = None
        if payload is None:
            fail = {
                "tile_id": tile_id,
                "pass_index": 1,
                "timestamp": _now_iso(),
                "model_name": model,
                "errors": errors,
                "raw_text": raw_text,
            }
            _save_json(out_path, fail)
            tile["status"] = "flagged"
            print(f"[draft] fail {tile_id}: {errors[-1] if errors else 'unknown error'}")
    _save_manifest(out_dir, manifest)


def _render_overlay(base_img: Image.Image, payload: Dict[str, Any]) -> Image.Image:
    out = base_img.copy()
    draw = ImageDraw.Draw(out)
    colors = {"wall": (57, 255, 20), "doorway_gap": (0, 255, 255)}
    widths = {"wall": 4, "doorway_gap": 5}
    for vec in payload.get("vectors", []):
        pts = [tuple(node) for node in vec.get("nodes", [])]
        if len(pts) < 2:
            continue
        color = colors.get(vec.get("type"), (57, 255, 20))
        width = widths.get(vec.get("type"), 4)
        draw.line(pts, fill=color, width=width, joint="curve")
        for p in pts:
            r = 3
            draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], outline=color, fill=color)
    return out


def refine_tiles(
    out_dir: Path,
    model: str,
    tile_ids: Optional[List[str]],
    only_selected: bool,
    limit: Optional[int],
    overwrite: bool,
    retry_once: bool,
) -> None:
    client = _get_client()
    manifest = _load_manifest(out_dir)
    tiles = _selected_tiles(manifest, tile_ids, only_selected)
    if limit:
        tiles = tiles[:limit]

    for tile in tiles:
        tile_id = tile["tile_id"]
        pass1_path = out_dir / RESP_DIR / f"{tile_id}.pass1.json"
        out_path = out_dir / RESP_DIR / f"{tile_id}.pass2.json"
        if out_path.exists() and not overwrite:
            print(f"[refine] skip {tile_id}: response exists")
            continue
        if not pass1_path.exists():
            print(f"[refine] skip {tile_id}: missing pass1")
            continue

        pass1 = _load_json(pass1_path)
        if "payload" not in pass1:
            print(f"[refine] skip {tile_id}: pass1 invalid/failure file")
            continue

        micro_path = out_dir / TILES_DIR / f"{tile_id}.png"
        macro_path = out_dir / MACRO_DIR / f"{tile_id}.png"
        micro_img = _load_image(micro_path)
        qa_img = _render_overlay(micro_img, pass1["payload"])
        qa_path = out_dir / QA_DIR / f"{tile_id}.qa.png"
        qa_img.save(qa_path)

        prompt = _make_tile_prompt(tile, micro_img.size, refinement=True)
        raw_text = ""
        payload: Optional[Dict[str, Any]] = None
        errors: List[str] = []
        attempts = 2 if retry_once else 1
        for attempt in range(1, attempts + 1):
            try:
                call_prompt = prompt
                if attempt > 1:
                    call_prompt += "\nReturn strict JSON only. No markdown."
                raw_text = _call_gemini(client, model, call_prompt, [macro_path, micro_path, qa_path])
                payload = _coerce_payload_shape(_parse_model_json(raw_text))
                payload, warnings = _sanitize_vectors(payload, micro_img.size[0], micro_img.size[1])
                _validate_payload(payload)
                wrapped = _response_wrapper(tile, 2, model, payload, warnings, raw_text)
                _save_json(out_path, wrapped)
                tile["status"] = "refined"
                print(f"[refine] ok {tile_id}: {len(payload.get('vectors', []))} vectors")
                break
            except Exception as exc:
                errors.append(f"attempt {attempt}: {exc}")
                payload = None
        if payload is None:
            fail = {
                "tile_id": tile_id,
                "pass_index": 2,
                "timestamp": _now_iso(),
                "model_name": model,
                "errors": errors,
                "raw_text": raw_text,
            }
            _save_json(out_path, fail)
            if tile["status"] != "drafted":
                tile["status"] = "flagged"
            print(f"[refine] fail {tile_id}: {errors[-1] if errors else 'unknown error'}")
    _save_manifest(out_dir, manifest)


def _iter_best_vectors(out_dir: Path, manifest: Dict[str, Any], tile_ids: Optional[Sequence[str]], only_selected: bool) -> Iterable[Tuple[Dict[str, Any], Dict[str, Any], int]]:
    tiles = _selected_tiles(manifest, tile_ids, only_selected)
    for tile in tiles:
        tile_id = tile["tile_id"]
        pass2_path = out_dir / RESP_DIR / f"{tile_id}.pass2.json"
        pass1_path = out_dir / RESP_DIR / f"{tile_id}.pass1.json"
        chosen = None
        pass_idx = 0
        if pass2_path.exists():
            data = _load_json(pass2_path)
            if "payload" in data:
                chosen = data["payload"]
                pass_idx = 2
        if chosen is None and pass1_path.exists():
            data = _load_json(pass1_path)
            if "payload" in data:
                chosen = data["payload"]
                pass_idx = 1
        if chosen is not None:
            yield tile, chosen, pass_idx


def _segment_key(nodes: List[List[int]], vtype: str, quant: int = 8) -> Tuple:
    pts = []
    for n in nodes:
        pts.append((int(round(n[0] / quant)), int(round(n[1] / quant))))
    if len(pts) >= 2:
        a = pts[0]
        b = pts[-1]
        ends = tuple(sorted([a, b]))
    else:
        ends = tuple(pts)
    return (vtype, ends, len(pts))


def stitch_vectors(
    out_dir: Path,
    source: Path,
    tile_ids: Optional[List[str]],
    only_selected: bool,
    render_overlay: bool,
) -> None:
    manifest = _load_manifest(out_dir)
    source_img = _load_image(source)
    draw = ImageDraw.Draw(source_img) if render_overlay else None

    stitched: List[Dict[str, Any]] = []
    dedupe: Dict[Tuple, Dict[str, Any]] = {}
    stats = {"tiles_used": 0, "vectors_before_dedupe": 0, "vectors_after_dedupe": 0}

    for tile, payload, pass_idx in _iter_best_vectors(out_dir, manifest, tile_ids, only_selected):
        stats["tiles_used"] += 1
        x0, y0 = tile["x0"], tile["y0"]
        for vec in payload.get("vectors", []):
            stats["vectors_before_dedupe"] += 1
            nodes_global = [[n[0] + x0, n[1] + y0] for n in vec["nodes"]]
            item = {
                "type": vec["type"],
                "nodes_global": nodes_global,
                "origin_tile_id": tile["tile_id"],
                "pass_index": pass_idx,
            }
            key = _segment_key(nodes_global, vec["type"])
            prev = dedupe.get(key)
            if prev is None or item["pass_index"] > prev["pass_index"]:
                dedupe[key] = item

    stitched = list(dedupe.values())
    stats["vectors_after_dedupe"] = len(stitched)
    out_json = {
        "created_at": _now_iso(),
        "floor": manifest.get("floor"),
        "source_image": str(source),
        "vectors": stitched,
        "stats": stats,
    }
    _save_json(out_dir / STITCH_DIR / STITCHED_JSON, out_json)

    if draw is not None:
        for vec in stitched:
            pts = [tuple(n) for n in vec["nodes_global"]]
            if len(pts) < 2:
                continue
            color = (57, 255, 20) if vec["type"] == "wall" else (0, 255, 255)
            width = 3 if vec["type"] == "wall" else 4
            draw.line(pts, fill=color, width=width)
        source_img.save(out_dir / STITCH_DIR / STITCHED_OVERLAY)
    _save_json(out_dir / REPORT_DIR / "stitch_summary.json", stats)
    print(f"Stitched {stats['vectors_after_dedupe']} vectors from {stats['tiles_used']} tiles")


def summarize(out_dir: Path) -> None:
    manifest = _load_manifest(out_dir)
    counts: Dict[str, int] = {}
    selected = 0
    for t in manifest["tiles"]:
        counts[t["status"]] = counts.get(t["status"], 0) + 1
        if t.get("selected"):
            selected += 1
    resp_files = sorted((out_dir / RESP_DIR).glob("*.json"))
    summary = {
        "generated_at": _now_iso(),
        "manifest_status_counts": counts,
        "selected_tiles": selected,
        "response_files": [p.name for p in resp_files],
    }
    _save_json(out_dir / REPORT_DIR / "status_summary.json", summary)
    print(json.dumps(summary, indent=2))


def _parse_tile_ids(text: Optional[str]) -> Optional[List[str]]:
    if not text:
        return None
    return [x.strip() for x in text.split(",") if x.strip()]


def _add_common_selection_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    p.add_argument("--tile-ids", type=str, help="Comma-separated tile ids")
    p.add_argument("--all", action="store_true", help="Use all non-skipped tiles instead of selected-only")
    p.add_argument("--limit", type=int)


def main() -> None:
    parser = argparse.ArgumentParser(description="Tile drafting pilot runner (Gemini)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prep = sub.add_parser("prep", help="Generate tiles, macro views, and manifest")
    p_prep.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    p_prep.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    p_prep.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    p_prep.add_argument("--overlap", type=int, default=DEFAULT_OVERLAP)
    p_prep.add_argument("--macro-max", type=int, default=1024)
    p_prep.add_argument("--select-count", type=int, default=5)

    p_draft = sub.add_parser("draft", help="Run pass-1 Gemini drafting on tiles")
    _add_common_selection_args(p_draft)
    p_draft.add_argument("--model", default="gemini-3-flash-preview")
    p_draft.add_argument("--overwrite", action="store_true")
    p_draft.add_argument("--no-retry", action="store_true")

    p_refine = sub.add_parser("refine", help="Run pass-2 Gemini refinement using QA overlays")
    _add_common_selection_args(p_refine)
    p_refine.add_argument("--model", default="gemini-3.1-pro-preview")
    p_refine.add_argument("--overwrite", action="store_true")
    p_refine.add_argument("--no-retry", action="store_true")

    p_stitch = sub.add_parser("stitch", help="Merge best tile vectors into global coords")
    _add_common_selection_args(p_stitch)
    p_stitch.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    p_stitch.add_argument("--no-overlay", action="store_true")

    p_summary = sub.add_parser("summary", help="Write/print current status summary")
    p_summary.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)

    args = parser.parse_args()

    if args.cmd == "prep":
        prep_tiles(
            source=args.source,
            out_dir=args.out_dir,
            tile_size=args.tile_size,
            overlap=args.overlap,
            macro_max=args.macro_max,
            select_count=args.select_count,
        )
        return

    if args.cmd == "summary":
        summarize(args.out_dir)
        return

    tile_ids = _parse_tile_ids(getattr(args, "tile_ids", None))
    only_selected = not getattr(args, "all", False)

    if args.cmd == "draft":
        draft_tiles(
            out_dir=args.out_dir,
            model=args.model,
            tile_ids=tile_ids,
            only_selected=only_selected,
            limit=args.limit,
            overwrite=args.overwrite,
            retry_once=not args.no_retry,
        )
        return

    if args.cmd == "refine":
        refine_tiles(
            out_dir=args.out_dir,
            model=args.model,
            tile_ids=tile_ids,
            only_selected=only_selected,
            limit=args.limit,
            overwrite=args.overwrite,
            retry_once=not args.no_retry,
        )
        return

    if args.cmd == "stitch":
        stitch_vectors(
            out_dir=args.out_dir,
            source=args.source,
            tile_ids=tile_ids,
            only_selected=only_selected,
            render_overlay=not args.no_overlay,
        )
        return

    raise RuntimeError(f"Unknown command: {args.cmd}")


if __name__ == "__main__":
    main()
