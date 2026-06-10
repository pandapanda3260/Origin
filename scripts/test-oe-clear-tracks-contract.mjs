/**
 * 剪辑SDK"清空轨道 + 空轨道同步自动铺设"契约测试（2026-06-11）
 *
 * 需求：壳层顶栏"同步素材"右侧新增「清空轨道」；点击清掉 VevDemo 工程全部轨道
 * （素材库不动）。轨道为空时点「同步素材」按当前剪辑方案自动铺设（同首次进入），
 * 轨道非空时绝不覆盖用户手工编排。
 *
 * 关键机制（防回归重点）：
 *   1. 写 EditParam.Track 前必须先销毁编辑器实例（SDK autoPublish 自动保存会用
 *      内存旧草稿盖掉刚写入的 Track），写完重建编辑器加载新草稿。
 *   2. 清空时必须保留 EditParam 其余字段（尤其 OriginTimelineTimeUnit 时间单位
 *      凭据），否则清空后再铺轨会被 resolveTimelineTimeUnit 拦下要求手动拖样本。
 *   3. 手动同步铺设 = onlyIfTracksEmpty，轨道非空跳过；首次进入自动铺设不受影响。
 *
 * 运行：node scripts/test-oe-clear-tracks-contract.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const oeSrc = readFileSync(new URL('../public/modules/online_editor.js', import.meta.url), 'utf8');
const feSrc = readFileSync(new URL('../vevdemo-1.0.6/fe/index.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');

// ── 壳层 HTML：按钮位于 同步素材 与 快捷键帮助 之间 ──
const syncIdx = htmlSrc.indexOf('id="oeBtnSyncMaterials"');
const clearIdx = htmlSrc.indexOf('id="oeBtnClearTracks"');
const helpIdx = htmlSrc.indexOf('id="oeBtnShortcutHelp"');
assert.ok(syncIdx > 0 && clearIdx > 0 && helpIdx > 0, 'workspace.html 必须有 同步素材/清空轨道/帮助 三个按钮');
assert.ok(syncIdx < clearIdx && clearIdx < helpIdx, '清空轨道按钮必须在同步素材右侧、帮助按钮左侧');

// ── 壳层 online_editor.js ──
assert.match(oeSrc, /function _handleClearTracksClick\(\)[\s\S]*?showConfirm/, '清空轨道必须带确认弹窗');
assert.match(oeSrc, /_sendToVevDemo\('origin:clearTracks', \{\}\)/, '清空轨道必须发 origin:clearTracks 桥消息');
assert.match(oeSrc, /_messageHandlers\.set\('vevdemo:tracksCleared'/, '必须等待 vevdemo:tracksCleared 回执');
assert.match(
  oeSrc,
  /const applyOptions = silent \? undefined : \{ onlyIfTracksEmpty: true, recreateEditor: true \};/,
  '手动同步必须用 onlyIfTracksEmpty+recreateEditor，silent 自动同步保持原行为',
);
assert.match(
  oeSrc,
  /skipped === 'tracks_not_empty'/,
  '壳层必须识别"轨道非空已跳过铺设"分支',
);
assert.match(
  oeSrc,
  /if \(_clearTracksBusyFlag\) \{\s*if \(!silent\) _oeCtx\?\.showToast\?\.\('正在清空轨道/,
  '清空进行中必须挡住同步素材，防并发写 EditParam',
);
assert.match(
  oeSrc,
  /_clearTracksBusyFlag = false; \/\/ iframe 都没了/,
  '销毁 iframe 时必须复位清空轨道在途状态',
);
assert.match(
  oeSrc,
  /_sendToVevDemo\('origin:applyTimeline', \{ plan, options: options \|\| \{\} \}\)/,
  'applyTimeline 桥消息必须携带 options',
);

// ── fe 桥 vevdemo-1.0.6/fe/index.js ──
assert.match(feSrc, /case 'origin:clearTracks':/, 'fe 桥必须处理 origin:clearTracks');
assert.match(
  feSrc,
  /async function handleOriginClearTracks\(\)[\s\S]*?destroyVevEditorInstance\('clear-tracks'\);[\s\S]*?Track: \[\],[\s\S]*?recreateVevEditorForSameProject\('clear-tracks'\)/,
  '清空流程必须 先销毁编辑器→写空 Track→重建编辑器（防 SDK 自动保存盖写）',
);
assert.match(
  feSrc,
  /const nextEditParam = \{\s*\.\.\.editParam,\s*Track: \[\],/,
  '清空必须展开保留 EditParam 其余字段（时间单位凭据 OriginTimelineTimeUnit 等）',
);
assert.match(
  feSrc,
  /function handleOriginApplyTimeline\(plan, options = \{\}\)/,
  'handleOriginApplyTimeline 必须接收 options',
);
assert.match(
  feSrc,
  /if \(onlyIfTracksEmpty && existingTrackItemCount > 0\) \{[\s\S]*?skipped: 'tracks_not_empty'/,
  '轨道非空 + onlyIfTracksEmpty 必须跳过铺设并回执 skipped',
);
assert.match(
  feSrc,
  /if \(recreateEditor\) destroyVevEditorInstance\('apply-timeline'\);/,
  '带 recreateEditor 的铺设必须在写 Track 前销毁编辑器',
);
assert.match(
  feSrc,
  /if \(recreateEditor\) recreateVevEditorForSameProject\('apply-timeline'\);/,
  '带 recreateEditor 的铺设成功后必须重建编辑器',
);
assert.match(
  feSrc,
  /ensureVevEditorAlive\('apply-timeline-failed'\)[\s\S]*?ensureVevEditorAlive\('clear-tracks-failed'\)/,
  '失败路径必须把已销毁的编辑器拉回来（不能留空容器）',
);
assert.match(
  feSrc,
  /handleOriginApplyTimeline\(data\.plan, data\.options \|\| \{\}\)/,
  '消息分发必须把 options 透传给 handleOriginApplyTimeline',
);

// ── 2026-06-11 回归修复：清空后被自动铺设回填 + "本来就是空的"误报 ──
// 回归现场：清空轨道→编辑器重建触发 ready→会话内首次自动同步重试→把刚清空的
// 轨道铺了回去（且因降级/跳段铺得不全没字幕）；同时清空计数只看 EditParam.Track，
// 而 SDK 活草稿在 LatestEditParam，导致明明有片段却报"轨道本来就是空的"。

// fe：自动铺设必须尊重"用户清空过"标记；手动铺设成功后作废标记
assert.match(
  feSrc,
  /const respectClearedMarker = options\?\.respectClearedMarker === true;/,
  'handleOriginApplyTimeline 必须支持 respectClearedMarker 选项',
);
assert.match(
  feSrc,
  /if \(respectClearedMarker\) \{[\s\S]*?clearedAt > appliedAt[\s\S]*?skipped: 'tracks_cleared_by_user'/,
  '清空时间晚于上次铺设时间时，自动铺设必须跳过',
);
assert.match(
  feSrc,
  /delete nextEditParam\.OriginTracksClearedAt;/,
  '铺设成功必须作废 OriginTracksClearedAt 标记',
);

// fe：判空/计数必须看三个来源（编辑器内存活草稿/LatestEditParam/EditParam）
assert.match(
  feSrc,
  /function resolveCurrentTrackForInspection\(projectInfo, editParam\)[\s\S]*?getVevEditorProjectData\(\)\?\.LatestEditParam\?\.Track/,
  '轨道判空必须包含编辑器内存活草稿与 LatestEditParam',
);
assert.match(
  feSrc,
  /const existingTrackItemCount = resolveCurrentTrackForInspection\(projectInfo, editParam\)\.itemCount;/,
  'onlyIfTracksEmpty 判空必须用三来源取最大',
);
assert.match(
  feSrc,
  /const liveTrackSnapshot = getVevEditorProjectData\(\)\?\.LatestEditParam\?\.Track \|\| null;\s*destroyVevEditorInstance\('clear-tracks'\);/,
  '清空计数必须在销毁编辑器前先取活草稿快照',
);

// 壳层：两条自动铺设路径都必须带 respectClearedMarker；清空成功必须压制会话内重试
const autoApplyWithMarker = oeSrc.match(/_applyCurrentEdlTimelineToVevDemo\((?:scopedMaterials|result\.reachableMaterials), \{ respectClearedMarker: true \}\)/g) || [];
assert.equal(autoApplyWithMarker.length, 2, '自动同步的两条铺设路径（复用binding+完整同步）都必须带 respectClearedMarker');
assert.match(
  oeSrc,
  /_vevDemoInitialAutoSyncKey = `\$\{_vevDemoBoundOriginProjectId\}:\$\{_vevDemoBoundVevProjectId\}`;/,
  '清空成功必须把会话内首次自动同步标记为已消费',
);
assert.match(
  oeSrc,
  /skipped === 'tracks_cleared_by_user'/,
  '壳层必须识别"用户已清空轨道"的跳过分支',
);

console.log('oe clear-tracks / sync-auto-layout contract tests passed');
