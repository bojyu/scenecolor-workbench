# Routing Rules

Apply this precedence after listing all issues:

1. `regenerate` when any issue action is `regenerate`.
2. Otherwise use `manual_review` when any required comparison is uncertain or an issue action is `manual_review`.
3. Otherwise use `detail_repair` when at least one issue action is `detail_repair`.
4. Otherwise use `pass` and return no issues.

## Confirmed Boundaries

- Wrong overall color family → `regenerate`.
- Mild color difference → `detail_repair`.
- Missing, misplaced, mirrored, or inaccurate logo with correct product identity → `detail_repair`.
- Wrong product identity plus a logo problem → `regenerate`.
- Person or background abnormality → `regenerate`; never send it to detail restoration.
- Clean result → `pass`; do not send it to detail restoration.

## Uncertainty

Use `manual_review` instead of guessing when:

- The relevant chair component is fully occluded in both generated and usable references.
- Same-product references contradict one another.
- Multiple chairs appear to be different models and the intended mapping is unavailable.
- Image decoding, orientation, or task-to-image mapping is uncertain.

## Multi-Issue Examples

- Wrong five-star base plus blurred logo → `regenerate` because the base issue dominates.
- Correct chair plus misplaced logo and local color cast → `detail_repair` with two repair targets.
- Correct visible parts but armrests are fully hidden → `manual_review` only when armrest identity is required to distinguish the model.
- No actionable difference → `pass` with an empty `issues` array.
