import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeGeneratedShot,
  normalizeGeneratedShotPlan,
  resolveShotFieldsForPrompt,
  validateGeneratedShotPlan,
} from '../lib/shot-plan-normalize';

const legacyAngleShot = normalizeGeneratedShot({ shotType: '俯拍', visual: '主角走进走廊' }, 0);
assert.match(legacyAngleShot.shotUid, /^shot_[a-f0-9]{16}$/);
assert.equal(legacyAngleShot.shotType, '中景');
assert.equal(legacyAngleShot.framing, '中景');
assert.equal(legacyAngleShot.angle, '俯拍');
assert.equal(legacyAngleShot.lens, '标准50');
assert.equal(legacyAngleShot.focus, '中等景深');
assert.equal(legacyAngleShot.light, '侧光·硬光·中性·高反差');
assert.equal(legacyAngleShot.composition, '三分法');

const legacyAngleWithFraming = normalizeGeneratedShot({ shotType: '俯拍', framing: '近景', visual: '主角回头' }, 1);
assert.equal(legacyAngleWithFraming.shotType, '近景');
assert.equal(legacyAngleWithFraming.angle, '俯拍');

const viewpointShot = normalizeGeneratedShot({ shotType: '过肩镜头', visual: '两人对话' }, 2);
assert.equal(viewpointShot.shotType, '中景');
assert.equal(viewpointShot.angle, '过肩');

const preservedShotUid = normalizeGeneratedShot({ shotUid: 'stable-shot-uid', visual: '保留身份' }, 0);
assert.equal(preservedShotUid.shotUid, 'stable-shot-uid');

const promptFields = resolveShotFieldsForPrompt({ shotType: '主观镜头', camera: '推', lens: '长焦135+' });
assert.equal(promptFields.shotType, '中景');
assert.equal(promptFields.angle, '主观');
assert.equal(promptFields.camera, '推近');
assert.equal(promptFields.focus, '浅景深');

const normalizedA = normalizeGeneratedShotPlan([
  { shotType: '广角全景', camera: '固定机位', durationSec: 9, visual: '城市夜景', dialogue: '' },
  { shotType: '仰拍', camera: '航拍', duration: 2, visual: '塔楼压迫感', dialogue: '一句台词' },
], {
  styleBible: {
    mood: '冷峻写实',
    visualStyle: '电影感',
    colorPalette: [{ name: '冷蓝' }, { name: '雪白' }],
    lighting: '冷白顶光高反差',
  },
  generatedAt: '2026-06-01T00:00:00.000Z',
});
const normalizedB = normalizeGeneratedShotPlan([
  { shotType: '广角全景', camera: '固定机位', durationSec: 9, visual: '城市夜景', dialogue: '' },
  { shotType: '仰拍', camera: '航拍', duration: 2, visual: '塔楼压迫感', dialogue: '一句台词' },
], {
  styleBible: {
    mood: '冷峻写实',
    visualStyle: '电影感',
    colorPalette: [{ name: '冷蓝' }, { name: '雪白' }],
    lighting: '冷白顶光高反差',
  },
  generatedAt: '2026-06-01T00:00:00.000Z',
});

assert.deepEqual(normalizedA, normalizedB);
assert.equal(normalizedA.shots.length, 2);
assert.match(normalizedA.shots[0].shotUid, /^shot_[a-f0-9]{16}$/);
assert.match(normalizedA.shots[1].shotUid, /^shot_[a-f0-9]{16}$/);
assert.notEqual(normalizedA.shots[0].shotUid, normalizedA.shots[1].shotUid);
assert.equal(normalizedA.shots[0].shotType, '大全景');
assert.equal(normalizedA.shots[0].camera, '固定镜头');
assert.equal(normalizedA.shots[0].durationSec, 7);
assert.equal(normalizedA.shots[1].shotType, '中景');
assert.equal(normalizedA.shots[1].angle, '仰拍');
assert.equal(normalizedA.shots[1].camera, '升降');
assert.equal(normalizedA.shots[1].durationSec, 2);
assert.equal(normalizedA.planMeta.version, 4);
assert.equal(normalizedA.planMeta.generatedAt, '2026-06-01T00:00:00.000Z');
assert.equal(normalizedA.planMeta.shotCount, 2);
assert.equal(normalizedA.planMeta.plannedDurationSec, 9);
assert.deepEqual(normalizedA.planMeta.primaryAngles, ['平视', '仰拍']);
assert.equal(normalizedA.planMeta.styleTone, '冷峻写实');
assert.equal(normalizedA.planMeta.paletteAnchor, '冷蓝、雪白');
assert.equal(normalizedA.planMeta.lightingAnchor, '冷白顶光高反差');
assert.equal(normalizedA.validation.ok, false);
assert.deepEqual(normalizedA.validation.errors, ['shot_count_out_of_range:2']);

// P6（时长解锁）：下限放开到 1，短镜头不再被顶到 3，交由合并/生成兜底
const shortFloor = normalizeGeneratedShotPlan([
  { shotType: '特写', camera: '固定机位', duration: 1, visual: '快切插入', dialogue: '' },
], { generatedAt: '2026-06-01T00:00:00.000Z' });
assert.equal(shortFloor.shots[0].durationSec, 1, '1s 快镜头应被保留，不再顶到 3');

const variedDefaults = normalizeGeneratedShotPlan([
  { shotType: '全景', emotion: 'setup', visual: '清晨街口' },
  { shotType: '特写', emotion: 'climax', visual: '角色眼神爆发' },
], { generatedAt: '2026-06-01T00:00:00.000Z' });
assert.notEqual(variedDefaults.shots[0].light, variedDefaults.shots[1].light, 'missing light should derive by emotion instead of one flat default');
assert.notEqual(variedDefaults.shots[0].composition, variedDefaults.shots[1].composition, 'missing composition should derive by shot type instead of one flat default');

const sixShotPlan = normalizeGeneratedShotPlan(Array.from({ length: 6 }, (_, idx) => ({
  shotType: idx % 2 ? '中景' : '全景',
  camera: idx % 3 ? '固定机位' : '缓慢推进',
  durationSec: 4,
  visual: `剧情动作 ${idx + 1}`,
  dialogue: idx === 0 ? '一句稍长但没有超出预算的台词' : '',
})), { generatedAt: '2026-06-01T00:00:00.000Z' });
assert.equal(sixShotPlan.validation.ok, true, '6-shot plan should pass hard validation');
assert.deepEqual(sixShotPlan.validation.errors, []);
assert.equal(sixShotPlan.planMeta.validation.ok, true, 'planMeta should carry validation summary');

const invalidValidation = validateGeneratedShotPlan([
  { idx: 2, durationSec: 8, visual: '', shotType: '', camera: '' },
], { shotCount: 2, plannedDurationSec: 1 });
assert.equal(invalidValidation.ok, false);
assert(invalidValidation.errors.includes('shot_count_out_of_range:1'));
assert(invalidValidation.errors.includes('shot_1:idx_not_contiguous'));
assert(invalidValidation.errors.includes('shot_1:missing_visual'));
assert(invalidValidation.errors.includes('shot_1:duration_out_of_range'));

const batchExecutorSource = readFileSync(new URL('../lib/batch-executors.ts', import.meta.url), 'utf8');
const shotsExecutorStart = batchExecutorSource.indexOf("registerExecutor('shots'");
const shotsExecutorEnd = batchExecutorSource.indexOf("registerExecutor(", shotsExecutorStart + 30);
const shotsExecutorBlock = batchExecutorSource.slice(
  shotsExecutorStart,
  shotsExecutorEnd > 0 ? shotsExecutorEnd : undefined,
);
assert.match(
  shotsExecutorBlock,
  /shot-plan validation signals/,
  'shots executor should treat validation failures as observable signals',
);
const validationBranchStart = shotsExecutorBlock.indexOf('if (planValidation');
const validationBranchEnd = shotsExecutorBlock.indexOf("ctx.progress({ stage: 'assembling'", validationBranchStart);
const validationBranch = shotsExecutorBlock.slice(validationBranchStart, validationBranchEnd);
assert.doesNotMatch(
  validationBranch,
  /throw new Error/,
  'shots executor must not hard-fail a non-empty normalized shot plan on validation signals',
);
assert.doesNotMatch(
  shotsExecutorBlock,
  /AI 返回的镜头计划结构不完整/,
  'shots executor must not keep the old validation hard-fail error',
);

console.log('test-shot-plan-normalize: ok');
