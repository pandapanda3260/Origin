import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveLocalImagePath } from './image-gen';

export const FRAME_WORKFLOW_SCHEMA_VERSION = 3;
export type TailFrameIntent = 'none' | 'requested';
export type TailFrameReferenceStatus = 'missing' | 'pending' | 'ready' | 'failed' | 'stale' | 'file_missing';

const SINGLE_SHOT_MIGRATION_REASON = 'single_shot_migration';

function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashValue(value: any): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function cleanUrl(value: any): string {
  return String(value || '').trim();
}

function strictArrayEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

function validShotIndex(value: any, shotsLength: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < shotsLength ? n : null;
}

function normalizedShotIndices(raw: any, shotsLength: number): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v: any) => validShotIndex(v, shotsLength))
    .filter((v: number | null): v is number => v !== null);
}

function hasMeaningfulLegacyValue(value: any): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(hasMeaningfulLegacyValue);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function makeEmptyStoryboardSlot(idx: number): any {
  return {
    idx,
    shotIdx: idx + 1,
    shotIndices: [idx],
  };
}

export function makeSingleShotStoryboardSlots(shotsOrProject: any): any[] {
  const shots = Array.isArray(shotsOrProject?.shots)
    ? shotsOrProject.shots
    : (Array.isArray(shotsOrProject) ? shotsOrProject : []);
  return shots.map((_: any, idx: number) => makeEmptyStoryboardSlot(idx));
}

function isDevAlignmentAssertEnabled(): boolean {
  const raw = String(process.env.FRAME_WORKFLOW_ASSERT_ALIGNMENT ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return process.env.NODE_ENV !== 'production';
}

export function assertStoryboardsAlignedWithShots(project: any, context = 'project'): void {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  if (storyboards.length !== shots.length) {
    throw new Error(`[frame-workflow] ${context}: storyboards.length=${storyboards.length} does not match shots.length=${shots.length}`);
  }
  for (let idx = 0; idx < shots.length; idx += 1) {
    const sb = storyboards[idx];
    if (!sb || typeof sb !== 'object') {
      throw new Error(`[frame-workflow] ${context}: storyboards[${idx}] is missing`);
    }
    const shotIndices = Array.isArray(sb.shotIndices) ? sb.shotIndices.map((v: any) => Number(v)) : [];
    if (!strictArrayEqual(shotIndices, [idx])) {
      throw new Error(`[frame-workflow] ${context}: storyboards[${idx}].shotIndices must be [${idx}]`);
    }
    if (sb.idx != null && Number(sb.idx) !== idx) {
      throw new Error(`[frame-workflow] ${context}: storyboards[${idx}].idx must be ${idx}`);
    }
    if (sb.shotIdx != null && Number(sb.shotIdx) !== idx + 1) {
      throw new Error(`[frame-workflow] ${context}: storyboards[${idx}].shotIdx must be ${idx + 1}`);
    }
    const firstShotIndices = Array.isArray(sb.frames?.first?.shotIndices)
      ? sb.frames.first.shotIndices.map((v: any) => Number(v))
      : null;
    if (firstShotIndices && !strictArrayEqual(firstShotIndices, [idx])) {
      throw new Error(`[frame-workflow] ${context}: storyboards[${idx}].frames.first.shotIndices must be [${idx}]`);
    }
    const tailShotIndices = Array.isArray(sb.frames?.tail?.shotIndices)
      ? sb.frames.tail.shotIndices.map((v: any) => Number(v))
      : null;
    if (tailShotIndices && !strictArrayEqual(tailShotIndices, [idx])) {
      throw new Error(`[frame-workflow] ${context}: storyboards[${idx}].frames.tail.shotIndices must be [${idx}]`);
    }
  }

  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  for (let idx = 0; idx < videoTasks.length; idx += 1) {
    const task = videoTasks[idx];
    if (!hasMeaningfulLegacyValue(task)) continue;
    if (idx >= shots.length) {
      throw new Error(`[frame-workflow] ${context}: videoTasks[${idx}] has no matching shot`);
    }
    const taskGroupIdx = task?.groupIdx ?? task?._groupIdx;
    if (taskGroupIdx != null && Number(taskGroupIdx) !== idx) {
      throw new Error(`[frame-workflow] ${context}: videoTasks[${idx}].groupIdx must be ${idx}`);
    }
  }
}

export function maybeAssertStoryboardsAlignedWithShots(project: any, context = 'project'): void {
  if (!isDevAlignmentAssertEnabled()) return;
  assertStoryboardsAlignedWithShots(project, context);
}

export function storyboardShotIndices(
  project: any,
  groupIdx: number,
  storyboard?: any,
  opts: { mode?: 'legacy-compatible' | 'single-shot-strict'; explicitShotIndices?: any } = {},
): number[] {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const explicit = Array.isArray(opts.explicitShotIndices) && opts.explicitShotIndices.length
    ? opts.explicitShotIndices
    : null;
  const fromStoryboard = Array.isArray(storyboard?.shotIndices) && storyboard.shotIndices.length
    ? storyboard.shotIndices
    : null;
  const raw = explicit || fromStoryboard;
  const out = normalizedShotIndices(raw, shots.length);
  if (opts.mode === 'single-shot-strict') {
    if (!raw || raw.length !== 1 || out.length !== 1) {
      throw new Error(`[frame-workflow] storyboards[${groupIdx}] must bind exactly one valid shot`);
    }
    if (out[0] !== groupIdx) {
      throw new Error(`[frame-workflow] storyboards[${groupIdx}].shotIndices must be [${groupIdx}], got [${out.join(',')}]`);
    }
    return out;
  }
  return out.length ? out : [groupIdx].filter((v) => v >= 0 && v < shots.length);
}

function computeFirstFrameSourceHashForShotIndices(project: any, shotIndices: number[]): string | null {
  const shots = shotIndices.map((idx) => project?.shots?.[idx]).filter(Boolean);
  if (!shotIndices.length || !shots.length) return null;
  return hashValue({
    frameType: 'first_frame',
    shotIndices,
    shots,
    styleBible: project?.styleBible || {},
  });
}

function computeTailFrameSourceHashForShotIndices(project: any, userId: number, storyboard: any, shotIndices: number[]): string | null {
  const firstFrameUrl =
    cleanUrl(storyboard?.firstFrameUrl) ||
    cleanUrl(storyboard?.frames?.first?.url) ||
    cleanUrl(storyboard?.firstFrame?.currentUrl);
  const firstFrameContentHash = imageContentHashForUrl(firstFrameUrl, userId);
  if (!firstFrameContentHash) return null;
  const shots = shotIndices.map((idx) => project?.shots?.[idx]).filter(Boolean);
  if (!shotIndices.length || !shots.length) return null;
  return hashValue({
    frameType: 'tail_frame',
    firstFrameContentHash,
    shotIndices,
    shots,
    styleBible: project?.styleBible || {},
  });
}

export function resolveProtectedImageFilePath(imageUrl: string | undefined | null, userId: number): string | null {
  return resolveLocalImagePath(cleanUrl(imageUrl), userId);
}

export function imageContentHashForUrl(imageUrl: string | undefined | null, userId: number): string | null {
  const path = resolveProtectedImageFilePath(imageUrl, userId);
  if (!path) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function computeFirstFrameSourceHash(project: any, userId: number, groupIdx: number): string | null {
  const sb = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] : null;
  if (!sb) return null;
  const shotIndices = storyboardShotIndices(project, groupIdx, sb);
  return computeFirstFrameSourceHashForShotIndices(project, shotIndices);
}

export function computeTailFrameSourceHash(project: any, userId: number, groupIdx: number): string | null {
  const sb = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] : null;
  if (!sb) return null;
  const shotIndices = storyboardShotIndices(project, groupIdx, sb);
  return computeTailFrameSourceHashForShotIndices(project, userId, sb, shotIndices);
}

function tailFrameUrl(sb: any): string {
  return cleanUrl(sb?.frames?.tail?.url) || cleanUrl(sb?.tailFrameUrl);
}

export function markTailFrameStaleForFirstFrameChange(storyboard: any, opts: { staleAt?: string } = {}): any {
  const sb = storyboard && typeof storyboard === 'object' ? storyboard : {};
  const url = tailFrameUrl(sb);
  if (!url) return sb;
  const alreadyStaleForFirstFrame =
    sb.tailFrameReferenceStatus === 'stale' &&
    (sb.tailFrameStaleReason === 'first_frame_changed' || sb.frames?.tail?.staleReason === 'first_frame_changed');
  const existingStaleAt = cleanUrl(sb.tailFrameStaleAt) || cleanUrl(sb.frames?.tail?.staleAt);
  const staleAt = alreadyStaleForFirstFrame && existingStaleAt
    ? existingStaleAt
    : opts.staleAt || new Date().toISOString();
  const frames = sb.frames && typeof sb.frames === 'object' ? { ...sb.frames } : {};
  if (frames.tail && typeof frames.tail === 'object') {
    frames.tail = {
      ...frames.tail,
      referenceStatus: 'stale',
      staleAt,
      staleReason: 'first_frame_changed',
    };
  }
  return {
    ...sb,
    frames,
    tailFrameIntent: validIntent(sb.tailFrameIntent) || 'requested',
    tailFrameReferenceStatus: 'stale',
    tailFrameStaleAt: staleAt,
    tailFrameStaleReason: 'first_frame_changed',
  };
}

function validIntent(value: any): TailFrameIntent | null {
  return value === 'requested' || value === 'none' ? value : null;
}

function normalizeStoryboardSlot(project: any, userId: number, storyboard: any, idx: number): any {
  const sb = storyboard && typeof storyboard === 'object' ? storyboard : {};
  const shotIndices = [idx];
  const url = tailFrameUrl(sb);
  const intent = validIntent(sb?.tailFrameIntent) || (url ? 'requested' : 'none');
  const localPath = url ? resolveProtectedImageFilePath(url, userId) : null;
  const referenceStatus: TailFrameReferenceStatus =
    intent === 'requested'
      ? (url ? (localPath ? 'ready' : 'file_missing') : 'missing')
      : 'missing';
  const storedTailShotIndices = Array.isArray(sb?.frames?.tail?.shotIndices)
    ? normalizedShotIndices(sb.frames.tail.shotIndices, Array.isArray(project?.shots) ? project.shots.length : 0)
    : [];
  const canTrustExistingTail =
    intent === 'requested' &&
    referenceStatus === 'ready' &&
    storedTailShotIndices.length > 0 &&
    strictArrayEqual(storedTailShotIndices, shotIndices);
  const sourceHash =
    typeof sb?.tailFrameSourceHash === 'string'
      ? sb.tailFrameSourceHash
      : (canTrustExistingTail ? computeTailFrameSourceHashForShotIndices(project, userId, sb, shotIndices) : null);
  const updatedAt =
    sb?.tailFrameIntentUpdatedAt ||
    sb?.frames?.tail?.generatedAt ||
    sb?.tailFrameGeneratedAt ||
    new Date().toISOString();
  const hasExistingFirstFrame = !!(
    cleanUrl(sb?.firstFrameUrl) ||
    cleanUrl(sb?.frames?.first?.url) ||
    cleanUrl(sb?.imageUrl) ||
    cleanUrl(sb?.url)
  );
  const firstFrameSourceHash =
    typeof sb?.firstFrameSourceHash === 'string'
      ? sb.firstFrameSourceHash
      : (typeof sb?.frames?.first?.sourceHash === 'string'
          ? sb.frames.first.sourceHash
          : (hasExistingFirstFrame ? computeFirstFrameSourceHashForShotIndices(project, shotIndices) : null));

  const frames = sb?.frames && typeof sb.frames === 'object' ? { ...sb.frames } : {};
  if (frames.tail && typeof frames.tail === 'object') {
    frames.tail = {
      ...frames.tail,
      referenceStatus,
      shotIndices,
      sourceHash,
    };
  }
  if (frames.first && typeof frames.first === 'object') {
    frames.first = {
      ...frames.first,
      shotIndices,
      ...(firstFrameSourceHash ? { sourceHash: typeof frames.first.sourceHash === 'string' ? frames.first.sourceHash : firstFrameSourceHash } : {}),
    };
  }

  return {
    ...sb,
    idx,
    shotIdx: idx + 1,
    shotIndices,
    frames,
    tailFrameIntent: intent,
    tailFrameIntentUpdatedAt: updatedAt,
    tailFrameSourceHash: sourceHash,
    tailFrameReferenceStatus: referenceStatus,
    firstFrameSourceHash,
  };
}

function archiveLegacyStoryboard(args: {
  archive: any[];
  oldGroupIdx: number;
  oldShotIndices: number[];
  storyboard: any;
  videoTask: any;
  archivedAt: string;
  archiveReason?: string;
}) {
  const { archive, oldGroupIdx, oldShotIndices, storyboard, videoTask, archivedAt, archiveReason } = args;
  if (!hasMeaningfulLegacyValue(storyboard) && !hasMeaningfulLegacyValue(videoTask)) return;
  archive.push({
    oldGroupIdx,
    oldShotIndices,
    storyboard: hasMeaningfulLegacyValue(storyboard) ? storyboard : undefined,
    videoTask: hasMeaningfulLegacyValue(videoTask) ? videoTask : undefined,
    archivedAt,
    archiveReason: archiveReason || SINGLE_SHOT_MIGRATION_REASON,
  });
}

function migrateEditDataForSingleShotSlots(editData: any, groupIdxRemap: Map<number, number>, archivedAt: string) {
  if (!editData || typeof editData !== 'object') return { editData: undefined, archive: null };
  let touched = false;
  const nextEditData = { ...editData };
  const legacyTimelineArchive: any = {};

  const edl = editData.edl && typeof editData.edl === 'object' ? editData.edl : null;
  if (edl && Array.isArray(edl.timeline)) {
    const oldTimeline = edl.timeline;
    const nextTimeline: any[] = [];
    let dropped = 0;
    for (const entry of oldTimeline) {
      const oldGroupIdx = Number(entry?.groupIdx);
      if (!Number.isInteger(oldGroupIdx)) {
        nextTimeline.push(entry);
        continue;
      }
      const nextGroupIdx = groupIdxRemap.get(oldGroupIdx);
      if (nextGroupIdx == null) {
        dropped += 1;
        continue;
      }
      nextTimeline.push({ ...entry, groupIdx: nextGroupIdx });
      if (nextGroupIdx !== oldGroupIdx) touched = true;
    }
    if (dropped > 0 || nextTimeline.length !== oldTimeline.length) {
      touched = true;
      legacyTimelineArchive.edl = edl;
      legacyTimelineArchive.droppedTimelineCount = dropped;
    }
    if (touched) {
      nextEditData.edl = {
        ...edl,
        timeline: nextTimeline,
        version: (Number(edl.version) || 0) + 1,
      };
    }
  }

  const segmentTags = editData.segmentTags && typeof editData.segmentTags === 'object' ? editData.segmentTags : null;
  if (segmentTags && Array.isArray(segmentTags.segments)) {
    const oldSegments = segmentTags.segments;
    const nextSegments: any[] = [];
    let dropped = 0;
    for (const seg of oldSegments) {
      const oldGroupIdx = Number(seg?.groupIdx);
      if (!Number.isInteger(oldGroupIdx)) {
        nextSegments.push(seg);
        continue;
      }
      const nextGroupIdx = groupIdxRemap.get(oldGroupIdx);
      if (nextGroupIdx == null) {
        dropped += 1;
        continue;
      }
      nextSegments.push({ ...seg, groupIdx: nextGroupIdx });
      if (nextGroupIdx !== oldGroupIdx) touched = true;
    }
    if (dropped > 0 || nextSegments.length !== oldSegments.length) {
      touched = true;
      legacyTimelineArchive.segmentTags = segmentTags;
      legacyTimelineArchive.droppedSegmentTagCount = dropped;
    }
    if (touched) {
      nextEditData.segmentTags = {
        ...segmentTags,
        segments: nextSegments,
      };
    }
  }

  if (!touched) return { editData: undefined, archive: null };
  const archive = hasMeaningfulLegacyValue(legacyTimelineArchive)
    ? {
        ...legacyTimelineArchive,
        archivedAt,
        archiveReason: SINGLE_SHOT_MIGRATION_REASON,
      }
    : null;
  return { editData: nextEditData, archive };
}

export function buildFrameWorkflowNormalizationPatch(project: any, userId: number): any | null {
  if (!project || Number(project.frameWorkflowSchemaVersion || 0) >= FRAME_WORKFLOW_SCHEMA_VERSION) return null;
  const previousVersion = Number(project.frameWorkflowSchemaVersion || 0);
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  const archivedAt = new Date().toISOString();
  const archive = Array.isArray(project.legacyStoryboardArchive)
    ? [...project.legacyStoryboardArchive]
    : [];

  const normalizedStoryboards = shots.map((_: any, idx: number) => normalizeStoryboardSlot(project, userId, makeEmptyStoryboardSlot(idx), idx));
  const normalizedVideoTasks: any[] = [];
  const occupiedShotIdx = new Set<number>();
  const groupIdxRemap = new Map<number, number>();
  const maxOldLen = Math.max(storyboards.length, videoTasks.length);
  let archivedStoryboardCount = 0;

  for (let oldGroupIdx = 0; oldGroupIdx < maxOldLen; oldGroupIdx += 1) {
    const oldSb = storyboards[oldGroupIdx];
    const oldVideoTask = videoTasks[oldGroupIdx];
    const rawOldShotIndices = Array.isArray(oldSb?.shotIndices) ? oldSb.shotIndices : [];
    const oldShotIndices = normalizedShotIndices(rawOldShotIndices, shots.length);
    const singleShotIdx = rawOldShotIndices.length === 1 && oldShotIndices.length === 1 ? oldShotIndices[0] : null;
    const canInherit =
      singleShotIdx !== null &&
      !occupiedShotIdx.has(singleShotIdx);

    if (canInherit) {
      normalizedStoryboards[singleShotIdx] = normalizeStoryboardSlot(project, userId, oldSb, singleShotIdx);
      occupiedShotIdx.add(singleShotIdx);
      groupIdxRemap.set(oldGroupIdx, singleShotIdx);
      if (hasMeaningfulLegacyValue(oldVideoTask)) {
        normalizedVideoTasks[singleShotIdx] = {
          ...oldVideoTask,
          groupIdx: singleShotIdx,
        };
      }
      continue;
    }

    const beforeCount = archive.length;
    archiveLegacyStoryboard({
      archive,
      oldGroupIdx,
      oldShotIndices,
      storyboard: oldSb,
      videoTask: oldVideoTask,
      archivedAt,
      archiveReason: occupiedShotIdx.has(singleShotIdx as number)
        ? `${SINGLE_SHOT_MIGRATION_REASON}:duplicate_single_shot`
        : SINGLE_SHOT_MIGRATION_REASON,
    });
    if (archive.length > beforeCount) archivedStoryboardCount += 1;
  }

  const editMigration = migrateEditDataForSingleShotSlots(project.editData, groupIdxRemap, archivedAt);
  const patch: any = {
    storyboards: normalizedStoryboards,
    videoTasks: normalizedVideoTasks,
    frameWorkflowSchemaVersion: FRAME_WORKFLOW_SCHEMA_VERSION,
    frameWorkflowMigratedFromVersion: previousVersion,
  };
  if (archive.length !== (Array.isArray(project.legacyStoryboardArchive) ? project.legacyStoryboardArchive.length : 0)) {
    patch.legacyStoryboardArchive = archive;
    patch.legacyStoryboardArchiveLastMigratedAt = archivedAt;
    patch.legacyStoryboardArchiveLastCount = archivedStoryboardCount;
  }
  if (editMigration.editData) patch.editData = editMigration.editData;
  if (editMigration.archive) {
    const timelineArchive = Array.isArray(project.legacyTimelineArchive)
      ? [...project.legacyTimelineArchive]
      : [];
    timelineArchive.push(editMigration.archive);
    patch.legacyTimelineArchive = timelineArchive;
  }
  maybeAssertStoryboardsAlignedWithShots({ ...project, ...patch }, 'frame-workflow-v3-migration');
  return patch;
}

export function computeFrameWorkflowStaleFlags(project: any, userId: number): Record<string, true> {
  const flags: Record<string, true> = {};
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  for (let groupIdx = 0; groupIdx < storyboards.length; groupIdx += 1) {
    const sb = storyboards[groupIdx] || {};
    const hasFirst =
      cleanUrl(sb.frames?.first?.url) ||
      cleanUrl(sb.firstFrameUrl) ||
      cleanUrl(sb.imageUrl) ||
      cleanUrl(sb.url);
    if (hasFirst) {
      const currentFirstHash = computeFirstFrameSourceHash(project, userId, groupIdx);
      const storedFirstHash = typeof sb.firstFrameSourceHash === 'string'
        ? sb.firstFrameSourceHash
        : (typeof sb.frames?.first?.sourceHash === 'string' ? sb.frames.first.sourceHash : null);
      if (!storedFirstHash || (currentFirstHash && storedFirstHash !== currentFirstHash)) {
        flags[`storyboard_${groupIdx}`] = true;
      }
    }

    const tailRequested = sb.tailFrameIntent === 'requested' || !!tailFrameUrl(sb);
    if (tailRequested) {
      const currentTailHash = computeTailFrameSourceHash(project, userId, groupIdx);
      const storedTailHash = typeof sb.tailFrameSourceHash === 'string'
        ? sb.tailFrameSourceHash
        : (typeof sb.frames?.tail?.sourceHash === 'string' ? sb.frames.tail.sourceHash : null);
      if (!storedTailHash || !currentTailHash || storedTailHash !== currentTailHash) {
        flags[`tail_frame_${groupIdx}`] = true;
      }
    }
  }
  return flags;
}
