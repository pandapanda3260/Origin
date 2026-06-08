import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveCharacterReferenceUpdate, deriveCrowdReferenceUpdate } from '../lib/character-reference-update';
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
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, display_name, password_hash, email_verified)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(
    ownerId,
    `reference-test-owner-${ownerId}`,
    `Reference Test Owner ${ownerId}`,
    'test-hash',
  );
  db.prepare(
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
  const update = deriveCrowdReferenceUpdate(
    {
      name: '考核少年少女群像',
      isCrowd: true,
      imageUrl: '/old.png',
      rawUrl: '/old.png',
      reference: {
        currentUrl: '/old.png',
        lastKnownGoodUrl: '/old.png',
        status: 'ready',
      },
      panels: {
        schema: 'human-character-sheet-v1',
        sheetUrl: '/old-sheet.png',
        headshotUrl: '/old-head.png',
        frontUrl: '/old-front.png',
        sideUrl: '/old-side.png',
        backUrl: '/old-back.png',
        version: 3,
      },
    },
    { url: '/new-crowd.png', id: 'new-crowd-id' },
    styleMeta,
    now,
  );
  assert.equal(update.accepted, true);
  assert.equal(update.referenceStatus, 'ready');
  assert.equal(update.nextAsset.imageUrl, '/new-crowd.png');
  assert.equal(update.nextAsset.rawUrl, '/new-crowd.png');
  assert.equal(update.nextAsset.realPhotoUrl, '/new-crowd.png');
  assert.equal(update.nextAsset.pencilUrl, '/new-crowd.png');
  assert.equal(update.nextAsset.skippedStylize, true);
  assert.equal(update.nextAsset.reference.status, 'ready');
  assert.equal(update.nextAsset.reference.currentUrl, '/new-crowd.png');
  assert.equal(update.nextAsset.panels.schema, 'anonymous-crowd-reference-v1');
  assert.equal(update.nextAsset.panels.sheetUrl, '/new-crowd.png');
  assert.equal(update.nextAsset.panels.headshotUrl, undefined);
  assert.equal(update.nextAsset.panels.frontUrl, undefined);
  assert.equal(update.referenceLock?.sheetUrl, '/new-crowd.png');
  assert.equal(update.referenceLock?.frontUrl, undefined);
  assert.equal(update.referenceLock?.referenceStatus, 'ready');
}

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
  const crab = {
    characterId: 'crab-1',
    name: '活螃蟹',
    entityType: 'non-human',
    reference: {},
    panels: {
      sheetUrl: '/api/images/file/stale-crab-sheet',
      frontUrl: '/api/images/file/stale-crab-front',
    },
  };
  const update = deriveCharacterReferenceUpdate(
    crab,
    { url: '/api/images/file/new-crab-sheet', id: 'new-crab-id' },
    { ok: false, error: 'split finished but panel quality was unusable' },
    'non-human',
    styleMeta,
    now,
  );
  assert.equal(update.accepted, true, 'non-human generated sheet remains usable when strict panel split fails');
  assert.equal(update.referenceStatus, 'degraded');
  assert.equal(update.nextAsset.pencilUrl, '/api/images/file/new-crab-sheet');
  assert.equal(update.nextAsset.reference.status, 'degraded');
  assert.equal(update.nextAsset.reference.currentUrl, '/api/images/file/new-crab-sheet');
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/api/images/file/new-crab-sheet');
  assert.equal(update.nextAsset.reference.lastAttemptUrl, '/api/images/file/new-crab-sheet');
  assert.equal(update.nextAsset.reference.lastError.reason, 'character_panel_split_failed');
  assert.equal(update.nextAsset.reference.lastError.message, 'split finished but panel quality was unusable');
  assert.equal(update.nextAsset.panels, undefined, 'degraded sheet must not keep stale split panels');
  assert.equal(update.referenceLock?.referenceStatus, 'degraded');
  assert.equal(update.referenceLock?.sheetUrl, '/api/images/file/new-crab-sheet');
  assert.equal(update.referenceLock?.sourceImageId, 'new-crab-id');
  assert.equal(update.referenceLock?.qualityScore, undefined);
  assert.equal(update.lastError?.message, 'split finished but panel quality was unusable');
}

{
  const update = deriveCharacterReferenceUpdate(
    {
      characterId: 'crab-ready-1',
      name: '活螃蟹',
      entityType: 'non-human',
      reference: { status: 'degraded' },
    },
    { url: '/api/images/file/new-crab-ready-sheet', id: 'new-crab-ready-id' },
    okPanel({
      schema: 'non-human-character-sheet-v1',
      sourceImageId: 'nonhuman-source',
      sheetUrl: '/api/images/file/nonhuman-sheet',
      headshotUrl: undefined,
      frontUrl: '/api/images/file/nonhuman-front',
      sideUrl: '/api/images/file/nonhuman-side',
      backUrl: '/api/images/file/nonhuman-back',
      confidence: 0.88,
      quality: {
        front: quality(true),
        side: quality(true),
        back: quality(true),
      },
    }),
    'non-human',
    styleMeta,
    now,
  );
  assert.equal(update.accepted, true, 'non-human successful split should be ready');
  assert.equal(update.referenceStatus, 'ready');
  assert.equal(update.nextAsset.reference.status, 'ready');
  assert.equal(update.nextAsset.reference.currentUrl, '/api/images/file/new-crab-ready-sheet');
  assert.equal(update.nextAsset.panels.schema, 'non-human-character-sheet-v1');
  assert.equal(update.nextAsset.panels.frontUrl, '/api/images/file/nonhuman-front');
  assert.equal(update.referenceLock?.referenceStatus, 'ready');
  assert.equal(update.referenceLock?.sheetUrl, '/api/images/file/nonhuman-sheet');
  assert.equal(update.referenceLock?.frontUrl, '/api/images/file/nonhuman-front');
  assert.equal(update.referenceLock?.qualityScore, 0.88);
}

{
  const oldReadyCrab = {
    characterId: 'crab-old-ready',
    name: '活螃蟹',
    entityType: 'non-human',
    imageUrl: '/api/images/file/old-crab-sheet',
    rawUrl: '/api/images/file/old-crab-sheet',
    realPhotoUrl: '/api/images/file/old-crab-sheet',
    pencilUrl: '/api/images/file/old-crab-sheet',
    reference: {
      currentUrl: '/api/images/file/old-crab-sheet',
      lastKnownGoodUrl: '/api/images/file/old-crab-sheet',
      status: 'ready',
    },
    panels: {
      schema: 'non-human-character-sheet-v1',
      sheetUrl: '/api/images/file/old-crab-sheet',
      frontUrl: '/api/images/file/old-crab-front',
      sideUrl: '/api/images/file/old-crab-side',
      backUrl: '/api/images/file/old-crab-back',
      confidence: 0.92,
    },
  };
  const update = deriveCharacterReferenceUpdate(
    oldReadyCrab,
    { url: '/api/images/file/new-crab-sheet-2', id: 'new-crab-id-2' },
    { ok: false, error: 'not enough usable panels (0/3)' },
    'non-human',
    styleMeta,
    now,
  );
  assert.equal(update.accepted, true, 'non-human regeneration should honor the new sheet even when old ready panels exist');
  assert.equal(update.referenceStatus, 'degraded');
  assert.equal(update.nextAsset.imageUrl, '/api/images/file/new-crab-sheet-2');
  assert.equal(update.nextAsset.rawUrl, '/api/images/file/new-crab-sheet-2');
  assert.equal(update.nextAsset.realPhotoUrl, '/api/images/file/new-crab-sheet-2');
  assert.equal(update.nextAsset.pencilUrl, '/api/images/file/new-crab-sheet-2');
  assert.equal(update.nextAsset.reference.status, 'degraded');
  assert.equal(update.nextAsset.reference.currentUrl, '/api/images/file/new-crab-sheet-2');
  assert.equal(update.nextAsset.reference.lastKnownGoodUrl, '/api/images/file/new-crab-sheet-2');
  assert.equal(update.nextAsset.panels, undefined, 'new degraded non-human sheet should drop old panel URLs');
  assert.equal(update.referenceLock?.referenceStatus, 'degraded');
  assert.equal(update.referenceLock?.sheetUrl, '/api/images/file/new-crab-sheet-2');
  assert.equal(update.referenceLock?.frontUrl, undefined);
  assert.equal(update.referenceLock?.qualityScore, undefined);
}

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
        identityLock: { role: '角色A', identity: '角色A', entityType: 'non-human', species: '螃蟹' },
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
          sideUrl: '/old-side.png',
          backUrl: '/old-back.png',
          sourceImageId: 'old-source',
          referenceStatus: 'ready',
          qualityScore: 0.92,
        },
      }],
    },
  };
  const result = mutateCharacterLock(
    project,
    'char-1',
    {
      referenceLock: {
        sheetUrl: '/new-sheet.png',
        sourceImageId: 'new-source',
        referenceStatus: 'degraded',
      },
    },
    { source: 'asset_image', now },
  );
  const lock = result.project.consistency.characters[0].referenceLock;
  assert.equal(lock.referenceStatus, 'degraded');
  assert.equal(lock.sheetUrl, '/new-sheet.png');
  assert.equal(lock.frontUrl, undefined, 'sheet-only degraded lock must not retain stale front panel');
  assert.equal(lock.sideUrl, undefined, 'sheet-only degraded lock must not retain stale side panel');
  assert.equal(lock.backUrl, undefined, 'sheet-only degraded lock must not retain stale back panel');
  assert.equal(lock.sourceImageId, 'new-source');
  assert.equal(lock.qualityScore, undefined, 'sheet-only degraded lock should not keep stale qualityScore');
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
  const sheetUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000cb01');
  const degradedNonHuman = {
    name: '活螃蟹',
    entityType: 'non-human',
    imageUrl: sheetUrl,
    rawUrl: sheetUrl,
    realPhotoUrl: sheetUrl,
    pencilUrl: sheetUrl,
    reference: {
      status: 'degraded',
      currentUrl: sheetUrl,
      lastKnownGoodUrl: sheetUrl,
    },
  };
  const project = {
    assets: { characters: [degradedNonHuman], scenes: [], props: [] },
    shots: [{ visual: '活螃蟹 full body enters', description: '活螃蟹 enters', characters: ['活螃蟹'] }],
  };
  const selectedPanels = selectCharacterReferencePanels({
    project,
    ownerId,
    groupShotIndices: [0],
    maxSlots: 3,
  });
  assert.equal(selectedPanels.length, 1, 'degraded non-human sheet should be selected as sheet fallback');
  assert.equal(selectedPanels[0].panel, 'sheet');

  const plan = buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0],
    ownerId,
    frameType: 'first_frame',
    modelSnapshot: { provider: 'test', model: 'test', multiRefImageCap: 4 },
    resolveLocalPath: () => '/tmp/degraded-non-human.png',
  });
  const charRefs = plan.referenceManifest.filter((ref) => ref.role === 'character');
  assert.equal(charRefs.length, 1, 'degraded non-human should appear in reference manifest');
  assert.equal(charRefs[0].delivery, 'image', 'degraded non-human sheet should be delivered as image reference');
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
	  assert.equal(charRefs.length, 2, 'ready character sheet/front panels should appear in reference manifest');
	  assert.deepEqual(charRefs.map((ref) => ref.panel), ['sheet', 'front']);
	  assert.equal(charRefs.every((ref) => ref.delivery === 'image'), true, 'ready character panel images should be delivered as image references');
	}

{
  const ownerId = 1;
  const sheetUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fa01');
  const headshotUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fa02');
  const frontUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fa03');
  const sideUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fa04');
  const backUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fa05');
  const readyCharacter = {
    name: '角色B',
    imageUrl: sheetUrl,
    rawUrl: sheetUrl,
    reference: {
      status: 'ready',
      currentUrl: sheetUrl,
      lastKnownGoodUrl: sheetUrl,
    },
    panels: {
      schema: 'human-character-sheet-v1',
      sheetUrl,
      headshotUrl,
      frontUrl,
      sideUrl,
      backUrl,
    },
  };
  const project = {
    assets: { characters: [readyCharacter], scenes: [], props: [] },
    shots: [{ visual: '角色B 特写看向镜头', description: '角色B face close-up', characters: ['角色B'] }],
  };
  const defaultPanels = selectCharacterReferencePanels({
    project,
    ownerId,
    groupShotIndices: [0],
    maxSlots: 3,
    perCharacterLimit: 3,
  });
  assert.deepEqual(defaultPanels.map((panel) => panel.panel), ['headshot', 'front'], 'default/video mode keeps existing face allocation without sheet');

  const framePanels = selectCharacterReferencePanels({
    project,
    ownerId,
    groupShotIndices: [0],
    maxSlots: 3,
    perCharacterLimit: 3,
    mode: 'frame',
  });
  assert.deepEqual(framePanels.map((panel) => panel.panel), ['sheet', 'headshot', 'front'], 'frame mode promotes sheet before face/front crops');
}

{
  const ownerId = 1;
  const sheetUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fb01');
  const frontUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fb02');
  const sideUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fb03');
  const backUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fb04');
  const nonHuman = {
    name: '机械兽',
    entityType: 'non-human',
    imageUrl: sheetUrl,
    rawUrl: sheetUrl,
    reference: {
      status: 'ready',
      currentUrl: sheetUrl,
      lastKnownGoodUrl: sheetUrl,
    },
    panels: {
      schema: 'non-human-character-sheet-v1',
      sheetUrl,
      frontUrl,
      sideUrl,
      backUrl,
    },
  };
  const project = {
    assets: { characters: [nonHuman], scenes: [], props: [] },
    shots: [{ visual: '机械兽 全身穿过街道', description: '机械兽 full body', characters: ['机械兽'] }],
  };
  const framePanels = selectCharacterReferencePanels({
    project,
    ownerId,
    groupShotIndices: [0],
    maxSlots: 3,
    perCharacterLimit: 3,
    mode: 'frame',
  });
  assert.deepEqual(framePanels.map((panel) => panel.panel), ['sheet', 'front', 'side'], 'non-human frame mode uses sheet/front/side and never requires headshot');
}

{
  const ownerId = 1;
  const sheetUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fc01');
  const headshotUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fc02');
  const frontUrl = ensureResolvableTestImage(ownerId, '00000000-0000-0000-0000-00000000fc03');
  const crowd = {
    name: '考核少年少女群像',
    isCrowd: true,
    crowdSize: '十几人',
    imageUrl: sheetUrl,
    rawUrl: sheetUrl,
    reference: {
      status: 'ready',
      currentUrl: sheetUrl,
      lastKnownGoodUrl: sheetUrl,
    },
    panels: {
      schema: 'human-character-sheet-v1',
      sheetUrl,
      headshotUrl,
      frontUrl,
      sideUrl: frontUrl,
      backUrl: frontUrl,
    },
  };
  const project = {
    assets: { characters: [crowd], scenes: [], props: [] },
    shots: [{ visual: '考核少年少女群像 聚集在广场上', description: 'group shot', characters: ['考核少年少女群像'] }],
  };
  const panels = selectCharacterReferencePanels({
    project,
    ownerId,
    groupShotIndices: [0],
    maxSlots: 4,
    perCharacterLimit: 4,
    mode: 'frame',
    enableFocusCharacterPair: true,
  });
  assert.deepEqual(panels.map((panel) => panel.panel), ['sheet'], 'crowd selection must ignore leftover headshot/front/side/back panels');
  assert.equal(panels[0]?.path.includes('fc01'), true, 'crowd selection should use the sheet image');
  assert.equal(panels[0]?.focusPair, false, 'crowd should not consume focus-pair multi-panel slots');
}

console.log('[test-character-reference-update] all assertions passed');
