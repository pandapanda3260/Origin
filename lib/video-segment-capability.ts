import type { SegmentPlanOptions } from './segment-planning';
import type { VideoModelCapability } from './video-provider-capabilities';

export type AutoSegmentPlanOptions = Required<Pick<SegmentPlanOptions, 'targetMinSec' | 'targetMaxSec' | 'hardMaxSec'>>;

export type AutoSegmentPlanSnapshot = {
  version: 1;
  segmentationMode: 'auto';
  modelRole: 'video';
  modelId: string;
  options: AutoSegmentPlanOptions;
  createdAt: string;
};

function positiveInt(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function segmentPlanOptionsFromCapability(capability: VideoModelCapability): AutoSegmentPlanOptions {
  const targetMinSec = positiveInt(capability.segmentTargetMinSec, 4);
  const targetMaxSec = Math.max(targetMinSec, positiveInt(capability.segmentTargetMaxSec, 15));
  const hardMaxSec = Math.max(targetMaxSec, positiveInt(capability.maxSingleGenSec, targetMaxSec));
  return { targetMinSec, targetMaxSec, hardMaxSec };
}

export function normalizeAutoSegmentPlanOptions(value: unknown): AutoSegmentPlanOptions {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const targetMinSec = positiveInt(raw.targetMinSec, 4);
  const targetMaxSec = Math.max(targetMinSec, positiveInt(raw.targetMaxSec, 15));
  const hardMaxSec = Math.max(targetMaxSec, positiveInt(raw.hardMaxSec, targetMaxSec));
  return { targetMinSec, targetMaxSec, hardMaxSec };
}

export function buildAutoSegmentPlanSnapshot(args: {
  modelId?: string | null;
  capability: VideoModelCapability;
  createdAt: string;
}): AutoSegmentPlanSnapshot {
  return {
    version: 1,
    segmentationMode: 'auto',
    modelRole: 'video',
    modelId: String(args.modelId || '').trim(),
    options: segmentPlanOptionsFromCapability(args.capability),
    createdAt: args.createdAt,
  };
}
