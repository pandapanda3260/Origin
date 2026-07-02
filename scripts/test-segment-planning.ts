// 纯逻辑单测：lib/segment-planning.ts。
// Mac 上跑：npx tsx scripts/test-segment-planning.ts
// 沙箱里跑：tsc 编译成 JS 后 node 执行（见执行报告）。

import { planSegments, shotIndexToSegment } from '../lib/segment-planning';
import { resolveVideoModelCapability } from '../lib/video-provider-capabilities';
import { segmentPlanOptionsFromCapability } from '../lib/video-segment-capability';

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  XX  ${name}\n        got : ${g}\n        want: ${w}`);
  }
}
const S = (...durs: number[]) => durs.map((d) => ({ duration: d }));
function segmentSums(segs: number[][], durs: number[]): number[] {
  return segs.map((group) => group.reduce((acc, idx) => acc + durs[idx], 0));
}

// 默认 MIN=4 / MAX=15
eq('all-solo（全部 ≥MIN 各自成段）', planSegments(S(4, 5, 7)), [[0], [1], [2]]);
eq('merge-forward（短镜头前向并够数即停）', planSegments(S(1, 1, 1, 5, 2, 3, 7)), [[0, 1, 2, 3], [4, 5], [6]]);
eq('two-3s（3+3=6）', planSegments(S(3, 3)), [[0, 1]]);
eq('trailing-short-merge-back（末尾 1s 并回上一段）', planSegments(S(5, 1)), [[0, 1]]);
eq('trailing-3-after-solo（末尾 3s 并回）', planSegments(S(5, 3)), [[0, 1]]);
eq('single-short（整片仅一个短镜头 → 单段，交给 padding）', planSegments(S(2)), [[0]]);
eq('single-solo', planSegments(S(6)), [[0]]);
eq('all-1s-x4（连续 1s 需并 4 个够 MIN）', planSegments(S(1, 1, 1, 1)), [[0, 1, 2, 3]]);
eq('empty', planSegments([]), []);

// 覆盖完整、无重叠
{
  const segs = planSegments(S(3, 3, 3, 3, 3));
  eq('coverage-flat（覆盖 0..4）', segs.flat(), [0, 1, 2, 3, 4]);
  eq('coverage-shape', segs, [[0, 1], [2, 3, 4]]);
  eq('shotIndexToSegment 映射', shotIndexToSegment(segs), [0, 0, 1, 1, 1]);
}

// 上限护栏：不超过 MAX（用 7s 镜头逼近）
eq('max-cap（7+7=14 ≤15，不再加）', planSegments(S(3, 7, 7)), [[0, 1], [2]]);

// MIN=5 情形（若标准模型下限是 5）
eq('min5-merges-4s（4<5 要并）', planSegments(S(4, 4), { minDurationSec: 5 }), [[0, 1]]);
eq('min5-5s-solo（5≥5 单独）', planSegments(S(5, 5), { minDurationSec: 5 }), [[0], [1]]);

// 未来 Seedance 2.5 的 20-25s 目标窗：现在只验证参数化能力，不改变默认生产行为。
{
  const durs = [7, 7, 7, 7, 7, 7];
  const segs = planSegments(S(...durs), { targetMinSec: 20, targetMaxSec: 25, hardMaxSec: 25 });
  eq('target20-25-greedy-window（逼近目标窗）', segs, [[0, 1, 2], [3, 4, 5]]);
  eq('target20-25-sums', segmentSums(segs, durs), [21, 21]);
}

{
  const durs = [7, 7, 7, 7, 7];
  const segs = planSegments(S(...durs), { targetMinSec: 20, targetMaxSec: 25, hardMaxSec: 25 });
  eq('target20-25-tail-hardmax（末段过短但不能并成 35s）', segs, [[0, 1, 2], [3, 4]]);
  eq('target20-25-tail-sums', segmentSums(segs, durs), [21, 14]);
}

eq(
  'capability 2.0 → plan options',
  segmentPlanOptionsFromCapability(resolveVideoModelCapability('doubao-seedance-2-0-260128')),
  { targetMinSec: 4, targetMaxSec: 15, hardMaxSec: 15 },
);
eq(
  'capability 2.5 → plan options',
  segmentPlanOptionsFromCapability(resolveVideoModelCapability('doubao-seedance-2-5')),
  { targetMinSec: 20, targetMaxSec: 25, hardMaxSec: 30 },
);

if (failed) {
  console.error(`\nFAILED: ${failed} 个用例不通过`);
  process.exit(1);
}
console.log('\nALL PASS（' + 'segment-planning' + '）');
