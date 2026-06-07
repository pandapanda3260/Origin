import type { TailFrameSignals } from './shot-tail-frame-signals';
import { normalizeTailFrameSignals } from './shot-tail-frame-signals';
import { resolveShotFieldsForPrompt } from './shot-plan-normalize';
import type { VideoPayloadDecisionReason, VideoPayloadMode } from './video-payload-decision';
import type { VideoPromptShotPlanItem } from './video-prompt-runtime';
import {
  cleanDialogueCharCount,
  normalizeDurationSec,
  plannedDurationFromShots,
  roundDurationSec,
} from './video-reference-manifest';

export const TAIL_RUSHED_WARNING_KEY = 'tail_rushed';
export const TAIL_RUSHED_WARNING_MESSAGE = '片段结尾仓促，请在镜头页增加对应片段的视频时长';
export const SEGMENT_TEMPO_MAX_DURATION_SEC = 15;

export type SegmentDialoguePair = { speaker: string; text: string };

export type SegmentShotPlanItem = VideoPromptShotPlanItem & {
  emotion?: string;
  tailFrameSignals?: TailFrameSignals;
  dialogueChars?: number;
  hasDialogue?: boolean;
};

export type SegmentTempoBudget = {
  version: 'segment_tempo_budget_v1';
  dialogueChars: number;
  plannedDurationSec: number;
  requestedDurationSec: number;
  requiredRawSec: number;
  requiredDurationSec: number;
  safeDurationSec: number;
  maxDurationSec: number;
  exceedsMaxDuration: boolean;
  charsPerSecond: number;
  speechSec: number;
  openingReserveSec: number;
  endingReserveSec: number;
  slowMarkerCount: number;
  slowMarkers: string[];
  payloadMode?: string;
  payloadModeReason?: string;
};

export type SegmentTempoBudgetInput = {
  dialoguePairs?: SegmentDialoguePair[];
  plannedDurationSec?: number;
  durationSec?: number;
  shotPlan?: SegmentShotPlanItem[];
  payloadMode?: VideoPayloadMode | string;
  payloadModeReason?: VideoPayloadDecisionReason | string;
  tailReferenceStatus?: string;
  maxDurationSec?: number;
};

function uniquePush(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

export function parseDialogue(raw: string): SegmentDialoguePair[] {
  if (!raw) return [];
  const speakerRe = /([^：:\s“”‘’"'「」『』]{1,24})[：:]/g;
  const anchors: Array<{ speaker: string; textStart: number; anchorStart: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = speakerRe.exec(raw)) !== null) {
    anchors.push({
      speaker: match[1].trim(),
      textStart: match.index + match[0].length,
      anchorStart: match.index,
    });
  }
  if (anchors.length === 0) return [{ speaker: '', text: raw.trim() }].filter((pair) => !!pair.text);

  const pairs: SegmentDialoguePair[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const cur = anchors[i];
    const nextStart = i + 1 < anchors.length ? anchors[i + 1].anchorStart : raw.length;
    const text = raw
      .slice(cur.textStart, nextStart)
      .trim()
      .replace(/^[「『“”‘’"']+/, '')
      .replace(/[」』“”‘’"']+$/, '')
      .trim();
    if (text) pairs.push({ speaker: cur.speaker, text });
  }
  return pairs;
}

export function buildSegmentShotPlan(shots: any[], groupShotIndices: number[]): SegmentShotPlanItem[] {
  return groupShotIndices.map((shotIdx) => {
    const shot = shots[shotIdx] || {};
    const fields = resolveShotFieldsForPrompt(shot);
    const rawDuration = Number(shot.duration ?? shot.durationSec ?? 4);
    const durationSec = Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration * 10) / 10
      : 4;
    const tailFrameSignals = normalizeTailFrameSignals(shot, {
      shotType: fields.shotType,
      camera: fields.camera,
      dialogue: String(shot.dialogue || shot.scriptRef || ''),
      durationSec,
    });
    const rawDialogue = String(shot.dialogue || shot.scriptRef || '').trim();
    const dialoguePairs = rawDialogue && rawDialogue !== '——' && rawDialogue !== '-' && rawDialogue !== '无'
      ? parseDialogue(rawDialogue)
      : [];
    const dialogueChars = cleanDialogueCharCount(dialoguePairs);
    return {
      idx: shotIdx + 1,
      durationSec,
      pace: shot.pace || shot.narrativePace || 'normal',
      shotType: fields.shotType,
      angle: fields.angle,
      lens: fields.lens,
      focus: fields.focus,
      light: fields.light,
      composition: fields.composition,
      camera: fields.camera,
      visual: shot.visual || shot.description || '',
      emotion: shot.emotion || undefined,
      tailFrameSignals,
      dialogueChars,
      hasDialogue: dialogueChars > 0,
    };
  });
}

export function collectSegmentDialoguePairs(shots: any[], groupShotIndices: number[]): SegmentDialoguePair[] {
  const pairs: SegmentDialoguePair[] = [];
  for (const shotIdx of groupShotIndices) {
    const shot = shots[shotIdx];
    if (!shot) continue;
    const raw = String(shot.dialogue || shot.scriptRef || '').trim();
    if (!raw || raw === '——' || raw === '-' || raw === '无') continue;
    pairs.push(...parseDialogue(raw));
  }
  return pairs;
}

export function plannedDurationForSegment(shots: any[], groupShotIndices: number[]): number {
  return plannedDurationFromShots(groupShotIndices.map((shotIdx) => shots[shotIdx]).filter(Boolean));
}

export function buildEffectiveShotPlanForDuration(
  shotPlan: SegmentShotPlanItem[],
  durationSec: number,
): SegmentShotPlanItem[] {
  if (!Array.isArray(shotPlan) || !shotPlan.length) return shotPlan;
  const safeDurationSec = normalizeDurationSec(durationSec, 4);
  if (shotPlan.length === 1) return [{ ...shotPlan[0], durationSec: safeDurationSec }];

  const currentTotal = shotPlan.reduce((sum, item) => sum + normalizeDurationSec(item.durationSec, 4), 0);
  const extraSec = roundDurationSec(safeDurationSec - currentTotal);
  if (extraSec <= 0) return shotPlan.map((item) => ({ ...item }));

  const extraTenths = Math.round(extraSec * 10);
  const weights = shotPlan.map((item) => {
    const signals = item.tailFrameSignals;
    const tailLandingNeed =
      Number(signals?.endingCompositionNeed) >= 3 ||
      Number(signals?.actionLandingNeed) >= 3 ||
      Number(signals?.revealNeed) >= 3 ||
      Number(signals?.emotionPeakNeed) >= 3;
    let weight = 0;
    if (Number(item.dialogueChars) > 0 || item.hasDialogue) weight += 4;
    if (/slow|慢/.test(String(item.pace || '').toLowerCase())) weight += 3;
    if (/resolution|falling|收束|低落|沉静/.test(String(item.emotion || '').toLowerCase())) weight += 2;
    if (tailLandingNeed) weight += 2;
    return weight;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || extraTenths <= 0) {
    return shotPlan.map((item) => ({ ...item }));
  }

  const shares = weights.map((weight, index) => {
    const raw = (weight / totalWeight) * extraTenths;
    return {
      index,
      tenths: Math.floor(raw),
      remainder: raw - Math.floor(raw),
    };
  });
  let assignedTenths = shares.reduce((sum, share) => sum + share.tenths, 0);
  shares
    .sort((a, b) => (b.remainder - a.remainder) || (b.index - a.index))
    .forEach((share) => {
      if (assignedTenths >= extraTenths) return;
      share.tenths += 1;
      assignedTenths += 1;
    });
  const extraByIndex = new Map(shares.map((share) => [share.index, share.tenths]));
  return shotPlan.map((item, index) => ({
    ...item,
    durationSec: roundDurationSec(normalizeDurationSec(item.durationSec, 4) + (extraByIndex.get(index) || 0) / 10),
  }));
}

function detectSlowMarkers(input: SegmentTempoBudgetInput): string[] {
  const markers: string[] = [];
  const shotPlan = Array.isArray(input.shotPlan) ? input.shotPlan : [];
  const dialoguePairs = Array.isArray(input.dialoguePairs) ? input.dialoguePairs : [];
  const dialogueText = dialoguePairs.map((pair) => `${pair.speaker || ''} ${pair.text || ''}`).join('\n');

  if (shotPlan.some((item) => /slow|慢/.test(String(item.pace || '').toLowerCase()))) {
    uniquePush(markers, 'pace_slow');
  }
  if (shotPlan.some((item) => /resolution|falling|收束|低落|沉静/.test(String(item.emotion || '').toLowerCase()))) {
    uniquePush(markers, 'emotion_resolution');
  }
  if (/低声|咬牙|冷冷|轻声|停顿|旁白/.test(dialogueText)) {
    uniquePush(markers, 'dialogue_slow_semantics');
  }
  if (/……|\.{3,}|…/.test(dialogueText)) {
    uniquePush(markers, 'ellipsis_pause');
  }
  if (shotPlan.some((item) => {
    const signals = item.tailFrameSignals;
    if (!signals) return false;
    return (
      Number(signals.endingCompositionNeed) >= 3 ||
      Number(signals.actionLandingNeed) >= 3 ||
      Number(signals.revealNeed) >= 3 ||
      Number(signals.emotionPeakNeed) >= 3
    );
  })) {
    uniquePush(markers, 'tail_landing_need');
  }

  return markers;
}

function resolveCharsPerSecond(input: SegmentTempoBudgetInput, slowMarkers: string[]): number {
  if (slowMarkers.length >= 2) return 3.2;
  if (slowMarkers.length === 1) return 3.4;
  const shotPlan = Array.isArray(input.shotPlan) ? input.shotPlan : [];
  if (shotPlan.some((item) => /fast_forward|快进|very_fast/.test(String(item.pace || '').toLowerCase()))) return 4.5;
  if (shotPlan.some((item) => /fast|快速/.test(String(item.pace || '').toLowerCase()))) return 4.2;
  return 4.0;
}

function resolveEndingReserveSec(input: SegmentTempoBudgetInput): number {
  const shotPlan = Array.isArray(input.shotPlan) ? input.shotPlan : [];
  const payloadMode = String(input.payloadMode || '');
  const payloadModeReason = String(input.payloadModeReason || '');
  const tailReferenceStatus = String(input.tailReferenceStatus || '').toLowerCase();
  const needsTailReserve =
    (payloadMode === 'first_last_frame' && (payloadModeReason === 'tail_ready' || tailReferenceStatus === 'ready')) ||
    shotPlan.some((item) => /resolution|falling|收束|低落|沉静/.test(String(item.emotion || '').toLowerCase()));
  return needsTailReserve ? 1.0 : 0.4;
}

export function computeSegmentTempoBudget(input: SegmentTempoBudgetInput): SegmentTempoBudget {
  const dialogueChars = cleanDialogueCharCount(input.dialoguePairs || []);
  const plannedDurationSec = normalizeDurationSec(input.plannedDurationSec, 4);
  const requestedDurationSec = normalizeDurationSec(input.durationSec ?? plannedDurationSec, plannedDurationSec);
  const openingReserveSec = dialogueChars > 0 ? 0.3 : 0;
  const endingReserveSec = dialogueChars > 0 ? resolveEndingReserveSec(input) : 0;
  const slowMarkers = dialogueChars > 0 ? detectSlowMarkers(input) : [];
  const charsPerSecond = dialogueChars > 0 ? resolveCharsPerSecond(input, slowMarkers) : 4.0;
  const speechSec = dialogueChars > 0 ? dialogueChars / charsPerSecond : 0;
  const requiredRawSec = roundDurationSec(Math.max(requestedDurationSec, speechSec + openingReserveSec + endingReserveSec));
  const requiredDurationSec = Math.ceil(requiredRawSec);
  const maxDurationSec = Math.max(1, Math.floor(input.maxDurationSec ?? SEGMENT_TEMPO_MAX_DURATION_SEC));
  const safeDurationSec = Math.min(requiredDurationSec, maxDurationSec);
  return {
    version: 'segment_tempo_budget_v1',
    dialogueChars,
    plannedDurationSec,
    requestedDurationSec,
    requiredRawSec,
    requiredDurationSec,
    safeDurationSec,
    maxDurationSec,
    exceedsMaxDuration: requiredDurationSec > maxDurationSec,
    charsPerSecond,
    speechSec: roundDurationSec(speechSec),
    openingReserveSec,
    endingReserveSec,
    slowMarkerCount: slowMarkers.length,
    slowMarkers,
    payloadMode: input.payloadMode ? String(input.payloadMode) : undefined,
    payloadModeReason: input.payloadModeReason ? String(input.payloadModeReason) : undefined,
  };
}

export function buildTailRushedWarning(tempoBudget?: SegmentTempoBudget | null) {
  return {
    key: TAIL_RUSHED_WARNING_KEY,
    level: 'warn',
    message: TAIL_RUSHED_WARNING_MESSAGE,
    ...(tempoBudget
      ? {
          dialogueChars: tempoBudget.dialogueChars,
          requiredRawSec: tempoBudget.requiredRawSec,
          requiredDurationSec: tempoBudget.requiredDurationSec,
          safeDurationSec: tempoBudget.safeDurationSec,
        }
      : {}),
  };
}

export function shouldMarkTailRushedAfterProbe(
  actualDurationSec: number,
  tempoBudget?: SegmentTempoBudget | null,
): boolean {
  if (!tempoBudget) return false;
  if (!Number.isFinite(actualDurationSec) || actualDurationSec <= 0) return false;
  if (!Number.isFinite(tempoBudget.requiredRawSec) || tempoBudget.requiredRawSec <= 0) return false;
  return actualDurationSec + 0.4 < tempoBudget.requiredRawSec;
}
