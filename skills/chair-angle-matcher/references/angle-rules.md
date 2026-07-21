# Chair angle rules

## Coordinate convention

All directions use the projected chair-front direction in the final image. This is the single operational convention for both scene labels and product anchors.

| Label | Azimuth | What the camera sees |
| --- | ---: | --- |
| `front` | 0° | Chair front, approximately symmetric |
| `front_right` | 1–79° | Shallow/front-oblique view whose chair front projects toward image-right |
| `right` | 80–100° | Side profile whose chair front points toward image-right |
| `back_right` | 101–169° | Back plus the chair's right side |
| `back` | 170–190° | Chair back |
| `back_left` | 191–259° | Back plus the chair's left side |
| `left` | 260–280° | Side profile whose chair front points toward image-left |
| `front_left` | 281–359° | Shallow/front-oblique view whose chair front projects toward image-left |

Do not name a side from the viewer-side location of the larger armrest. A profile whose seat/front points image-right is `right=90`, while a profile whose seat/front points image-left is `left=270`. The same rule applies to shallow obliques: image-right is `front_right`, image-left is `front_left`.

## Direction-first guard

Assign `imageFacingDirection` before the angle:

1. Trace the chair's seat/front axis or the centerline shared by the backrest, seated pelvis, and armrests.
2. Set `right` when that axis projects toward image-right, `left` when it projects toward image-left, and `center` when it is frontal and symmetric.
3. Use the nearer armrest, visible side-panel width, seat convergence, and base offset only to estimate how far the chair turns from front.
4. Compare the silhouette with both native product anchors when the center is occluded. Reject a result that needs the opposite native anchor unless a declared mirror fallback is intentionally being used.

The near armrest's screen position and the chair-front direction are not the same concept. Mapping an image-left near armrest directly to `front_left` can invert the result.

## Evidence order

Use several cues and prioritize them in this order:

1. Seat and clearly extended footrest projection: the exposed forward direction is the strongest side-profile cue. A retracted or occluded footrest is not directional evidence.
2. Backrest side surface and thickness: the visible side panel identifies the chair side.
3. Armrest perspective: the nearer armrest is larger, less occluded, and often farther from the centerline.
4. Base and gas-lift alignment: useful for confirming small front-left/front-right rotations.
5. Person pose: supporting evidence only. Use it when the pelvis/seat and chair back share the same horizontal axis; ignore a twisted head or upper body.
6. Logos, lighting, or shadows: never sufficient by themselves.

## Front versus shallow oblique

Label `front` only when the backrest, seat edge, armrests, and base are all approximately symmetric. If one armrest is clearly larger or the seat/front edge has consistent convergence, keep a continuous shallow azimuth such as 20° or 30°.

When a person hides the chair center or one side, do not treat the remaining visible backrest top as proof of a frontal view. Compare the visible side-panel width, near-armrest scale, armrest-to-center distance, and exposed bolster edge with the product anchors. If the visible near side is consistently larger, keep the matching shallow oblique label even when the seat and footrest are hidden.

Classify azimuth independently from footrest state. A footrest that is invisible and operationally defaulted to `retracted` must retain the angle inferred from the backrest and armrest geometry; never default its angle to `front`.

## Occlusion and overlays

- Judge visible chair geometry, not the composited person.
- Treat a person's facing direction as weak evidence only. It may confirm image-facing direction when the seated pelvis and chair geometry align, but it may not override conflicting chair geometry.
- Treat transparent motion/recline copies as the same angle when they share the same horizontal azimuth.
- Use `review` when decisive seat/back cues are mostly hidden or the crop removes more than half of the chair.
- A cropped footrest detail may still be directional, but should be low confidence.

## Multiple chairs

Do not average chairs at different azimuths. If they cannot be verified as the same product model, return:

```json
{
  "angle": "multiple",
  "azimuth": null,
  "chairCount": 2,
  "matchable": false,
  "status": "unmatched"
}
```

Do not average different chairs into one direction.

When two or more chairs are confidently the same model, record each chair as an instance and keep the scene-level angle as `multiple`. Permit a `multi_same_model` reference package only when model identity, footrest capability, footrest state, and material cues agree. Always mark this package `review`; never treat the averaged or compromise angle as scene truth. Read `multi-view-rules.md` before building the package.

## Confidence and review thresholds

- `auto`: confidence at least 0.85, occlusion at most 0.65, one dominant chair, and consistent geometry.
- `review`: confidence below 0.85, occlusion above 0.65, heavy crop, or conflicting cues.
- `unmatched`: mixed-model `multiple`, `unknown`, or no usable product anchor. Same-model multi-view packages remain `review`.

The threshold controls workflow, not truth. Keep the best angle estimate for review items instead of replacing it with `unknown`.
