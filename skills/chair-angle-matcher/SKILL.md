---
name: chair-angle-matcher
description: Identify gaming-chair viewing angles, image-facing direction, footrest capability and state, and same-model multi-chair views, then select feature-compatible product references. Use for batch scene-to-product matching, correcting front/left/right or mirror-inversion errors, distinguishing absent/retracted/extended/occluded footrests, defaulting completely invisible footrests to retracted references, building multi-view reference packs, preparing calibration labels, or maintaining a reusable chair-angle and feature index.
---

# Chair Angle Matcher

Identify chair azimuths and footrest states consistently, reduce them to the effective combinations present in a scene batch, and map each usable combination to one product reference per material or color group.

## Workflow

1. Inventory the scene and product folders. Do not change the web application or API configuration unless the user asks.
2. Read `references/angle-rules.md`, `references/visibility-rules.md`, and `references/footrest-rules.md` before classifying images. Read `references/multi-view-rules.md` when a scene contains more than one chair. Use one label convention only: `right` means the chair front/seat axis projects toward image-right; `left` means it projects toward image-left. Never derive the label from the screen position of the nearer armrest alone.
3. Build a contact sheet with `scripts/build-contact-sheet.mjs` for the first pass. Inspect an original image only when it is cropped, heavily occluded, contains overlays, or scores below 0.85 confidence.
4. Record one result per scene using the schema shown in `references/calibration-cases.json`. Record `angleObservability` as `exact`, `coarse`, or `none`, and record `imageFacingDirection` before assigning the angle. Require the angle family to agree with that direction. Classify footrest capability and visible state independently from angle. Never let an invisible-footrest fallback replace a shallow or side angle with `front`. Use `multiple` with `azimuth: null` and `imageFacingDirection: multiple` when a scene contains chairs at different angles, and record per-chair instances when they are the same model.
5. Cluster usable azimuths with `scripts/cluster-scenes.mjs`. Default to a 15-degree radius and keep `multiple` or `unknown` outside automatic matching.
6. Inspect the turntable sequence of one representative product group. Select only the nearest product anchor with the same footrest state for each scene cluster, then verify the equivalent filename in every other product group.
7. Use `references/product-angle-index.json` directly when the project contains the same J97A material library. Do not scan all 459 images again unless filenames or imagery changed.
8. Run `scripts/match-scenes.mjs` to enforce capability, footrest-state, and multi-view gates. Never substitute a retracted anchor for an extended scene. When the footrest region is completely invisible and the declared thresholds pass, keep the observation `unknown` but match the nearest retracted anchor with `footrestAssumedRetracted: true`.
9. Mark a result `review` when normal angle/footrest thresholds fail or a mirror fallback is required. Do not require review solely because the footrest is completely invisible when the configured invisible-to-retracted fallback and a direct angle anchor both pass.
10. Validate future prediction files against labeled data with `scripts/evaluate-results.mjs`. Report direction accuracy, footrest-state accuracy, extended recall, false-extended rate, joint accuracy, review rate, and unmatched rate separately.
11. After every training, rule, label, index, matcher, or evaluator update, follow `references/workbench-validation.md`. Open the actual workbench, load the offline Skill result, inspect automatic/review/blocked cases, and send the required screenshots. Do not claim completion from script-only tests.
12. Use `references/priority-one-generation-hard-negatives.json` only when auditing generated replacement outputs. Do not promote those failed outputs to angle anchors or positive scene matches.

## Call Budget

- Make one batch inspection pass.
- Make at most one additional inspection pass, and only for `review` items.
- Never retry a model or external API call automatically. Ask before using a paid API.
- Run post-training workbench validation through the offline Skill path by default; keep external API calls and Token usage at zero unless the user approves otherwise.
- Reuse cached contact sheets, angle labels, and product anchors when image hashes or filenames have not changed.
- Return `unknown` once when the footrest area is cropped or occluded. Do not loop until a forced state is produced.
- Do not generate replacement images during recognition and matching.

## Output Rules

- Keep exact filenames and use project-relative paths.
- Preserve continuous azimuths even when the coarse label is the same.
- Record `imageFacingDirection` as `left`, `right`, `center`, or `multiple`. Determine it from the projected chair-front/seat axis before using armrest scale to estimate the oblique amount.
- Infer the angle from visible backrest side panels, armrest scale, seat convergence, and base geometry before applying any footrest fallback. A hidden footrest changes only the effective footrest state, not the angle.
- Use `front=0`, `right=90`, `back=180`, and `left=270`.
- Enforce `front→center`, `front_right/right→right`, `front_left/left→left`, and `multiple→multiple`. Reject the result instead of silently selecting the opposite native anchor when this guard fails.
- Prefer one representative anchor per 15-degree cluster instead of one asset for every observed degree.
- Explain the decisive geometry in one short sentence; do not infer direction from a person alone when chair geometry is visible.
- Treat visible `extended` versus `retracted` as a hard compatibility gate. Treat a completely invisible footrest as retracted only through the declared fallback thresholds, and retain the original unknown observation in the output.
- Permit horizontal mirror fallback only when it is declared in the product index; always mark it `review`.
- Never auto-match `multiple` or `unknown` scenes. Permit only reviewed same-model multi-view packages for `multiple` scenes.

## Resources

- `references/angle-rules.md`: chair-centric direction convention and visual evidence hierarchy.
- `references/visibility-rules.md`: exact/coarse/none observability, crop handling, invisible-footrest fallback gates, and safe abstention.
- `references/footrest-rules.md`: capability/state taxonomy, visual evidence, hard gates, and mirror policy.
- `references/multi-view-rules.md`: same-model identity gate, per-chair instance labels, and multi-view reference packages.
- `references/partial-visibility-training-plan.md`: second-stage dataset, labeling, and acceptance plan for footrest feedback, half-chair crops, close-ups, and safe abstention.
- `references/third-stage-training-plan.md`: third-stage implementation scope and the remaining 96-image blind-data gate.
- `references/workbench-validation.md`: mandatory UI test, screenshot, reporting, and failure-handling protocol after every training iteration.
- `references/calibration-cases.json`: corrected angle and footrest examples for all 19 current scenes.
- `references/priority-one-training-cases.json`: first-priority QL-66B7 and LS-66D57H positives, multi-view review cases, hard negatives, and expected gates.
- `references/priority-one-generation-hard-negatives.json`: 12 major QL-66B1 generation failures for base, wheel, caster, and support-hardware auditing only.
- `references/product-angle-index.json`: retracted and extended anchors across seven J97A material groups.
- `scripts/build-contact-sheet.mjs`: deterministic visual inventory.
- `scripts/cluster-scenes.mjs`: circular azimuth clustering.
- `scripts/match-scenes.mjs`: deterministic state-gated product-reference matching.
- `scripts/evaluate-results.mjs`: repeatable accuracy evaluation.
