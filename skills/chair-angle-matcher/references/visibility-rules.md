# Visibility and Safe-Abstention Rules

Classify angle observability before deciding whether a scene can be matched. Footrest visibility remains an independent observation.

## Angle Observability

- `exact`: the seat axis plus at least two structural cues are visible. Structural cues include backrest side panels, armrest perspective, seat-edge convergence, base orientation, or a full side silhouette. A direct product anchor may be selected when confidence and feature gates pass.
- `coarse`: the left/right/front family is inferable, but crop, person, desk, cutaway, or overlay removes the geometry needed to place the scene inside the product index tolerance. Preserve the coarse label and set `matchable: false` unless a human verifies an exact azimuth.
- `none`: no usable chair axis exists. Use `angle: unknown`, `azimuth: null`, `matchable: false`, and `status: unmatched`.

Do not promote a scene from `coarse` or `none` because a historical filename, previous output, person orientation, or proposed product reference suggests an angle. The scene pixels must provide the evidence.

## Crop and Close-Up Gates

- Fabric macros, seat-construction cutaways, isolated armrest crops, and upper-back crops do not inherit the full-chair angle from a nearby scene.
- A cutaway can retain a coarse direction only when its remaining seat and armrest geometry visibly support it.
- A person or desk may hide the decisive seat-front region. Record a coarse direction if the back and armrest still support it, but abstain from an exact anchor.
- Same-model multi-chair scenes require per-chair instances. Do not collapse distinct angles into a single average.

## Footrest Visibility

- Visible `extended` versus `retracted` is a hard compatibility gate even when azimuth is identical.
- When the footrest region is partly visible, classify only what is supported by visible pad and rail geometry. Low visibility alone never turns `unknown` into `retracted`.
- A completely invisible footrest may use the declared retracted-reference fallback only when visibility is exactly `0`, invisibility confidence meets the product-index threshold, the angle is `exact`, and a direct same-angle retracted anchor exists.
- Preserve `observedFootrestState: unknown` and set `footrestAssumedRetracted: true` when that fallback is used.
- Do not apply the invisible-footrest fallback to `coarse`, `none`, `multiple`, or already unmatchable scenes.

## Expected Gates

- `exact` + compatible visible state + direct anchor: `auto` when normal confidence thresholds pass.
- `exact` + fully invisible footrest + declared direct fallback: `auto`, with the unknown observation preserved.
- `multi_same_model` + complete same-state reference pack: `review`.
- `coarse`, `none`, state conflict, incomplete multi-view pack, or missing same-state anchor: `unmatched`.
