import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveCharacterReferenceUpdate } from '../lib/character-reference-update';
import type { SplitCharacterPanelsResult } from '../lib/character-panels';
import { buildFrameImageGenerationPlan } from '../lib/frame-image-plan';
import { selectCharacterReferencePanels } from '../lib/panel-selection';
import { mutateCharacterLock } from '../lib/character-consistency';
import { getDb } from '../lib/db';
import { getDataDir } from '../lib/runtime-paths';

const now = '2026-01-01T00:00:00.000Z';
const styleMeta = {
  styleBibleSignature: 'sig-v3',
  styleLockVersion: 3,
  resolvedBackdropColor: '#FFFFFF',
};

function ensureResolvableTestImage(ownerId: number, id: string): string {
  const dir = join(getDataDir(), 'images', String(ownerId));
  const filename = `${id}.png`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), Buffer.from([0]));
  getDb().prepare(
    `INSERT OR REPLACE INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
     VALUES (?, ?, ?, 'character', ?, ?, 'image/png', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerId,
    'test-character-reference-update',
    'characters[0].panels.front',
    filename,
    1,
    1,
    1,
    'test character panel',
    'test',
  );
  return `/api/images/file/${id}`;
}

function quality(usable = true) {
  return {
    usable,
    nonWhiteRatio: 0.2,
    bboxCoverage: 0.5,
    bboxCenterX: 0.5,
    bboxCenterY: 0.5,
  };
}

function okPanel(overrides: any = {}): Extract<SplitCharacterPanelsResult, { ok: true }> {
  return {
    ok: true,
    panels: {
      schema: 'human-character-sheet-v1',
      sourceImageId: 'panel-source',
      sourceImageUrl: '/api/images/file/source',
      sheetUrl: '/api/images/file/sheet',
      headshotUrl: '/api/images/file/head',
      frontUrl: '/api/images/file/front',
      sideUrl: '/api/images/file/side',
      backUrl: '/api/images/file/back',
      cropMethod: 'pixel-detect',
      confidence: 0.92,
      version: 2,
      generatedAt: now,
      quality: {
        headshot: quality(true),
        front: quality(true),
        side: quality(true),
        back: quality(true),
      },
      ...overrides,
    },
    panelImageIds: ['head', 'front', 'side', 'back'],
  };
}

const previous = {
  imageUrl: '/old.png',
  rawUrl: '/old.png',
  reference: {
    currentUrl: '/old.png',
    lastKnownGoodUrl: '/old.png',
    status: 'ready',
  },
  panels: {
    sheetUrl: '/old-sheet.png',
    frontUrl: '/old-front.png',
  },
};

{
  const update = deriveCharacterReferenceUpdate(previous, { url: '/new.png', id: 'new-id' }, okPanel(), 'human', styleMeta, now);
  assert.equal(update.accepted, true);
  assert.equal(update.referenceStatus, 'ready');
  assert.equal(update.nextAsset.imageUrl, '/new.png');
  assert.equal(update.nextAsset.rawUrl, '/new.png');
  assert.equal(update.nextAsset.reference.status, 'ready');
  assert.equal(update.nextAsset.reference.currentUrl, '/new.png');
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/new.png');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, undefined);
  assert.equal(update.referenceLock?.referenceStatus, 'ready');
  assert.equal(update.referenceLock?.qualityScore, 0.92);
  assert.equal(update.referenceLock?.frontUrl, '/api/images/file/front');
}

{
  const update = deriveCharacterReferenceUpdate(
    previous,
    { url: '/fallback.png', id: 'fallback-id' },
    okPanel({ cropMethod: 'percent-fallback', confidence: 0.5 }),
    'human',
    styleMeta,
    now,
  );
  assert.equal(update.accepted, true, 'usable percent fallback should be accepted');
  assert.equal(update.referenceStatus, 'ready');
  assert.equal(update.nextAsset.imageUrl, '/fallback.png');
  assert.equal(update.nextAsset.rawUrl, '/fallback.png');
  assert.equal(update.nextAsset.reference.status, 'ready');
  assert.equal(update.nextAsset.reference.currentUrl, '/fallback.png');
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/fallback.png');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, undefined);
  assert.equal(update.nextAsset.panelsError, undefined);
  assert.equal(update.nextAsset.panelsErrorAt, undefined);
  assert.equal(update.referenceLock?.referenceStatus, 'ready');
  assert.equal(update.referenceLock?.qualityScore, 0.5);
  assert.equal(update.referenceLock?.frontUrl, '/api/images/file/front');
}

function assertReady(
  panelResult: Extract<SplitCharacterPanelsResult, { ok: true }>,
  message: string,
  prev = previous,
  generated = { url: '/new.png', id: 'new-id' },
) {
  const update = deriveCharacterReferenceUpdate(prev, generated, panelResult, 'human', styleMeta, now);
  assert.equal(update.accepted, true, message);
  assert.equal(update.referenceStatus, 'ready', `${message}: status should be ready`);
  assert.equal(update.nextAsset.imageUrl, generated.url, `${message}: imageUrl should update to new generated image`);
  assert.equal(update.nextAsset.rawUrl, generated.url, `${message}: rawUrl should update to new generated image`);
  assert.equal(update.nextAsset.reference.status, 'ready', `${message}: reference.status should be ready`);
  assert.equal(update.nextAsset.reference.currentUrl, generated.url, `${message}: currentUrl should update to new generated image`);
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, generated.url, `${message}: lastKnownGoodUrl should update to new generated image`);
  assert.equal(update.nextAsset.reference.lastAttemptUrl, undefined, `${message}: lastAttemptUrl should be cleaned`);
  assert.equal(update.nextAsset.reference.lastError, undefined, `${message}: lastError should be cleaned`);
  assert.equal(update.nextAsset.panelsError, undefined, `${message}: panelsError should be cleared`);
  assert.equal(update.nextAsset.panelsErrorAt, undefined, `${message}: panelsErrorAt should be cleared`);
  assert.equal(update.referenceLock?.referenceStatus, 'ready', `${message}: referenceLock should be ready`);
  assert.equal(update.referenceLock?.qualityScore, panelResult.panels.confidence, `${message}: referenceLock quality should follow panel confidence`);
  assert.equal(update.referenceLock?.frontUrl, '/api/images/file/front', `${message}: referenceLock should include front panel`);
  return update;
}

function assertFailurePreservesOldGood(
  panelResult: SplitCharacterPanelsResult | null | undefined,
  message: string,
  prev = previous,
  expectedStatus: 'ready' | 'degraded' = 'ready',
) {
  const update = deriveCharacterReferenceUpdate(prev, { url: '/bad.png', id: 'bad-id' }, panelResult, 'human', styleMeta, now);
  assert.equal(update.accepted, false, message);
  assert.equal(update.referenceStatus, expectedStatus, message);
  assert.equal(update.nextAsset.imageUrl, '/old.png', `${message}: imageUrl should not be overwritten`);
  assert.equal(update.nextAsset.rawUrl, '/old.png', `${message}: rawUrl should not be overwritten`);
  assert.equal(update.nextAsset.reference.currentUrl, '/old.png', `${message}: currentUrl should not be overwritten`);
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/old.png', `${message}: lastKnownGoodUrl should not be overwritten`);
  assert.equal(update.nextAsset.reference.status, expectedStatus);
  assert.equal(update.nextAsset.reference.lastAttemptUrl, '/bad.png');
  assert.equal(update.referenceLock, undefined, `${message}: referenceLock should not overwrite existing lock`);
  assert.equal(update.nextAsset.panelsError, undefined, `${message}: top-level panelsError should not mark old-good reference failed`);
  assert.equal(update.nextAsset.panels.frontUrl, '/old-front.png', `${message}: old panel data should remain on asset`);
  assert.equal(update.nextAsset.reference.lastError.reason, 'character_panel_split_failed');
  if (panelResult?.ok) {
    assert.equal(update.nextAsset.reference.lastError.quality.front.usable, true);
  }
}

assertFailurePreservesOldGood({ ok: false, error: 'not enough usable panels' }, 'ok=false');
assertReady(okPanel({ confidence: 0.5 }), 'low confidence');
assertReady(okPanel({ confidence: 0 }), 'zero confidence');
assertReady(okPanel({ confidence: 1 }), 'full confidence');
assertReady(okPanel({
  cropMethod: 'percent-fallback',
  quality: {
    headshot: quality(true),
    front: quality(true),
    side: quality(false),
    back: quality(true),
  },
}), 'percent fallback with unusable required panel');
assertReady(okPanel({
  quality: {
    headshot: quality(true),
    front: quality(true),
    side: quality(false),
    back: quality(true),
  },
}), 'unusable required panel');
assertFailurePreservesOldGood(null, 'missing panel result');

{
  const degradedPrevious = {
    ...previous,
    reference: {
      ...previous.reference,
      status: 'degraded',
    },
  };
  assertReady(okPanel({ confidence: 0.5 }), 'low confidence with degraded previous reference', degradedPrevious);
}

{
  const lockOnlyPrevious = {
    characterId: 'crab-1',
    name: '活螃蟹',
    entityType: 'non-human',
    reference: {},
  };
  const update = deriveCharacterReferenceUpdate(
    lockOnlyPrevious,
    { url: '/bad-crab.png', id: 'bad-crab-id' },
    null,
    'non-human',
    styleMeta,
    now,
    {
      sheetUrl: '/api/images/file/old-crab-sheet',
      frontUrl: '/api/images/file/old-crab-front',
      referenceStatus: 'missing',
      qualityScore: 0.5,
    },
  );
  assert.equal(update.accepted, false);
  assert.equal(update.referenceStatus, 'failed');
  assert.equal(update.nextAsset.imageUrl, undefined);
  assert.equal(update.nextAsset.rawUrl, undefined);
  assert.equal(update.nextAsset.realPhotoUrl, undefined);
  assert.equal(update.nextAsset.reference.currentUrl, undefined);
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, undefined);
  assert.equal(update.nextAsset.reference.status, 'failed');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, '/bad-crab.png');
  assert.equal(update.nextAsset.panelsError, 'missing panel split result');
  assert.equal(update.referenceLock?.referenceStatus, 'failed');
  assert.equal(update.referenceLock?.sheetUrl, undefined);
  assert.equal(update.referenceLock?.frontUrl, undefined);
}

{
  const lockOnlyPrevious = {
    characterId: 'crab-1',
    name: '活螃蟹',
    entityType: 'non-human',
    reference: {},
  };
  const update = deriveCharacterReferenceUpdate(
    lockOnlyPrevious,
    { url: '/bad-crab.png', id: 'bad-crab-id' },
    null,
    'non-human',
    styleMeta,
    now,
    {
      sheetUrl: '/api/images/file/old-crab-sheet',
      frontUrl: '/api/images/file/old-crab-front',
      referenceStatus: 'ready',
      qualityScore: 0.9,
    },
  );
  assert.equal(update.accepted, false);
  assert.equal(update.referenceStatus, 'ready');
  assert.equal(update.nextAsset.imageUrl, '/api/images/file/old-crab-sheet');
  assert.equal(update.nextAsset.reference.currentUrl, '/api/images/file/old-crab-sheet');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, '/bad-crab.png');
  assert.equal(update.referenceLock, undefined, 'ready old lock should be preserved as-is, not rewritten');
}

{
  const pollutedPrevious = {
    imageUrl: '/old.png',
    rawUrl: '/old.png',
    reference: {
      currentUrl: '/old.png',
      lastKnownGoodUrl: '/old.png',
      status: 'failed',
    },
    panels: {
      sheetUrl: '/old-sheet.png',
      frontUrl: '/old-front.png',
      confidence: 0.92,
    },
  };
  const update = assertReady(
    okPanel({ confidence: 0.5 }),
    'low confidence should replace failed previous reference',
    pollutedPrevious,
    { url: '/bad.png', id: 'bad-id' },
  );
  assert.equal(update.nextAsset.reference.currentUrl, '/bad.png');
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/bad.png');
  assert.equal(update.nextAsset.panels?.frontUrl, '/api/images/file/front');
}

{
  const pollutedNonHuman = {
    name: '活螃蟹',
    entityType: 'non-human',
    imageUrl: '/api/images/file/human-sheet',
    rawUrl: '/api/images/file/human-sheet',
    reference: {
      currentUrl: '/api/images/file/human-sheet',
      lastKnownGoodUrl: '/api/images/file/human-sheet',
      status: 'degraded',
    },
    panels: {
      schema: 'human-character-sheet-v1',
      sheetUrl: '/api/images/file/human-sheet',
      confidence: 0.5,
    },
  };
  const update = deriveCharacterReferenceUpdate(pollutedNonHuman, { url: '/bad-crab.png', id: 'bad-crab-id' }, null, 'non-human', styleMeta, now);
  assert.equal(update.accepted, false);
  assert.equal(update.referenceStatus, 'failed');
  assert.equal(update.nextAsset.imageUrl, undefined, 'non-human must not preserve a human sheet');
  assert.equal(update.nextAsset.reference.currentUrl, undefined);
  assert.equal(update.nextAsset.panels, undefined);
}

{
  const noOldGood = { reference: {} };
  const update = deriveCharacterReferenceUpdate(noOldGood, { url: '/bad.png', id: 'bad-id' }, null, 'human', styleMeta, now);
  assert.equal(update.accepted, false);
  assert.equal(update.referenceStatus, 'failed');
  assert.equal(update.nextAsset.reference.status, 'failed');
  assert.equal(update.nextAsset.reference.currentUrl, undefined);
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, undefined);
  assert.equal(update.nextAsset.reference.lastAttemptUrl, '/bad.png');
  assert.equal(update.nextAsset.panelsError, 'missing panel split result');
  assert.equal(update.referenceLock?.referenceStatus, 'failed');
}

{
  const pollutedPrevious = {
    imageUrl: '/old.png',
    rawUrl: '/old.png',
    reference: {
      currentUrl: '/old.png',
      lastKnownGoodUrl: '/old.png',
      status: 'failed',
      lastAttemptUrl: '/bad.png',
      lastFailedAt: '2025-12-31T00:00:00.000Z',
      lastError: { reason: 'character_panel_split_failed', unusablePanels: ['front'] },
    },
  };
  const update = deriveCharacterReferenceUpdate(pollutedPrevious, { url: '/new.png', id: 'new-id' }, okPanel(), 'human', styleMeta, now);
  assert.equal(update.accepted, true);
  assert.equal(update.referenceStatus, 'ready');
  assert.equal(update.nextAsset.reference.status, 'ready');
  assert.equal(update.nextAsset.reference.currentUrl, '/new.png');
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/new.png');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, undefined);
  assert.equal(update.nextAsset.reference.lastFailedAt, undefined);
  assert.equal(update.nextAsset.reference.lastError, undefined);
}

{
  const project = {
    assets: { characters: [{ characterId: 'char-1', name: '角色A' }], scenes: [], props: [] },
    consistency: {
      schema: 'origin-consistency-v1',
      updatedAt: now,
      meta: { needsRoleSync: false, roleSyncReasons: [], resolverCaseVersion: 1 },
      characters: [{
        characterId: 'char-1',
        canonicalName: '角色A',
        aliases: ['角色A'],
        versions: {
          identityVersion: 1,
          visualVersion: 1,
          performanceVersion: 1,
          voiceVersion: 1,
          resolverVersion: 1,
          referenceVersion: 1,
        },
        status: 'locked',
        identityLock: { role: '角色A', identity: '角色A', entityType: 'human' },
        visualLock: {
          appearance: '',
          clothing: '',
          equipment: '',
          negativeRules: [],
          signatureColors: [],
          canonicalPrompt: '',
          visualSignatureHash: '',
        },
        performanceLock: {
          temperament: '',
          actionTraits: '',
          gestureRules: [],
          performanceSignatureHash: '',
        },
        voiceLock: {
          confidence: 0.5,
          negativeRules: [],
          voiceSignatureHash: '',
        },
        referenceLock: {
          sheetUrl: '/old-sheet.png',
          frontUrl: '/old-front.png',
          referenceStatus: 'ready',
          qualityScore: 0.92,
        },
      }],
    },
  };
  const result = mutateCharacterLock(project, 'char-1', { referenceLock: undefined }, { source: 'asset_image', now });
  const lock = result.project.consistency.characters[0].referenceLock;
  assert.equal(lock.referenceStatus, 'ready');
  assert.equal(lock.sheetUrl, '/old-sheet.png');
  assert.equal(lock.frontUrl, '/old-front.png');
  assert.equal(lock.qualityScore, 0.92);
}

{
  const failedCharacter = {
    name: '角色A',
    imageUrl: '/api/images/file/bad-sheet',
    rawUrl: '/api/images/file/bad-sheet',
    reference: {
      status: 'failed',
      currentUrl: '/api/images/file/bad-sheet',
      lastAttemptUrl: '/api/images/file/bad-attempt',
    },
    panels: {
      sheetUrl: '/api/images/file/bad-sheet',
      frontUrl: '/api/images/file/bad-front',
    },
  };
  const project = {
    assets: { characters: [failedCharacter], scenes: [], props: [] },
    shots: [{ visual: '角色A enters', description: '角色A enters', characters: ['角色A'] }],
  };
  const selectedPanels = selectCharacterReferencePanels({
    project,
    ownerId: 1,
    groupShotIndices: [0],
    maxSlots: 3,
  });
  assert.equal(selectedPanels.length, 0, 'failed character references should not be selected as panels');

  const plan = buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0],
    ownerId: 1,
    frameType: 'first_frame',
    modelSnapshot: { provider: 'test', model: 'test', multiRefImageCap: 4 },
    resolveLocalPath: () => '/tmp/should-not-be-used.png',
  });
  const charRefs = plan.referenceManifest.filter((ref) => ref.role === 'character');
  assert.equal(charRefs.length, 1, 'failed character may remain as text fallback context');
  assert.equal(charRefs[0].delivery, 'text_only', 'failed character image must not be delivered as image reference');
  assert.equal(charRefs[0].droppedReason, 'no_image_available');
}

{
  const ownerId = 1;
  const frontUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000ca01');
  const readyCharacter = {
    name: '角色A',
    imageUrl: frontUrl,
    rawUrl: frontUrl,
    reference: {
      status: 'ready',
      currentUrl: frontUrl,
      lastKnownGoodUrl: frontUrl,
    },
    panels: {
      schema: 'human-character-sheet-v1',
      sheetUrl: frontUrl,
      frontUrl,
    },
  };
  const project = {
    assets: { characters: [readyCharacter], scenes: [], props: [] },
    shots: [{ visual: '角色A full body enters', description: '角色A enters', characters: ['角色A'] }],
  };
  const selectedPanels = selectCharacterReferencePanels({
    project,
    ownerId,
    groupShotIndices: [0],
    maxSlots: 3,
  });
  assert.ok(selectedPanels.length > 0, 'ready character references should be selected as panels');

  const plan = buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0],
    ownerId,
    frameType: 'first_frame',
    modelSnapshot: { provider: 'test', model: 'test', multiRefImageCap: 4 },
    resolveLocalPath: () => '/tmp/ready-character.png',
  });
  const charRefs = plan.referenceManifest.filter((ref) => ref.role === 'character');
  assert.equal(charRefs.length, 1, 'ready character should appear in reference manifest');
  assert.equal(charRefs[0].delivery, 'image', 'ready character image should be delivered as image reference');
}

console.log('[test-character-reference-update] all assertions passed');
