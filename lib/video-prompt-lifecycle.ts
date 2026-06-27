import { createHash, randomUUID } from 'node:crypto';
import { styleBibleForVideoPrompt } from './casting-profile';
import { sanitizePromptObject } from './content-sanitize';
import { imageContentHashForUrl, maybeAssertStoryboardsAlignedWithShots, storyboardShotIndices } from './frame-workflow-state';
import { buildVideoReferenceManifest } from './reference-matcher';
import { patchProjectForUser } from './projects-db';
import { hashValue } from './project-dependency-state';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from './video-prompt-state';
import { resolveStoryboardFirstFrameUrl } from './visual-reference-state';
import type { DroppedReference, ReferenceManifestItem } from './video-reference-manifest';
import { normalizePlanMetaForHash, resolveShotFieldsForPrompt } from './shot-plan-normalize';
import { type ExpectedShotBinding, writeGroupSlot } from './group-slot-write-guard';

export const VIDEO_PROMPT_SOURCE_HASH_VERSION = 'video_prompt_source_hash_v1';
export const VIDEO_PROMPT_DRAFT_SCHEMA_VERSION = 'video_prompt_edit_draft_v1';
export const VIDEO_PROMPT_SNAPSHOT_SCHEMA_VERSION = 'video_prompt_snapshot_v1';

export type VideoPromptEditDraft = {
  content: string;
  sourceHash: string | null;
  savedDraftFingerprint: string;
  updatedAt: string;
};

export type VideoPromptBackup = {
  content: string;
  sourceHash: string | null;
  createdAt: string;
  videoPromptRunId?: string;
  legacyBackfilled?: boolean;
};

export type VideoPromptSnapshot = {
  version: typeof VIDEO_PROMPT_SNAPSHOT_SCHEMA_VERSION;
  content: string;
  sourceHash: string | null;
  fingerprint: string;
  finalPromptHash?: string;
  projectId: string;
  groupIdx: number;
  videoTaskId: string;
  legacy?: boolean;
  createdAt: string;
};

export type ApplyVideoPromptWriteKind =
  | 'system_generated'
  | 'commit_draft'
  | 'restore_backup'
  | 'apply_history';

export type ApplyVideoPromptWriteArgs = {
  projectId: string;
  userId: number;
  groupIdx: number;
  prompt: string;
  sourceHash?: string | null;
  runId?: string;
  ownership?: 'same-run' | 'takeover';
  writeKind: ApplyVideoPromptWriteKind;
  referenceManifest?: ReferenceManifestItem[];
  droppedReferences?: DroppedReference[];
  narrationsUsed?: any[];
  consistency?: any;
  shotIndices?: number[];
  expectedBinding?: ExpectedShotBinding | null;
  updatedAt?: string;
};

export type ApplyVideoPromptWriteResult = {
  applied: boolean;
  project: any | null;
  runId: string;
  sourceHash: string | null;
  shotIndices?: number[];
  skippedReason?: 'project_missing' | 'slot_missing' | 'run_taken_by_other' | 'empty_prompt' | 'write_not_applied' | 'shot_binding_mismatch';
  storedRunId?: string | null;
  storedStatus?: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

export function normalizeVideoPromptContent(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim();
}

function cleanUrlForHash(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    }
  } catch {}
  return raw.split('?')[0].split('#')[0];
}

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickDefined(source: any, fields: string[]) {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source?.[field];
    if (value !== undefined && value !== null && value !== '') out[field] = value;
  }
  return out;
}

function normalizeAssetForHash(asset: any, role: 'character' | 'scene' | 'prop' | 'environment') {
  const common = pickDefined(asset, [
    'id',
    'assetId',
    'characterId',
    'sceneId',
    'propId',
    'name',
    'role',
    'title',
    'identity',
    'appearance',
    'description',
    'desc',
    'visual',
    'promptHint',
    'material',
    'species',
    'location',
    'sceneName',
    'propName',
    'storyboardMaterialRole',
    'storyboardMaterialGroupIdx',
  ]);
  const reference = asset?.reference || {};
  const urls = [
    asset?.imageUrl,
    asset?.rawUrl,
    asset?.realPhotoUrl,
    asset?.coverUrl,
    asset?.pencilUrl,
    reference?.currentUrl,
    reference?.lastKnownGoodUrl,
  ].map(cleanUrlForHash).filter(Boolean);
  const panels = asset?.panels && typeof asset.panels === 'object'
    ? Object.fromEntries(
        Object.keys(asset.panels)
          .sort()
          .map((key) => [key, cleanUrlForHash(asset.panels[key])])
          .filter(([, value]) => value),
      )
    : undefined;
  return {
    role,
    ...common,
    ...(urls.length ? { urls: [...new Set(urls)] } : {}),
    ...(reference?.status ? { referenceStatus: reference.status } : {}),
    ...(panels && Object.keys(panels).length ? { panels } : {}),
  };
}

function stableAssetKey(asset: any) {
  return compactText(asset?.id || asset?.assetId || asset?.characterId || asset?.sceneId || asset?.propId || asset?.name || asset?.role || asset?.title || '');
}

function normalizeAssetList(value: unknown, role: 'character' | 'scene' | 'prop' | 'environment') {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeAssetForHash(item, role))
    .sort((a, b) => stableAssetKey(a).localeCompare(stableAssetKey(b)) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normalizeShotForHash(shot: any) {
  const fields = resolveShotFieldsForPrompt(shot);
  return {
    ...pickDefined(shot, [
    'idx',
    'visual',
    'description',
    'desc',
    'dialogue',
    'scriptRef',
    'duration',
    'durationSec',
    'characters',
    'speaker',
    'keyInfo',
    'location',
    'scene',
    'sceneId',
    'sceneName',
    'imagePrompt',
    ]),
    shotType: fields.shotType,
    framing: fields.framing,
    angle: fields.angle,
    lens: fields.lens,
    focus: fields.focus,
    light: fields.light,
    composition: fields.composition,
    camera: fields.camera,
    movement: fields.movement,
  };
}

function normalizeReferenceManifestForHash(refs: ReferenceManifestItem[] | undefined) {
  if (!Array.isArray(refs)) return [];
  return refs
    .slice()
    .sort((a, b) => Number(a.imageNo || 0) - Number(b.imageNo || 0))
    .map((ref) => ({
      imageNo: ref.imageNo,
      role: ref.role,
      assetId: ref.assetId,
      assetName: ref.assetName,
      label: ref.label,
      url: cleanUrlForHash(ref.url),
      useFor: ref.useFor,
      immutable: ref.immutable,
      promptHint: ref.promptHint,
      priority: ref.priority,
      matchReason: ref.matchReason,
      score: ref.score,
      panelInfo: ref.panelInfo,
    }));
}

function normalizeDroppedReferencesForHash(refs: DroppedReference[] | undefined) {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => ({
      role: ref.role,
      assetName: ref.assetName,
      reason: ref.reason,
    }))
    .sort((a, b) => `${a.role}:${a.assetName || ''}:${a.reason}`.localeCompare(`${b.role}:${b.assetName || ''}:${b.reason}`));
}

function safeShotIndices(project: any, groupIdx: number, explicitShotIndices?: number[]) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const sb = storyboards[groupIdx] || {};
  try {
    return storyboardShotIndices(project, groupIdx, sb, {
      mode: 'single-shot-strict',
      explicitShotIndices,
    });
  } catch {
    try {
      return storyboardShotIndices(project, groupIdx, sb, { explicitShotIndices });
    } catch {
      const shots = Array.isArray(project?.shots) ? project.shots : [];
      return Number.isInteger(groupIdx) && groupIdx >= 0 && groupIdx < shots.length ? [groupIdx] : [];
    }
  }
}

function safeImageContentHash(url: string, userId: number): string | null {
  if (!url) return null;
  try {
    return imageContentHashForUrl(url, userId);
  } catch {
    return null;
  }
}

export function computeVideoPromptSourceSnapshot(args: {
  project: any;
  groupIdx: number;
  ownerId: number;
  shotIndices?: number[];
}) {
  const project = args.project || {};
  const groupIdx = args.groupIdx;
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = safeShotIndices(project, groupIdx, args.shotIndices);
  const shots = shotIndices.map((idx) => project?.shots?.[idx]).filter(Boolean).map(normalizeShotForHash);
  const firstFrameUrl = cleanUrlForHash(resolveStoryboardFirstFrameUrl(sb));
  const tailFrameUrl = cleanUrlForHash(sb?.frames?.tail?.url || sb?.tailFrameUrl);
  const assets = project.assets || {};
  const referenceBuild = buildVideoReferenceManifest({
    project,
    assets,
    shots: Array.isArray(project.shots) ? project.shots : [],
    groupShotIndices: shotIndices,
    groupIdx,
    ownerId: args.ownerId,
    storyboardImageUrl: firstFrameUrl || null,
  });

  return sanitizePromptObject({
    version: VIDEO_PROMPT_SOURCE_HASH_VERSION,
    groupIdx,
    shotIndices,
    planMeta: normalizePlanMetaForHash(project.planMeta),
    shots,
    styleBible: styleBibleForVideoPrompt(project.styleBible || {}),
    narrations: Array.isArray(project.narrations) ? project.narrations : [],
    assets: {
      characters: normalizeAssetList(assets.characters, 'character'),
      scenes: normalizeAssetList(assets.scenes, 'scene'),
      environments: normalizeAssetList(assets.environments, 'environment'),
      props: normalizeAssetList(assets.props, 'prop'),
    },
    projectCharacters: normalizeAssetList(project.characters, 'character'),
    projectEnvironments: normalizeAssetList(project.environments, 'environment'),
    firstFrame: {
      url: firstFrameUrl,
      sourceHash: sb?.frames?.first?.sourceHash || sb?.firstFrameSourceHash || null,
      prompt: sb?.frames?.first?.prompt || sb?.firstFramePrompt || '',
      imageContentHash: sb?.frames?.first?.imageContentHash || safeImageContentHash(firstFrameUrl, args.ownerId),
    },
    storyboardSketch: {
      debugSketchUrl: cleanUrlForHash(sb?.debugSketchUrl),
      pencilUrl: cleanUrlForHash(sb?.pencilUrl),
    },
    tailFrame: {
      url: tailFrameUrl,
      caption: sb?.frames?.tail?.caption || null,
      intent: sb?.tailFrameIntent || null,
      referenceStatus: sb?.tailFrameReferenceStatus || sb?.frames?.tail?.referenceStatus || null,
    },
    referenceManifest: normalizeReferenceManifestForHash(referenceBuild.manifest),
    droppedReferences: normalizeDroppedReferencesForHash(referenceBuild.droppedReferences),
  });
}

export function computeVideoPromptSourceHash(args: {
  project: any;
  groupIdx: number;
  ownerId: number;
  shotIndices?: number[];
}): string | null {
  const snapshot = computeVideoPromptSourceSnapshot(args);
  const shotIndices = Array.isArray((snapshot as any).shotIndices) ? (snapshot as any).shotIndices : [];
  return shotIndices.length ? hashValue(snapshot) : null;
}

export function videoPromptDraftFingerprint(
  sourceHash: string | null | undefined,
  draftOrContent: Partial<VideoPromptEditDraft> | string | null | undefined,
): string {
  const content = typeof draftOrContent === 'string'
    ? draftOrContent
    : (draftOrContent?.content || '');
  return hashValue({
    version: VIDEO_PROMPT_DRAFT_SCHEMA_VERSION,
    sourceHash: sourceHash || null,
    content: normalizeVideoPromptContent(content),
  });
}

export function currentDisplayVideoPrompt(sb: any): string {
  if (sb?.videoPromptEditDraft && typeof sb.videoPromptEditDraft.content === 'string') {
    return normalizeVideoPromptContent(sb.videoPromptEditDraft.content);
  }
  return normalizeVideoPromptContent(sb?.videoPrompt || '');
}

export function normalizeVideoPromptEditDraftInput(input: any, sourceHash: string | null): VideoPromptEditDraft | null {
  const content = normalizeVideoPromptContent(input?.content ?? input?.videoPrompt ?? input?.prompt ?? input);
  const updatedAt = typeof input?.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso();
  return {
    content,
    sourceHash,
    savedDraftFingerprint: videoPromptDraftFingerprint(sourceHash, content),
    updatedAt,
  };
}

export function buildLegacyVideoPromptBackup(sb: any, fallbackCreatedAt?: string): VideoPromptBackup | null {
  const content = normalizeVideoPromptContent(sb?.videoPrompt);
  if (!content) return null;
  return {
    content,
    sourceHash: typeof sb?.videoPromptSourceHash === 'string' ? sb.videoPromptSourceHash : null,
    createdAt: sb?.videoPromptUpdatedAt || fallbackCreatedAt || nowIso(),
    ...(sb?.videoPromptRunId ? { videoPromptRunId: String(sb.videoPromptRunId) } : {}),
    legacyBackfilled: true,
  };
}

export function buildVideoPromptBackupBackfillPatch(project: any) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  let changed = false;
  const nextStoryboards = storyboards.map((sb: any) => {
    if (!sb || sb.videoPromptBackup || !normalizeVideoPromptContent(sb.videoPrompt)) return sb;
    const backup = buildLegacyVideoPromptBackup(sb, project?.updatedAt);
    if (!backup) return sb;
    changed = true;
    return {
      ...sb,
      videoPromptBackup: backup,
    };
  });
  return changed ? { storyboards: nextStoryboards } : null;
}

export function buildVideoPromptSnapshot(args: {
  content: string;
  sourceHash: string | null | undefined;
  projectId: string;
  groupIdx: number;
  videoTaskId: string;
  finalPromptHash?: string;
  legacy?: boolean;
  createdAt?: string;
}): VideoPromptSnapshot {
  const content = normalizeVideoPromptContent(args.content);
  const sourceHash = args.sourceHash || null;
  return {
    version: VIDEO_PROMPT_SNAPSHOT_SCHEMA_VERSION,
    content,
    sourceHash,
    fingerprint: videoPromptDraftFingerprint(sourceHash, content),
    ...(args.finalPromptHash ? { finalPromptHash: args.finalPromptHash } : {}),
    projectId: args.projectId,
    groupIdx: args.groupIdx,
    videoTaskId: args.videoTaskId,
    ...(args.legacy ? { legacy: true } : {}),
    createdAt: args.createdAt || nowIso(),
  };
}

function videoPromptRunId(prefix: string, runId?: string) {
  return runId || `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function shouldUpdateBackup(prev: any, sourceHash: string | null) {
  const backup = prev?.videoPromptBackup;
  if (!backup || !normalizeVideoPromptContent(backup.content)) return true;
  return (backup.sourceHash || null) !== (sourceHash || null);
}

export function applyVideoPromptWrite(args: ApplyVideoPromptWriteArgs): ApplyVideoPromptWriteResult {
  const prompt = normalizeVideoPromptContent(args.prompt);
  const runId = videoPromptRunId(
    args.writeKind === 'system_generated'
      ? 'vp_gen'
      : args.writeKind === 'commit_draft'
        ? 'vp_commit'
        : args.writeKind === 'restore_backup'
          ? 'vp_restore'
          : 'vp_history',
    args.runId,
  );
  if (!prompt) {
    return {
      applied: false,
      project: null,
      runId,
      sourceHash: args.sourceHash || null,
      skippedReason: 'empty_prompt',
    };
  }

  let sourceHash: string | null = args.sourceHash ?? null;
  let skippedReason: ApplyVideoPromptWriteResult['skippedReason'];
  let storedRunId: string | null = null;
  let storedStatus: string | null = null;
  const now = args.updatedAt || nowIso();
  const ownership = args.ownership || 'takeover';

  const project = patchProjectForUser(args.projectId, args.userId, (fresh) => {
    if (!fresh) {
      skippedReason = 'project_missing';
      return null;
    }
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const prev = storyboards[args.groupIdx];
    if (!prev) {
      skippedReason = 'slot_missing';
      return null;
    }
    if (ownership === 'same-run' && prev.videoPromptRunId && prev.videoPromptRunId !== runId) {
      skippedReason = 'run_taken_by_other';
      storedRunId = prev.videoPromptRunId || null;
      storedStatus = prev.videoPromptStatus || null;
      return null;
    }

    sourceHash = args.sourceHash === undefined
      ? computeVideoPromptSourceHash({ project: fresh, groupIdx: args.groupIdx, ownerId: args.userId })
      : (args.sourceHash || null);

    const bindingWrite = args.expectedBinding
      ? writeGroupSlot({
        fresh,
        groupIdx: args.groupIdx,
        storyboard: prev,
        explicitShotIndices: args.shotIndices,
        expectedBinding: args.expectedBinding,
        mismatchPolicy: 'abortPatch',
        mutator: () => undefined,
      })
      : null;
    if (bindingWrite && bindingWrite.status !== 'applied') {
      skippedReason = bindingWrite.reason === 'shot_binding_mismatch' ? 'shot_binding_mismatch' : 'slot_missing';
      return null;
    }
    const freshShotIndices = bindingWrite?.status === 'applied'
      ? bindingWrite.shotIndices
      : safeShotIndices(fresh, args.groupIdx, args.shotIndices);
    const firstShot = bindingWrite?.status === 'applied'
      ? bindingWrite.firstShot
      : (Array.isArray((fresh as any).shots) ? (fresh as any).shots[freshShotIndices[0]] : null);
    const next = {
      ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', now),
      idx: args.groupIdx,
      shotIdx: firstShot?.idx ?? freshShotIndices[0] + 1,
      shotIndices: freshShotIndices,
      videoPrompt: prompt,
      videoPromptSourceHash: sourceHash,
      videoPromptStatus: 'ready',
      videoPromptRunId: runId,
      videoPromptUpdatedAt: now,
      videoPromptLastError: undefined,
      videoPromptFailedAt: undefined,
      _vpCache: null,
      ...(Array.isArray(args.narrationsUsed) ? { narrationsUsed: args.narrationsUsed } : {}),
      ...(Array.isArray(args.referenceManifest) ? { videoReferenceManifest: args.referenceManifest } : {}),
      ...(Array.isArray(args.droppedReferences) ? { videoReferenceDropped: args.droppedReferences } : {}),
      ...(args.consistency ? {
        consistency: {
          ...(prev.consistency || {}),
          videoPrompt: args.consistency,
        },
      } : {}),
    };
    delete (next as any).videoPromptEditDraft;
    if (args.writeKind === 'system_generated' && shouldUpdateBackup(prev, sourceHash)) {
      (next as any).videoPromptBackup = {
        content: prompt,
        sourceHash,
        createdAt: now,
        videoPromptRunId: runId,
      };
    }

    storyboards[args.groupIdx] = next;

    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    if (videoTasks.length > args.groupIdx && videoTasks[args.groupIdx]) {
      videoTasks[args.groupIdx] = markVideoTaskOutdated(videoTasks[args.groupIdx], 'video_prompt_regeneration', now);
    }

    const patch: any = { storyboards, videoTasks };
    if ((fresh as any)._staleFlags && typeof (fresh as any)._staleFlags === 'object') {
      const staleFlags = { ...(fresh as any)._staleFlags };
      delete staleFlags[`video_prompt_${args.groupIdx}`];
      patch._staleFlags = staleFlags;
    }
    maybeAssertStoryboardsAlignedWithShots({ ...fresh, ...patch }, 'applyVideoPromptWrite');
    return patch;
  });

  const sb = Array.isArray(project?.storyboards) ? project.storyboards[args.groupIdx] : null;
  const applied = !!(
    sb &&
    sb.videoPromptRunId === runId &&
    sb.videoPromptStatus === 'ready' &&
    normalizeVideoPromptContent(sb.videoPrompt) === prompt
  );

  return {
    applied,
    project,
    runId,
    sourceHash,
    shotIndices: sb?.shotIndices,
    skippedReason: applied ? undefined : (skippedReason || 'write_not_applied'),
    storedRunId: sb?.videoPromptRunId || storedRunId,
    storedStatus: sb?.videoPromptStatus || storedStatus,
  };
}
