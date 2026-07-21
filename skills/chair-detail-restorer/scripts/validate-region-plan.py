#!/usr/bin/env python3
"""Validate a chair detail region plan before any crop or edit is performed."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


TARGETS = {"logo", "stitching", "piping", "texture", "hardware", "color", "other"}


def validate(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be an object"]
    if payload.get("schemaVersion") != "1.0":
        errors.append("schemaVersion must equal 1.0")
    for key in ("taskId", "sourceImage", "productGroup"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            errors.append(f"{key} is required")
    targets = payload.get("targets")
    if not isinstance(targets, list) or not targets:
        return errors + ["targets must be a non-empty array"]

    seen: set[str] = set()
    for index, target in enumerate(targets):
        prefix = f"targets[{index}]"
        if not isinstance(target, dict):
            errors.append(f"{prefix} must be an object")
            continue
        target_id = target.get("id")
        if not isinstance(target_id, str) or not target_id.strip():
            errors.append(f"{prefix}.id is required")
        elif target_id in seen:
            errors.append(f"{prefix}.id must be unique")
        else:
            seen.add(target_id)
        if target.get("type") not in TARGETS:
            errors.append(f"{prefix}.type is invalid")
        for key in ("referencePath", "instruction", "evidence"):
            if not isinstance(target.get(key), str) or not target[key].strip():
                errors.append(f"{prefix}.{key} is required")
        bbox = target.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4 or not all(isinstance(value, (int, float)) and 0 <= value <= 1 for value in bbox):
            errors.append(f"{prefix}.bbox must contain four numbers within 0..1")
        elif not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
            errors.append(f"{prefix}.bbox must satisfy x1<x2 and y1<y2")
        polygon = target.get("polygon")
        if polygon is not None:
            if not isinstance(polygon, list) or len(polygon) < 3:
                errors.append(f"{prefix}.polygon must contain at least three points")
            elif any(not isinstance(point, list) or len(point) != 2 or not all(isinstance(value, (int, float)) and 0 <= value <= 1 for value in point) for point in polygon):
                errors.append(f"{prefix}.polygon points must be normalized pairs")
        padding = target.get("cropPadding")
        if not isinstance(padding, (int, float)) or not 0 <= padding <= 0.5:
            errors.append(f"{prefix}.cropPadding must be within 0..0.5")
        feather = target.get("featherPx")
        if not isinstance(feather, int) or not 0 <= feather <= 64:
            errors.append(f"{prefix}.featherPx must be an integer within 0..64")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    args = parser.parse_args()
    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"valid": False, "errors": [str(exc)]}, ensure_ascii=False, indent=2))
        return 2
    errors = validate(payload)
    print(json.dumps({"valid": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
