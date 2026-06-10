/**
 * 剪辑预览框"转圈+加载中…"遮罩 契约测试（2026-06-11）
 *
 * 背景：进剪辑页瞬间视频地址还在签名（裸地址塞 <video> 必 401 黑屏）、或首段
 * 还在缓冲；这段窗口期点播放只会默默等待，用户以为页面坏了。修复 = 预览框
 * 加载遮罩 _setPreviewLoading()，签名中/缓冲中/等待起播均显示，起播成功、
 * 暂停、失败、切项目时隐藏。本测试锁住这些挂钩点，防后续重构悄悄删掉。
 *
 * 运行：node scripts/test-edit-preview-loading-contract.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editSrc = readFileSync(new URL('../public/modules/edit.js', import.meta.url), 'utf8');
const cssSrc = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

// 1. 遮罩helper存在且默认文案是"加载中…"
assert.match(
  editSrc,
  /function _setPreviewLoading\(visible, label\)[\s\S]*?"加载中…"/,
  'edit.js 必须有 _setPreviewLoading 且默认文案为 加载中…',
);

// 2. 未签名地址不直接塞 <video>（必 401 黑屏），改亮遮罩等 hydration 重签
assert.match(
  editSrc,
  /_runtimeVideoUrlNeedsRefresh\(url\)\)\s*\{[\s\S]*?_setPreviewLoading\(true\)/,
  '_initDoubleBuffer 对未签名地址必须显示加载遮罩而不是直接塞 src',
);

// 3. 首段缓冲未就绪（readyState<2）也要亮遮罩，loadeddata/error 撤掉
assert.match(
  editSrc,
  /readyState < 2\) \{\s*_setPreviewLoading\(true\);[\s\S]*?addEventListener\("loadeddata", hideInitLoading\)/,
  '_initDoubleBuffer 首段缓冲期必须显示加载遮罩并在 loadeddata 后撤掉',
);

// 4. 点播放遇到地址待刷新：亮遮罩（不再只有一条易错过的 toast）
assert.match(
  editSrc,
  /if \(_timelineVideoUrlsNeedRefresh\(\)\) \{\s*_setPreviewLoading\(true\);\s*showToast\("正在刷新视频播放地址…"/,
  '_editPlay 的地址刷新分支必须先亮加载遮罩',
);

// 5. 空时间线点播放不再静默 return
assert.match(
  editSrc,
  /showToast\("时间线上还没有可播放的片段", "warn"\)/,
  '_editPlay 空片段时必须给出可见反馈',
);

// 6. 等 canplay 的缓冲分支亮遮罩；起播成功 / 失败收尾都要撤遮罩
assert.match(
  editSrc,
  /_setPreviewLoading\(true\);\s*var handler = function \(\) \{\s*vid\.removeEventListener\("canplay", handler\)/,
  '_seekThenPlay 等待 canplay 时必须显示加载遮罩',
);
assert.match(
  editSrc,
  /settled = true;\s*cleanup\(\);\s*_setPreviewLoading\(false\);/,
  '起播成功后必须撤掉加载遮罩',
);
assert.match(
  editSrc,
  /var failPlayback = function \(err\) \{[\s\S]*?_setPreviewLoading\(false\);/,
  '播放失败必须撤掉加载遮罩',
);

// 7. 暂停 / 切项目 teardown / 回到 guard 态都要撤遮罩（防挂死）
assert.match(
  editSrc,
  /function _editPause\(\) \{\s*_editState\.isPlaying = false;\s*_setPreviewLoading\(false\);/,
  '_editPause 必须撤掉加载遮罩',
);
assert.match(
  editSrc,
  /_editUiEpoch\+\+;\s*try \{ _setPreviewLoading\(false\); \} catch \(_e\) \{\}/,
  '切项目 teardown 必须撤掉加载遮罩',
);

// 8. hydration 失败兜底：遮罩不能永久挂死
assert.match(
  editSrc,
  /else if \(!changed && _timelineVideoUrlsNeedRefresh\(\)\) \{[\s\S]*?_setPreviewLoading\(false\);/,
  '重签静默失败时必须撤掉加载遮罩',
);

// 9. CSS：遮罩样式存在、不挡点击、z 层在字幕(20)之下
assert.match(cssSrc, /\.edit-preview-loading \{[\s\S]*?z-index: 19;[\s\S]*?pointer-events: none;/, 'styles.css 必须有 .edit-preview-loading 且 pointer-events:none / z-index:19');
assert.match(cssSrc, /\.edit-preview-loading \.edit-preview-loading-spinner \{[\s\S]*?animation: editSpin/, '遮罩转圈必须复用 editSpin 动画');

console.log('edit preview loading contract tests passed');
