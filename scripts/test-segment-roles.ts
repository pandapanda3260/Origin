// 纯逻辑单测：lib/segment-roles.ts
// Mac: npx tsx scripts/test-segment-roles.ts ；沙箱: tsc 编译成 JS 后 node 跑。
import {
  buildShotRolesFromSegments,
  buildShotRoles,
  shouldGenerateFirstFrame,
  tailFrameEligible,
} from '../lib/segment-roles';

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.error(`  XX  ${name}\n        got : ${g}\n        want: ${w}`);
  }
}
const S = (...durs: number[]) => durs.map((d) => ({ duration: d }));

// 段结构 [[0,1,2,3],[4,5],[6]]
const roles = buildShotRolesFromSegments([[0, 1, 2, 3], [4, 5], [6]]);
eq('shot0 段首·非solo', roles[0], { groupIdx: 0, positionInGroup: 0, groupSize: 4, isSegmentFirst: true, isSegmentLast: false, isSolo: false });
eq('shot3 段尾·非solo', roles[3], { groupIdx: 0, positionInGroup: 3, groupSize: 4, isSegmentFirst: false, isSegmentLast: true, isSolo: false });
eq('shot4 段首(第二段)', roles[4], { groupIdx: 1, positionInGroup: 0, groupSize: 2, isSegmentFirst: true, isSegmentLast: false, isSolo: false });
eq('shot6 solo', roles[6], { groupIdx: 2, positionInGroup: 0, groupSize: 1, isSegmentFirst: true, isSegmentLast: true, isSolo: true });

// 首帧决策：段首(含solo)出，其余不出
eq('首帧 shot0(段首)', shouldGenerateFirstFrame(roles[0]), true);
eq('首帧 shot1(中间)', shouldGenerateFirstFrame(roles[1]), false);
eq('首帧 shot3(段尾非段首)', shouldGenerateFirstFrame(roles[3]), false);
eq('首帧 shot6(solo)', shouldGenerateFirstFrame(roles[6]), true);

// 尾帧资格：仅 solo
eq('尾帧 shot6(solo) 资格', tailFrameEligible(roles[6]), true);
eq('尾帧 shot3(非solo段尾) 无资格', tailFrameEligible(roles[3]), false);
eq('尾帧 shot0(非solo段首) 无资格', tailFrameEligible(roles[0]), false);

// undefined 安全
eq('首帧 undefined→false', shouldGenerateFirstFrame(undefined), false);
eq('尾帧 undefined→false', tailFrameEligible(undefined), false);

// 从镜头表直接算（默认 MIN=4）：[1,1,1,5,2,3,7] → 段 [[0,1,2,3],[4,5],[6]]
eq('buildShotRoles groupIdx 序列', buildShotRoles(S(1, 1, 1, 5, 2, 3, 7)).map((r) => r.groupIdx), [0, 0, 0, 0, 1, 1, 2]);
eq('buildShotRoles 首帧序列', buildShotRoles(S(1, 1, 1, 5, 2, 3, 7)).map((r) => shouldGenerateFirstFrame(r)), [true, false, false, false, true, false, true]);

if (failed) {
  console.error(`\nFAILED: ${failed}`);
  process.exit(1);
}
console.log('\nALL PASS（segment-roles）');
