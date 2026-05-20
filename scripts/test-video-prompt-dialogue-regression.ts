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

console.log('test-video-prompt-dialogue-regression: ok');
