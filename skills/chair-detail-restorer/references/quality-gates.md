# Quality Gates

Apply every global gate and the relevant target gate before accepting a repair.

## Global Gates

- Final width and height exactly match the source scene.
- File orientation and alpha behavior remain valid.
- No visible halo, rectangular crop edge, seam, blur jump, or color block appears at the mask boundary.
- Pixels outside the full-resolution mask remain unchanged within the validator threshold.
- People, background, non-target furniture, and unrequested chair geometry remain unchanged.
- The repaired target remains plausible at native resolution and normal review scale.

## Target Gates

### Logo

- Match the same-product reference identity, orientation, placement, aspect ratio, and local perspective.
- Preserve hard edges; avoid excessive feathering.
- Reject invented characters, mirrored lettering, unreadable marks, or a logo copied from another product group.

### Stitching

- Maintain path continuity, direction, pitch rhythm, thread color, and junction behavior.
- Reject duplicated parallel seams, abrupt line endings, or stitches crossing panel boundaries.

### Piping

- Maintain contour continuity and thickness through curves.
- Reject flattening, swelling, double edges, or material bleeding across the panel boundary.

### Texture

- Match local scale, grain direction, weave, sharpness, and highlight response.
- Reject repeating tiles, melted texture, or a sharpness mismatch against adjacent material.

### Hardware

- Preserve exact count, attachment point, perspective, edge hardness, and material finish.
- Return to regeneration if the target reveals missing major structure.

### Color

- Preserve luminance structure, texture, highlights, and shadows while correcting tone.
- Use a full-chair mask only for a mild controlled tone correction.
- Reject a repair that changes the color family, skin, clothing, floor, or background.

## Retry Policy

1. First failure: choose a sharper or better-angle same-product reference and tighten the instruction.
2. Second failure: expand the crop modestly while keeping the repair mask unchanged or safer.
3. Third failure: stop and return `manual_review`; never loop indefinitely.
