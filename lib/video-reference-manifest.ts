import type { VideoSubmitMode } from './feature-flags';
import type { VideoPayloadDecisionReason, VideoPayloadMode } from './video-payload-decision';

export const VIDEO_REFERENCE_IMAGE_BUDGET = 9;
export const DEFAULT_SHOT_DURATION_SEC = 4;
export const DIALOGUE_WARNING_CHARS_PER_SEC = 4.5;
export const DIALOGUE_STRIP_PATTERN = /[\s「」『』""''，。！？、,.!?；;：:（）()[\]【】《》<>]/g;

export type VideoReferenceRole = 'first_frame' | 'target_end' | 'scene' | 'character' | 'prop';

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
  referenceBrief?: string;
};

export type DroppedReference = {
  role: Exclude<VideoReferenceRole, 'first_frame'>;
  assetName?: string;
  reason:
    | 'image_budget_exceeded'
    | 'asset_missing'
    | 'missing_file'
    | 'url_lookup_failed'
    | 'filtered_constraint';
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
  submitMode?: VideoSubmitMode;
  payloadMode?: VideoPayloadMode;
  modeReason?: VideoPayloadDecisionReason | string;
  plannedReferenceRoles?: VideoReferenceRole[];
  planAuditPayloadModeMismatch?: boolean;
  tempoBudget?: any;
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
    resolution?: string;
    durationSec: number;
    plannedDurationSec?: number;
    subtitles: 'none';
    audioMode: 'seedance_dialogue_audio' | 'none';
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

export function plannedTimelineStartFromGroups(groups: any[][] | undefined, groupIdx: number, fallback = DEFAULT_SHOT_DURATION_SEC): number {
  const end = Math.max(0, Math.floor(Number(groupIdx) || 0));
  if (!Array.isArray(groups) || !groups.length || end <= 0) return 0;
  let total = 0;
  for (let i = 0; i < Math.min(end, groups.length); i += 1) {
    const group = groups[i];
    if (Array.isArray(group) && group.length) total += plannedDurationFromShots(group, fallback);
  }
  return roundDurationSec(total);
}

export function plannedTimelineGroupsFromProject(project: any): any[][] {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const count = Math.max(storyboards.length, shots.length);
  const groups: any[][] = [];
  for (let idx = 0; idx < count; idx += 1) {
    const sb = storyboards[idx] || {};
    const rawIndices = Array.isArray(sb?.shotIndices) && sb.shotIndices.length ? sb.shotIndices : [idx];
    const indices = rawIndices
      .map((value: any) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value >= 0);
    const groupShots = indices.map((shotIdx: number) => shots[shotIdx]).filter(Boolean);
    groups.push(groupShots.length ? groupShots : (shots[idx] ? [shots[idx]] : []));
  }
  return groups;
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
  // Seedance/volcano 生成下限 = 4s（Seedance 2.0 真实下限）。
  // 必须与 lib/segment-planning.ts 的 SEGMENT_MIN_DURATION_SEC(=4) 对齐：
  // 否则 4s 镜头在分组阶段被当作"可单飞"，生成时却被顶到 5s，破坏快节奏。
  // 仍可用 env VIDEO_MIN_DURATION_SECONDS 覆盖（如实测某模型需 5，设回 5 即可）。
  const minDurationSec = Number.isFinite(configuredMin) && configuredMin > 0
    ? configuredMin
    : (isVolcano ? 4 : 0);

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

function compactBriefText(value: unknown, fallback = ''): string {
  return String(value ?? fallback)
    .replace(/\s+/g, ' ')
    .trim();
}

function referenceDisplayName(ref: Pick<ReferenceManifestItem, 'assetName' | 'label' | 'role'>): string {
  const fallback = ref.role === 'first_frame'
    ? '片段首帧'
    : ref.role === 'target_end'
      ? '片段尾帧'
      : ref.role === 'scene'
        ? '场景参考'
        : ref.role === 'prop'
          ? '道具参考'
          : '角色参考';
  return compactBriefText(ref.assetName || ref.label || fallback, fallback).slice(0, 80);
}

function sameCharacterRefs(ref: ReferenceManifestItem, refs: ReferenceManifestItem[]): ReferenceManifestItem[] {
  const name = compactBriefText(ref.assetName || ref.label);
  if (!name) return [];
  return refs.filter((item) =>
    item.role === 'character' &&
    compactBriefText(item.assetName || item.label) === name
  );
}

function pairedPanelImageNo(
  ref: ReferenceManifestItem,
  refs: ReferenceManifestItem[],
  panel: string,
): number | null {
  const hit = sameCharacterRefs(ref, refs).find((item) => item.panelInfo?.panel === panel);
  return hit && Number.isInteger(Number(hit.imageNo)) ? Number(hit.imageNo) : null;
}

export function buildReferenceBriefLine(ref: ReferenceManifestItem, refs: ReferenceManifestItem[] = [ref]): string {
  const imageNo = Number(ref.imageNo);
  const imageLabel = Number.isInteger(imageNo) && imageNo > 0 ? `Image ${imageNo}` : 'Image';
  const role = ref.role;
  const name = referenceDisplayName(ref);

  if (role === 'first_frame') {
    return `${imageLabel} | first_frame | ${name} | 用于起幅构图、站位、光线和色调；角色脸和服装以角色参考图为准。`;
  }
  if (role === 'target_end') {
    return `${imageLabel} | target_end | ${name} | 用于结尾落点、姿态和画面收束；过程要自然抵达，禁止硬切。`;
  }
  if (role === 'scene') {
    return `${imageLabel} | scene | ${name} | 用于环境布局、空间结构、材质和氛围；不锁人物外貌。`;
  }
  if (role === 'prop') {
    return `${imageLabel} | prop | ${name} | 用于外形、材质、尺度和识别符号；不当角色或场景。`;
  }

  const panel = compactBriefText(ref.panelInfo?.panel);
  if (panel === 'sheet') {
    const headshotNo = pairedPanelImageNo(ref, refs, 'headshot');
    const faceRule = headshotNo ? `近景脸以 Image ${headshotNo} 为主。` : '近景脸以独立脸部参考或本图左侧脸部为准。';
    return `${imageLabel} | character | ${name} sheet | 同一角色设定图：左侧脸部特写，右侧正面/侧面/背面全身或半身；四个视图都是${name}，不是四个人，不是分镜，不作为构图。用于锁定发型、服装、体型和正侧背一致性；${faceRule}`;
  }
  if (panel === 'headshot') {
    const sheetNo = pairedPanelImageNo(ref, refs, 'sheet');
    const sheetRule = sheetNo ? `与 Image ${sheetNo} 是同一人。` : '与同名角色设定图是同一人。';
    return `${imageLabel} | character | ${name} headshot | ${name}脸部近景主参考；${sheetRule}用于锁定脸型、五官、眼神和近景表情；不改变角色设定图的服装和体型。`;
  }
  if (panel === 'front') {
    return `${imageLabel} | character | ${name} front | ${name}正面角色参考；用于锁定正面服装、体型、发型和主要识别特征，不作为画面构图。`;
  }
  if (panel === 'side') {
    return `${imageLabel} | character | ${name} side | ${name}侧面角色参考；用于锁定侧脸/侧身轮廓、服装侧面和体型，不作为画面构图。`;
  }
  if (panel === 'back') {
    return `${imageLabel} | character | ${name} back | ${name}背面角色参考；用于锁定背面轮廓、发型背面和服装背面，不作为画面构图。`;
  }

  const hint = compactBriefText(ref.promptHint);
  return `${imageLabel} | character | ${name} | 用于锁定角色脸部、发型、服装、体型和身份一致性；不作为画面构图。${hint ? ` ${hint}` : ''}`;
}

export function buildReferenceManifestPromptBlock(refs: ReferenceManifestItem[]): string {
  if (!Array.isArray(refs) || !refs.length) return '';
  const orderedRefs = refs
    .slice()
    .sort((a, b) => a.imageNo - b.imageNo);
  const lines = orderedRefs.map((ref) => ref.referenceBrief || buildReferenceBriefLine(ref, orderedRefs));

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
