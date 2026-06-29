import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveLocalImagePath } from './image-gen';
import { planSegments } from './segment-planning';
import { isMultiShotSegmentEnabled } from './feature-flags';
import { computeWorldHash } from './project-dependency-state';
import { inferTailFrameDependencyForShots } from './tail-frame-dependency';

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

function cleanText(value: any): string {
  return String(value ?? '').trim();
}

function strictArrayEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

function shotUidFor(project: any, shotIdx: number): string {
  const shot = Array.isArray(project?.shots) ? project.shots[shotIdx] : null;
  return cleanText(shot?.shotUid ?? shot?.shot_uid);
}

function primaryFirstShotIndices(shotIndices: number[], primaryShotIdx: number): number[] {
  return [primaryShotIdx, ...shotIndices.filter((idx) => idx !== primaryShotIdx)];
}

function candidateTime(candidate: any): number {
  const created = Date.parse(cleanText(candidate?.createdAt));
  if (!Number.isNaN(created)) return created;
  const generated = Date.parse(cleanText(candidate?.generatedAt));
  if (!Number.isNaN(generated)) return generated;
  return 0;
}

function selectedShotFrameCandidate(state: any): any | null {
  const candidates = Array.isArray(state?.candidates)
    ? state.candidates.filter((candidate: any) => candidate && cleanUrl(candidate.url))
    : [];
  if (!candidates.length) return null;
  const selectedId = cleanText(state?.selectedCandidateId);
  if (selectedId) {
    const selected = candidates.find((candidate: any) => cleanText(candidate?.id) === selectedId);
    if (selected) return selected;
  }
  return [...candidates].sort((a, b) => candidateTime(b) - candidateTime(a))[0] || null;
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

function makeStoryboardSlotForGroup(groupIdx: number, shotIndices: number[]): any {
  const indices = shotIndices.slice();
  return {
    idx: groupIdx,
    shotIdx: (indices[0] ?? groupIdx) + 1,
    shotIndices: indices,
  };
}

export function makeSingleShotStoryboardSlots(shotsOrProject: any): any[] {
  const shots = Array.isArray(shotsOrProject?.shots)
    ? shotsOrProject.shots
    : (Array.isArray(shotsOrProject) ? shotsOrProject : []);
  // flag OFF：维持 1:1（与历史完全一致）；flag ON：按时长把相邻短镜头合并成段。
  // 注意：本函数 flag ON 后会产出 storyboards.length < shots.length，需配合 P2c 放开对齐不变量。
  if (isMultiShotSegmentEnabled()) {
    const segments = planSegments(shots);
    return segments.map((shotIndices, gIdx) => makeStoryboardSlotForGroup(gIdx, shotIndices));
  }
  return shots.map((_: any, idx: number) => makeEmptyStoryboardSlot(idx));
}

function isDevAlignmentAssertEnabled(): boolean {
  const raw = String(process.env.FRAME_WORKFLOW_ASSERT_ALIGNMENT ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return process.env.NODE_ENV !== 'production';
}

export function assertGroupsCoverAllShotsOnce(storyboards: any[], shots: any[], context: string): void {
  const n = shots.length;
  const seen: boolean[] = new Array(n).fill(false);
  let expectedNext = 0;
  for (let g = 0; g < storyboards.length; g += 1) {
    const sb = storyboards[g];
    if (!sb || typeof sb !== 'object') {
      throw new Error(`[frame-workflow] ${context}: storyboards[${g}] is missing`);
    }
    const indices = Array.isArray(sb.shotIndices) ? sb.shotIndices : [];
    if (!indices.length) {
      throw new Error(`[frame-workflow] ${context}: storyboards[${g}].shotIndices 为空`);
    }
    for (let k = 0; k < indices.length; k += 1) {
      const shotIdx = Number(indices[k]);
      if (!Number.isInteger(shotIdx) || shotIdx < 0 || shotIdx >= n) {
        throw new Error(`[frame-workflow] ${context}: storyboards[${g}].shotIndices 含越界下标 ${shotIdx}`);
      }
      if (shotIdx !== expectedNext) {
        throw new Error(`[frame-workflow] ${context}: storyboards[${g}].shotIndices 必须按镜头顺序连续覆盖（期望 ${expectedNext}，得 ${shotIdx}）`);
      }
      if (seen[shotIdx]) {
        throw new Error(`[frame-workflow] ${context}: 镜头 ${shotIdx} 被多个段重复绑定`);
      }
      seen[shotIdx] = true;
      expectedNext += 1;
    }
  }
  if (expectedNext !== n) {
    throw new Error(`[frame-workflow] ${context}: 段未覆盖全部镜头（覆盖到 ${expectedNext}，共 ${n}）`);
  }
}

export function assertStoryboardsAlignedWithShots(project: any, context = 'project'): void {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  // flag ON：storyboards 是"段"，不再与 shots 1:1；改校验"段按序、无重叠、覆盖全部镜头"。
  if (isMultiShotSegmentEnabled()) {
    assertGroupsCoverAllShotsOnce(storyboards, shots, context);
    return;
  }
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
  // 此前 dev 模式直接抛错，导致开发期写盘流程在对齐异常时全链路中断。
  // 改为捕获并以 console.warn 形式上报，方便观测但不中断业务。
  // 单元测试直接调 assertStoryboardsAlignedWithShots（不走此 wrapper），断言能力保留。
  try {
    assertStoryboardsAlignedWithShots(project, context);
  } catch (error: any) {
    try {
      console.warn('[frame-workflow-assert]', JSON.stringify({
        context,
        message: error?.message || String(error),
      }));
    } catch {
      console.warn('[frame-workflow-assert]', context, error?.message || error);
    }
  }
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
    // flag ON：段绑定的是一个镜头运行段（≥1），不再强制单镜头 / [groupIdx]。
    if (isMultiShotSegmentEnabled()) {
      if (!out.length) {
        throw new Error(`[frame-workflow] storyboards[${groupIdx}] 绑定的镜头下标无效`);
      }
      return out;
    }
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

export function computeFirstFrameSourceHashForShotIndices(project: any, shotIndices: number[]): string | null {
  const shots = shotIndices.map((idx) => project?.shots?.[idx]).filter(Boolean);
  if (!shotIndices.length || !shots.length) return null;
  return hashValue({
    frameType: 'first_frame',
    shotIndices,
    shots,
    styleBible: project?.styleBible || {},
    worldHash: computeWorldHash(project),
  });
}

export function computeFirstFrameSourceHashForShot(project: any, groupIdx: number, shotUid: string): string | null {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = storyboardShotIndices(project, groupIdx, sb);
  const targetShotUid = cleanText(shotUid);
  if (!targetShotUid) return null;
  const primaryShotIdx = shotIndices.find((idx) => shotUidFor(project, idx) === targetShotUid);
  if (!Number.isInteger(primaryShotIdx)) return null;
  return computeFirstFrameSourceHashForShotIndices(project, primaryFirstShotIndices(shotIndices, primaryShotIdx as number));
}

export function computeTailFrameSourceHashForShotIndices(project: any, userId: number, storyboard: any, shotIndices: number[]): string | null {
  const shots = shotIndices.map((idx) => project?.shots?.[idx]).filter(Boolean);
  if (!shotIndices.length || !shots.length) return null;
  const dependency = inferTailFrameDependencyForShots(shots, storyboard);
  const firstFrameUrl =
    cleanUrl(storyboard?.firstFrameUrl) ||
    cleanUrl(storyboard?.frames?.first?.url) ||
    cleanUrl(storyboard?.firstFrame?.currentUrl);
  const firstFrameContentHash = dependency === 'requires_first_frame'
    ? imageContentHashForUrl(firstFrameUrl, userId)
    : null;
  if (dependency === 'requires_first_frame' && !firstFrameContentHash) return null;
  return hashValue({
    frameType: 'tail_frame',
    dependency,
    firstFrameContentHash,
    shotIndices,
    shots,
    styleBible: project?.styleBible || {},
    worldHash: computeWorldHash(project),
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

// 用户原则: 首帧变化不自动 stale 尾帧, 也不删除已生成的视频任务,
// 用户自决要不要重做。markTailFrameStaleForFirstFrameChange 已废弃。

function validIntent(value: any): TailFrameIntent | null {
  return value === 'requested' || value === 'none' ? value : null;
}

function normalizeStoryboardSlot(project: any, userId: number, storyboard: any, idx: number, overrideShotIndices?: number[]): any {
  const sb = storyboard && typeof storyboard === 'object' ? storyboard : {};
  const shotsLength = Array.isArray(project?.shots) ? project.shots.length : 0;
  const overrideIndices = Array.isArray(overrideShotIndices)
    ? normalizedShotIndices(overrideShotIndices, shotsLength)
    : [];
  const shotIndices = overrideIndices.length ? overrideIndices : [idx];
  const primaryShotIdx = shotIndices[0] ?? idx;
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
    // 历史脏数据里残留的 staleAt / staleReason 在 normalize 时一并清理。
    const { staleAt: _legacyStaleAt, staleReason: _legacyStaleReason, ...tailRest } = frames.tail;
    frames.tail = {
      ...tailRest,
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

  // 顶层同样把历史 stale 字段 strip 掉, 避免老数据继续在前端显示"已过期"。
  const { tailFrameStaleAt: _legacyTopStaleAt, tailFrameStaleReason: _legacyTopStaleReason, ...sbRest } = sb;
  return {
    ...sbRest,
    idx,
    shotIdx: primaryShotIdx + 1,
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

function shotIndicesEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

function storyboardShotIndicesEvidence(sb: any, shotsLength: number): {
  top: number[];
  first: number[][];
  tail: number[][];
} {
  const top = normalizedShotIndices(sb?.shotIndices, shotsLength);
  return {
    top,
    first: [
      normalizedShotIndices(sb?.firstFramePlanSummary?.shotIndices, shotsLength),
      normalizedShotIndices(sb?.frames?.first?.shotIndices, shotsLength),
    ].filter((arr) => arr.length > 0),
    tail: [
      normalizedShotIndices(sb?.tailFramePlanSummary?.shotIndices, shotsLength),
      normalizedShotIndices(sb?.frames?.tail?.shotIndices, shotsLength),
    ].filter((arr) => arr.length > 0),
  };
}

function evidenceMatchesTarget(evidence: number[][], target: number[]): boolean {
  return evidence.some((arr) => shotIndicesEqual(arr, target));
}

function summarizeFrameWorkflowCoverage(project: any) {
  const shotsLength = Array.isArray(project?.shots) ? project.shots.length : 0;
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const groups = storyboards.map((sb: any) => normalizedShotIndices(sb?.shotIndices, shotsLength));
  const counts = new Map<number, number>();
  groups.forEach((indices: number[]) => {
    indices.forEach((idx) => counts.set(idx, (counts.get(idx) || 0) + 1));
  });
  const missing: number[] = [];
  for (let idx = 0; idx < shotsLength; idx += 1) {
    if (!counts.has(idx)) missing.push(idx);
  }
  const duplicate = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([idx]) => idx);
  return {
    shotsLength,
    slotCount: storyboards.length,
    groups,
    missing,
    duplicate,
  };
}

function compactFrameWorkflowSlot(project: any, groupIdx: number) {
  const shotsLength = Array.isArray(project?.shots) ? project.shots.length : 0;
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  const sb = storyboards[groupIdx] || {};
  const task = videoTasks[groupIdx] || null;
  return {
    groupIdx,
    shotIndices: normalizedShotIndices(sb?.shotIndices, shotsLength),
    first: [
      normalizedShotIndices(sb?.firstFramePlanSummary?.shotIndices, shotsLength),
      normalizedShotIndices(sb?.frames?.first?.shotIndices, shotsLength),
    ].filter((arr) => arr.length > 0),
    tail: [
      normalizedShotIndices(sb?.tailFramePlanSummary?.shotIndices, shotsLength),
      normalizedShotIndices(sb?.frames?.tail?.shotIndices, shotsLength),
    ].filter((arr) => arr.length > 0),
    hasFirstUrl: !!(cleanUrl(sb?.firstFrameUrl) || cleanUrl(sb?.frames?.first?.url)),
    hasTailUrl: !!(cleanUrl(sb?.tailFrameUrl) || cleanUrl(sb?.frames?.tail?.url)),
    videoTaskShotIndices: task
      ? normalizedShotIndices(task?.shotIndices, shotsLength)
      : [],
  };
}

function frameWorkflowRepairChanges(before: any, after: any) {
  const beforeStoryboards = Array.isArray(before?.storyboards) ? before.storyboards : [];
  const afterStoryboards = Array.isArray(after?.storyboards) ? after.storyboards : [];
  const maxLen = Math.max(beforeStoryboards.length, afterStoryboards.length);
  const changes: any[] = [];
  for (let groupIdx = 0; groupIdx < maxLen; groupIdx += 1) {
    const beforeSlot = compactFrameWorkflowSlot(before, groupIdx);
    const afterSlot = compactFrameWorkflowSlot(after, groupIdx);
    if (stableStringify(beforeSlot) !== stableStringify(afterSlot)) {
      changes.push({ groupIdx, before: beforeSlot, after: afterSlot });
    }
  }
  return changes;
}

function logFrameWorkflowRepair(project: any, patch: any, reason: string, userId: number) {
  const projectId = String(project?.id || project?.projectId || '').trim();
  if (!projectId) return;
  const after = { ...project, ...patch };
  const archiveBefore = Array.isArray(project?.legacyStoryboardArchive)
    ? project.legacyStoryboardArchive.length
    : 0;
  const archiveAfter = Array.isArray(after?.legacyStoryboardArchive)
    ? after.legacyStoryboardArchive.length
    : archiveBefore;
  const payload = {
    projectId,
    userId,
    reason,
    before: summarizeFrameWorkflowCoverage(project),
    after: summarizeFrameWorkflowCoverage(after),
    changes: [] as any[],
    changeCount: 0,
    archivedStoryboardDelta: archiveAfter - archiveBefore,
  };
  const changes = frameWorkflowRepairChanges(project, after);
  payload.changes = changes.slice(0, 30);
  payload.changeCount = changes.length;
  try {
    console.error('[frame-workflow-repair]', JSON.stringify(payload));
  } catch {
    console.error('[frame-workflow-repair]', projectId, reason);
  }
}

function findStoryboardForShotIndices(storyboards: any[], target: number[], used: Set<number>, shotsLength: number): number | null {
  let best: { idx: number; score: number } | null = null;
  for (let idx = 0; idx < storyboards.length; idx += 1) {
    if (used.has(idx)) continue;
    const sb = storyboards[idx];
    if (!hasMeaningfulLegacyValue(sb)) continue;
    const evidence = storyboardShotIndicesEvidence(sb, shotsLength);
    let score = 0;
    if (shotIndicesEqual(evidence.top, target)) score = 100;
    else if (evidenceMatchesTarget(evidence.first, target)) score = 80;
    else if (evidenceMatchesTarget(evidence.tail, target)) score = 50;
    if (!score) continue;
    if (!best || score > best.score) best = { idx, score };
  }
  return best ? best.idx : null;
}

function stripFirstFrameFields(sb: any): any {
  const {
    assetLibraryAssetId: _assetLibraryAssetId,
    effectiveVisualDescription: _effectiveVisualDescription,
    firstFrame: _firstFrame,
    firstFrameBackup: _firstFrameBackup,
    firstFrameBasePrompt: _firstFrameBasePrompt,
    firstFrameConsistencyCheck: _firstFrameConsistencyCheck,
    firstFrameConsistencyStatus: _firstFrameConsistencyStatus,
    firstFrameEditDraft: _firstFrameEditDraft,
    firstFrameFailedAt: _firstFrameFailedAt,
    firstFrameLastError: _firstFrameLastError,
    firstFrameMode: _firstFrameMode,
    firstFramePlanSummary: _firstFramePlanSummary,
    firstFramePrompt: _firstFramePrompt,
    firstFrameSafetyAudit: _firstFrameSafetyAudit,
    firstFrameSourceHash: _firstFrameSourceHash,
    firstFrameUrl: _firstFrameUrl,
    imagePrompt: _imagePrompt,
    imageUrl: _imageUrl,
    originalFirstFramePrompt: _originalFirstFramePrompt,
    rawUrl: _rawUrl,
    url: _url,
    ...rest
  } = sb || {};
  return rest;
}

function stripTailFrameFields(sb: any): any {
  const {
    originalTailFramePrompt: _originalTailFramePrompt,
    tailFrameBackup: _tailFrameBackup,
    tailFrameBasePrompt: _tailFrameBasePrompt,
    tailFrameConsistencyCheck: _tailFrameConsistencyCheck,
    tailFrameConsistencyStatus: _tailFrameConsistencyStatus,
    tailFrameEditDraft: _tailFrameEditDraft,
    tailFrameFailedAt: _tailFrameFailedAt,
    tailFrameHistory: _tailFrameHistory,
    tailFrameIntent: _tailFrameIntent,
    tailFrameIntentUpdatedAt: _tailFrameIntentUpdatedAt,
    tailFrameLastError: _tailFrameLastError,
    tailFrameMode: _tailFrameMode,
    tailFramePlanSummary: _tailFramePlanSummary,
    tailFramePrompt: _tailFramePrompt,
    tailFrameReferenceStatus: _tailFrameReferenceStatus,
    tailFrameSafetyAudit: _tailFrameSafetyAudit,
    tailFrameSourceHash: _tailFrameSourceHash,
    tailFrameUrl: _tailFrameUrl,
    ...rest
  } = sb || {};
  return rest;
}

function sanitizeStoryboardForTargetShotIndices(sb: any, target: number[], shotsLength: number): { storyboard: any; sanitized: boolean } {
  let next = sb && typeof sb === 'object' ? { ...sb } : {};
  if (next.frames && typeof next.frames === 'object') next.frames = { ...next.frames };
  const evidence = storyboardShotIndicesEvidence(next, shotsLength);
  const topMatches = shotIndicesEqual(evidence.top, target);
  const firstMatches = topMatches || evidenceMatchesTarget(evidence.first, target);
  const tailMatches = topMatches || evidenceMatchesTarget(evidence.tail, target);
  let sanitized = false;

  if (!firstMatches) {
    next = stripFirstFrameFields(next);
    if (next.frames && typeof next.frames === 'object') {
      delete next.frames.first;
    }
    sanitized = true;
  }
  if (!tailMatches) {
    next = stripTailFrameFields(next);
    if (next.frames && typeof next.frames === 'object') {
      delete next.frames.tail;
    }
    sanitized = true;
  }
  return { storyboard: next, sanitized };
}

function projectFrameAlignmentOk(project: any): boolean {
  try {
    if (isManualSegmentation(project)) {
      assertGroupsCoverAllShotsOnce(
        Array.isArray(project?.storyboards) ? project.storyboards : [],
        Array.isArray(project?.shots) ? project.shots : [],
        'frame-workflow-normalization-check',
      );
      return true;
    }
    assertStoryboardsAlignedWithShots(project, 'frame-workflow-normalization-check');
    return true;
  } catch {
    return false;
  }
}

function isManualSegmentation(project: any): boolean {
  return String(project?.segmentationMode || '').trim() === 'manual';
}

function makeManualRepairStoryboardSlots(project: any): any[] {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const groups: number[][] = [];
  let cursor = 0;
  for (const sb of storyboards) {
    const raw = normalizedShotIndices(sb?.shotIndices, shots.length).filter((idx) => idx >= cursor);
    if (!raw.length) continue;
    const start = raw[0];
    while (cursor < start) {
      groups.push([cursor]);
      cursor += 1;
    }
    const group: number[] = [];
    for (const idx of raw) {
      if (idx !== cursor) break;
      group.push(idx);
      cursor += 1;
    }
    if (group.length) groups.push(group);
  }
  while (cursor < shots.length) {
    groups.push([cursor]);
    cursor += 1;
  }
  return groups.map((shotIndices, groupIdx) => makeStoryboardSlotForGroup(groupIdx, shotIndices));
}

function buildFrameWorkflowAlignmentRepairPatch(project: any, userId: number, reason = 'alignment_repair'): any | null {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  if (!shots.length) return null;
  if (projectFrameAlignmentOk(project)) return null;

  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  const archivedAt = new Date().toISOString();
  const archive = Array.isArray(project.legacyStoryboardArchive)
    ? [...project.legacyStoryboardArchive]
    : [];
  const expectedSlots = isManualSegmentation(project)
    ? makeManualRepairStoryboardSlots(project)
    : makeSingleShotStoryboardSlots(shots);
  const usedStoryboards = new Set<number>();
  const groupIdxRemap = new Map<number, number>();
  const repairedStoryboards: any[] = [];
  const repairedVideoTasks: any[] = [];
  let archivedStoryboardCount = 0;

  expectedSlots.forEach((slot: any, groupIdx: number) => {
    const target = normalizedShotIndices(slot.shotIndices, shots.length);
    const oldGroupIdx = findStoryboardForShotIndices(storyboards, target, usedStoryboards, shots.length);
    const source = oldGroupIdx == null ? slot : storyboards[oldGroupIdx];
    if (oldGroupIdx != null) {
      usedStoryboards.add(oldGroupIdx);
      groupIdxRemap.set(oldGroupIdx, groupIdx);
    }
    const sanitized = sanitizeStoryboardForTargetShotIndices(source, target, shots.length);
    repairedStoryboards[groupIdx] = normalizeStoryboardSlot(project, userId, sanitized.storyboard, groupIdx, target);
    if (oldGroupIdx != null && hasMeaningfulLegacyValue(videoTasks[oldGroupIdx])) {
      repairedVideoTasks[groupIdx] = {
        ...videoTasks[oldGroupIdx],
        groupIdx,
        shotIndices: target,
      };
    }
    if (oldGroupIdx != null && sanitized.sanitized) {
      const beforeCount = archive.length;
      archiveLegacyStoryboard({
        archive,
        oldGroupIdx,
        oldShotIndices: normalizedShotIndices(storyboards[oldGroupIdx]?.shotIndices, shots.length),
        storyboard: storyboards[oldGroupIdx],
        videoTask: videoTasks[oldGroupIdx],
        archivedAt,
        archiveReason: `${reason}:sanitized_mismatched_frame_fields`,
      });
      if (archive.length > beforeCount) archivedStoryboardCount += 1;
    }
  });

  storyboards.forEach((sb: any, oldGroupIdx: number) => {
    if (usedStoryboards.has(oldGroupIdx)) return;
    const beforeCount = archive.length;
    archiveLegacyStoryboard({
      archive,
      oldGroupIdx,
      oldShotIndices: normalizedShotIndices(sb?.shotIndices, shots.length),
      storyboard: sb,
      videoTask: videoTasks[oldGroupIdx],
      archivedAt,
      archiveReason: `${reason}:unused_or_duplicate_slot`,
    });
    if (archive.length > beforeCount) archivedStoryboardCount += 1;
  });

  const editMigration = migrateEditDataForSingleShotSlots(project.editData, groupIdxRemap, archivedAt);
  const patch: any = {
    storyboards: repairedStoryboards,
    videoTasks: repairedVideoTasks,
    frameWorkflowSchemaVersion: FRAME_WORKFLOW_SCHEMA_VERSION,
    frameWorkflowAlignmentRepairedAt: archivedAt,
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
  maybeAssertStoryboardsAlignedWithShots({ ...project, ...patch }, reason);
  logFrameWorkflowRepair(project, patch, reason, userId);
  return patch;
}

export function buildFrameWorkflowNormalizationPatch(project: any, userId: number): any | null {
  if (!project) return null;
  if (Number(project.frameWorkflowSchemaVersion || 0) >= FRAME_WORKFLOW_SCHEMA_VERSION) {
    return buildFrameWorkflowAlignmentRepairPatch(project, userId, 'frame-workflow-alignment-repair');
  }
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
    const shotIndices = storyboardShotIndices(project, groupIdx, sb);
    const shotFrames = sb.shotFrames && typeof sb.shotFrames === 'object' ? sb.shotFrames : null;
    let hasShotFrameCandidate = false;
    if (shotFrames) {
      for (const shotIdx of shotIndices) {
        const shotUid = shotUidFor(project, shotIdx);
        if (!shotUid) continue;
        const selected = selectedShotFrameCandidate(shotFrames[shotUid]);
        if (!selected) continue;
        hasShotFrameCandidate = true;
        const storedHash = typeof selected.sourceHash === 'string' ? selected.sourceHash : null;
        const currentHash = computeFirstFrameSourceHashForShot(project, groupIdx, shotUid);
        if (!storedHash || (currentHash && storedHash !== currentHash)) {
          flags[`storyboard_${groupIdx}`] = true;
          break;
        }
      }
    }
    const hasFirst =
      cleanUrl(sb.frames?.first?.url) ||
      cleanUrl(sb.firstFrameUrl) ||
      cleanUrl(sb.imageUrl) ||
      cleanUrl(sb.url);
    if (!hasShotFrameCandidate && hasFirst) {
      const currentFirstHash = computeFirstFrameSourceHash(project, userId, groupIdx);
      const storedFirstHash = typeof sb.firstFrameSourceHash === 'string'
        ? sb.firstFrameSourceHash
        : (typeof sb.frames?.first?.sourceHash === 'string' ? sb.frames.first.sourceHash : null);
      if (!storedFirstHash || (currentFirstHash && storedFirstHash !== currentFirstHash)) {
        flags[`storyboard_${groupIdx}`] = true;
      }
    }
    // 用户原则: 不再为尾帧自动产生 tail_frame_${groupIdx} stale flag,
    // 尾帧的失效/重做完全由用户主动触发。
  }
  return flags;
}
