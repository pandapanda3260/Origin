import { createHash } from 'node:crypto';
import type { AutoSegmentPlanSnapshot } from './video-segment-capability';

export const SHOT_PLAN_STALE_FLAG = 'shotPlan';
export const SHOT_PLAN_ARCHIVE_CONTEXTS = ['pre_regen'] as const;
export const SHOT_PLAN_STATUSES = ['ready', 'stale', 'legacy_unknown', 'generating', 'failed'] as const;
export const SHOT_PLAN_STALE_REASONS = [
  'script_changed',
  'style_bible_changed',
  'assets_changed',
  'duration_changed',
  'emotion_changed',
  'world_changed',
  'upstream_changed_during_generation',
  'manual_shot_edit',
  'unknown',
] as const;

export const SHOT_PLAN_DEPENDENCY_KEYS = [
  'script',
  'styleBible',
  'assets',
  'characters',
  'scenes',
  'environments',
  'props',
  'emotionSegments',
  'emotions',
  'scriptTargetDurationSec',
  'targetDurationSec',
  'durationSec',
  'selectedWorldTemplateId',
  'worldTemplateSnapshot',
] as const;

export type ShotPlanStatus = typeof SHOT_PLAN_STATUSES[number];
export type ShotPlanStaleReason = typeof SHOT_PLAN_STALE_REASONS[number];
export type ShotPlanArchiveContext = typeof SHOT_PLAN_ARCHIVE_CONTEXTS[number];

export type ShotPlanSourceSnapshot = {
  scriptHash: string;
  styleBibleHash: string;
  assetsHash: string;
  durationHash: string;
  emotionHash: string;
  worldHash: string;
};

const SNAPSHOT_REASON_BY_KEY: Record<keyof ShotPlanSourceSnapshot, ShotPlanStaleReason> = {
  scriptHash: 'script_changed',
  styleBibleHash: 'style_bible_changed',
  assetsHash: 'assets_changed',
  durationHash: 'duration_changed',
  emotionHash: 'emotion_changed',
  worldHash: 'world_changed',
};

export class ShotPlanConfirmInvalidStateError extends Error {
  code = 'shot_plan_confirm_invalid_state';
  currentState: string;

  constructor(currentState: string) {
    super(`shot plan status ${currentState || '(empty)'} cannot be confirmed as still valid`);
    this.name = 'ShotPlanConfirmInvalidStateError';
    this.currentState = currentState;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        const normalized = normalizeValue(value[key]);
        if (normalized !== undefined) out[key] = normalized;
      });
    return out;
  }
  if (value == null) return null;
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function pickFields(source: any, fields: string[], defaults: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(defaults, field)) out[field] = defaults[field];
    if (source && source[field] != null) out[field] = source[field];
  }
  return out;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function sortByStableId(items: any[]) {
  return [...items].sort((a, b) => {
    const aKey = normalizeText(a?.id || a?.assetId || a?.name || a?.sceneName || a?.location || '');
    const bKey = normalizeText(b?.id || b?.assetId || b?.name || b?.sceneName || b?.location || '');
    return aKey.localeCompare(bKey) || stableJsonStringify(a).localeCompare(stableJsonStringify(b));
  });
}

const CHARACTER_SEMANTIC_FIELDS = [
  'name',
  'role',
  'identity',
  'appearance',
  'clothing',
  'equipment',
  'species',
  'gender',
  'ageBand',
  'entityType',
  'description',
] as const;

const SCENE_SEMANTIC_FIELDS = [
  'name',
  'location',
  'description',
  'lighting',
  'atmosphere',
  'elements',
  'structure',
  'time',
  'weather',
] as const;

const PROP_SEMANTIC_FIELDS = [
  'name',
  'propType',
  'features',
  'description',
  'material',
  'usage',
  'visual',
] as const;

const STYLE_BIBLE_FIELDS = [
  'vision',
  'visualStyle',
  'style',
  'tone',
  'mood',
  'colorPalette',
  'palette',
  'cameraStyle',
  'shotLanguage',
  'lighting',
  'texture',
  'composition',
  'worldview',
  'worldContext',
  'era',
  'timePeriod',
  'reference',
  'referenceStyle',
  'negativeRules',
  'hardConstraints',
  'consistencyRules',
] as const;

function normalizeAssetsForShotPlan(project: any) {
  const assets = project?.assets || {};
  const characters = asArray(assets.characters || project?.characters).map((item) => ({
    id: item?.id || item?.assetId || item?.name || '',
    ...pickFields(item, [...CHARACTER_SEMANTIC_FIELDS], { entityType: 'human' }),
  }));
  const scenes = asArray(assets.scenes || assets.environments || project?.scenes || project?.environments).map((item) => ({
    id: item?.id || item?.assetId || item?.name || item?.sceneName || item?.location || '',
    ...pickFields(item, [...SCENE_SEMANTIC_FIELDS]),
  }));
  const props = asArray(assets.props || project?.props).map((item) => ({
    id: item?.id || item?.assetId || item?.name || '',
    ...pickFields(item, [...PROP_SEMANTIC_FIELDS]),
  }));
  return {
    characters: sortByStableId(characters),
    scenes: sortByStableId(scenes),
    props: sortByStableId(props),
  };
}

function normalizeStyleBibleForShotPlan(project: any) {
  return pickFields(project?.styleBible || {}, [...STYLE_BIBLE_FIELDS]);
}

function normalizeEmotionsForShotPlan(project: any) {
  const emotions = asArray(project?.emotionSegments || project?.emotions).map((item) => ({
    start: Number.isFinite(Number(item?.start)) ? Number(item.start) : null,
    end: Number.isFinite(Number(item?.end)) ? Number(item.end) : null,
    label: item?.label || item?.emotion || '',
    text: item?.text || item?.description || '',
    intensity: Number.isFinite(Number(item?.intensity)) ? Number(item.intensity) : null,
  }));
  return emotions.sort((a, b) => {
    const startDiff = Number(a.start ?? -1) - Number(b.start ?? -1);
    if (startDiff) return startDiff;
    return Number(a.end ?? -1) - Number(b.end ?? -1);
  });
}

export function computeScriptHash(project: any): string {
  return hashValue({ script: normalizeText(project?.script) });
}

export function computeStyleBibleHash(project: any): string {
  return hashValue(normalizeStyleBibleForShotPlan(project));
}

export function computeAssetsSemanticHash(project: any): string {
  return hashValue(normalizeAssetsForShotPlan(project));
}

export function computeDurationHash(project: any): string {
  const duration = Number(project?.scriptTargetDurationSec ?? project?.targetDurationSec ?? project?.durationSec);
  return hashValue({ durationSec: Number.isFinite(duration) ? Math.round(duration) : null });
}

export function computeEmotionHash(project: any): string {
  return hashValue(normalizeEmotionsForShotPlan(project));
}

export function computeWorldHash(project: any): string {
  return hashValue({
    selectedWorldTemplateId: normalizeText(project?.selectedWorldTemplateId),
    worldTemplateSnapshot: project?.worldTemplateSnapshot || null,
  });
}

export function computeShotPlanSourceSnapshot(project: any): ShotPlanSourceSnapshot {
  return {
    scriptHash: computeScriptHash(project),
    styleBibleHash: computeStyleBibleHash(project),
    assetsHash: computeAssetsSemanticHash(project),
    durationHash: computeDurationHash(project),
    emotionHash: computeEmotionHash(project),
    worldHash: computeWorldHash(project),
  };
}

export function computeShotPlanSourceHash(project: any): string {
  return hashValue(computeShotPlanSourceSnapshot(project));
}

export function diffShotPlanSourceSnapshots(
  before: ShotPlanSourceSnapshot,
  after: ShotPlanSourceSnapshot,
): ShotPlanStaleReason[] {
  const reasons: ShotPlanStaleReason[] = [];
  (Object.keys(SNAPSHOT_REASON_BY_KEY) as Array<keyof ShotPlanSourceSnapshot>).forEach((key) => {
    if (before[key] !== after[key]) reasons.push(SNAPSHOT_REASON_BY_KEY[key]);
  });
  return reasons;
}

function normalizeReason(reason: unknown): ShotPlanStaleReason {
  const raw = String(reason || '').trim();
  return (SHOT_PLAN_STALE_REASONS as readonly string[]).includes(raw) ? raw as ShotPlanStaleReason : 'unknown';
}

export function normalizeShotPlanStatus(value: unknown): ShotPlanStatus | null {
  const raw = String(value || '').trim();
  return (SHOT_PLAN_STATUSES as readonly string[]).includes(raw) ? raw as ShotPlanStatus : null;
}

export function effectiveShotPlanStatus(project: any): ShotPlanStatus | null {
  const explicit = normalizeShotPlanStatus(project?.shotPlanStatus);
  if (explicit) return explicit;
  if (Array.isArray(project?.shots) && project.shots.length > 0) return 'legacy_unknown';
  return null;
}

function uniqueReasons(current: unknown, nextReason: ShotPlanStaleReason): ShotPlanStaleReason[] {
  const values = Array.isArray(current) ? current : current ? [current] : [];
  const out: ShotPlanStaleReason[] = [];
  for (const value of values) {
    const normalized = normalizeReason(value);
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (!out.includes(nextReason)) out.push(nextReason);
  return out;
}

function normalizeReasons(current: unknown): ShotPlanStaleReason[] {
  const values = Array.isArray(current) ? current : current ? [current] : [];
  const out: ShotPlanStaleReason[] = [];
  for (const value of values) {
    const normalized = normalizeReason(value);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function uniqueTextReasons(values: unknown): string[] {
  const raw = Array.isArray(values) ? values : values ? [values] : [];
  const out: string[] = [];
  for (const value of raw) {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function mergeTextReasons(current: unknown, next: unknown): string[] {
  const out = uniqueTextReasons(current);
  for (const reason of uniqueTextReasons(next)) {
    if (!out.includes(reason)) out.push(reason);
  }
  return out;
}

export function seedDownstreamStaleForShotPlan<T extends Record<string, any>>(
  project: T,
  opts: { reasons?: unknown; now?: string } = {},
): T {
  if (!project || typeof project !== 'object') return project;
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  if (!storyboards.length) return project;
  const reasons = mergeTextReasons([], opts.reasons || project.shotPlanStaleReasons || project.shotPlanStaleReason || 'unknown');
  const now = opts.now || new Date().toISOString();
  const staleFlags = { ...(project._staleFlags || {}) };
  const nextStoryboards = storyboards.map((storyboard: any, groupIdx: number) => {
    staleFlags[`storyboard_${groupIdx}`] = true;
    staleFlags[`video_prompt_${groupIdx}`] = true;
    if (!storyboard || typeof storyboard !== 'object') return storyboard;
    return {
      ...storyboard,
      staleSource: 'shot_plan',
      staleSourceReasons: mergeTextReasons(storyboard.staleSourceReasons, reasons),
      staleSourceAt: storyboard.staleSourceAt || now,
    };
  });
  return {
    ...(project || {}),
    _staleFlags: staleFlags,
    storyboards: nextStoryboards,
  };
}

export function hasDownstreamShotPlanStaleFlags(project: any): boolean {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const flags = project?._staleFlags && typeof project._staleFlags === 'object' ? project._staleFlags : {};
  return storyboards.some((_: any, groupIdx: number) => (
    flags[`storyboard_${groupIdx}`] === true || flags[`video_prompt_${groupIdx}`] === true
  ));
}

export function shouldSeedDownstreamStaleOnShotPlanConfirm(project: any): boolean {
  const status = effectiveShotPlanStatus(project);
  if (status === 'legacy_unknown') return true;
  if (status === 'stale' && !hasDownstreamShotPlanStaleFlags(project)) return true;
  return false;
}

export function markShotPlanStale(project: any, reason: ShotPlanStaleReason | string = 'unknown', now = new Date().toISOString()) {
  const nextReason = normalizeReason(reason);
  const status = effectiveShotPlanStatus(project);
  const next: any = { ...(project || {}) };
  const staleFlags = { ...(next._staleFlags || {}) };
  staleFlags[SHOT_PLAN_STALE_FLAG] = true;
  next._staleFlags = staleFlags;
  if (status !== 'generating') next.shotPlanStatus = 'stale';
  next.shotPlanStaleReasons = uniqueReasons(next.shotPlanStaleReasons || next.shotPlanStaleReason, nextReason);
  next.shotPlanStaleAt = now;
  return seedDownstreamStaleForShotPlan(next, { reasons: next.shotPlanStaleReasons, now });
}

function clearShotPlanStaleFlag(flags: any) {
  const next = { ...(flags || {}) };
  delete next[SHOT_PLAN_STALE_FLAG];
  return next;
}

function clearShotPlanGeneratedArtifactFlags(flags: any) {
  const next = clearShotPlanStaleFlag(flags);
  Object.keys(next).forEach((key) => {
    if (
      key.startsWith('storyboard_') ||
      key.startsWith('video_prompt_') ||
      key.startsWith('shot_prompt_') ||
      key.startsWith('tail_frame_') ||
      key.startsWith('shot_')
    ) {
      delete next[key];
    }
  });
  return next;
}

export function beginShotPlanGeneration(project: any, opts: {
  batchId: string;
  sourceHash?: string;
  sourceSnapshot?: ShotPlanSourceSnapshot;
  now?: string;
  archive?: boolean;
}) {
  const now = opts.now || new Date().toISOString();
  const sourceSnapshot = opts.sourceSnapshot || computeShotPlanSourceSnapshot(project);
  const sourceHash = opts.sourceHash || hashValue(sourceSnapshot);
  const base = opts.archive
    ? archiveCurrentShotPlan(project, { context: 'pre_regen', batchId: opts.batchId, now })
    : project;
  return {
    ...(base || {}),
    _staleFlags: clearShotPlanStaleFlag(base?._staleFlags),
    shotPlanStatus: 'generating' as ShotPlanStatus,
    shotPlanBatchId: opts.batchId,
    shotPlanGenerationStartedAt: now,
    shotPlanGenerationSourceHash: sourceHash,
    shotPlanGenerationSourceSnapshot: sourceSnapshot,
    shotPlanLastError: undefined,
    shotPlanFailedAt: undefined,
    shotPlanStaleReason: undefined,
    shotPlanStaleReasons: [],
    shotPlanStaleAt: undefined,
  };
}

export function completeShotPlanGenerationPatch(project: any, opts: {
  batchId: string;
  shots: any[];
  planMeta?: any;
  storyboards: any[];
  autoSegmentPlanSnapshot?: AutoSegmentPlanSnapshot | null;
  sourceHash?: string;
  sourceSnapshot?: ShotPlanSourceSnapshot;
  now?: string;
  videoTasks?: any[];
}) {
  const status = effectiveShotPlanStatus(project);
  if (status !== 'generating' || String(project?.shotPlanBatchId || '') !== opts.batchId) {
    return { ok: false as const, reason: 'cas_mismatch' as const };
  }
  const now = opts.now || new Date().toISOString();
  const sourceSnapshot = opts.sourceSnapshot || project?.shotPlanGenerationSourceSnapshot || computeShotPlanSourceSnapshot(project);
  const sourceHash = opts.sourceHash || project?.shotPlanGenerationSourceHash || hashValue(sourceSnapshot);
  const currentSnapshot = computeShotPlanSourceSnapshot(project);
  const reasons = normalizeReasons(project?.shotPlanStaleReasons || project?.shotPlanStaleReason);
  const diffReasons = diffShotPlanSourceSnapshots(sourceSnapshot, currentSnapshot);
  if (diffReasons.length && !reasons.includes('upstream_changed_during_generation')) {
    reasons.push('upstream_changed_during_generation');
  }
  for (const reason of diffReasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  const isStale = reasons.length > 0;
  const staleFlags = isStale
    ? { ...(project?._staleFlags || {}), [SHOT_PLAN_STALE_FLAG]: true }
    : clearShotPlanGeneratedArtifactFlags(project?._staleFlags);
  let patch: Record<string, any> = {
    shots: opts.shots,
    shotsApproved: false,
    imagesApproved: false,
    videoPromptsApproved: false,
    storyboards: opts.storyboards,
    videoTasks: Array.isArray(opts.videoTasks) ? opts.videoTasks : [],
    currentStep: 3,
    _staleFlags: staleFlags,
    shotPlanStatus: isStale ? 'stale' : 'ready',
    shotPlanLastBatchId: opts.batchId,
    shotPlanBatchId: undefined,
    shotPlanGeneratedAt: now,
    shotPlanSourceHash: sourceHash,
    shotPlanSourceSnapshot: sourceSnapshot,
    autoSegmentPlanSnapshot: opts.autoSegmentPlanSnapshot || undefined,
    shotPlanGenerationSourceHash: undefined,
    shotPlanGenerationSourceSnapshot: undefined,
    shotPlanGenerationStartedAt: undefined,
    shotPlanLastError: undefined,
    shotPlanFailedAt: undefined,
    shotsManuallyEditedAt: null,
    shotPlanStaleReason: undefined,
    shotPlanStaleReasons: reasons,
    shotPlanStaleAt: isStale ? now : undefined,
  };
  if (Object.prototype.hasOwnProperty.call(opts, 'planMeta')) {
    patch.planMeta = opts.planMeta ?? null;
  }
  if (isStale) {
    const seeded = seedDownstreamStaleForShotPlan({ ...(project || {}), ...patch }, { reasons, now });
    patch = {
      ...patch,
      _staleFlags: seeded._staleFlags,
      storyboards: seeded.storyboards,
    };
  }
  return { ok: true as const, patch, staleReasons: reasons };
}

export function failShotPlanGenerationPatch(project: any, opts: {
  batchId: string;
  error: string;
  now?: string;
}) {
  const status = effectiveShotPlanStatus(project);
  if (status !== 'generating' || String(project?.shotPlanBatchId || '') !== opts.batchId) {
    return { ok: false as const, reason: 'cas_mismatch' as const };
  }
  const now = opts.now || new Date().toISOString();
  return {
    ok: true as const,
    patch: {
      shotPlanStatus: 'failed' as ShotPlanStatus,
      shotPlanLastBatchId: opts.batchId,
      shotPlanBatchId: undefined,
      shotPlanFailedAt: now,
      shotPlanLastError: String(opts.error || '镜头计划生成失败').slice(0, 1000),
      shotPlanGenerationSourceHash: undefined,
      shotPlanGenerationSourceSnapshot: undefined,
      shotPlanGenerationStartedAt: undefined,
    },
  };
}

function hasAnyKey(source: any, keys: readonly string[]) {
  if (!source || typeof source !== 'object') return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function hasUsableShotPlan(project: any) {
  return Array.isArray(project?.shots) && project.shots.length > 0;
}

function extractShotPlanStatePatch(next: any) {
  const patch: Record<string, any> = {
    _staleFlags: next._staleFlags,
    shotPlanStatus: next.shotPlanStatus,
    shotPlanStaleReasons: next.shotPlanStaleReasons,
    shotPlanStaleReason: undefined,
    shotPlanStaleAt: next.shotPlanStaleAt,
  };
  if (Array.isArray(next.storyboards)) patch.storyboards = next.storyboards;
  return patch;
}

export function buildShotPlanDependencyPatch(opts: {
  current: any;
  candidate: any;
  changedPatch?: any;
  now?: string;
}) {
  const current = opts.current || {};
  const candidate = opts.candidate || {};
  const changedPatch = opts.changedPatch || {};
  const now = opts.now || new Date().toISOString();
  const patch: Record<string, any> = {};
  const hasShotPlan = hasUsableShotPlan(current) || hasUsableShotPlan(candidate);

  if (hasShotPlan && !candidate.shotPlanSourceHash && !normalizeShotPlanStatus(candidate.shotPlanStatus)) {
    patch.shotPlanStatus = 'legacy_unknown';
    patch._staleFlags = { ...(candidate._staleFlags || {}), [SHOT_PLAN_STALE_FLAG]: true };
  }

  if (Object.prototype.hasOwnProperty.call(changedPatch, 'shots')) {
    const currentShots = Array.isArray(current?.shots) ? current.shots : [];
    const candidateShots = Array.isArray(candidate?.shots) ? candidate.shots : [];
    if (currentShots.length > 0 && candidateShots.length > 0 && detectShotsManualEdit(currentShots, candidateShots)) {
      patch.shotsManuallyEditedAt = now;
    }
  }

  if (hasShotPlan && hasAnyKey(changedPatch, SHOT_PLAN_DEPENDENCY_KEYS)) {
    const beforeSnapshot = computeShotPlanSourceSnapshot(current);
    const afterSnapshot = computeShotPlanSourceSnapshot(candidate);
    const reasons = diffShotPlanSourceSnapshots(beforeSnapshot, afterSnapshot);
    if (reasons.length) {
      let marked = { ...candidate, ...patch };
      reasons.forEach((reason) => {
        marked = markShotPlanStale(marked, reason, now);
      });
      Object.assign(patch, extractShotPlanStatePatch(marked));
    }
  }

  return Object.keys(patch).length ? patch : null;
}

export function confirmCurrentShotPlanStillValid(project: any, now = new Date().toISOString()) {
  const status = effectiveShotPlanStatus(project);
  if (status !== 'stale' && status !== 'legacy_unknown') {
    throw new ShotPlanConfirmInvalidStateError(status || '');
  }
  const snapshot = computeShotPlanSourceSnapshot(project);
  const sourceHash = hashValue(snapshot);
  const staleFlags = { ...((project && project._staleFlags) || {}) };
  delete staleFlags[SHOT_PLAN_STALE_FLAG];
  return {
    ...(project || {}),
    _staleFlags: staleFlags,
    shotPlanStatus: 'ready' as ShotPlanStatus,
    shotPlanSourceHash: sourceHash,
    shotPlanSourceSnapshot: snapshot,
    shotPlanStaleReason: undefined,
    shotPlanStaleReasons: [],
    shotPlanStaleAt: undefined,
    shotPlanLastConfirmedAt: now,
    shotPlanLastConfirmedHash: sourceHash,
  };
}

export function confirmCurrentShotPlanStillValidWithDownstreamSeed(project: any, now = new Date().toISOString()) {
  const seedDownstream = shouldSeedDownstreamStaleOnShotPlanConfirm(project);
  const rawReasons = project?.shotPlanStaleReasons || project?.shotPlanStaleReason || [];
  const seedReasons = uniqueTextReasons(rawReasons);
  const confirmed = confirmCurrentShotPlanStillValid(project, now);
  return seedDownstream
    ? seedDownstreamStaleForShotPlan(confirmed, {
        reasons: seedReasons.length ? seedReasons : ['legacy_unknown'],
        now,
      })
    : confirmed;
}

const SHOT_MANUAL_COMPARE_FIELDS = [
  'id',
  'idx',
  'sceneId',
  'sceneName',
  'scene',
	  'duration',
	  'durationSec',
	  'shotType',
	  'framing',
	  'angle',
	  'lens',
	  'focus',
	  'light',
	  'composition',
	  'camera',
	  'movement',
  'visual',
  'dialogue',
  'keyInfo',
  'audio',
  'emotion',
  'intensity',
  'scriptRef',
  'characters',
] as const;

function normalizeShotsForManualCompare(shots: unknown) {
  return asArray(shots).map((shot) => pickFields(shot, [...SHOT_MANUAL_COMPARE_FIELDS]));
}

export function detectShotsManualEdit(oldShots: unknown, newShots: unknown): boolean {
  return hashValue(normalizeShotsForManualCompare(oldShots)) !== hashValue(normalizeShotsForManualCompare(newShots));
}

export function archiveCurrentShotPlan(
  project: any,
  opts: { context: ShotPlanArchiveContext; batchId?: string; now?: string },
) {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  if (!shots.length) return project;
  const now = opts.now || new Date().toISOString();
  const archive = Array.isArray(project?.legacyShotPlanArchive) ? [...project.legacyShotPlanArchive] : [];
  archive.push({
    archivedAt: now,
    archiveContext: opts.context,
    batchId: opts.batchId,
    shotPlanStatus: effectiveShotPlanStatus(project),
    shotPlanGeneratedAt: project?.shotPlanGeneratedAt,
    shotPlanSourceHash: project?.shotPlanSourceHash,
    shotPlanSourceSnapshot: project?.shotPlanSourceSnapshot,
    planMeta: project?.planMeta ? JSON.parse(JSON.stringify(project.planMeta)) : undefined,
    shots: JSON.parse(JSON.stringify(shots)),
  });
  return {
    ...(project || {}),
    legacyShotPlanArchive: archive,
  };
}

export function markVideoTasksOutdatedForShotPlanChange(project: any, reason = 'shot_plan_changed', now = new Date().toISOString()) {
  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  if (!videoTasks.length) return project;
  return {
    ...(project || {}),
    videoTasks: videoTasks.map((task: any) => task ? {
      ...task,
      outdated: true,
      outdatedReason: reason,
      outdatedAt: now,
    } : task),
  };
}
