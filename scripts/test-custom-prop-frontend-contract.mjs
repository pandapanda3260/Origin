import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const modulePath = join(root, 'public/modules/prop_custom.js');
assert.equal(existsSync(modulePath), true, 'prop_custom.js must exist');

const propModule = readFileSync(modulePath, 'utf8');
const toolbox = readFileSync(join(root, 'public/modules/toolbox.js'), 'utf8');
const workspace = readFileSync(join(root, 'public/workspace.html'), 'utf8');
const main = readFileSync(join(root, 'public/main.js'), 'utf8');
const styles = readFileSync(join(root, 'public/styles.css'), 'utf8');

assert.doesNotMatch(propModule, /from '\/modules\/assets\.js'|from "\/modules\/assets\.js"/, 'prop_custom.js must not import assets.js');
assert.match(propModule, /import \{[\s\S]*hydrateProtectedImageElements[\s\S]*\} from '\/modules\/utils\.js'/, 'prop_custom.js must import hydrateProtectedImageElements');
assert.match(propModule, /function _render\(\)[\s\S]*hydrateProtectedImageElements\(root\)/, 'main render must hydrate protected images');
assert.match(propModule, /function _openPropViewsLightbox\(prop\)[\s\S]*hydrateProtectedImageElements\(overlay\)/, 'lightbox render must hydrate protected images');
assert.match(propModule, /var PROP_VIEW_SLOTS = \['hero', 'front', 'back', 'side_left', 'side_right', 'top'\]/, 'prop custom must carry six view slots');
assert.match(propModule, /function _propViewOriginalUrl\(item, slot\)/, 'prop custom must resolve per-slot URLs');
assert.match(propModule, /function _propHasViewSlots\(item\)[\s\S]*PROP_VIEW_SLOTS\.some/, 'prop custom must gate six-view UI on usable slots');
assert.match(propModule, /function _itemDisplayImageUrl\(item\)[\s\S]*displayImageUrl/, 'thumbnail source must consume backend displayImageUrl');
assert.doesNotMatch(propModule, /function _propCanonicalOriginalUrl/, 'prop custom must not reimplement canonical thumbnail ordering');
assert.match(propModule, /data-prop-views-error/, 'split failure must have a stable marker');
assert.match(propModule, /data-prop-image-error/, 'image generation failure must have a stable marker');
assert.match(propModule, /新图已生成，但没有切出可用的多视图；系统没有替换当前道具图。/, 'split failure copy must be distinct');
assert.match(propModule, /道具图生成失败；系统没有替换当前道具图。/, 'image failure copy must be distinct');
assert.match(propModule, /data-prop-image/, 'single-image fallback action must exist');
assert.match(propModule, /data-prop-views/, 'six-view lightbox action must exist');
assert.match(propModule, /function _findPropListEntry\(id\)[\s\S]*\(_items \|\| \[\]\)[\s\S]*\(_drafts \|\| \[\]\)/, 'six-view and image actions must resolve confirmed items and drafts');
assert.match(propModule, /var item = _findPropListEntry\(views\.getAttribute\('data-prop-views'\)\)/, 'draft six-view action must open the draft entry');
assert.match(propModule, /apiUpload\('\/api\/prop-custom\/items\/' \+ encodeURIComponent\(id\) \+ '\/image'/, 'prop card upload must call prop-custom image route');

assert.match(toolbox, /tool: 'propCustom'[\s\S]*title: '道具定制'[\s\S]*goto: 'propCustom'/, 'toolbox must expose prop custom entry');

assert.match(workspace, /"propCustom"/, 'workspace boot page list must include propCustom');
assert.match(workspace, /data-workspace-boot-page="propCustom"[\s\S]*#pagePropCustom/, 'boot guard must include pagePropCustom');
assert.match(workspace, /id="pagePropCustom"[\s\S]*id="propCustomRoot"/, 'workspace must include prop custom page container');
assert.match(workspace, /"\/modules\/prop_custom\.js": "\/modules\/prop_custom\.js\?v=101"/, 'workspace import map must include prop_custom.js');
assert.match(workspace, /"\/modules\/toolbox\.js": "\/modules\/toolbox\.js\?v=206"/, 'workspace import map must bump toolbox.js for the new prop entry');
assert.match(workspace, /main\.js\?v=364/, 'workspace main script version must be bumped for prop page wiring');
assert.match(workspace, /styles\.css\?v=254/, 'styles import version must be bumped for prop custom CSS');

assert.match(main, /import \{ initPropCustom, refreshPropCustomPage, _initPropCustomEvents \} from '\/modules\/prop_custom\.js'/, 'main must import prop custom module');
assert.match(main, /"propCustom"/, 'main PAGES must include propCustom');
assert.match(main, /activePage === "propCustom"[\s\S]*refreshPropCustomPage\(\{ force: true \}\)/, 'refreshAllPages must refresh prop custom when active');
assert.match(main, /page === "propCustom"[\s\S]*refreshPropCustomPage\(\)/, 'switchPage must refresh prop custom');
assert.match(main, /initPropCustom\(\{[\s\S]*openLightbox/, 'boot must initialize prop custom');
assert.match(main, /_initPropCustomEvents\(\)/, 'global event wiring must initialize prop custom events');

assert.match(styles, /\.prop-custom-card/, 'styles must define prop custom card');
assert.match(styles, /\.prop-custom-view-grid[\s\S]*grid-template-columns: repeat\(3, 1fr\)/, 'styles must render six-view grid as 3 columns');

console.log('[test-custom-prop-frontend-contract] all assertions passed');
