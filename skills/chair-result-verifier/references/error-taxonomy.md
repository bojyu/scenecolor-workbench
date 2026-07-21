# Error Taxonomy

Use the smallest category that explains the visible failure. Report multiple independent issues when needed.

| Category | Regenerate when | Detail repair when |
|---|---|---|
| `product_identity` | The chair is a different model or the defining silhouette is wrong. | Never. |
| `armrest` | Shape, count, mounting, or large geometry differs. | Only a tiny surface mark differs. |
| `base_and_wheels` | Five-star base, caster count, base material, or support geometry is wrong. | A small hardware finish differs. |
| `backrest` | Backrest outline, headrest, lumbar assembly, or panel layout is wrong. | Fine seam, piping, texture, or logo needs repair. |
| `seat` | Seat shape, thickness, proportion, or attachment is wrong. | Fine seam, piping, or local material needs repair. |
| `overall_color` | Main color family or color-block layout is clearly different. | Mild tone, exposure, or local color deviation. |
| `logo_placement` | Never by itself when product identity is correct. | Missing, misplaced, mirrored, blurred, or visibly wrong logo. |
| `chair_count` | Chair is missing, duplicated, fused, or mixed with an unintended model. | Never. |
| `person_anatomy` | Missing limb, impossible pose, body/chair fusion, or person holds a chair part incorrectly. | Never; the detail skill must not modify people. |
| `scene_integrity` | Non-target people, furniture, foreground objects, or background regions disappear or change materially. | Never; the detail skill must not modify the scene. |
| `physical_plausibility` | Floating chair, impossible support, severe collision, broken perspective, or irrational scale/contact. | A small edge transition can be repaired locally. |
| `local_color` | Never when geometry and color family are correct. | Local or mild chair color mismatch. |
| `stitching` | Never unless it proves a different product model. | Stitch path, pitch, continuity, or thread color differs. |
| `piping` | Never unless the large panel structure is wrong. | Piping contour, thickness, or material transition differs. |
| `texture` | Regenerate only when the complete material class is wrong and cannot be corrected safely. | Local grain, weave, leather highlight, or surface texture differs. |
| `hardware_detail` | Regenerate when a major structural part is absent or wrong. | Screw, connector, trim, or finish detail differs. |

## Scope Boundary

- Treat a defect as local when it can be enclosed in one or a few masks without changing product geometry, people, or background.
- Treat a large structural correction as regeneration even if a broad mask could technically cover it.
- Permit a mild whole-chair tone correction in detail restoration only through a chair mask and controlled color adjustment, not free generative repainting.
- Do not reject a clean image for tiny differences that are invisible at normal review scale.
