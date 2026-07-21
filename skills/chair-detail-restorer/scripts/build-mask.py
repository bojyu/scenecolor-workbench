#!/usr/bin/env python3
"""Build a full-resolution or crop-space feathered mask from a region-plan target."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps


def normalized_point(point: list[float], width: int, height: int) -> tuple[int, int]:
    return round(point[0] * width), round(point[1] * height)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--region-plan", type=Path, required=True)
    parser.add_argument("--target-id", required=True)
    parser.add_argument("--crop-metadata", type=Path, help="Crop full mask to cropBoxPixels")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    plan = json.loads(args.region_plan.read_text(encoding="utf-8"))
    matches = [target for target in plan.get("targets", []) if target.get("id") == args.target_id]
    if len(matches) != 1:
        parser.error(f"target-id must match exactly one target, found {len(matches)}")
    target = matches[0]
    with Image.open(args.image) as source:
        image = ImageOps.exif_transpose(source)
        width, height = image.size

    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    polygon = target.get("polygon")
    if polygon:
        draw.polygon([normalized_point(point, width, height) for point in polygon], fill=255)
    else:
        bbox = target.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4 or not all(isinstance(value, (int, float)) and 0 <= value <= 1 for value in bbox):
            parser.error("target bbox must contain four normalized values")
        x1, y1 = normalized_point(bbox[:2], width, height)
        x2, y2 = normalized_point(bbox[2:], width, height)
        if x1 >= x2 or y1 >= y2:
            parser.error("target bbox must satisfy x1<x2 and y1<y2")
        draw.rectangle((x1, y1, x2, y2), fill=255)

    feather = int(target.get("featherPx", 12))
    if feather < 0 or feather > 64:
        parser.error("featherPx must be within 0..64")
    if feather:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=max(0.5, feather / 2)))

    coordinate_space = "full"
    if args.crop_metadata:
        metadata = json.loads(args.crop_metadata.read_text(encoding="utf-8"))
        box = metadata.get("cropBoxPixels")
        if not isinstance(box, list) or len(box) != 4:
            parser.error("crop metadata is missing cropBoxPixels")
        mask = mask.crop(tuple(int(value) for value in box))
        coordinate_space = "crop"

    args.output.parent.mkdir(parents=True, exist_ok=True)
    mask.save(args.output)
    print(json.dumps({"success": True, "size": list(mask.size), "coordinateSpace": coordinate_space, "output": str(args.output.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
