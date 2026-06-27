import { storyboardShotIndices } from './frame-workflow-state';

export const SHOT_BINDING_BATCH_TYPES = [
  'storyboard_prompts',
  'storyboard_images',
  'tail_frame_images',
  'video_prompts',
  'video_segments',
  'videos',
] as const;

export type ExpectedShotBinding = {
  version: 1;
  groupIdx: number;
  shotIndicesAtStart: number[];
  shotUidsAtStart: string[];
  primaryShotUid: string;
};

export type WriteGroupSlotResult<T = unknown> =
  | { status: 'applied'; shotIndices: number[]; firstShot: any; value?: T }
  | { status: 'skipped'; reason: string }
  | { status: 'aborted'; reason: string };

function cleanText(value: any): string {
  return String(value ?? '').trim();
}

function targetGroupIdx(target: any): number | null {
  const raw = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function explicitShotIndicesFromTarget(target: any): number[] | undefined {
  if (!Array.isArray(target?.shotIndices)) return undefined;
  const out = target.shotIndices
    .map((idx: any) => Number(idx))
    .filter((idx: number) => Number.isInteger(idx) && idx >= 0);
  return out.length ? out : undefined;
}

function shotUidFor(project: any, shotIdx: number): string {
  const shot = Array.isArray(project?.shots) ? project.shots[shotIdx] : null;
  return cleanText(shot?.shotUid ?? shot?.shot_uid);
}

export function shouldAttachExpectedShotBinding(batchType: string): boolean {
  return (SHOT_BINDING_BATCH_TYPES as readonly string[]).includes(String(batchType || ''));
}

export function buildExpectedShotBinding(project: any, groupIdx: number, target?: any): ExpectedShotBinding | null {
  if (!Number.isInteger(groupIdx) || groupIdx < 0) return null;
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const storyboard = storyboards[groupIdx] || {};
  let shotIndices: number[] = [];
  try {
    shotIndices = storyboardShotIndices(project, groupIdx, storyboard, {
      mode: 'single-shot-strict',
      explicitShotIndices: explicitShotIndicesFromTarget(target),
    });
  } catch {
    return null;
  }
  if (!shotIndices.length) return null;
  const shotUids = shotIndices.map((idx) => shotUidFor(project, idx));
  if (shotUids.some((uid) => !uid)) return null;
  return {
    version: 1,
    groupIdx,
    shotIndicesAtStart: shotIndices,
    shotUidsAtStart: shotUids,
    primaryShotUid: shotUids[0],
  };
}

export function attachExpectedShotBindingsToTargets(project: any, batchType: string, targets: any[]): any[] {
  if (!shouldAttachExpectedShotBinding(batchType)) return targets;
  return (Array.isArray(targets) ? targets : []).map((target) => {
    const groupIdx = targetGroupIdx(target);
    if (groupIdx == null) return target;
    const expectedShotBinding = buildExpectedShotBinding(project, groupIdx, target);
    return expectedShotBinding ? { ...target, expectedShotBinding } : target;
  });
}

export function readExpectedShotBinding(target: any): ExpectedShotBinding | null {
  const binding = target?.expectedShotBinding;
  if (!binding || typeof binding !== 'object') return null;
  const groupIdx = Number(binding.groupIdx);
  const shotIndicesAtStart = Array.isArray(binding.shotIndicesAtStart)
    ? binding.shotIndicesAtStart.map((idx: any) => Number(idx)).filter((idx: number) => Number.isInteger(idx) && idx >= 0)
    : [];
  const shotUidsAtStart = Array.isArray(binding.shotUidsAtStart)
    ? binding.shotUidsAtStart.map(cleanText).filter(Boolean)
    : [];
  const primaryShotUid = cleanText(binding.primaryShotUid);
  if (!Number.isInteger(groupIdx) || groupIdx < 0 || !shotIndicesAtStart.length || !shotUidsAtStart.length || !primaryShotUid) {
    return null;
  }
  return {
    version: 1,
    groupIdx,
    shotIndicesAtStart,
    shotUidsAtStart,
    primaryShotUid,
  };
}

export function writeGroupSlot<T>(args: {
  fresh: any;
  groupIdx: number;
  storyboard?: any;
  explicitShotIndices?: any;
  expectedBinding?: ExpectedShotBinding | null;
  mismatchPolicy: 'skip' | 'abortPatch';
  mutator: (ctx: { shotIndices: number[]; firstShot: any }) => T;
}): WriteGroupSlotResult<T> {
  const groupIdx = Number(args.groupIdx);
  const shots = Array.isArray(args.fresh?.shots) ? args.fresh.shots : [];
  if (!Number.isInteger(groupIdx) || groupIdx < 0 || groupIdx >= shots.length) {
    return args.mismatchPolicy === 'skip'
      ? { status: 'skipped', reason: 'group_idx_out_of_bounds' }
      : { status: 'aborted', reason: 'group_idx_out_of_bounds' };
  }

  let shotIndices: number[];
  try {
    shotIndices = storyboardShotIndices(args.fresh, groupIdx, args.storyboard, {
      mode: 'single-shot-strict',
      explicitShotIndices: args.explicitShotIndices,
    });
  } catch {
    return args.mismatchPolicy === 'skip'
      ? { status: 'skipped', reason: 'invalid_shot_indices' }
      : { status: 'aborted', reason: 'invalid_shot_indices' };
  }

  const expected = args.expectedBinding || null;
  if (expected) {
    const currentUids = shotIndices.map((idx) => shotUidFor(args.fresh, idx));
    const sameLength = currentUids.length === expected.shotUidsAtStart.length;
    const sameUids = sameLength && currentUids.every((uid, idx) => uid && uid === expected.shotUidsAtStart[idx]);
    const samePrimary = currentUids[0] && currentUids[0] === expected.primaryShotUid;
    if (!sameUids || !samePrimary) {
      return args.mismatchPolicy === 'skip'
        ? { status: 'skipped', reason: 'shot_binding_mismatch' }
        : { status: 'aborted', reason: 'shot_binding_mismatch' };
    }
  }

  const firstShot = shots[shotIndices[0]];
  const value = args.mutator({ shotIndices, firstShot });
  return { status: 'applied', shotIndices, firstShot, value };
}
