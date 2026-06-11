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

// ---------------------------------------------------------------------------
// 开头吃字修复契约（2026-06-11）：
// 有台词 → 必须有"开场气口"指令 + 禁止第 0 帧开口 + 去掉"嘴唇微动"诱导；
// 有台词 + 有时长 → 逐句"建议说完窗口"按净字数比例分配（head 0.4s / tail 0.4s）。
// ---------------------------------------------------------------------------
for (const [label, output] of [
  ['first_last', firstLast.finalPrompt],
  ['multi_ref', multiRef.finalPrompt],
] as const) {
  assert.match(output, /开口时机【最重要】/, `${label} should include speech-onset rule`);
  assert.match(output, /严禁从第 0 帧开讲/, `${label} should forbid frame-0 speech`);
  assert.match(output, /句首的字严禁吞掉/, `${label} should forbid clipping the first character`);
  assert.match(output, /不等于开口说话/, `${label} motion-opening should decouple motion from speech`);
  assert.match(output, /禁止第 0 帧就开口/, `${label} motion-opening should forbid frame-0 mouth opening`);
  assert.doesNotMatch(output, /嘴唇微动/, `${label} should drop lip-micro-motion hint when dialogue exists`);
}

// multi_ref 带 durationSec=5：净字数 6/5 → 窗口 0.4s~2.7s 和 2.7s~4.6s
assert.match(multiRef.finalPrompt, /\[1\]（建议在 0\.4s ~ 2\.7s 内说完）/, 'multi_ref first line should carry suggested window');
assert.match(multiRef.finalPrompt, /\[2\]（建议在 2\.7s ~ 4\.6s 内说完）/, 'multi_ref second line should carry suggested window');
assert.match(multiRef.finalPrompt, /建议说完窗口/, 'multi_ref should explain window semantics');

// first_last 样例没传 durationSec：不输出逐句窗口，但气口规则仍在
assert.doesNotMatch(firstLast.finalPrompt, /建议在 .*内说完/, 'first_last without duration should not emit windows');

// first_last 带 durationSec 时也要有窗口
const firstLastTimed = buildSeedanceFirstLastFramePromptParts({ ...sample, durationSec: 5 });
assert.match(firstLastTimed.finalPrompt, /\[1\]（建议在 0\.4s ~ 2\.7s 内说完）/, 'timed first_last should carry suggested window');

// ---------------------------------------------------------------------------
// 多镜头合并片段窗口对齐契约（审查 finding 2026-06-11）：
// shot1(0-3s) 无台词、shot2(3-7s) 有台词 → 窗口必须从 3s 开始，不能从 0.4s。
// ---------------------------------------------------------------------------
const mergedShotPlan = [
  { idx: 1, durationSec: 3, camera: '固定镜头', pace: 'normal' },
  { idx: 2, durationSec: 4, camera: '固定镜头', pace: 'normal' },
];
const mergedWithShotIdx = buildSeedancePromptParts({
  prompt: '大殿全景，随后切长老近景。',
  ratio: '9:16',
  durationSec: 7,
  shotPlan: mergedShotPlan,
  dialoguePairs: [{ speaker: '接引长老', text: '此子并无惊人体质。', shotIdx: 1 }],
});
assert.match(
  mergedWithShotIdx.finalPrompt,
  /\[1\]（建议在 3s ~ 6\.6s 内说完）/,
  'merged segment window should start at owning shot start (3s), not segment head',
);
assert.doesNotMatch(
  mergedWithShotIdx.finalPrompt,
  /建议在 0\.4s/,
  'merged segment must not pull shot2 dialogue to segment head',
);

// 多镜头但台词缺 shotIdx → 宁缺毋错：不输出逐句窗口，气口规则保留
const mergedNoShotIdx = buildSeedancePromptParts({
  prompt: '大殿全景，随后切长老近景。',
  ratio: '9:16',
  durationSec: 7,
  shotPlan: mergedShotPlan,
  dialoguePairs: [{ speaker: '接引长老', text: '此子并无惊人体质。' }],
});
assert.doesNotMatch(mergedNoShotIdx.finalPrompt, /建议在 .*内说完/, 'multi-shot without shotIdx must skip windows');
assert.match(mergedNoShotIdx.finalPrompt, /开口时机【最重要】/, 'multi-shot without shotIdx should keep onset rule');

// ---------------------------------------------------------------------------
// 尾部预留契约（审查 finding 2026-06-11）：tailReserveSec=1.0（首尾帧
// tail_ready 的 endingReserveSec）时，窗口与收声文案都要按 1 秒留尾。
// ---------------------------------------------------------------------------
const tailReserved = buildSeedanceFirstLastFramePromptParts({
  ...sample,
  durationSec: 5,
  tailReserveSec: 1,
});
assert.match(tailReserved.finalPrompt, /\[1\]（建议在 0\.4s ~ 2\.4s 内说完）/, 'tail-reserved first window should shrink');
assert.match(tailReserved.finalPrompt, /\[2\]（建议在 2\.4s ~ 4s 内说完）/, 'tail-reserved last window should end at duration-1s');
assert.match(tailReserved.finalPrompt, /视频结束前约 1 秒说完/, 'tail-reserve rule text should follow endingReserveSec');
// tailReserveSec 低于 0.4 下限时不放松
const tailFloor = buildSeedanceFirstLastFramePromptParts({ ...sample, durationSec: 5, tailReserveSec: 0.1 });
assert.match(tailFloor.finalPrompt, /视频结束前约 0\.4 秒说完/, 'tail reserve must not drop below 0.4s floor');

// 无台词片段：嘴唇微动保留（开场动态不受影响），且不出现台词气口规则
for (const [label, output] of [
  ['fixed_multi_ref', fixedMultiRef.finalPrompt],
  ['fixed_first_last', fixedFirstLast.finalPrompt],
] as const) {
  assert.match(output, /嘴唇微动/, `${label} without dialogue should keep lip-micro-motion hint`);
  assert.match(output, /【本片段无台词】/, `${label} should keep no-dialogue block`);
  assert.doesNotMatch(output, /开口时机【最重要】/, `${label} without dialogue should not emit speech-onset rule`);
}

console.log('test-video-prompt-dialogue-regression: ok');
