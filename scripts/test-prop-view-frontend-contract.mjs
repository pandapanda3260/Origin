import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const assets = readFileSync(join(root, 'public/modules/assets.js'), 'utf8');
const workspace = readFileSync(join(root, 'public/workspace.html'), 'utf8');

assert.match(assets, /var PROP_VIEW_SLOTS = \["hero", "front", "back", "side_left", "side_right", "top"\]/, 'prop UI must render the six raw sheet slots');
assert.match(assets, /function _propViewOriginalUrl\(item, slot\)/, 'prop UI must resolve per-slot URLs');
assert.match(assets, /function _propCanonicalOriginalUrl\(item\)/, 'prop UI must resolve canonical prop URL from views before legacy fields');
assert.match(assets, /function _propViewGridHtml\(item, idx\)/, 'prop UI must render a dedicated prop view grid');
assert.match(assets, /function _propViewsErrorHtml\(item\)/, 'prop UI must render split failure feedback');
assert.match(assets, /data-prop-views-error/, 'prop split failure feedback must have a stable marker');
assert.match(assets, /data-prop-image-error/, 'prop generation failure feedback must have a separate stable marker');
assert.match(assets, /新图已生成，但没有切出可用的多视图/, 'split failure copy must not claim image generation failed');
assert.match(assets, /道具图生成失败；系统没有替换当前道具图/, 'image failure copy must be distinct from split failure copy');
assert.match(assets, /asset-prop-view-grid[\s\S]*grid-cols-3 grid-rows-2/, 'prop view grid must be 3x2');
assert.match(assets, /\(propViewsHtml \? '' : thumbHtml\)/, 'prop cards with views must not also show the legacy single thumb');
assert.match(assets, /if \(type === "prop" && extra\.views && typeof extra\.views === "object"\)[\s\S]*item\.views = extra\.views/, 'task_completed must merge prop views payload');
assert.match(assets, /if \(type === "prop" && extra\.viewsError\)[\s\S]*item\.viewsError = extra\.viewsError/, 'task_completed must preserve prop split errors');
assert.doesNotMatch(assets, /item\.imageLastError = extra\.viewsError/, 'split errors must not be mirrored into imageLastError');
assert.match(assets, /if \(type === "prop" && extra\.viewsError\) \{\s*delete item\.imageLastError;\s*delete item\.imageFailedAt;\s*item\.viewsError = extra\.viewsError/, 'split errors must clear stale image generation errors before writing viewsError');
assert.match(assets, /if \(type === "prop" && \(extra\.views \|\| extra\.viewsError\) && Array\.isArray\(proj\.props\)/, 'task_completed must sync top-level props for split errors too');
assert.match(assets, /if \(type === "prop" && \(extra\.views \|\| extra\.viewsError\)\) renderAssets\(\)/, 'prop completion must redraw the whole card after merging views or split errors');
assert.match(assets, /if \(type === "prop" && _propHasViewSlots\(item\)\) _rerenderAssetGrid\("prop"\)/, 'polling fallback must rerender prop view cards');
assert.match(workspace, /"\/modules\/assets\.js": "\/modules\/assets\.js\?v=182"/, 'assets.js import map version must be bumped');

console.log('[test-prop-view-frontend-contract] all assertions passed');
