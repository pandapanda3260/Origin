export type TailFrameSignals = {
  actionLandingNeed: number;
  visualTransformationNeed: number;
  revealNeed: number;
  endingCompositionNeed: number;
  emotionPeakNeed: number;
  isSimpleStaticDialogue: boolean;
};

export type TailFrameSignalFallback = {
  shotType: string;
  camera: string;
  dialogue: string;
  durationSec: number;
};

export function clampSignal(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(5, Math.round(n)));
}

export function normalizeTailFrameSignals(
  shot: any,
  fallback: TailFrameSignalFallback,
): TailFrameSignals {
  const raw = shot?.tailFrameSignals && typeof shot.tailFrameSignals === 'object'
    ? shot.tailFrameSignals
    : {};
  const shotType = fallback.shotType;
  const camera = fallback.camera;
  const dialogue = fallback.dialogue || '';
  const dialogueChars = dialogue.replace(/[：:\s「」『』""''，。！？、,.!?；;：:（）()[\]【】《》<>]/g, '').length;
  const deterministicSimpleDialogue =
    ['近景', '中近景', '特写', '大特写'].includes(shotType) &&
    /固定/.test(camera) &&
    dialogueChars > 40;

  return {
    actionLandingNeed: clampSignal(raw.actionLandingNeed),
    visualTransformationNeed: clampSignal(raw.visualTransformationNeed),
    revealNeed: clampSignal(raw.revealNeed),
    endingCompositionNeed: clampSignal(raw.endingCompositionNeed),
    emotionPeakNeed: clampSignal(raw.emotionPeakNeed),
    isSimpleStaticDialogue:
      typeof raw.isSimpleStaticDialogue === 'boolean'
        ? raw.isSimpleStaticDialogue
        : deterministicSimpleDialogue,
  };
}
