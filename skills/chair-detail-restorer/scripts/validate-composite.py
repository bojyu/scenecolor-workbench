#!/usr/bin/env python3
"""Validate canvas size and quantify visible pixel changes outside the declared repair mask."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--composite", type=Path, required=True)
    parser.add_argument("--mask", type=Path, required=True, help="Full-canvas repair mask")
    parser.add_argument("--pixel-threshold", type=int, default=4)
    parser.add_argument("--max-outside-change-ratio", type=float, default=0.0005)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if not 0 <= args.pixel_threshold <= 255:
        parser.error("pixel-threshold must be within 0..255")
    if not 0 <= args.max_outside_change_ratio <= 1:
        parser.error("max-outside-change-ratio must be within 0..1")

    with Image.open(args.source) as value:
        source = ImageOps.exif_transpose(value).convert("RGBA")
    with Image.open(args.composite) as value:
        composite = ImageOps.exif_transpose(value).convert("RGBA")
    with Image.open(args.mask) as value:
        mask = ImageOps.exif_transpose(value).convert("L")

    dimensions_match = source.size == composite.size == mask.size
    outside_changed = 0
    outside_pixels = 0
    ratio = 1.0
    max_outside_delta = 255
    if dimensions_match:
        source_array = np.asarray(source, dtype=np.int16)
        composite_array = np.asarray(composite, dtype=np.int16)
        mask_array = np.asarray(mask, dtype=np.uint8)
        delta = np.max(np.abs(source_array - composite_array), axis=2)
        outside = mask_array == 0
        outside_pixels = int(np.count_nonzero(outside))
        changed = outside & (delta > args.pixel_threshold)
        outside_changed = int(np.count_nonzero(changed))
        ratio = outside_changed / outside_pixels if outside_pixels else 0.0
        max_outside_delta = int(delta[outside].max()) if outside_pixels else 0

    passed = dimensions_match and ratio <= args.max_outside_change_ratio
    report = {
        "schemaVersion": "1.0",
        "passed": passed,
        "dimensionsMatch": dimensions_match,
        "sourceSize": list(source.size),
        "compositeSize": list(composite.size),
        "maskSize": list(mask.size),
        "pixelThreshold": args.pixel_threshold,
        "maxAllowedOutsideChangeRatio": args.max_outside_change_ratio,
        "outsidePixelCount": outside_pixels,
        "outsideChangedPixelCount": outside_changed,
        "outsideChangeRatio": ratio,
        "maxOutsideChannelDelta": max_outside_delta,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
