export type VideoAspectRatioInput = '16:9' | '9:16' | '1:1' | '21:9' | '4:3' | '3:4';
export type NormalizedVideoAspectRatio = '16:9' | '9:16' | '1:1';
export type VideoSize = '1080x1920' | '1920x1080' | '1024x1024';

const DEFAULT_VIDEO_ASPECT_RATIO: VideoAspectRatioInput = '9:16';
const VIDEO_ASPECT_RATIOS = new Set<VideoAspectRatioInput>(['16:9', '9:16', '1:1', '21:9', '4:3', '3:4']);

function parseVideoAspectRatio(value: unknown): VideoAspectRatioInput | null {
  const ratio = String(value || '').trim();
  return VIDEO_ASPECT_RATIOS.has(ratio as VideoAspectRatioInput) ? (ratio as VideoAspectRatioInput) : null;
}

export function resolveVideoAspectRatio(project: any, explicitRatio?: unknown): VideoAspectRatioInput {
  const candidates = [
    explicitRatio,
    project?.styleOptions?.aspectRatio,
    project?.styleBible?.aspectRatio,
    project?.videoAspectRatio,
    DEFAULT_VIDEO_ASPECT_RATIO,
  ];

  for (const candidate of candidates) {
    const ratio = parseVideoAspectRatio(candidate);
    if (ratio) return ratio;
  }

  return DEFAULT_VIDEO_ASPECT_RATIO;
}

export function normalizeVideoAspectRatio(ratio?: unknown): {
  ratio: NormalizedVideoAspectRatio;
  size: VideoSize;
  width: number;
  height: number;
} {
  const value = parseVideoAspectRatio(ratio);

  if (value === '16:9' || value === '4:3' || value === '21:9') {
    return { ratio: '16:9', size: '1920x1080', width: 1920, height: 1080 };
  }

  if (value === '1:1') {
    return { ratio: '1:1', size: '1024x1024', width: 1024, height: 1024 };
  }

  return { ratio: '9:16', size: '1080x1920', width: 1080, height: 1920 };
}
