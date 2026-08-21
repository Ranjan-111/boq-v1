/* Residual finder (#10).

   Two different things can be unresolved, and conflating them loses money:

     category unknown  - "is this furniture at all?"  A layer name can answer it.
     item unknown      - "which sofa is it?"          Only a block name can.

   A drawing with a clean A-FURN layer and a block called Block_17 already
   counts correctly -- the layer voted -- but has no item identity, so it cannot
   be priced or matched to a vendor product. That is still a residual, and in
   real drawings it is the common one. */

const CATEGORY_UNKNOWN = 'category+item';
const ITEM_UNKNOWN = 'item';

function residualsFor(document, { layerCategory, blockCategory, geometryFor = () => null } = {}) {
  const out = [];
  for (const entity of document.entities || []) {
    if (entity.type !== 'INSERT') continue;
    const fromLayer = layerCategory(entity.layer) || null;
    const fromBlock = blockCategory(entity.block);
    if (fromBlock !== null) continue; // the block name already identifies the item
    out.push({
      handle: entity.handle,
      blockName: entity.block || null,
      layer: entity.layer || null,
      categoryKnown: fromLayer,
      /* item: the count is already right, the identity is missing.
         category+item: nothing about this symbol is known. */
      missing: fromLayer ? ITEM_UNKNOWN : CATEGORY_UNKNOWN,
      geometry: geometryFor(entity) || entity.points || []
    });
  }
  return out;
}

function splitCounts(residuals) {
  return {
    total: residuals.length,
    itemUnknown: residuals.filter((residual) => residual.missing === ITEM_UNKNOWN).length,
    categoryUnknown: residuals.filter((residual) => residual.missing === CATEGORY_UNKNOWN).length
  };
}

module.exports = { residualsFor, splitCounts, CATEGORY_UNKNOWN, ITEM_UNKNOWN };
