#!/usr/bin/env python3
"""Crop a bounded repair region and save exact source-coordinate metadata."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageOps


def parse_bbox(values: list[float], width: int, height: int, normalized: bool) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = values
    if normalized:
        if not all(0 <= value <= 1 for value in values):
            raise ValueError("normalized bbox values must be within 0..1")
        x1, x2 = x1 * width, x2 * width
        y1, y2 = y1 * height, y2 * height
    if not (x1 < x2 and y1 < y2):
        raise ValueError("bbox must satisfy x1<x2 and y1<y2")
    return x1, y1, x2, y2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--bbox", nargs=4, type=float, metavar=("X1", "Y1", "X2", "Y2"), required=True)
    parser.add_argument("--normalized", action="store_true")
    parser.add_argument("--padding", type=float, default=0.2)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    if not 0 <= args.padding <= 0.5:
        parser.error("padding must be within 0..0.5")
    with Image.open(args.image) as source:
        image = ImageOps.exif_transpose(source).copy()
    width, height = image.size
    try:
        x1, y1, x2, y2 = parse_bbox(args.bbox, width, height, args.normalized)
    except ValueError as exc:
        parser.error(str(exc))

    pad_x = (x2 - x1) * args.padding
    pad_y = (y2 - y1) * args.padding
    crop_box = (
        max(0, math.floor(x1 - pad_x)),
        max(0, math.floor(y1 - pad_y)),
        min(width, math.ceil(x2 + pad_x)),
        min(height, math.ceil(y2 + pad_y)),
    )
    target_box = (math.floor(x1), math.floor(y1), math.ceil(x2), math.ceil(y2))
    crop = image.crop(crop_box)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    crop.save(args.output)
    metadata = {
        "schemaVersion": "1.0",
        "sourceImage": str(args.image.resolve()),
        "sourceSize": [width, height],
        "targetBboxPixels": list(target_box),
        "cropBoxPixels": list(crop_box),
        "cropSize": list(crop.size),
        "padding": args.padding,
        "cropImage": str(args.output.resolve()),
    }
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    args.metadata.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"success": True, "cropBoxPixels": list(crop_box), "cropSize": list(crop.size)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
