---
name: chair-angle-matcher
description: Observe gaming-chair orientation, visibility, footrest state, and same-model multi-chair instances, then deterministically select compatible product references. Use for scene-to-product angle matching, left/right inversion diagnosis, partial-chair abstention, multi-view reference packs, calibration cases, or maintaining the chair-angle index.
---

# Chair Angle Matcher

Separate visual observation from deterministic product matching. The observer records evidence only; `scripts/match-scenes.mjs` owns semantic angle derivation, thresholds, workflow status, and anchor selection.

## Required flow

1. Open the template project folder, inventory scene images, and locate the product index. Reuse cached observations when their image, contract, policy, schema, and model hashes are unchanged.
2. For visual recognition, read `references/recognition-contract.md`. Emit one observation per project-relative scene path. Do not expose product anchors to the observer.
3. Run recognition in small batches. Preserve continuous azimuth and abstain with `coarse` or `none` when exact angle evidence is insufficient.
4. Require a human decision for every scene: confirm the observation or correct observability, azimuth/coarse direction, multi-chair instances, and footrest labels. Never publish pending observations.
5. Save corrections as a separate review run, then rerun `scripts/match-scenes.mjs` with `references/decision-policy.json` and the selected `product-angle-index.json`. Do not overwrite the source model run.
6. Publish only a complete reviewed run. Write structured cases to `references/training-cases.jsonl` when the user selects the Skill corpus, or to the project's `.scenecolor/case-corpus/cases.jsonl` when the user selects the local database. Do not rewrite `SKILL.md` automatically from examples.
7. Evaluate labeled predictions with `scripts/evaluate-results.mjs`. Report exact-angle accuracy, direction accuracy, observability accuracy, footrest metrics, auto precision, review rate, unmatched rate, and confidence calibration.
8. Keep run-scoped artifacts and update compatibility pointers atomically. Never let two runs write the same temporary output.

## Conditional references

- Read `references/angle-rules.md` only to investigate angle/direction ambiguity or curate labels.
- Read `references/visibility-rules.md` for crops, occlusion, close-ups, and abstention policy.
- Read `references/footrest-rules.md` for footrest-capability or state disputes.
- Read `references/multi-view-rules.md` when a scene contains multiple chairs.
- Read `references/case.schema.json` before adding or migrating reusable cases.
- Read `references/workbench-validation.md` only when changing rules, labels, indexes, matcher/evaluator behavior, or preparing a release validation.
- Training plans and generation hard negatives are planning/audit material; do not load them during ordinary matching.

## Hard constraints

- Use project-relative paths and preserve exact filenames.
- Never infer direction only from the nearer armrest or a person. Use the projected chair-front/seat axis and supporting chair geometry.
- Treat visible `extended` versus `retracted` as a hard compatibility gate. A hidden footrest may use only the policy-declared fallback and must retain the original unknown observation.
- Never silently select an opposite-direction native anchor. A declared mirror fallback is always `review`.
- `coarse`, `none`, `unknown`, and ordinary `multiple` observations cannot auto-match.
- Multi-view matching requires same-model evidence, per-instance observations, consistent footrest state, and at least the policy minimum number of unique views.
- Recognition does not generate replacement images, mutate the product library, or retry paid/external calls automatically.
- A model result, including an `auto` result, is not a training label until a human confirms or corrects it.

## Data lifecycle

Keep reusable cases provenance-aware and split-safe. Only adjudicated cases with known hashes and `retrievalEligible: true` may enter retrieval. Deduplicate by source/perceptual group before splitting. Keep regression, validation, and blind sets outside retrieval. Introduce vector retrieval only after the corpus and measured retrieval quality justify it; the default matcher remains deterministic.
