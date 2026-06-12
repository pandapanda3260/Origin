/**
 * 剪辑工作台预览画幅与 filmstrip 缩略图契约测试。
 *
 * 锁定：
 * - 预览框由 edit.js 按项目导出格式写入实际宽高，并在 9:16 时居中；
 * - action row 高度变化会触发布局同步；
 * - 时间线 filmstrip 使用中心 cover 裁切，不再把视频帧几何拉伸成 80x60。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workspace = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
const editSrc = readFileSync(new URL('../public/modules/edit.js', import.meta.url), 'utf8');
const cssSrc = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function versionFor(pattern, label) {
  const match = workspace.match(pattern);
  assert(match, `${label} version should be present in workspace.html`);
  const version = Number(match[1]);
  assert(Number.isFinite(version), `${label} version should be numeric`);
  return version;
}

assert(workspace.includes('id="editPreviewFormatLabel"'), 'workspace.html should expose editPreviewFormatLabel');
assert(workspace.includes('id="editPreviewActionRow"'), 'workspace.html should expose editPreviewActionRow');
assert(!workspace.includes('Preview · 16:9'), 'workspace.html must not hard-code Preview · 16:9');

assert(versionFor(/styles\.css\?v=(\d+)/, 'styles.css') >= 247, 'styles.css cache version should be at least 247');
assert(
  versionFor(/"\/modules\/edit\.js":\s*"\/modules\/edit\.js\?v=(\d+)"/, 'edit.js import map') >= 307,
  'edit.js cache version should be at least 307',
);

assert(editSrc.includes('function _syncEditPreviewFrameLayout()'), 'edit.js should define _syncEditPreviewFrameLayout');
assert(editSrc.includes('function _initEditPreviewFrameObserver()'), 'edit.js should define _initEditPreviewFrameObserver');
assert(editSrc.includes('function _drawVideoFrameCover(ctx, video, dstW, dstH)'), 'edit.js should define _drawVideoFrameCover');
assert(editSrc.includes('_editPreviewFrameObserver.observe(panel);'), 'preview ResizeObserver should observe the preview panel');
assert(editSrc.includes('if (actionRow) _editPreviewFrameObserver.observe(actionRow);'), 'preview ResizeObserver should observe the action row');
assert(/if \(!panelW \|\| !panelH\) return;/.test(editSrc), 'preview layout sync should ignore hidden/zero panel size');
assert(/if \(!boxW \|\| !boxH\) return;/.test(editSrc), 'preview layout sync should ignore zero available size');

const setW = editSrc.indexOf('area.style.setProperty("--edit-preview-frame-w"');
const setH = editSrc.indexOf('area.style.setProperty("--edit-preview-frame-h"');
const addReady = editSrc.indexOf('panel.classList.add("edit-preview-aspect-ready")');
assert(setW >= 0 && setH >= 0 && addReady >= 0, 'preview CSS variable writes and ready class should exist');
assert(setW < addReady && setH < addReady, 'preview frame variables must be written before the ready class is added');
assert(!editSrc.includes('--edit-preview-ar') && !cssSrc.includes('--edit-preview-ar'), 'dead --edit-preview-ar variable must not be introduced');

const readyRule = cssSrc.match(/#editPreviewPanel\.edit-preview-aspect-ready #editPreviewArea \{[\s\S]*?\n\}/);
assert(readyRule, 'styles.css should have edit-preview-aspect-ready rule for editPreviewArea');
assert(readyRule[0].includes('width: var(--edit-preview-frame-w)'), 'preview ready rule should use --edit-preview-frame-w');
assert(readyRule[0].includes('height: var(--edit-preview-frame-h)'), 'preview ready rule should use --edit-preview-frame-h');
assert(
  readyRule[0].includes('align-self: center') ||
  (readyRule[0].includes('margin-left: auto') && readyRule[0].includes('margin-right: auto')),
  'preview area must be horizontally centered in the panel',
);

const actionRule = cssSrc.match(/#editPreviewActionRow \{[\s\S]*?\n\}/);
assert(actionRule, 'styles.css should style editPreviewActionRow');
assert(actionRule[0].includes('align-self: stretch'), 'editPreviewActionRow should stretch instead of narrowing with preview frame');

assert(!editSrc.includes('ctx.drawImage(tmpVid, 0, 0, 80, 60);'), 'filmstrip must not geometrically stretch frames into 80x60');
assert(editSrc.includes('video.videoWidth') && editSrc.includes('video.videoHeight'), 'filmstrip cover helper should read intrinsic video size');
assert(/if \(!vw \|\| !vh\) \{[\s\S]*?ctx\.drawImage\(video, 0, 0, dstW, dstH\);[\s\S]*?return;[\s\S]*?\}/.test(editSrc), 'filmstrip cover helper should guard zero intrinsic size');
assert(
  /ctx\.drawImage\(video,\s*sx,\s*sy,\s*sw,\s*sh,\s*0,\s*0,\s*dstW,\s*dstH\);/.test(editSrc),
  'filmstrip cover helper should draw with source crop parameters',
);
assert(/_VID_STYLE = ".*object-fit:contain/.test(editSrc), 'main edit preview video must remain object-fit:contain');

console.log('edit preview aspect contract tests passed');
