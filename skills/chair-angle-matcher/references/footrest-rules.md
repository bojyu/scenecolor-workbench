# Retractable footrest rules

## Taxonomy

Classify product capability and visible state separately:

```json
{
  "footrest": {
    "capability": "present",
    "state": "extended",
    "visibility": 0.95,
    "confidence": 0.98,
    "decisiveCue": "The padded footrest and both support rails project beyond the seat."
  }
}
```

- `capability`: `present`, `absent`, or `unknown`.
- `state`: `retracted`, `partial`, `extended`, `not_applicable`, or `unknown`.
- `visibility`: fraction from `0` to `1` describing how much decisive footrest geometry is visible.
- `confidence`: confidence in the state label, not confidence that an invisible product lacks a footrest.

Do not label capability `absent` merely because no pad is visible. Use `absent` only when the full under-seat/front structure is visible and either the product model is verified as having no footrest or the mounting rails and stored pad are demonstrably absent.

Use `not_applicable` only with capability `absent`. Keep the observation label `unknown` when the region is invisible; the matching layer may apply the declared fully-invisible fallback below without rewriting the observation.

## Evidence order

Use several cues in this order:

1. Separate padded footrest visibly projecting beyond the seat front.
2. One or two telescoping/support rails exposed between seat and pad.
3. Stored pad directly beneath the seat front with rails fully nested.
4. Distance between the seat front and pad compared with the pad's own depth.
5. Person's feet or reclined pose as supporting evidence only.

Ignore glow outlines, arrows, transparent motion copies, and a person's pose unless physical pad/rail geometry agrees.

## State decisions

- `extended`: the pad projects beyond the seat and support rails are exposed; accept a cropped detail when pad-to-rail continuity is clear.
- `partial`: the pad has moved beyond its stored position but the rails are not near their full visible length, or the image explicitly demonstrates an intermediate position.
- `retracted`: the stored pad is visible under the seat front and no rail extension is exposed. A full chair with no projecting pad may be `retracted` when the storage area is clearly visible.
- `unknown`: the footrest region is outside the crop, behind a desk/person, too dark, or covered by overlays. Preserve this observation even when the matching layer defaults a completely invisible region to a retracted reference.
- `not_applicable`: the complete under-seat/front structure is visible and confirms that the chair has no footrest capability.

## Match gate

Apply feature compatibility before angle distance:

1. Reject `extended` scene to `retracted` anchor and `retracted` scene to `extended` anchor.
2. Keep partially visible or conflicting `unknown` cases unmatched. When visibility is exactly `0`, invisibility confidence is at least `0.95`, angle confidence is at least `0.70`, and the angle is matchable, use the nearest retracted anchor automatically and set `footrestAssumedRetracted: true`.
3. After the state gate, select the nearest circular azimuth within the product index tolerance.
4. Use recline state only to break ties between anchors with the same angle and footrest state.
5. If the only usable reference is a declared horizontal mirror, return the declared source with `mirrored: true` and `status: review`.
6. For capability `absent`, prefer an explicit absent anchor. When the library has none, allow the nearest retracted anchor only as a structural fallback with `status: review` and `capabilityFallback: true`.
7. Do not apply the invisible fallback when any decisive footrest geometry is partly visible, the cues conflict, the angle is unknown/multiple, or the configured thresholds fail.

## Review thresholds

- Allow automatic matching when the normal footrest and angle thresholds pass, or when the fully-invisible fallback thresholds pass and a direct non-mirrored retracted anchor exists.
- Return `review` for partial crop, conflicting pad/rail cues, confidence below `0.85`, or declared mirror fallback.
- Return `unmatched` for partially visible/conflicting `unknown`, `partial` without an anchor, unknown angles, or a state with no compatible product reference.
- A fully invisible footrest region is an explicit operational exception: retain the observed capability/state as `unknown`, but use effective capability `present` and state `retracted` for reference matching. This fallback does not require review when the direct angle anchor exists.

## Current calibration coverage

The current 19-scene calibration set covers `extended`, `retracted`, and five fully invisible `unknown` scenes. Those five scenes exercise the invisible-to-retracted operational fallback. It does not contain a verified chair without footrest capability or a clear `partial` example; treat `absent` and `partial` as uncalibrated until labeled examples are added.
