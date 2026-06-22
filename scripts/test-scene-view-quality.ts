import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSceneViewQualityPrompt,
  buildSceneViewQualityRetryPrompt,
  evaluateSceneViewQuality,
  formatSceneViewQualityRubricCards,
  normalizeSceneViewQualityResult,
  SCENE_VIEW_QUALITY_PASS_SCORE,
  shouldEvaluateSceneViewQuality,
  skippedSceneViewQualityResult,
} from '../lib/scene-view-quality';
import type { ResolvedModelConfig } from '../lib/model-routing';

const fakeCfg: ResolvedModelConfig = {
  baseUrl: '',
  apiKey: '',
  model: 'fake',
  contextWindow: 128000,
  maxOutputTokens: 8192,
  mode: 'fake',
  source: 'fallback',
  provider: 'fake',
  role: 'frameConsistencyCheck',
};

const realVisionCfg: ResolvedModelConfig = {
  baseUrl: 'https://example.test',
  apiKey: 'test-key',
  model: 'vision-model',
  contextWindow: 128000,
  maxOutputTokens: 8192,
  mode: 'real',
  source: 'env',
  provider: 'openai_responses',
  role: 'frameConsistencyCheck',
};

function testGateBoundary() {
  assert.equal(shouldEvaluateSceneViewQuality('scene', 'reverse'), true);
  assert.equal(shouldEvaluateSceneViewQuality('scene', 'alt'), true);
  assert.equal(shouldEvaluateSceneViewQuality('scene', 'topdown'), true);
  assert.equal(shouldEvaluateSceneViewQuality('scene', 'establishing'), false);
  assert.equal(shouldEvaluateSceneViewQuality('char', 'reverse'), false);
  assert.equal(shouldEvaluateSceneViewQuality('prop', 'topdown'), false);
}

function testNormalizeDecision() {
  const retry = normalizeSceneViewQualityResult({
    raw: { score: 48, sceneIdentityScore: 42, reasons: ['different layout'], retryPromptHint: 'Preserve the plaza axis.' },
    viewRole: 'reverse',
    attempt: 0,
  });
  assert.equal(retry.status, 'checked');
  assert.equal(retry.decision, 'retry');
  assert.equal(retry.score, 48);
  assert.equal(retry.threshold, SCENE_VIEW_QUALITY_PASS_SCORE);
  assert.equal(retry.sceneIdentityScore, 42);
  assert.equal(retry.reasons[0], 'different layout');

  const exhausted = normalizeSceneViewQualityResult({
    raw: { score: 48, reasons: ['still weak'] },
    viewRole: 'reverse',
    attempt: 1,
  });
  assert.equal(exhausted.decision, 'accept', 'retry budget exhausted should accept best available candidate');

  const pass = normalizeSceneViewQualityResult({
    raw: { score: 82 },
    viewRole: 'topdown',
    attempt: 0,
  });
  assert.equal(pass.decision, 'accept');
}

function testFailOpenResult() {
  const skipped = skippedSceneViewQualityResult('alt', 'not configured', fakeCfg);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.decision, 'accept');
  assert.equal(skipped.score, null);
  assert.equal(skipped.model, 'fake');
}

function testRetryPrompt() {
  const check = normalizeSceneViewQualityResult({
    raw: { score: 50, reasons: ['missing shared entrance'], retryPromptHint: 'Keep the entrance and central altar aligned.' },
    viewRole: 'alt',
    attempt: 0,
  });
  const prompt = buildSceneViewQualityRetryPrompt('base prompt', check);
  assert.match(prompt, /SCENE VIEW CONSISTENCY RETRY LOCK/);
  assert.match(prompt, /missing shared entrance/);
  assert.match(prompt, /central altar/);
}

function testRubricCardFormatting() {
  const rubric = formatSceneViewQualityRubricCards([{
    title: '空间一致性规则',
    data: {
      content: '只判断同一物理空间。',
      hardRules: ['同风格不等于同空间。'],
      scoreFields: ['spatialLayoutScore: 检查空间锚点。'],
      outputSchema: '{"score":0-100}',
    },
  } as any]);
  assert.match(rubric, /空间一致性规则/);
  assert.match(rubric, /同风格不等于同空间/);
  const prompt = buildSceneViewQualityPrompt({ viewRole: 'topdown', rubric });
  assert.match(prompt, /Additional rubric/);
  assert.match(prompt, /spatialLayoutScore/);
  assert.doesNotMatch(rubric, /75/, 'rubric card text must not become threshold authority');
}

async function testEvaluateFakeConfigFailOpen() {
  const result = await evaluateSceneViewQuality({
    user: { id: 1, phone: '', display_name: '', username: '' } as any,
    viewRole: 'reverse',
    establishingImagePath: '/path/does/not/matter.png',
    candidateImagePath: '/path/does/not/matter-2.png',
  }, {
    resolveTextModelConfigImpl: () => fakeCfg,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.decision, 'accept');
}

async function testEvaluateConfigThrowFailOpen() {
  const result = await evaluateSceneViewQuality({
    user: { id: 1, phone: '', display_name: '', username: '' } as any,
    viewRole: 'reverse',
    establishingImagePath: '/path/does/not/matter.png',
    candidateImagePath: '/path/does/not/matter-2.png',
  }, {
    resolveTextModelConfigImpl: () => {
      throw new Error('config exploded');
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.decision, 'accept');
  assert.match(result.reasons.join(' '), /config exploded/);
}

async function testEvaluateBudgetThrowFailOpen() {
  const dir = mkdtempSync(join(tmpdir(), 'scene-view-quality-'));
  try {
    const establishingPath = join(dir, 'establishing.png');
    const candidatePath = join(dir, 'candidate.png');
    writeFileSync(establishingPath, 'fake-image');
    writeFileSync(candidatePath, 'fake-image');
    const result = await evaluateSceneViewQuality({
      user: { id: 1, phone: '', display_name: '', username: '' } as any,
      viewRole: 'alt',
      establishingImagePath: establishingPath,
      candidateImagePath: candidatePath,
      rubric: '',
    }, {
      resolveTextModelConfigImpl: () => realVisionCfg,
      applyTokenBudgetImpl: () => {
        throw new Error('budget exploded');
      },
      postJsonImpl: async () => {
        throw new Error('postJson should not be reached');
      },
    });
    assert.equal(result.status, 'error');
    assert.equal(result.decision, 'accept');
    assert.equal(result.model, 'vision-model');
    assert.equal(result.provider, 'openai_responses');
    assert.match(result.reasons.join(' '), /budget exploded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testGateBoundary();
  testNormalizeDecision();
  testFailOpenResult();
  testRetryPrompt();
  testRubricCardFormatting();
  await testEvaluateFakeConfigFailOpen();
  await testEvaluateConfigThrowFailOpen();
  await testEvaluateBudgetThrowFailOpen();
  console.log('[test-scene-view-quality] all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
