import assert from 'node:assert/strict';
import {
  correctLatestScriptConsultReadyForRead,
  detectScriptConsultReady,
  extractScriptConsultOutline,
  findLatestScriptConsultOutline,
  isExplicitScriptDraftConfirmCommand,
  shouldAutoTriggerConsultConfirm,
} from '../lib/script-consult-ready';

const outline = `场景：现代MCN公司工位 + 深夜空荡的天台
人物：穿越而来的李白（唐装、随身酒壶）+ 数据至上的内容总监老板
核心冲突：李白的文案被老板用流量数据狂喷——没钩子、完播率不到5%、零转化
关键转折：李白独坐天台，看着冰冷的流量榜第一次怀疑自己的才华一文不值
结尾画面：李白把工牌轻放栏杆，对月吟出诗句，转身走进夜色

—— 觉得 ok 就点下方"确认生成剧本"按钮，想改的话告诉我哪里要调。`;

const marker = detectScriptConsultReady(`好。这是大纲：\n\n[READY]\n${outline}`);
assert.equal(marker.markerReady, true);
assert.equal(marker.heuristicReady, true);
assert.equal(marker.ready, true);
assert.match(marker.outline, /^场景：/);
assert.deepEqual(marker.matchedHeadings, ['场景', '人物', '核心冲突', '关键转折', '结尾画面']);

const noMarker = detectScriptConsultReady(outline);
assert.equal(noMarker.markerReady, false);
assert.equal(noMarker.heuristicReady, true);
assert.equal(noMarker.ready, true);
assert.match(noMarker.outline, /^场景：/);

const noIntro = extractScriptConsultOutline(outline);
assert.ok(noIntro, 'outline that starts with 场景 must be detected');

const question = detectScriptConsultReady('核心冲突是什么？\n关键转折要不要更强？\n结尾画面需要改吗？');
assert.equal(question.ready, false, 'follow-up questions must not be treated as a ready outline');

const latest = findLatestScriptConsultOutline([
  { role: 'user', content: '30秒' },
  { role: 'assistant', content: `旧大纲\n\n${outline.replace('深夜空荡的天台', '白天办公室')}`, readyToDraft: true },
  { role: 'user', content: '最后不要老板求李白' },
  { role: 'assistant', content: outline, readyToDraft: false },
], 'fallback');
assert.match(latest, /深夜空荡的天台/);

const corrected = correctLatestScriptConsultReadyForRead({
  messages: [
    { role: 'user', content: '确认生成剧本' },
    { role: 'assistant', content: outline, readyToDraft: false },
  ],
  outline: 'old',
  ready: false,
  startedAt: null,
  confirmedAt: null,
}, '');
assert.equal(corrected.ready, true);
assert.equal(corrected.messages[1].readyToDraft, true);
assert.match(corrected.outline, /^场景：/);

const unchangedWhenScriptExists = correctLatestScriptConsultReadyForRead({
  messages: [
    { role: 'user', content: '确认生成剧本' },
    { role: 'assistant', content: outline, readyToDraft: false },
  ],
  outline: 'old',
  ready: false,
}, '已有正式剧本');
assert.equal(unchangedWhenScriptExists.ready, false);
assert.equal(unchangedWhenScriptExists.messages[1].readyToDraft, false);

assert.equal(isExplicitScriptDraftConfirmCommand('确认生成剧本'), true);
assert.equal(isExplicitScriptDraftConfirmCommand('生成 草稿'), true);
assert.equal(isExplicitScriptDraftConfirmCommand('确认生成剧本。'), true);
assert.equal(isExplicitScriptDraftConfirmCommand('可以把场景改成夜市吗'), false);
assert.equal(isExplicitScriptDraftConfirmCommand('生成剧本？'), false);
assert.equal(shouldAutoTriggerConsultConfirm('确认生成剧本', true), true);
assert.equal(shouldAutoTriggerConsultConfirm('确认生成剧本', false), false);
assert.equal(shouldAutoTriggerConsultConfirm('可以把场景改成夜市吗', true), false);

console.log('[test-script-consult-ready] ok');
