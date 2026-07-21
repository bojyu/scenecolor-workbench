#!/usr/bin/env python3
"""Build a deterministic manifest of full-product and high-resolution detail references."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
TYPE_HINTS = [
    ("logo", ("logo", "brand", "标志", "标识", "商标")),
    ("stitching", ("stitch", "seam", "thread", "缝线", "车线", "针脚")),
    ("piping", ("piping", "welt", "edge", "滚边", "包边")),
    ("texture", ("texture", "material", "fabric", "leather", "grain", "纹理", "材质", "面料", "皮革")),
    ("hardware", ("hardware", "screw", "caster", "wheel", "base", "metal", "五金", "螺丝", "滚轮", "五星脚", "底盘")),
]
VIEW_HINTS = [
    ("front", ("front", "正面", "前视")),
    ("back", ("back", "rear", "背面", "后视")),
    ("left", ("left", "左侧", "左视")),
    ("right", ("right", "右侧", "右视")),
    ("side", ("side", "侧面", "侧视")),
    ("detail", ("detail", "closeup", "close-up", "特写", "细节")),
]


def classify(text: str, hints: list[tuple[str, tuple[str, ...]]], fallback: str) -> str:
    lowered = text.lower()
    for label, terms in hints:
        if any(term in lowered for term in terms):
            return label
    return fallback


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("products_dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hash", action="store_true", help="Include SHA-256 hashes; slower on large libraries")
    args = parser.parse_args()

    root = args.products_dir.resolve()
    if not root.is_dir():
        parser.error(f"products directory does not exist: {root}")

    assets: list[dict[str, object]] = []
    errors: list[dict[str, str]] = []
    for path in sorted((item for item in root.rglob("*") if item.is_file() and item.suffix.lower() in IMAGE_EXTENSIONS), key=lambda item: item.as_posix().lower()):
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        try:
            with Image.open(path) as image:
                oriented = ImageOps.exif_transpose(image)
                width, height = oriented.size
                image_format = image.format or path.suffix.lstrip(".").upper()
            stat = path.stat()
            group = relative.parts[0] if len(relative.parts) > 1 else "_root"
            searchable = " ".join(relative.parts)
            asset = {
                "path": relative.as_posix(),
                "group": group,
                "assetType": classify(searchable, TYPE_HINTS, "full"),
                "view": classify(searchable, VIEW_HINTS, "unknown"),
                "width": width,
                "height": height,
                "megapixels": round(width * height / 1_000_000, 3),
                "format": image_format,
                "fileSize": stat.st_size,
                "modifiedNs": stat.st_mtime_ns,
            }
            if args.hash:
                asset["sha256"] = sha256(path)
            assets.append(asset)
        except Exception as exc:  # Pillow reports many decoder-specific exception types.
            errors.append({"path": relative.as_posix(), "error": str(exc)})

    counts: dict[str, int] = {}
    for asset in assets:
        key = str(asset["assetType"])
        counts[key] = counts.get(key, 0) + 1

    payload = {
        "schemaVersion": "1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "productsRoot": str(root),
        "assetCount": len(assets),
        "countsByType": counts,
        "assets": assets,
        "errors": errors,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"success": True, "assetCount": len(assets), "errorCount": len(errors), "output": str(args.output.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
