export type TailFrameDependency = 'requires_first_frame' | 'independent';

function clean(value: unknown): string {
  return String(value || '').trim();
}

function normalizeExplicitDependency(value: unknown): TailFrameDependency | null {
  const raw = clean(value);
  if (
    raw === 'requires_first_frame' ||
    raw === 'first_frame' ||
    raw === 'continuity' ||
    raw === 'continuous'
  ) {
    return 'requires_first_frame';
  }
  if (
    raw === 'independent' ||
    raw === 'standalone' ||
    raw === 'script_only' ||
    raw === 'asset_driven'
  ) {
    return 'independent';
  }
  return null;
}

function signalScore(signals: any, key: string): number {
  const n = Number(signals?.[key]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

export function inferTailFrameDependencyForShots(
  shots: any[],
  storyboard?: any,
): TailFrameDependency {
  const explicitStoryboard = normalizeExplicitDependency(
    storyboard?.tailFrameDependency ||
      storyboard?.tailFrameDependencyMode ||
      storyboard?.frames?.tail?.dependency ||
      storyboard?.tailFramePlanSummary?.dependency,
  );
  if (explicitStoryboard) return explicitStoryboard;

  const list = Array.isArray(shots) ? shots.filter(Boolean) : [];
  for (const shot of list) {
    const explicitShot = normalizeExplicitDependency(
      shot?.tailFrameDependency ||
        shot?.tailFrameDependencyMode ||
        shot?.tailFrameSignals?.dependency ||
        shot?.tailFrameSignals?.dependencyMode,
    );
    if (explicitShot) return explicitShot;
  }

  let continuity = 0;
  let actionLanding = 0;
  let visualTransform = 0;
  let emotionPeak = 0;
  for (const shot of list) {
    const signals = shot?.tailFrameSignals && typeof shot.tailFrameSignals === 'object'
      ? shot.tailFrameSignals
      : {};
    continuity = Math.max(continuity, signalScore(signals, 'continuityNeed'));
    actionLanding = Math.max(actionLanding, signalScore(signals, 'actionLandingNeed'));
    visualTransform = Math.max(visualTransform, signalScore(signals, 'visualTransformationNeed'));
    emotionPeak = Math.max(emotionPeak, signalScore(signals, 'emotionPeakNeed'));
  }

  if (
    continuity >= 3 ||
    actionLanding >= 3 ||
    visualTransform >= 3 ||
    emotionPeak >= 4
  ) {
    return 'requires_first_frame';
  }

  return 'independent';
}

