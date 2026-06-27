import { findActiveBatchForType } from './batches';

export const SHOT_STRUCTURE_LOCK_BATCH_TYPES = [
  'shots',
  'storyboard_prompts',
  'storyboard_images',
  'tail_frame_images',
  'video_prompts',
  'video_segments',
  'videos',
] as const;

function cleanText(value: any): string {
  return String(value ?? '').trim();
}

function hasOwn(obj: any, key: string): boolean {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function shotUidList(project: any): string[] {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  return shots.map((shot: any) => cleanText(shot?.shotUid ?? shot?.shot_uid));
}

function shotUidListChanged(current: any, next: any): boolean {
  const before = shotUidList(current);
  const after = shotUidList(next);
  if (before.length !== after.length) return true;
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) return true;
  }
  return false;
}

function normalizeShotIndices(value: any): number[] {
  return Array.isArray(value)
    ? value
        .map((idx: any) => Number(idx))
        .filter((idx: number) => Number.isInteger(idx) && idx >= 0)
    : [];
}

function storyboardGroupSignature(project: any): string {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  return JSON.stringify(storyboards.map((storyboard: any) => normalizeShotIndices(storyboard?.shotIndices)));
}

export function hasShotStructureChange(current: any, patch: any): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const next = { ...(current || {}), ...patch };
  if (hasOwn(patch, 'shots') && shotUidListChanged(current, next)) return true;
  if (hasOwn(patch, 'storyboards') && storyboardGroupSignature(current) !== storyboardGroupSignature(next)) return true;
  if (hasOwn(patch, 'segmentationMode') && cleanText(current?.segmentationMode || 'auto') !== cleanText(next?.segmentationMode || 'auto')) {
    return true;
  }
  return false;
}

export function findShotStructureLock(opts: {
  ownerId: number;
  projectId: string;
}): { batchType: string; batchId: string; total: number } | null {
  for (const batchType of SHOT_STRUCTURE_LOCK_BATCH_TYPES) {
    const active = findActiveBatchForType({
      ownerId: opts.ownerId,
      projectId: opts.projectId,
      batchType,
    });
    if (active) return { batchType, batchId: active.batchId, total: active.total };
  }
  return null;
}
