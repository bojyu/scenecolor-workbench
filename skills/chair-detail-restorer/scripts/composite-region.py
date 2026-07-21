#!/usr/bin/env python3
"""Composite an edited crop back onto the source canvas using saved coordinates and a crop-space mask."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageOps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--mask", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    crop_box = metadata.get("cropBoxPixels")
    source_size = metadata.get("sourceSize")
    if not isinstance(crop_box, list) or len(crop_box) != 4:
        parser.error("metadata must contain cropBoxPixels")
    if not isinstance(source_size, list) or len(source_size) != 2:
        parser.error("metadata must contain sourceSize")

    with Image.open(args.base) as value:
        base = ImageOps.exif_transpose(value).convert("RGBA")
    with Image.open(args.patch) as value:
        patch = ImageOps.exif_transpose(value).convert("RGBA")
    with Image.open(args.mask) as value:
        mask = ImageOps.exif_transpose(value).convert("L")

    if list(base.size) != [int(source_size[0]), int(source_size[1])]:
        parser.error(f"base size {base.size} does not match metadata sourceSize {source_size}")
    x1, y1, x2, y2 = (int(value) for value in crop_box)
    expected_size = (x2 - x1, y2 - y1)
    if patch.size != expected_size:
        parser.error(f"patch size {patch.size} must equal crop size {expected_size}; do not resize edited crops")
    if mask.size == base.size:
        mask = mask.crop((x1, y1, x2, y2))
    if mask.size != expected_size:
        parser.error(f"mask size {mask.size} must equal crop size {expected_size} or full canvas {base.size}")

    patch_alpha = patch.getchannel("A")
    combined_alpha = ImageChops.multiply(patch_alpha, mask)
    patch.putalpha(combined_alpha)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.alpha_composite(patch, dest=(x1, y1))
    result = Image.alpha_composite(base, layer)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.suffix.lower() in {".jpg", ".jpeg"}:
        result.convert("RGB").save(args.output, quality=100, subsampling=0)
    else:
        result.save(args.output)
    print(json.dumps({"success": True, "size": list(result.size), "cropBoxPixels": crop_box, "output": str(args.output.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
