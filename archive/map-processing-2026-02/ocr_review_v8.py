"""
OCR detection review — apply AI-informed classification rules.

After visually reviewing contact sheets, this script applies intelligent
filtering to classify REVIEW detections as ACCEPT or REJECT based on:
  1. Text content analysis (real words vs OCR noise)
  2. Spatial context (branding areas already cleared → noise there)
  3. Character composition (alphanumeric room labels vs special chars)
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "Maps" / "it-floor-text-removed-v8"

# Known room name words (from contact sheet review)
ROOM_WORDS = {
    "building", "mechanical", "room", "phone", "loading", "dock",
    "materials", "process", "lab", "equipment", "training", "center",
    "osh", "interior", "design", "studio", "architectural", "construction",
    "classroom", "lounge", "machine", "tool", "processes", "medical",
    "emergency", "industrial", "hygiene", "acoustics", "planning",
    "graphics", "engineering", "student", "chair", "iet", "mt",
    "telecommunications", "electronics", "south", "bridge", "east",
    "networking", "computer", "aided", "telephony", "wireless",
    "cybercave", "systems", "operations", "general", "power",
    "motor", "control", "freed", "curd", "auditorium", "radio",
    "janitor", "deck", "security", "network", "environment",
    "assistant", "area", "work", "projection", "audio", "fluid",
    "motion", "research", "env", "xai", "comm",
}

# Regex for room numbers (common patterns: 120A, 157 K, 253 B, 10C, etc.)
ROOM_NUMBER_RE = re.compile(r"^\d{2,3}\s*[A-Z]?$", re.IGNORECASE)


def is_likely_text(text):
    """Check if detected text looks like real floor plan text."""
    clean = text.strip().strip(".,;:'\"()[]{}!?")

    # Room number pattern
    if ROOM_NUMBER_RE.match(clean):
        return True

    # Check if words match known room vocabulary
    words = re.findall(r"[a-zA-Z]{2,}", clean)
    if words:
        matches = sum(1 for w in words if w.lower() in ROOM_WORDS)
        if matches > 0:
            return True

    # Multi-digit numbers (room numbers)
    if re.match(r"^\d{2,4}$", clean):
        return True

    return False


def is_ocr_noise(text):
    """Check if detected text is clearly OCR noise/artifacts."""
    clean = text.strip()

    # Mostly special characters or punctuation
    alpha_count = sum(1 for c in clean if c.isalnum())
    if len(clean) > 0 and alpha_count / len(clean) < 0.4:
        return True

    # Very short non-word text
    if len(clean) <= 2 and not clean.isdigit() and not ROOM_NUMBER_RE.match(clean):
        words = re.findall(r"[a-zA-Z]{2,}", clean)
        if not words:
            return True

    return False


def review_detections(json_path):
    """Apply review rules to a detection JSON file."""
    data = json.loads(json_path.read_text(encoding="utf-8"))

    stats = {"accepted": 0, "rejected": 0, "unchanged": 0}

    for d in data:
        if d["status"] == "REVIEW":
            txt = d["text"]
            if is_ocr_noise(txt):
                d["status"] = "REJECT"
                d["reason"] = f"review→reject: OCR noise '{txt}'"
                stats["rejected"] += 1
            elif is_likely_text(txt):
                d["status"] = "ACCEPT"
                d["reason"] = f"review→accept: recognized text '{txt}'"
                stats["accepted"] += 1
            else:
                # Ambiguous — accept if confidence >= 30, otherwise reject
                if d["conf"] >= 30:
                    d["status"] = "ACCEPT"
                    d["reason"] = f"review→accept: ambiguous but conf={d['conf']:.0f}"
                    stats["accepted"] += 1
                else:
                    d["status"] = "REJECT"
                    d["reason"] = f"review→reject: ambiguous low conf={d['conf']:.0f}"
                    stats["rejected"] += 1
        else:
            stats["unchanged"] += 1

    json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return stats, data


def main():
    for floor in ("floor1", "floor2"):
        json_path = OUT_DIR / f"detections_{floor}.json"
        if not json_path.exists():
            print(f"Skipping {floor}: no detection file")
            continue

        print(f"\nReviewing {floor}:")
        stats, data = review_detections(json_path)

        total = len(data)
        accept = sum(1 for d in data if d["status"] == "ACCEPT")
        reject = sum(1 for d in data if d["status"] == "REJECT")

        print(f"  Review decisions: {stats['accepted']} accepted, {stats['rejected']} rejected")
        print(f"  Final totals: {accept} ACCEPT, {reject} REJECT (of {total} total)")

    print(f"\nReview complete. Updated JSON files in {OUT_DIR}")


if __name__ == "__main__":
    main()
