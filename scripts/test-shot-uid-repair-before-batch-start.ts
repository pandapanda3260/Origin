import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ensureProjectShotUids } from '../lib/shot-plan-normalize';

const routeSource = readFileSync(new URL('../app/api/batch/start/route.ts', import.meta.url), 'utf8');

const project = {
  planMeta: { generatedAt: '2026-06-01T00:00:00.000Z' },
  shotPlanGeneratedAt: '2026-06-02T00:00:00.000Z',
  shots: [
    {
      visual: '主角站在广场中央',
      dialogue: '——',
      duration: 4,
      pace: 'normal',
      sceneId: 'scene-a',
      shotType: '大全景',
      angle: '平视',
      camera: '缓慢推进',
    },
    { shotUid: 'stable-shot', visual: '已有稳定身份' },
  ],
};

const firstRepair = ensureProjectShotUids(project);
const secondRepair = ensureProjectShotUids(JSON.parse(JSON.stringify(project)));
assert.equal(firstRepair.changed, true, 'legacy project should be repaired when a shot lacks shotUid');
assert.equal(firstRepair.repairedCount, 1, 'only missing shotUid rows are repaired');
assert.equal(firstRepair.generatedAt, '2026-06-01T00:00:00.000Z', 'planMeta.generatedAt is the primary repair seed');
assert.match(firstRepair.shots[0].shotUid, /^shot_[a-f0-9]{16}$/);
assert.equal(firstRepair.shots[0].shotUid, secondRepair.shots[0].shotUid, 'same project data repairs to the same shotUid');
assert.equal(firstRepair.shots[1].shotUid, 'stable-shot', 'existing shotUid is preserved');

const alreadyRepaired = ensureProjectShotUids({ ...project, shots: firstRepair.shots });
assert.equal(alreadyRepaired.changed, false, 'repair is idempotent after shotUid is written');
assert.equal(alreadyRepaired.shots[0].shotUid, firstRepair.shots[0].shotUid);

const shotPlanGeneratedSeed = ensureProjectShotUids({
  shotPlanGeneratedAt: '2026-06-03T00:00:00.000Z',
  shots: [{ visual: '用镜头计划生成时间兜底' }],
});
assert.equal(shotPlanGeneratedSeed.generatedAt, '2026-06-03T00:00:00.000Z');

const legacySeed = ensureProjectShotUids({ shots: [{ visual: '老项目兜底' }] });
assert.equal(legacySeed.generatedAt, 'legacy-shot-plan');

for (const batchType of ['storyboard_images', 'tail_frame_images', 'video_prompts', 'video_segments', 'videos']) {
  assert.ok(routeSource.includes(`'${batchType}'`), `${batchType} must be covered by shotUid repair`);
}

const repairIdx = routeSource.indexOf('if (shouldRepairShotUidsForBatch(batchType))');
const perShotIdx = routeSource.indexOf("if (batchType === 'storyboard_images' && isPerShotFirstFrameEnabled())");
assert.ok(repairIdx >= 0, 'batch/start must call repair gate');
assert.ok(perShotIdx >= 0, 'batch/start still keeps per-shot first-frame expansion gate');
assert.ok(repairIdx < perShotIdx, 'repair must run before the per-shot first-frame feature flag branch');
assert.ok(routeSource.includes('return { shots: repair.shots };'), 'repair patcher must return shots instead of mutating fresh in place only');
assert.ok(routeSource.includes('projectForBatch || getProjectByIdForUser'), 'per-shot expansion must use the fresh repaired project');

console.log('test-shot-uid-repair-before-batch-start: ok');
