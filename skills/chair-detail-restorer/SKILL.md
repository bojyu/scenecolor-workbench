---
name: chair-detail-restorer
description: Restore local chair details in an otherwise valid generated scene by selecting high-resolution references from the products folder, locating defects, planning normalized regions, cropping with context, building masks, performing constrained local redraws, compositing patches back at original coordinates, and validating that pixels outside repair masks remain unchanged. Use only for results routed as detail_repair, including logo, stitching, piping, mild color, texture, and small hardware defects; never use it to repair wrong products, people, backgrounds, major structure, or impossible geometry.
---

# 椅子细节定位与重绘

Execute a low-variance locate → crop → mask → redraw → composite → validate pipeline. Keep model judgment in planning and visual editing; keep coordinates, cropping, masking, compositing, and safety checks deterministic.

## Entry Gate

Start only when `chair-result-verifier` returned `detail_repair` and product identity, people, scene integrity, and major geometry passed.

Reject and return to regeneration when a requested repair would alter:

- Product model or major silhouette.
- Armrest, base, backrest, or seat geometry.
- People, anatomy, clothing, or held objects.
- Background, foreground furniture, or scene layout.
- Impossible contact, scale, or perspective.

Finish immediately with `no_repair_needed` when the verification task contains no detail targets.

## Workflow

1. Read `references/target-taxonomy.md`, `references/asset-selection.md`, and `references/quality-gates.md`.
2. Build or reuse the product manifest:
   `python scripts/index-product-assets.py <products-dir> --output <manifest.json>`
3. Select references from the same product group. Prefer a target-specific high-resolution close-up, then the nearest visible full-product angle. Never borrow detail from another SKU or color group.
4. Locate every requested target on the verified scene. Output one entry per independent repair using `references/region-plan.schema.json` and normalized coordinates. Run `python scripts/validate-region-plan.py <plan.json>` before cropping.
5. Keep separate defects separate. Do not use one broad crop for unrelated logo, stitching, and hardware repairs.
6. Crop each region with context:
   `python scripts/crop-region.py --image <scene> --bbox x1 y1 x2 y2 --normalized --padding 0.20 --output <crop> --metadata <crop.json>`
7. Build a mask from the region plan. Keep the mask inside the crop and feather only enough to hide the join:
   `python scripts/build-mask.py --image <scene> --region-plan <plan.json> --target-id <id> --output <full-mask.png>`
8. Convert the full mask to crop coordinates or use the crop metadata when invoking the configured image-edit backend. Give the editor the untouched crop, target-specific product reference, mask, and one precise edit instruction. Preserve crop dimensions.
9. Composite the edited crop back at its saved coordinates:
   `python scripts/composite-region.py --base <scene> --patch <edited-crop> --mask <crop-mask> --metadata <crop.json> --output <composite>`
10. Validate dimensions and outside-mask protection:
    `python scripts/validate-composite.py --source <scene> --composite <composite> --mask <full-mask> --output <report.json>`
11. Inspect the repaired target at native resolution and normal review scale. Apply the target-specific gates in `references/quality-gates.md`.
12. Retry at most twice. First retry with a better reference or clearer instruction; second retry with a modestly expanded crop. Do not silently widen the repair to people or background.
13. Return `completed`, `manual_review`, or `regenerate`. Preserve every intermediate artifact and attempt record.

## Color Handling

- Repair a local color mismatch through the local mask.
- Permit a mild whole-chair tone correction only through an accurate full-chair mask and controlled color adjustment.
- Never free-generate an entire chair to fix tone.
- Return to regeneration when the color family or color-block layout is wrong.

## Region Rules

- Use normalized coordinates in all model output; deterministic scripts convert them to pixels.
- Require `0 <= x1 < x2 <= 1` and `0 <= y1 < y2 <= 1`.
- Default crop padding to 20% of the target width and height; clamp to image bounds.
- Prefer 8–24 px mask feathering at source resolution. Use less around exact logos and hard hardware edges.
- Never resize the final canvas.
- Never modify pixels outside the declared full-resolution mask beyond the configured numerical tolerance.

## Progress Events

Emit progress only after the corresponding artifact exists:

- `10`: targets and same-product reference group configured.
- `25`: region plan and evidence validated.
- `40`: crops, masks, and coordinate metadata written.
- `70`: local redraw outputs written.
- `90`: patches composited at original dimensions.
- `100`: quality gates passed and final output saved.

## Resources

- `references/target-taxonomy.md`: supported targets and forbidden scope.
- `references/asset-selection.md`: products-folder indexing and reference ranking.
- `references/region-plan.schema.json`: locator output contract.
- `references/quality-gates.md`: target-specific and global acceptance checks.
- `scripts/index-product-assets.py`: deterministic product-reference manifest builder.
- `scripts/validate-region-plan.py`: deterministic plan, coordinate, and target validator.
- `scripts/crop-region.py`: bounded normalized crop and coordinate metadata writer.
- `scripts/build-mask.py`: full-resolution bbox or polygon mask builder.
- `scripts/composite-region.py`: coordinate-preserving masked crop compositor.
- `scripts/validate-composite.py`: dimension and outside-mask change validator.
