// 集成测试：frame-workflow-state 在 flag ON/OFF 下的真实行为（P2b/P2c）。
// Mac: npx tsx scripts/test-frame-workflow-merge.ts
// 沙箱: 复制到隔离目录、把 ./image-gen 换成桩后 tsc→node（见执行报告）。
import {
  makeSingleShotStoryboardSlots,
  storyboardShotIndices,
  assertStoryboardsAlignedWithShots,
  buildFrameWorkflowNormalizationPatch,
} from '../lib/frame-workflow-state';

let failed = 0;
function ok(name: string, cond: boolean, extra?: string): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.error(`  XX  ${name}${extra ? ' :: ' + extra : ''}`);
  }
}
function throws(name: string, fn: () => void): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(name + '（应抛错）', threw);
}
function noThrow(name: string, fn: () => void): void {
  let err: any = null;
  try { fn(); } catch (e) { err = e; }
  ok(name + '（不应抛错）', !err, err ? String((err && err.message) || err) : '');
}
const S = (...d: number[]) => d.map((x, i) => ({ idx: i + 1, duration: x }));
const setFlag = (on: boolean) => {
  // 默认已 ON，OFF 用例必须显式设 '0'（删除会回落到默认 true）。
  process.env.ORIGIN_MULTI_SHOT_SEGMENT = on ? '1' : '0';
};

// ===== flag OFF：现网行为必须 1:1 不变 =====
setFlag(false);
{
  const shots = S(1, 1, 1, 5, 2, 3, 7);
  const slots: any[] = makeSingleShotStoryboardSlots(shots);
  ok('OFF 槽位数=镜头数', slots.length === shots.length, `len=${slots.length}`);
  ok('OFF 每槽 shotIndices=[idx]', slots.every((s, i) => Array.isArray(s.shotIndices) && s.shotIndices.length === 1 && s.shotIndices[0] === i));
  const proj: any = { shots, storyboards: slots };
  noThrow('OFF 对齐校验(1:1)', () => assertStoryboardsAlignedWithShots(proj, 'off'));
  ok('OFF strict 返回 [idx]', JSON.stringify(storyboardShotIndices(proj, 0, slots[0], { mode: 'single-shot-strict' })) === '[0]');
  throws('OFF strict 遇多镜头', () => storyboardShotIndices({ shots } as any, 0, { shotIndices: [0, 1] } as any, { mode: 'single-shot-strict' }));
}

// ===== flag ON：合并 =====
setFlag(true);
{
  const shots = S(1, 1, 1, 5, 2, 3, 7); // → [[0,1,2,3],[4,5],[6]]
  const slots: any[] = makeSingleShotStoryboardSlots(shots);
  ok('ON 段数=3', slots.length === 3, `len=${slots.length}`);
  ok('ON 段0=[0,1,2,3]', JSON.stringify(slots[0].shotIndices) === '[0,1,2,3]');
  ok('ON 段1=[4,5]', JSON.stringify(slots[1].shotIndices) === '[4,5]');
  ok('ON 段2=[6]', JSON.stringify(slots[2].shotIndices) === '[6]');
  ok('ON 段0 idx=0/shotIdx=1', slots[0].idx === 0 && slots[0].shotIdx === 1);
  const proj: any = { shots, storyboards: slots };
  noThrow('ON 对齐校验(覆盖/无重叠/递增)', () => assertStoryboardsAlignedWithShots(proj, 'on'));
  ok('ON strict 返回整段 run', JSON.stringify(storyboardShotIndices(proj, 0, slots[0], { mode: 'single-shot-strict' })) === '[0,1,2,3]');
  ok('ON strict 段1 返回 [4,5]', JSON.stringify(storyboardShotIndices(proj, 1, slots[1], { mode: 'single-shot-strict' })) === '[4,5]');
  // 破坏性：缺口 / 重叠 / 乱序 都必须被抓
  throws('ON 缺口被抓', () => assertStoryboardsAlignedWithShots({ shots, storyboards: [{ shotIndices: [0, 1] }, { shotIndices: [3, 4, 5, 6] }] } as any, 'gap'));
  throws('ON 重叠被抓', () => assertStoryboardsAlignedWithShots({ shots, storyboards: [{ shotIndices: [0, 1, 2, 3] }, { shotIndices: [3, 4] }, { shotIndices: [5, 6] }] } as any, 'overlap'));
  throws('ON 乱序被抓', () => assertStoryboardsAlignedWithShots({ shots, storyboards: [{ shotIndices: [1, 0, 2, 3] }, { shotIndices: [4, 5] }, { shotIndices: [6] }] } as any, 'order'));
  // 全 4s（都≥MIN）→ 应全 solo
  const solo: any[] = makeSingleShotStoryboardSlots(S(4, 5, 6, 7));
  ok('ON 全≥MIN→全 solo', solo.length === 4 && solo.every((s, i) => s.shotIndices.length === 1 && s.shotIndices[0] === i));
}

// ===== flag ON：保存前自愈重复/缺失的 shotIndices =====
setFlag(true);
{
  const shots = S(5, 4, 6, 4, 5, 4, 4, 6, 5, 3, 7, 5, 2, 7);
  const storyboards: any[] = [
    { shotIndices: [0] },
    { shotIndices: [1] },
    { shotIndices: [2] },
    { shotIndices: [3] },
    { shotIndices: [4], firstFrameUrl: '/first-5' },
    { shotIndices: [5] },
    { shotIndices: [6] },
    { shotIndices: [7] },
    { shotIndices: [8] },
    { shotIndices: [9, 10] },
    {
      shotIndices: [4],
      firstFrameUrl: '/first-12',
      firstFramePlanSummary: { shotIndices: [11] },
      frames: {
        first: { url: '/first-12', shotIndices: [11] },
        tail: { url: '/wrong-tail-5', shotIndices: [4] },
      },
      tailFrameUrl: '/wrong-tail-5',
      tailFrameIntent: 'requested',
      tailFramePlanSummary: { shotIndices: [4] },
    },
    { shotIndices: [12, 13] },
  ];
  const patch = buildFrameWorkflowNormalizationPatch({
    frameWorkflowSchemaVersion: 3,
    shots,
    storyboards,
    videoTasks: [],
  } as any, 1);
  ok(
    'ON 显式生成目标优先于旧 slot 绑定',
    JSON.stringify(storyboardShotIndices({ shots } as any, 10, storyboards[10] as any, {
      mode: 'single-shot-strict',
      explicitShotIndices: [11],
    })) === '[11]',
  );
  const repaired = patch?.storyboards || [];
  ok('ON 自愈后段数=12', repaired.length === 12, `len=${repaired.length}`);
  ok('ON 自愈后连续覆盖 1-14', JSON.stringify(repaired.map((sb: any) => sb.shotIndices)) === '[[0],[1],[2],[3],[4],[5],[6],[7],[8],[9,10],[11],[12,13]]');
  ok('ON 自愈保留镜头12首帧', repaired[10]?.firstFrameUrl === '/first-12');
  ok('ON 自愈清掉错位尾帧', !repaired[10]?.tailFrameUrl && !repaired[10]?.frames?.tail?.url);
  noThrow('ON 自愈结果通过对齐校验', () => assertStoryboardsAlignedWithShots({ shots, storyboards: repaired } as any, 'repaired'));
}
setFlag(false);

if (failed) {
  console.error(`\nFAILED: ${failed}`);
  process.exit(1);
}
console.log('\nALL PASS（frame-workflow merge integration）');
