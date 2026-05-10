import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveLocalImagePath } from './image-gen';

export const FRAME_WORKFLOW_SCHEMA_VERSION = 2;
export type TailFrameIntent = 'none' | 'requested';
export type TailFrameReferenceStatus = 'ready' | 'unresolvable' | 'missing';

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

export function storyboardShotIndices(project: any, groupIdx: number, storyboard?: any): number[] {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const raw = Array.isArray(storyboard?.shotIndices) && storyboard.shotIndices.length
    ? storyboard.shotIndices
    : [groupIdx];
  const out = raw
    .map((v: any) => Number(v))
    .filter((v: number) => Number.isInteger(v) && v >= 0 && v < shots.length);
  return out.length ? out : [groupIdx].filter((v) => v >= 0 && v < shots.length);
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
  const shots = shotIndices.map((idx) => project.shots?.[idx]).filter(Boolean);
  return hashValue({
    frameType: 'first_frame',
    shotIndices,
    shots,
    styleBible: project?.styleBible || {},
  });
}

export function computeTailFrameSourceHash(project: any, userId: number, groupIdx: number): string | null {
  const sb = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] : null;
  if (!sb) return null;
  const firstFrameUrl =
    cleanUrl(sb.firstFrameUrl) ||
    cleanUrl(sb.frames?.first?.url) ||
    cleanUrl(sb.firstFrame?.currentUrl);
  const firstFrameContentHash = imageContentHashForUrl(firstFrameUrl, userId);
  if (!firstFrameContentHash) return null;
  const shotIndices = storyboardShotIndices(project, groupIdx, sb);
  const shots = shotIndices.map((idx) => project.shots?.[idx]).filter(Boolean);
  return hashValue({
    frameType: 'tail_frame',
    firstFrameContentHash,
    shotIndices,
    shots,
    styleBible: project?.styleBible || {},
  });
}

function tailFrameUrl(sb: any): string {
  return cleanUrl(sb?.frames?.tail?.url) || cleanUrl(sb?.tailFrameUrl);
}

function validIntent(value: any): TailFrameIntent | null {
  return value === 'requested' || value === 'none' ? value : null;
}

export function buildFrameWorkflowNormalizationPatch(project: any, userId: number): any | null {
  if (!project || Number(project.frameWorkflowSchemaVersion || 0) >= FRAME_WORKFLOW_SCHEMA_VERSION) return null;
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const normalizedStoryboards = storyboards.map((sb: any, groupIdx: number) => {
    const url = tailFrameUrl(sb);
    const intent = validIntent(sb?.tailFrameIntent) || (url ? 'requested' : 'none');
    const localPath = url ? resolveProtectedImageFilePath(url, userId) : null;
    const referenceStatus: TailFrameReferenceStatus =
      intent === 'requested'
        ? (url ? (localPath ? 'ready' : 'unresolvable') : 'missing')
        : 'missing';
    const currentShotIndices = storyboardShotIndices(project, groupIdx, sb);
    const storedShotIndices = Array.isArray(sb?.frames?.tail?.shotIndices)
      ? sb.frames.tail.shotIndices.map((v: any) => Number(v)).filter((v: number) => Number.isInteger(v))
      : [];
    const canTrustExistingTail =
      intent === 'requested' &&
      referenceStatus === 'ready' &&
      storedShotIndices.length > 0 &&
      strictArrayEqual(storedShotIndices, currentShotIndices);
    const sourceHash =
      typeof sb?.tailFrameSourceHash === 'string'
        ? sb.tailFrameSourceHash
        : (canTrustExistingTail ? computeTailFrameSourceHash(project, userId, groupIdx) : null);
    const updatedAt =
      sb?.tailFrameIntentUpdatedAt ||
      sb?.frames?.tail?.generatedAt ||
      sb?.tailFrameGeneratedAt ||
      new Date().toISOString();

    // v1 → v2: any project with an existing first frame but no
    // firstFrameSourceHash gets the current hash written as the new baseline
    // ("lenient migration" — we do not retroactively flag historical drift,
    //  only track changes starting from the migration moment).
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
            : (hasExistingFirstFrame ? computeFirstFrameSourceHash(project, userId, groupIdx) : null));

    const frames = sb?.frames && typeof sb.frames === 'object' ? { ...sb.frames } : {};
    if (frames.tail && typeof frames.tail === 'object') {
      frames.tail = {
        ...frames.tail,
        referenceStatus,
        shotIndices: storedShotIndices.length ? storedShotIndices : undefined,
        sourceHash,
      };
    }
    if (frames.first && typeof frames.first === 'object' && firstFrameSourceHash) {
      frames.first = {
        ...frames.first,
        sourceHash: typeof frames.first.sourceHash === 'string' ? frames.first.sourceHash : firstFrameSourceHash,
      };
    }

    return {
      ...sb,
      frames,
      tailFrameIntent: intent,
      tailFrameIntentUpdatedAt: updatedAt,
      tailFrameSourceHash: sourceHash,
      tailFrameReferenceStatus: referenceStatus,
      firstFrameSourceHash,
    };
  });

  return {
    storyboards: normalizedStoryboards,
    frameWorkflowSchemaVersion: FRAME_WORKFLOW_SCHEMA_VERSION,
  };
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
