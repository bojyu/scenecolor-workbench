# Target Taxonomy

| Target | Repair | Do not repair |
|---|---|---|
| `logo` | Missing, misplaced, mirrored, blurred, malformed, wrong edge, spacing, or local contrast. | A logo difference that proves the entire chair is the wrong product. |
| `stitching` | Path, continuity, pitch, thread color, and local junction. | Major panel geometry or seat/backrest shape. |
| `piping` | Edge contour, thickness, continuity, and material transition. | A different large panel layout. |
| `texture` | Local grain, weave, leather highlight, compression blur, or small material patch. | Complete material-class replacement that requires regenerating the chair. |
| `hardware` | Screw, connector, caster cap, trim, or small finish detail. | Missing/wrong base, caster count, armrest mount, or major support. |
| `color` | Mild tone, local cast, local color-block edge, or controlled full-chair tone adjustment. | Wrong overall color family or wrong color-block layout. |
| `other` | A clearly local chair-only defect that fits all safety gates. | People, background, scene furniture, major geometry, or unclassified broad repainting. |

## One Target Per Operation

- Split spatially separate defects into separate target IDs.
- Permit one continuous seam or piping contour in one target when a single mask represents it cleanly.
- Keep exact logos isolated from soft texture or color masks.
- Stop and request manual review when a mask cannot avoid people or background without losing the target.
