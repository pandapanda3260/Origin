export const VIDEO_REFERENCE_IMAGE_BUDGET = 4;
export const DEFAULT_SHOT_DURATION_SEC = 4;
export const DIALOGUE_WARNING_CHARS_PER_SEC = 4.5;
export const DIALOGUE_STRIP_PATTERN = /[\s「」『』""''，。！？、,.!?；;：:（）()[\]【】《》<>]/g;

export type VideoReferenceRole = 'first_frame' | 'scene' | 'character' | 'prop';

export type DialoguePolicy =
  | 'truncate_200_chars'
  | 'budget_check_only'
  | 'renderer_injects_original_text';

export type ReferenceManifestItem = {
  imageNo: number;
  role: VideoReferenceRole;
  assetId?: string;
  assetName?: string;
  label: string;
  url: string;
  localPath?: string;
  useFor: string[];
  immutable: string[];
  promptHint?: string;
  priority?: number;
  matchReason?: string;
  score?: number;
  panelInfo?: {
    panel: string;
    intent: string;
  };
};

export type DroppedReference = {
  role: Exclude<VideoReferenceRole, 'first_frame'>;
  assetName?: string;
  reason: 'image_budget_exceeded' | 'missing_file' | 'url_lookup_failed' | 'filtered_constraint';
};

export type DialogueBudgetLevel = 'ok' | 'soft_warning' | 'hard_block';

export type DialogueBudgetResult = {
  chars: number;
  durationSec: number;
  charsPerSec: number;
  level: DialogueBudgetLevel;
  message?: string;
};

export type VideoGenerationPlan = {
  version: 'video_plan_v1';
  projectId: string;
  groupIdx: number;
  shotIndices: number[];
  promptAudit: {
    sourcePrompt: {
      source: 'storyboard.videoPrompt' | 'shot.imagePrompt' | 'shot.visual';
      sanitizedFor: string[];
    };
    finalPrompt: {
      preview: string;
      hash: string;
      length: number;
    };
    dialoguePolicy: DialoguePolicy;
    dialoguePolicyNotes?: string;
  };
  references: ReferenceManifestItem[];
  droppedReferences: DroppedReference[];
  constraints: {
    hard: Array<{ id: string; text: string; source: 'project' | 'runtime' | 'sanitizer' }>;
    negative: Array<{ id: string; text: string; source: string }>;
  };
  params: {
    ratio: string;
    durationSec: number;
    plannedDurationSec?: number;
    subtitles: 'none';
    audioMode: 'seedance_dialogue_audio';
  };
  audit: {
    status?: 'submitting' | 'completed' | 'failed';
    referenceCount: number;
    dialogueChars: number;
    warnings: string[];
    failureStage?: string;
    errorMsg?: string;
  };
  modelSnapshot?: {
    modelRole: 'video';
    provider?: string;
    model?: string;
    providerTaskId?: string;
    filledAfterCall: boolean;
  };
};

export function normalizeReferenceName(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

export function cleanDialogueCharCountFromText(text: unknown): number {
  return String(text || '')
    .replace(DIALOGUE_STRIP_PATTERN, '')
    .length;
}

export function cleanDialogueCharCount(
  dialoguePairs: Array<{ speaker?: string; text?: string }> | undefined,
): number {
  if (!Array.isArray(dialoguePairs)) return 0;
  return dialoguePairs.reduce((sum, pair) => sum + cleanDialogueCharCountFromText(pair?.text), 0);
}

export function roundDurationSec(value: number): number {
  return Math.round(value * 10) / 10;
}

export function normalizeDurationSec(value: unknown, fallback = DEFAULT_SHOT_DURATION_SEC): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return roundDurationSec(Math.max(0.5, Math.min(120, n)));
}

export function plannedDurationFromShots(shots: any[] | undefined, fallback = DEFAULT_SHOT_DURATION_SEC): number {
  if (!Array.isArray(shots) || !shots.length) return fallback;
  const total = shots.reduce((sum, shot) => {
    return sum + normalizeDurationSec(shot?.duration ?? shot?.durationSec, fallback);
  }, 0);
  return roundDurationSec(total > 0 ? total : fallback);
}

export function resolveGenerationDurationSec(opts: {
  plannedDurationSec?: number;
  model?: string;
  baseUrl?: string;
  minDurationSec?: number | null;
}): number {
  const model = String(opts.model || '');
  const plannedDurationSec = normalizeDurationSec(opts.plannedDurationSec, DEFAULT_SHOT_DURATION_SEC);
  if (/^grok-video/i.test(model)) {
    const fixed = model.match(/-(\d+(?:\.\d+)?)s$/i);
    return fixed ? normalizeDurationSec(fixed[1], plannedDurationSec) : 5;
  }

  const isVolcano =
    /volces\.com|volcengine|ark\.cn-/i.test(String(opts.baseUrl || '')) ||
    /seedance|doubao/i.test(model);
  const configuredMin = Number(opts.minDurationSec);
  const minDurationSec = Number.isFinite(configuredMin) && configuredMin > 0
    ? configuredMin
    : (isVolcano ? 5 : 0);

  return roundDurationSec(Math.max(plannedDurationSec, minDurationSec || plannedDurationSec));
}

export function evaluateDialogueBudget(
  chars: number,
  durationSec: number,
): DialogueBudgetResult {
  const plannedDurationSec = normalizeDurationSec(durationSec, DEFAULT_SHOT_DURATION_SEC);
  const charsPerSec = plannedDurationSec > 0 ? chars / plannedDurationSec : chars;
  if (chars > 0 && charsPerSec > DIALOGUE_WARNING_CHARS_PER_SEC) {
    return {
      chars,
      durationSec: plannedDurationSec,
      charsPerSec,
      level: 'soft_warning',
      message:
        `本片段计划 ${plannedDurationSec}s 内有 ${chars} 字台词` +
        `（约 ${charsPerSec.toFixed(1)} 字/秒），语速可能偏快；` +
        `系统仍会按镜头表计划时长生成，不截断、不按档位压缩。`,
    };
  }
  return { chars, durationSec: plannedDurationSec, charsPerSec, level: 'ok' };
}

function formatList(values: string[]): string {
  return values.map((v) => String(v || '').trim()).filter(Boolean).join('、');
}

export function buildReferenceManifestPromptBlock(refs: ReferenceManifestItem[]): string {
  if (!Array.isArray(refs) || !refs.length) return '';
  const lines = refs
    .slice()
    .sort((a, b) => a.imageNo - b.imageNo)
    .map((ref) => [
      `Image ${ref.imageNo}: role=${ref.role} - ${ref.label}.`,
      ref.useFor.length ? `用途=${formatList(ref.useFor)}` : '',
      ref.immutable.length ? `不可改动=${formatList(ref.immutable)}` : '',
      ref.promptHint ? `注意=${ref.promptHint}` : '',
    ].filter(Boolean).join('\n'));

  return [
    '本组将会配以下参考图（按编号，视频生成阶段也会使用同一编号）：',
    '',
    ...lines,
    '',
    '写 videoPrompt 时不要重复长篇描述参考图已经锁定的字段；只写动作、情绪、人物调度、镜头运动、节奏、画面事件。引用图片时只使用 Image 1 / Image 2 这类编号。',
  ].join('\n');
}

export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
