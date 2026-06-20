/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const batch = fs.readFileSync(path.join(root, 'lib/batch-executors.ts'), 'utf8');
const imageGen = fs.readFileSync(path.join(root, 'lib/image-gen.ts'), 'utf8');
const extractRoute = fs.readFileSync(path.join(root, 'app/api/assets/extract/route.ts'), 'utf8');
const prompts = fs.readFileSync(path.join(root, 'lib/prompts.ts'), 'utf8');

assert.match(imageGen, /propDimensionality\?: 'volumetric' \| 'flat'/, 'ImageGenInput must carry propDimensionality');
assert.match(imageGen, /PROP SIX-VIEW REFERENCE SHEET RULES/, 'volumetric props must use the six-view sheet prompt');
assert.match(imageGen, /3 columns × 2 rows/, 'six-view sheet prompt must lock a 3x2 canvas');

assert.match(batch, /normalizePropDimensionality\(item\?\.dimensionality, item\)/, 'asset_images must normalize prop dimensionality');
assert.match(batch, /isVolumetricProp \? '1536x1024' : '1024x1024'/, 'volumetric props must request a 1536x1024 sheet');
assert.match(batch, /quality: type === 'prop' && !isVolumetricProp \? 'low' : 'medium'/, 'volumetric props must use medium quality while flat props remain low');
assert.match(batch, /isVolumetricProp \? 'prop-view-sheet' : undefined/, 'volumetric prop source image must be stored as prop-view-sheet');
assert.match(batch, /stage: 'splitting_prop_views'/, 'asset_images must split volumetric prop sheets');
assert.match(batch, /applyPropViewWrite\(baseAsset/, 'assets.props writeback must use applyPropViewWrite');
assert.match(batch, /applyPropViewWrite\(baseTop/, 'top-level props writeback must use applyPropViewWrite');
assert.match(batch, /const emittedImageUrl = type === 'prop' && isVolumetricProp \? eventPropUrl : result\.url/, 'prop completion events must emit the split canonical URL, not the sheet URL');
assert.match(batch, /sourceSheetUrl: type === 'prop' && isVolumetricProp \? result\.url : undefined/, 'prop events may expose sheet only as sourceSheetUrl');
assert.match(batch, /views: type === 'prop' && isVolumetricProp && propViewResult\?\.ok \? propViewResult\.views : undefined/, 'prop completion event must carry the whole views map');

assert.match(prompts, /"dimensionality": "volumetric 或 flat"/, 'prop extraction schema must ask for dimensionality');
assert.match(prompts, /dimensionality 必须二选一/, 'prop extraction rules must define flat versus volumetric');
assert.match(extractRoute, /dimensionality: normalizePropDimensionality\(p\.dimensionality, p\)/, 'extract route must normalize produced dimensionality');
assert.match(extractRoute, /props: \['name', 'propType', 'features', 'material', 'dimensionality', 'imagePrompt'\]/, 'dimensionality must participate in prop image stale detection');

console.log('[test-prop-view-generation-contract] all assertions passed');

