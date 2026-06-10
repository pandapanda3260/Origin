// 契约测试：世界观记录画面比例（preferredAspectRatio）+ 应用世界观时自动同步
// 链路与 preferredStyleTemplateId 同构：
//   记录侧：项目保存/更新世界观模板时带上当前画幅；关联世界观时模板缺画幅则用项目当前值补缺
//   应用侧：风格页关联世界观 → 同步 styleOptions.aspectRatio；续写下一集选模板 → 模板画幅优先于上一集继承
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---- 服务端 lib/world-templates-db.ts ----
const worldDb = readFileSync(new URL('../lib/world-templates-db.ts', import.meta.url), 'utf8');
// 画幅集合与读侧规范化
assert.ok(worldDb.includes("const WORLD_PREFERRED_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1'])"));
assert.ok(worldDb.includes('function preferredAspectRatioFrom(value: any)'));
assert.ok(worldDb.includes('if (preferredAspectRatio) out.preferredAspectRatio = preferredAspectRatio;'));
// 写侧：两条从项目构建模板的路径都要带画幅
assert.ok(worldDb.includes('function preferredAspectRatioFromProject(project: any)'));
assert.equal(worldDb.split('...preferredAspectRatioFromProject(project),').length - 1, 2,
  'buildWorldTemplateFromProject 与 buildWorldTemplateFromProjectSnapshot 都要 spread preferredAspectRatioFromProject');
// preferredAspectRatio 不允许进 stripVisualFields 黑名单
assert.ok(!worldDb.includes("'preferredAspectRatio',"), 'preferredAspectRatio 不能被 stripVisualFields 剥离');

// ---- 前端 assets.js ----
const assetsSource = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
assert.ok(assetsSource.includes('export function _normalizeWorldPreferredAspectRatio(value)'));
assert.ok(assetsSource.includes('export function _worldSnapshotPreferredAspectRatio(worldSnapshot)'));
// 关联世界观：模板缺画幅时用项目当前画幅补缺进快照
assert.ok(assetsSource.includes('if (aspect) worldSnapshot.preferredAspectRatio = aspect;'));
// 关联世界观：同步模板记录的画幅到项目
assert.ok(assetsSource.includes('var preferredAspect = _worldSnapshotPreferredAspectRatio(worldSnapshot);'));
assert.ok(assetsSource.includes('project.styleOptions.aspectRatio = preferredAspect;'));
// 防一次性默认迁移把 16:9 翻回 9:16
assert.ok(assetsSource.includes('project.styleOptions.aspectRatioDefaultVersion = "2026-05-14-9x16";'));
// 保存世界观弹窗展示画面比例
assert.ok(assetsSource.includes('var aspectText = _projectAspectRatioPreferenceForWorldSnapshot();'));

// ---- 前端 episodes.js（续写下一集）----
const episodesSource = readFileSync(new URL('../public/modules/episodes.js', import.meta.url), 'utf8');
assert.ok(episodesSource.includes("import { snapshotWorldTemplate, _normalizeWorldPreferredAspectRatio } from './assets.js';"));
// 继承上一集画幅时必须带 aspectRatioDefaultVersion，否则服务端迁移会把 16:9 翻回 9:16
assert.ok(episodesSource.includes('aspectRatioDefaultVersion: prevStyleOpts.aspectRatioDefaultVersion || _EP_ASPECT_DEFAULT_VERSION'));
// 模板记录的画幅优先于上一集继承
assert.ok(episodesSource.includes('var tplAspect = _normalizeWorldPreferredAspectRatio('));
assert.ok(episodesSource.includes('aspectRatio: tplAspect,'));

// ---- 前端 main.js ----
const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
// 世界观卡片副标题展示记录的画幅
assert.ok(mainSource.includes('function _styleWorldTemplatePreferredAspect(tpl)'));
assert.ok(mainSource.includes('var aspect = _styleWorldTemplatePreferredAspect(tpl);'));
// 应用世界观后刷新画幅选中态
const intentUiStart = mainSource.indexOf('function _renderStyleWorldIntentUi(intent)');
assert.ok(intentUiStart > 0);
const intentUiBody = mainSource.slice(intentUiStart, mainSource.indexOf('function _applyStyleWorldIntentLocal'));
assert.ok(intentUiBody.includes('_renderStyleAspectRatio();'), '_renderStyleWorldIntentUi 要刷新画幅选中态');

// ---- 服务端迁移常量与前端字面量同源 ----
const projectsDb = readFileSync(new URL('../lib/projects-db.ts', import.meta.url), 'utf8');
assert.ok(projectsDb.includes("const STYLE_ASPECT_DEFAULT_VERSION = '2026-05-14-9x16';"),
  '服务端迁移常量变了的话，episodes.js/assets.js/main.js 里的字面量要一起改');
assert.ok(episodesSource.includes('var _EP_ASPECT_DEFAULT_VERSION = "2026-05-14-9x16";'));
assert.ok(mainSource.includes('var _STYLE_ASPECT_DEFAULT_VERSION = "2026-05-14-9x16";'));

console.log('[test-world-aspect-preference-contract] all assertions passed');
