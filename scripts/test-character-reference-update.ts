import assert from 'node:assert/strict';
import { deriveCharacterReferenceUpdate } from '../lib/character-reference-update';
import type { SplitCharacterPanelsResult } from '../lib/character-panels';
import { buildFrameImageGenerationPlan } from '../lib/frame-image-plan';
import { selectCharacterReferencePanels } from '../lib/panel-selection';

const now = '2026-01-01T00:00:00.000Z';
const styleMeta = {
  styleBibleSignature: 'sig-v3',
  styleLockVersion: 3,
  resolvedBackdropColor: '#FFFFFF',
};

function quality(usable = true) {
  return {
    usable,
    nonWhiteRatio: 0.2,
    bboxCoverage: 0.5,
    bboxCenterX: 0.5,
    bboxCenterY: 0.5,
  };
}

function okPanel(overrides: any = {}): SplitCharacterPanelsResult {
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
  assert.equal(update.nextAsset.imageUrl, '/new.png');
  assert.equal(update.nextAsset.rawUrl, '/new.png');
  assert.equal(update.nextAsset.reference.status, 'ready');
  assert.equal(update.nextAsset.reference.currentUrl, '/new.png');
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/new.png');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, undefined);
  assert.equal(update.referenceLock.referenceStatus, 'ready');
  assert.equal(update.referenceLock.qualityScore, 0.92);
  assert.equal(update.referenceLock.frontUrl, '/api/images/file/front');
}

function assertFailure(panelResult: SplitCharacterPanelsResult | null | undefined, message: string) {
  const update = deriveCharacterReferenceUpdate(previous, { url: '/bad.png', id: 'bad-id' }, panelResult, 'human', styleMeta, now);
  assert.equal(update.accepted, false, message);
  assert.equal(update.nextAsset.imageUrl, '/old.png', `${message}: imageUrl should not be overwritten`);
  assert.equal(update.nextAsset.rawUrl, '/old.png', `${message}: rawUrl should not be overwritten`);
  assert.equal(update.nextAsset.reference.currentUrl, '/old.png', `${message}: currentUrl should not be overwritten`);
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/old.png', `${message}: lastKnownGoodUrl should not be overwritten`);
  assert.equal(update.nextAsset.reference.status, 'failed');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, '/bad.png');
  assert.equal(update.referenceLock.referenceStatus, 'failed');
  assert.equal(update.referenceLock.frontUrl, undefined, `${message}: referenceLock panel urls should not be overwritten`);
  assert.equal(update.nextAsset.panels.frontUrl, '/old-front.png', `${message}: old panel data should remain on asset`);
  assert.equal(update.nextAsset.reference.lastError.reason, 'character_panel_split_failed');
}

assertFailure({ ok: false, error: 'not enough usable panels' }, 'ok=false');
assertFailure(okPanel({ cropMethod: 'percent-fallback' }), 'percent fallback');
assertFailure(okPanel({ confidence: 0.5 }), 'low confidence');
assertFailure(okPanel({
  quality: {
    headshot: quality(true),
    front: quality(true),
    side: quality(false),
    back: quality(true),
  },
}), 'unusable required panel');
assertFailure(null, 'missing panel result');

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

console.log('[test-character-reference-update] all assertions passed');
