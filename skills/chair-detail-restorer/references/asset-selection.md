# Product Asset Selection

Build `product-assets.json` once per products-folder revision and reuse it while paths, sizes, and modification times remain unchanged.

## Grouping

- Treat the first directory below `products` as the product group when subdirectories exist.
- For flat folders, preserve each file under group `_root` until the workbench supplies an explicit SKU grouping.
- Never select a reference from a different group merely because its target is clearer.

## Asset Types

Classify assets as `full`, `logo`, `stitching`, `piping`, `texture`, or `hardware`. Use filenames as hints only; confirm the visible content before editing.

## Ranking

Rank candidate references in this order:

1. Same product group and exact requested target.
2. Highest usable native resolution.
3. Target unobstructed and sharply focused.
4. Viewpoint closest to the generated target surface.
5. Same material and color variant.
6. Full-product view only when no valid close-up exists.

Record the selected path and why it was selected in every region-plan target. If no trustworthy same-product reference exists, return `manual_review` instead of inventing detail.

## Cache Invalidation

Rebuild the manifest when any product image path, size, modification time, or group assignment changes. Do not rescan on every repair task.
