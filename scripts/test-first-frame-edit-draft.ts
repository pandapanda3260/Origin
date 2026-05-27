import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyFirstFrameDraftToPlan,
  buildFirstFrameDraftWithReferenceAttachment,
  buildFirstFrameDraftWithReferenceSelection,
  buildFirstFrameMaterialPanel,
  computeFirstFrameEditSourceHash,
  currentFirstFrameEditDraft,
  effectiveFirstFrameReferences,
  FirstFrameDraftValidationException,
  firstFrameDraftFingerprint,
  LEGACY_STYLE_RULE_BLOCK_PREFIX,
  MAX_NEGATIVE_PROMPT_CHARS,
  MAX_PROMPT_OVERRIDE_CHARS,
  mergeFirstFrameDraftPatch,
  normalizeFirstFrameDraftForFingerprint,
  validateAndNormalizeFirstFrameDraftWithWarnings,
} from '../lib/first-frame-edit-draft';
import { getDb } from '../lib/db';
import { getDataDir } from '../lib/runtime-paths';

const baseDraft = {
  sourceHash: 'source-a',
  content: 'base prompt',
  negativePromptOverride: 'base negative',
  referenceOverrides: {
    excluded: [{ role: 'character', assetId: 'char-a' }],
    added: [{ role: 'prop', assetId: 'prop-a' }],
  },
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 7,
};

const CHAR_A_IMAGE_ID = '11111111-1111-4111-8111-111111111111';
const SCENE_A_IMAGE_ID = '22222222-2222-4222-8222-222222222222';
const PROP_X_IMAGE_ID = '33333333-3333-4333-8333-333333333333';
const LIBRARY_CHAR_IMAGE_ID = '44444444-4444-4444-8444-444444444444';

function ensureImageFixture(ownerId: number, imageId: string) {
  const filename = `${imageId}.png`;
  const dir = join(getDataDir(), 'images', String(ownerId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), Buffer.from('fixture'));
  const db = getDb();
  const hadUser = !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(ownerId);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, display_name, password_hash)
     VALUES (?, ?, ?, ?)`,
  ).run(ownerId, `first-frame-test-${ownerId}`, 'First Frame Test', 'test');
  db.prepare(
    `INSERT OR REPLACE INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, null)`,
  ).run(imageId, ownerId, 'first-frame-edit-test', 'test', 'legacy-added-fixture', filename, 'image/png', 7, 'fixture');
  process.once('exit', () => {
    try { db.prepare('DELETE FROM images WHERE id = ?').run(imageId); } catch (_) {}
    if (!hadUser) {
      try { db.prepare('DELETE FROM users WHERE id = ?').run(ownerId); } catch (_) {}
    }
    try { rmSync(join(dir, filename), { force: true }); } catch (_) {}
  });
}

ensureImageFixture(7, PROP_X_IMAGE_ID);

function panelUrls(panel: ReturnType<typeof buildFirstFrameMaterialPanel>): string[] {
  return panel.orderedTiles.map((tile) => tile.url);
}

function effectiveUrls(refs: ReturnType<typeof effectiveFirstFrameReferences>): string[] {
  return refs.imageRefs.map((ref) => ref.remoteUrl || '').filter(Boolean);
}

function assertPanelMatchesEffective(
  panel: ReturnType<typeof buildFirstFrameMaterialPanel>,
  refs: ReturnType<typeof effectiveFirstFrameReferences>,
) {
  assert.deepEqual(panelUrls(panel), effectiveUrls(refs));
}

{
  const next = mergeFirstFrameDraftPatch(baseDraft, {
    content: 'new prompt',
  });

  assert.equal(next.content, 'new prompt');
  assert.equal('promptOverride' in next, false);
  assert.equal(next.negativePromptOverride, 'base negative');
  assert.deepEqual(next.referenceOverrides, baseDraft.referenceOverrides);
  assert.equal('styleRuleOverrides' in next, false);
}

{
  const next = mergeFirstFrameDraftPatch(baseDraft, {
    content: null,
    styleRuleOverrides: ['legacy patch ignored'],
  });

  assert.equal('content' in next, false);
  assert.equal('styleRuleOverrides' in next, false);
  assert.equal(next.negativePromptOverride, 'base negative');
}

{
  const next = mergeFirstFrameDraftPatch(baseDraft, {
    referenceOverrides: {
      excluded: [{ role: 'scene', assetId: 'scene-a' }],
    },
  });

  assert.deepEqual(next.referenceOverrides, {
    excluded: [{ role: 'scene', assetId: 'scene-a' }],
    added: [{ role: 'prop', assetId: 'prop-a' }],
  });
}

{
  const next = mergeFirstFrameDraftPatch(baseDraft, {
    referenceOverrides: {
      added: [],
    },
  });

  assert.deepEqual(next.referenceOverrides, {
    excluded: [{ role: 'character', assetId: 'char-a' }],
  });
}

{
  const next = mergeFirstFrameDraftPatch(baseDraft, {
    referenceOverrides: null,
  });

  assert.equal('referenceOverrides' in next, false);
}

const project = {
  shots: [{ visual: '角色在室内看向窗外' }],
  storyboards: [{ idx: 0, shotIdx: 1, shotIndices: [0] }],
  styleBible: {},
  assets: {
    characters: [{ id: 'char-a', name: 'Ada', imageUrl: `/api/images/file/${CHAR_A_IMAGE_ID}`, localPath: '/tmp/char-a.png' }],
    scenes: [{ id: 'scene-a', name: 'Room', imageUrl: `/api/images/file/${SCENE_A_IMAGE_ID}`, localPath: '/tmp/scene-a.png' }],
    props: [{ id: 'prop-x', name: 'Lantern', imageUrl: `/api/images/file/${PROP_X_IMAGE_ID}`, localPath: '/tmp/prop-x.png' }],
  },
};

const plan: any = {
  frameType: 'first_frame',
  groupIdx: 0,
  shotIndices: [0],
  primaryShotIdx: 0,
  primaryShot: project.shots[0],
  contextShots: [],
  aspectRatio: '16:9',
  compositionGuidance: '',
  contextShotIndices: [],
  characters: [],
  scene: null,
  props: [],
  styleLock: '',
  driftGuardrails: '',
  characterLockText: '',
  sceneLockText: '',
  propLockText: '',
  shotConstraintText: '',
  referenceManifest: [
    {
      slot: 1,
      imageNo: 1,
      role: 'character',
      assetId: 'char-a',
      assetName: 'Ada',
      remoteUrl: `/api/images/file/${CHAR_A_IMAGE_ID}`,
      localPath: '/tmp/char-a.png',
      textFallback: 'Ada',
      delivery: 'image',
    },
    {
      slot: 2,
      imageNo: 2,
      role: 'scene',
      assetId: 'scene-a',
      assetName: 'Room',
      remoteUrl: `/api/images/file/${SCENE_A_IMAGE_ID}`,
      localPath: '/tmp/scene-a.png',
      textFallback: 'Room',
      delivery: 'image',
    },
  ],
  finalPrompt: 'base prompt',
  modelSnapshot: {
    provider: 'test',
    model: 'test-image',
    quality: 'medium',
    multiRefImageCap: 4,
  },
};

{
  const longPrompt = 'p'.repeat(3500);
  const { draft } = validateAndNormalizeFirstFrameDraftWithWarnings({
    project,
    groupIdx: 0,
    userId: 7,
    input: { content: longPrompt },
    plan,
  });
  assert.equal(draft.content, longPrompt);
  assert.ok(longPrompt.length > 2000);
  assert.ok(longPrompt.length < MAX_PROMPT_OVERRIDE_CHARS);
}

{
  const overLimitPrompt = 'p'.repeat(MAX_PROMPT_OVERRIDE_CHARS + 1);
  assert.throws(
    () => validateAndNormalizeFirstFrameDraftWithWarnings({
      project,
      groupIdx: 0,
      userId: 7,
      input: { content: overLimitPrompt },
      plan,
    }),
    (err: any) => err instanceof FirstFrameDraftValidationException
      && err.errors.some((item: any) => item.field === 'content' && item.message.includes(String(MAX_PROMPT_OVERRIDE_CHARS))),
  );
}

{
  const overLimitNegative = 'n'.repeat(MAX_NEGATIVE_PROMPT_CHARS + 1);
  assert.throws(
    () => validateAndNormalizeFirstFrameDraftWithWarnings({
      project,
      groupIdx: 0,
      userId: 7,
      input: { negativePromptOverride: overLimitNegative },
      plan,
    }),
    (err: any) => err instanceof FirstFrameDraftValidationException
      && err.errors.some((item: any) => item.field === 'negativePromptOverride' && item.message.includes(String(MAX_NEGATIVE_PROMPT_CHARS))),
  );
}

{
  const normalizedA = normalizeFirstFrameDraftForFingerprint({
    updatedAt: 'ignored',
    updatedBy: 99,
    content: '',
    styleRuleOverrides: ['  beta  ', 'alpha', ''],
    referenceOverrides: {
      added: [
        { role: 'prop', assetId: 'prop-b' },
        { role: 'prop', assetId: 'prop-b' },
        { role: 'character', assetId: 'char-a' },
      ],
      excluded: [
        { role: 'scene', assetName: 'Room', imageNo: 2 },
        { imageNo: 2, assetName: 'Room', role: 'scene' },
      ],
    },
  });

  assert.deepEqual(normalizedA, {
    referenceOverrides: {
      excluded: [{ role: 'scene', assetName: 'Room', imageNo: 2 }],
      added: [
        { role: 'character', assetId: 'char-a' },
        { role: 'prop', assetId: 'prop-b' },
      ],
    },
  });
  assert.equal(
    firstFrameDraftFingerprint({ referenceOverrides: { added: [{ role: 'prop', assetId: 'prop-b' }, { role: 'character', assetId: 'char-a' }] } }),
    firstFrameDraftFingerprint({ referenceOverrides: { added: [{ role: 'character', assetId: 'char-a' }, { role: 'prop', assetId: 'prop-b' }] } }),
  );
  assert.equal(
    firstFrameDraftFingerprint({ styleRuleOverrides: ['alpha'] }),
    firstFrameDraftFingerprint({}),
  );
  assert.notEqual(
    firstFrameDraftFingerprint({ firstFrameReferenceSelection: { mode: 'manual', includeIds: ['ref:char:char-a'] } }),
    firstFrameDraftFingerprint({ firstFrameReferenceSelection: { mode: 'manual', includeIds: ['ref:scene:scene-a'] } }),
  );
  assert.notEqual(
    firstFrameDraftFingerprint({ firstFrameReferenceAttachments: [{ id: 'upload:a', imageId: '11111111-1111-4111-8111-111111111111', role: 'scene', url: '/api/images/file/11111111-1111-4111-8111-111111111111' }] }),
    firstFrameDraftFingerprint({ firstFrameReferenceAttachments: [{ id: 'upload:b', imageId: '22222222-2222-4222-8222-222222222222', role: 'scene', url: '/api/images/file/22222222-2222-4222-8222-222222222222' }] }),
  );
}

{
  const { draft, didMigrate } = currentFirstFrameEditDraft({
    storyboards: [{
      firstFrameEditDraft: {
        sourceHash: 'source-a',
        content: '',
        styleRuleOverrides: ['  保留手绘质感  ', ''],
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 7,
      },
    }],
  }, 0);

  assert.equal(didMigrate, true);
  assert.ok(draft);
  assert.equal('styleRuleOverrides' in draft!, false);
  assert.ok(draft!.content?.startsWith(LEGACY_STYLE_RULE_BLOCK_PREFIX));
  assert.match(draft!.content || '', /保留手绘质感/);

  const finalPlan = applyFirstFrameDraftToPlan({ project, userId: 7, plan, draft: draft! });
  assert.ok(finalPlan.finalPrompt.startsWith('base prompt'));
  assert.match(finalPlan.finalPrompt, /保留手绘质感/);

  const chained = currentFirstFrameEditDraft({ storyboards: [{ firstFrameEditDraft: draft }] }, 0);
  assert.equal(chained.didMigrate, false);
  assert.deepEqual(chained.draft, draft);
}

{
  const { draft, didMigrate } = currentFirstFrameEditDraft({
    storyboards: [{
      firstFrameEditDraft: {
        sourceHash: 'source-a',
        content: 'custom prompt',
        styleRuleOverrides: ['以前未生效的规则'],
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 7,
      },
    }],
  }, 0);

  assert.equal(didMigrate, true);
  assert.equal('styleRuleOverrides' in draft!, false);
  assert.equal(draft!.content?.startsWith(LEGACY_STYLE_RULE_BLOCK_PREFIX), false);
  assert.match(draft!.content || '', /custom prompt/);
  assert.match(draft!.content || '', /以前未生效的规则/);

  const finalPlan = applyFirstFrameDraftToPlan({ project, userId: 7, plan, draft: draft! });
  assert.equal(finalPlan.finalPrompt.startsWith('base prompt'), false);
  assert.match(finalPlan.finalPrompt, /custom prompt/);
}

{
  const { draft, didMigrate } = currentFirstFrameEditDraft({
    storyboards: [{
      firstFrameEditDraft: {
        sourceHash: 'source-a',
        styleRuleOverrides: [' ', ''],
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 7,
      },
    }],
  }, 0);

  assert.equal(didMigrate, false);
  assert.ok(draft);
  assert.equal('styleRuleOverrides' in draft!, false);
  assert.equal('content' in draft!, false);
}

{
  const result = validateAndNormalizeFirstFrameDraftWithWarnings({
    project,
    groupIdx: 0,
    userId: 7,
    input: {
      referenceOverrides: {
        excluded: [{ role: 'character', assetId: 'char-a' }],
        added: [{ role: 'character', assetId: 'char-a' }],
      },
    },
    plan,
  });

  assert.deepEqual(result.draft.referenceOverrides?.added, [{ role: 'character', assetId: 'char-a' }]);
  assert.equal(result.draft.referenceOverrides?.excluded, undefined);
  assert.equal(result.warnings.some((warning) => warning.code === 'reference_conflict_normalized'), true);
}

{
  const result = validateAndNormalizeFirstFrameDraftWithWarnings({
    project,
    groupIdx: 0,
    userId: 7,
    input: {
      referenceOverrides: {
        excluded: [{ role: 'scene', assetId: 'scene-a' }],
      },
    },
    plan,
  });

  assert.equal(result.warnings.some((warning) => warning.code === 'reference_count_reduced'), true);
}

{
  const result = validateAndNormalizeFirstFrameDraftWithWarnings({
    project,
    groupIdx: 0,
    userId: 7,
    input: {
      referenceOverrides: {
        excluded: [
          { role: 'character', assetId: 'char-a' },
          { role: 'scene', assetId: 'scene-a' },
        ],
      },
    },
    plan,
  });
  assert.deepEqual(result.draft.referenceOverrides?.excluded, [
    { role: 'character', assetId: 'char-a' },
    { role: 'scene', assetId: 'scene-a' },
  ]);
  assert.equal(result.warnings.some((warning) => warning.code === 'reference_count_reduced'), true);
  assert.equal(effectiveFirstFrameReferences(project, 7, plan, result.draft).imageRefs.length, 0);
}

{
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const panel = buildFirstFrameMaterialPanel({
    project,
    userId: 7,
    plan,
    draft: null,
    sourceHash,
  });
  assert.equal(panel.cap, 4);
  assert.equal(panel.productCap, 4);
  assert.equal(panel.used, 2);
  assert.equal(panel.mode, 'auto');
  assert.equal(panel.groups.char.length, 1);
  assert.equal(panel.groups.scene.length, 1);
  assert.match(panel.groups.char[0].id, /^ref:char:/);
  assert.equal(panel.groups.char[0].imageId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(panel.orderedTileIds, ['ref:char:char-a', 'ref:scene:scene-a']);
  assert.deepEqual(panel.orderedTiles.map((tile) => tile.id), panel.orderedTileIds);
  assertPanelMatchesEffective(panel, effectiveFirstFrameReferences(project, 7, plan, null));
}

{
  const highCapabilityPlan = {
    ...plan,
    modelSnapshot: {
      ...plan.modelSnapshot,
      multiRefImageCap: 16,
    },
  };
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, highCapabilityPlan);
  const panel = buildFirstFrameMaterialPanel({
    project,
    userId: 7,
    plan: highCapabilityPlan,
    draft: null,
    sourceHash,
  });
  assert.equal(panel.productCap, 4);
  assert.equal(panel.cap, 4);
}

{
  ensureImageFixture(7, LIBRARY_CHAR_IMAGE_ID);
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const projectWithAssetLibrary = {
    ...project,
    assetLibrary: {
      current: [{
        assetId: LIBRARY_CHAR_IMAGE_ID,
        kind: 'image',
        stage: 'asset_character',
        url: `/api/images/file/${LIBRARY_CHAR_IMAGE_ID}`,
        thumbUrl: `/api/images/file/${LIBRARY_CHAR_IMAGE_ID}?w=256`,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }],
    },
  };
  const panel = buildFirstFrameMaterialPanel({ project: projectWithAssetLibrary, userId: 7, plan, draft: null, sourceHash });
  assert.equal(panel.candidateGroups.char.some((tile) => tile.id === `library:${LIBRARY_CHAR_IMAGE_ID}`), true);
  assert.equal(panel.orderedTileIds.includes(`library:${LIBRARY_CHAR_IMAGE_ID}`), false);
  assert.match(panel.selectionVersion, /library:/);
  const draft = buildFirstFrameDraftWithReferenceSelection({
    baseDraft: null,
    sourceHash,
    userId: 7,
    includeIds: [`library:${LIBRARY_CHAR_IMAGE_ID}`],
    project: projectWithAssetLibrary,
    plan,
  });
  const refs = effectiveFirstFrameReferences(projectWithAssetLibrary, 7, plan, draft);
  assert.deepEqual(refs.imageRefs.map((ref) => ref.remoteUrl || ''), [`/api/images/file/${LIBRARY_CHAR_IMAGE_ID}`]);
}

{
  const materialImageId = '55555555-5555-4555-8555-555555555555';
  ensureImageFixture(7, materialImageId);
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const projectWithMaterial = {
    ...project,
    firstFrameReferenceMaterialsVersion: 'materials-test-v1',
    firstFrameReferenceMaterials: [{
      id: `upload:${materialImageId}`,
      imageId: materialImageId,
      role: 'scene',
      name: '用户上传场景',
      url: `/api/images/file/${materialImageId}`,
      thumbUrl: `/api/images/file/${materialImageId}`,
      uploadedAt: '2026-01-01T00:00:00.000Z',
      uploadedBy: 7,
    }],
  };
  const panel = buildFirstFrameMaterialPanel({ project: projectWithMaterial, userId: 7, plan, draft: null, sourceHash });
  assert.equal(panel.candidateGroups.scene.some((tile) => tile.id === `upload:${materialImageId}`), true);
  assert.equal(panel.orderedTileIds.includes(`upload:${materialImageId}`), false);
  assert.match(panel.selectionVersion, /materials-test-v1/);
  const draft = buildFirstFrameDraftWithReferenceSelection({
    baseDraft: null,
    sourceHash,
    userId: 7,
    includeIds: ['ref:char:char-a', `upload:${materialImageId}`],
    project: projectWithMaterial,
    plan,
  });
  assert.equal(draft.firstFrameReferenceAttachments, undefined);
  assert.deepEqual(draft.firstFrameReferenceSelection?.includeIds, ['ref:char:char-a', `upload:${materialImageId}`]);
  const refs = effectiveFirstFrameReferences(projectWithMaterial, 7, plan, draft);
  assert.deepEqual(refs.imageRefs.map((ref) => ref.remoteUrl || ''), [
    `/api/images/file/${CHAR_A_IMAGE_ID}`,
    `/api/images/file/${materialImageId}`,
  ]);
}

{
  const limitedPlan = {
    ...plan,
    modelSnapshot: {
      ...plan.modelSnapshot,
      multiRefImageCap: 1,
    },
  };
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, limitedPlan);
  const panel = buildFirstFrameMaterialPanel({
    project,
    userId: 7,
    plan: limitedPlan,
    draft: null,
    sourceHash,
  });
  assert.equal(panel.cap, 1);
  assert.equal(panel.productCap, 4);
  assert.equal(panel.used, 1);
  assert.equal(panel.remaining, 0);
}

{
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const legacyDraft = {
    sourceHash,
    referenceOverrides: {
      excluded: [{ role: 'character', assetId: 'char-a' }],
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 7,
  };
  const effectiveRefs = effectiveFirstFrameReferences(project, 7, plan, legacyDraft);
  const panel = buildFirstFrameMaterialPanel({
    project,
    userId: 7,
    plan,
    draft: legacyDraft,
    sourceHash,
  });
  const panelUrls = Object.values(panel.groups).flat().map((tile) => tile.url).sort();
  const submissionUrls = effectiveRefs.imageRefs.map((ref) => ref.remoteUrl || '').filter(Boolean).sort();
  assert.equal(panel.mode, 'manual');
  assert.match(panel.selectionVersion, /^legacy:/);
  assert.deepEqual(panelUrls, submissionUrls);
  assertPanelMatchesEffective(panel, effectiveRefs);
  assert.equal(panel.groups.char.length, 0);
  assert.equal(panel.groups.scene.length, 1);
}

{
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const legacyDraft = {
    sourceHash,
    referenceOverrides: {
      added: [{ role: 'prop' as const, assetId: 'prop-x' }],
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 7,
  };
  const effectiveRefs = effectiveFirstFrameReferences(project, 7, plan, legacyDraft);
  const panel = buildFirstFrameMaterialPanel({ project, userId: 7, plan, draft: legacyDraft, sourceHash });
  const panelUrls = Object.values(panel.groups).flat().map((tile) => tile.url).sort();
  const submissionUrls = effectiveRefs.imageRefs.map((ref) => ref.remoteUrl || '').filter(Boolean).sort();
  assert.deepEqual(panelUrls, submissionUrls);
  assertPanelMatchesEffective(panel, effectiveRefs);
  assert.equal(panel.groups.prop.length, 1);
  assert.equal(panel.groups.prop[0].id, 'ref:prop:prop-x');
}

{
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const legacyDraft = {
    sourceHash,
    referenceOverrides: {
      added: [{ role: 'prop' as const, assetId: 'prop-x' }],
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 7,
  };
  const beforePanel = buildFirstFrameMaterialPanel({ project, userId: 7, plan, draft: legacyDraft, sourceHash });
  const includeIds = Object.values(beforePanel.groups)
    .flat()
    .filter((tile) => tile.id !== 'ref:char:char-a')
    .map((tile) => tile.id);
  const migratedDraft = buildFirstFrameDraftWithReferenceSelection({
    baseDraft: legacyDraft,
    sourceHash,
    userId: 7,
    includeIds,
    project,
    plan,
  });
  assert.equal('referenceOverrides' in migratedDraft, false);
  assert.equal(migratedDraft.firstFrameReferenceAttachments?.some((item) => item.id === 'ref:prop:prop-x'), true);
  const afterPanel = buildFirstFrameMaterialPanel({ project, userId: 7, plan, draft: migratedDraft, sourceHash });
  const effectiveRefs = effectiveFirstFrameReferences(project, 7, plan, migratedDraft);
  const panelUrls = Object.values(afterPanel.groups).flat().map((tile) => tile.url).sort();
  const submissionUrls = effectiveRefs.imageRefs.map((ref) => ref.remoteUrl || '').filter(Boolean).sort();
  assert.deepEqual(panelUrls, submissionUrls);
  assertPanelMatchesEffective(afterPanel, effectiveRefs);
  assert.equal(afterPanel.groups.char.length, 0);
  assert.equal(afterPanel.groups.scene.length, 1);
  assert.equal(afterPanel.groups.prop.length, 1);
}

{
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const legacyDraft = {
    sourceHash,
    referenceOverrides: {
      added: [{ role: 'character' as const, assetId: 'char-a' }],
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 7,
  };
  const panel = buildFirstFrameMaterialPanel({ project, userId: 7, plan, draft: legacyDraft, sourceHash });
  const effectiveRefs = effectiveFirstFrameReferences(project, 7, plan, legacyDraft);
  const panelUrls = Object.values(panel.groups).flat().map((tile) => tile.url).sort();
  const submissionUrls = effectiveRefs.imageRefs.map((ref) => ref.remoteUrl || '').filter(Boolean).sort();
  assert.deepEqual(panelUrls, submissionUrls);
  assertPanelMatchesEffective(panel, effectiveRefs);
  assert.equal(panel.used, submissionUrls.length);
  assert.equal(new Set(submissionUrls).size, submissionUrls.length);
}

{
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const draft = validateAndNormalizeFirstFrameDraftWithWarnings({
    project,
    groupIdx: 0,
    userId: 7,
    input: {
      firstFrameReferenceSelection: {
        mode: 'manual',
        includeIds: ['ref:char:char-a'],
        version: 'manual-1',
      },
    },
    plan,
  }).draft;
  assert.equal(draft.sourceHash, sourceHash);
  const refs = effectiveFirstFrameReferences(project, 7, plan, draft);
  assert.equal(refs.imageRefs.length, 1);
  assert.equal(refs.imageRefs[0].assetId, 'char-a');
  const panel = buildFirstFrameMaterialPanel({ project, userId: 7, plan, draft, sourceHash });
  assert.equal(panel.mode, 'manual');
  assert.equal(panel.selectionVersion, 'manual-1');
  assert.equal(panel.used, 1);
  assert.deepEqual(panel.orderedTileIds, ['ref:char:char-a']);
  assertPanelMatchesEffective(panel, refs);
}

{
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const draft = validateAndNormalizeFirstFrameDraftWithWarnings({
    project,
    groupIdx: 0,
    userId: 7,
    input: {
      firstFrameReferenceSelection: {
        mode: 'manual',
        includeIds: ['ref:scene:scene-a', 'ref:char:char-a'],
        order: ['ref:char:char-a', 'ref:scene:scene-a'],
        version: 'manual-order-legacy',
      },
    },
    plan,
  }).draft;
  assert.equal(draft.firstFrameReferenceSelection?.order, undefined);
  assert.deepEqual(draft.firstFrameReferenceSelection?.includeIds, ['ref:char:char-a', 'ref:scene:scene-a']);
  const refs = effectiveFirstFrameReferences(project, 7, plan, draft);
  const panel = buildFirstFrameMaterialPanel({ project, userId: 7, plan, draft, sourceHash });
  assert.deepEqual(panel.orderedTileIds, ['ref:char:char-a', 'ref:scene:scene-a']);
  assert.deepEqual(refs.imageRefs.map((ref) => ref.assetId), ['char-a', 'scene-a']);
  assertPanelMatchesEffective(panel, refs);
}

{
  const uploadImageId = '44444444-4444-4444-8444-444444444444';
  ensureImageFixture(7, uploadImageId);
  const sourceHash = computeFirstFrameEditSourceHash(project, 7, 0, plan);
  const uploadedDraft = buildFirstFrameDraftWithReferenceAttachment({
    baseDraft: {
      sourceHash,
      firstFrameReferenceSelection: {
        sourceHash,
        mode: 'manual',
        includeIds: ['ref:char:char-a'],
        version: 'manual-upload-base',
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 7,
    },
    sourceHash,
    userId: 7,
    attachment: {
      id: 'upload:scene-new',
      imageId: uploadImageId,
      role: 'scene',
      name: '上传场景',
      url: `/api/images/file/${uploadImageId}`,
      thumbUrl: `/api/images/file/${uploadImageId}`,
      uploadedAt: '2026-01-01T00:00:00.000Z',
      uploadedBy: 7,
    },
    includeIds: ['ref:char:char-a', 'upload:scene-new'],
    project,
    plan,
  });
  assert.equal(uploadedDraft.firstFrameReferenceSelection?.order, undefined);
  assert.deepEqual(uploadedDraft.firstFrameReferenceSelection?.includeIds, ['ref:char:char-a', 'upload:scene-new']);
  const panel = buildFirstFrameMaterialPanel({ project, userId: 7, plan, draft: uploadedDraft, sourceHash });
  const refs = effectiveFirstFrameReferences(project, 7, plan, uploadedDraft);
  assert.deepEqual(panel.orderedTileIds, ['ref:char:char-a', 'upload:scene-new']);
  assert.deepEqual(refs.imageRefs.map((ref) => ref.remoteUrl || ''), [
    `/api/images/file/${CHAR_A_IMAGE_ID}`,
    `/api/images/file/${uploadImageId}`,
  ]);
  assertPanelMatchesEffective(panel, refs);
}

console.log('test-first-frame-edit-draft passed');
