import assert from 'node:assert/strict';
import {
  buildSeedanceFirstLastFramePromptParts,
  buildSeedancePromptParts,
} from '../lib/video-prompt-runtime';

const sample = {
  prompt: '雨夜广场，男主从广告屏前走过，镜头缓慢推进。',
  dialoguePairs: [
    { speaker: '萧南', text: '陈静，我回来了。' },
    { speaker: '陈静', text: '你终于来了。' },
  ],
  characterLockRoster: '萧南：黑色长风衣，克制冷静；陈静：白色礼服，神情紧张。',
  voiceRoster: '萧南：低沉男声；陈静：清亮女声。',
  prevTailSummary: '上一段结尾：萧南停在雨中的台阶前。',
  nextHeadSummary: '下一段开头：陈静转身看向门口。',
};

const firstLast = buildSeedanceFirstLastFramePromptParts(sample);
const multiRef = buildSeedancePromptParts({
  ...sample,
  ratio: '9:16',
  durationSec: 5,
  referenceImagePath: '/tmp/first.png',
  referenceImageRole: 'first_frame',
});

for (const [label, output] of [
  ['first_last', firstLast.finalPrompt],
  ['multi_ref', multiRef.finalPrompt],
] as const) {
  assert.match(output, /陈静，我回来了/, `${label} should keep dialogue text`);
  assert.match(output, /你终于来了/, `${label} should keep dialogue text`);
  assert.match(output, /萧南：黑色长风衣/, `${label} should keep character lock roster`);
  assert.match(output, /上一段结尾/, `${label} should keep previous-tail continuity`);
  assert.match(output, /下一段开头/, `${label} should keep next-head continuity`);
}

assert.match(firstLast.finalPrompt, /首尾帧模式生成/, 'first-last prompt should include first-last constraint');
assert.doesNotMatch(firstLast.finalPrompt, /--ratio/, 'first-last prompt should not embed top-level ratio');
assert.match(multiRef.finalPrompt, /--ratio 9:16 --duration 5/, 'multi-ref prompt should keep legacy ratio/duration suffix');

const fixedShotPlan = [{ idx: 1, durationSec: 4, camera: '固定镜头', pace: 'normal' }];
const fixedMultiRef = buildSeedancePromptParts({
  prompt: '镜头保持在桌面正前方，角色从第一帧开始有呼吸和眼神变化。',
  ratio: '16:9',
  durationSec: 4,
  shotPlan: fixedShotPlan,
});
const fixedFirstLast = buildSeedanceFirstLastFramePromptParts({
  prompt: '镜头保持在桌面正前方，角色从第一帧开始有呼吸和眼神变化。',
  durationSec: 4,
  shotPlan: fixedShotPlan,
});
for (const [label, output] of [
  ['fixed_multi_ref', fixedMultiRef.finalPrompt],
  ['fixed_first_last', fixedFirstLast.finalPrompt],
] as const) {
  assert.match(output, /镜头计划为固定机位/, `${label} should recognize fixed camera`);
  assert.match(output, /机位必须保持固定/, `${label} should keep camera fixed`);
  assert.doesNotMatch(output, /按【运镜系统】描述的方向开始物理位移/, `${label} should not force physical camera movement`);
}

console.log('test-video-prompt-dialogue-regression: ok');
