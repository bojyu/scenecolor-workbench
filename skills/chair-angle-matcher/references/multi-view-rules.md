# Same-model multi-view rules

Use multi-view matching only when a scene contains two or more chairs at different angles and the visible product identity is consistent.

## Identity gate

Require agreement on at least four of these cues: upholstery panels, stitching, headrest or lumbar pillow, armrest construction, seat-edge profile, base, footrest capability, and color/material. Set `sceneMode: multi_mixed` and return `unmatched` when product identity or footrest state conflicts.

## Instance output

Keep `angle: multiple` and `azimuth: null` at scene level. Record one instance per chair with a stable ID, angle, azimuth, confidence, and decisive cue. Do not average instance azimuths.

## Reference package

For a same-model scene, choose:

1. One shallow oblique primary anchor that exposes both front construction and side thickness.
2. One front supporting anchor.
3. One side supporting anchor matching the visible profile.

Keep all anchors in the same color/material group and footrest state. Return one scene-color decision with `referenceMode: multi_view`, a primary `productPath`, and `supportingReferences`. Always set `status: review`.

When a generation endpoint supports several reference images, send the primary anchor first and supporting views afterward. When it supports only one reference, send only the primary anchor and preserve the `review` status.

## Safety gates

- Do not create a multi-view package from different chair models.
- Do not combine conflicting footrest states or capabilities.
- Do not use a supporting reference from another color group.
- Do not convert a scene-level `multiple` label into a compromise ground-truth azimuth.
- Do not automatically retry a model call to force same-model confirmation.
