import { createHash } from 'node:crypto';
import { resolveLLMConfig } from './llm';
import { resolveLocalImagePath } from './image-gen';
import {
  FRAME_IMAGE_REFERENCE_IMAGE_BUDGET,
  buildFrameImageGenerationPlan,
  summarizePlanForAudit,
  type FrameImageGenerationPlan,
  type FrameImagePlanSummary,
} from './frame-image-plan';
import { computeTailFrameSourceHash, storyboardShotIndices } from './frame-workflow-state';
import { getProjectByIdForUser, patchProjectForUser } from './projects-db';
import { checkTailFramePreflight, formatTailFramePreflightError } from './visual-reference-state';

const MAX_TAIL_FRAME_PROMPT_CHARS = 5000;
const TAIL_FRAME_HISTORY_LIMIT = 30;

export type TailFrameBasePromptOrigin = 'system' | 'draft_commit' | 'backup_restore' | 'history_restore';

export type TailFrameBasePromptState = {
  content: string;
  sourceHash: string | null;
  updatedAt: string;
  updatedBy: number;
  origin: TailFrameBasePromptOrigin;
};

export type TailFrameBackupState = {
  content: string;
  sourceHash: string | null;
  createdAt: string;
};

export type TailFrameHistoryItem = {
  url: string;
  rawUrl?: string;
  at: string | number;
  source?: string;
  mode?: string;
  sourceHash: string | null;
  tailFrameBasePrompt?: string;
  submittedPrompt?: string;
  prompt?: string;
  originalPrompt?: string;
  planSummary?: any;
  safetyAudit?: any;
  shotIndices?: number[];
};

export type TailFrameEditDraft = {
  sourceHash: string | null;
  content?: string;
  updatedAt: string;
  updatedBy: number;
};

export type TailFrameEditDraftState = {
  draft: TailFrameEditDraft | null;
};

export type TailFrameDraftValidationError = {
  field: string;
  message: string;
};

export class TailFrameDraftValidationException extends Error {
  errors: TailFrameDraftValidationError[];

  constructor(errors: TailFrameDraftValidationError[]) {
    super(errors[0]?.message || 'validation_failed');
    this.name = 'TailFrameDraftValidationException';
    this.errors = errors;
  }
}

export type TailFramePromptPreflight = {
  allowed: boolean;
  code?: string;
  message?: string;
  firstFrameUrl?: string;
  selfFirstFrameLocal?: string;
};

export type TailFramePromptReconcileState = {
  plan: FrameImageGenerationPlan | null;
  planSummary: FrameImagePlanSummary | null;
  sourceHash: string | null;
  shotIndices: number[];
  modelSnapshot: FrameImageGenerationPlan['modelSnapshot'] | null;
  tailFrameBasePrompt: TailFrameBasePromptState | null;
  tailFrameBackup: TailFrameBackupState | null;
  tailFrameBasePromptStale: boolean;
  tailFrameDraftStale: boolean;
  preflight: TailFramePromptPreflight;
  slotPatch: Record<string, any> | null;
};

function cleanText(value: unknown, limit = MAX_TAIL_FRAME_PROMPT_CHARS): string {
  const text = String(value || '').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function cleanUrl(value: unknown): string {
  return String(value || '').trim();
}

function hashText(value: string) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}

function normalizeTailFrameBasePrompt(value: any): TailFrameBasePromptState | null {
  if (!value || typeof value !== 'object') return null;
  const content = cleanText(value.content);
  if (!content) return null;
  const updatedBy = Number(value.updatedBy || 0);
  const origin: TailFrameBasePromptOrigin =
    value.origin === 'draft_commit' || value.origin === 'backup_restore' || value.origin === 'history_restore'
      ? value.origin
      : 'system';
  return {
    content,
    sourceHash: typeof value.sourceHash === 'string' ? value.sourceHash : null,
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : new Date(0).toISOString(),
    updatedBy: Number.isFinite(updatedBy) ? updatedBy : 0,
    origin,
  };
}

function normalizeTailFrameBackup(value: any): TailFrameBackupState | null {
  if (!value || typeof value !== 'object') return null;
  const content = cleanText(value.content);
  if (!content) return null;
  return {
    content,
    sourceHash: typeof value.sourceHash === 'string' ? value.sourceHash : null,
    createdAt: typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : new Date(0).toISOString(),
  };
}

function normalizeTailFrameDraft(value: any): TailFrameEditDraft | null {
  if (!value || typeof value !== 'object') return null;
  const updatedBy = Number(value.updatedBy || 0);
  const content = cleanText(value.content);
  return {
    sourceHash: typeof value.sourceHash === 'string' ? value.sourceHash : null,
    ...(content ? { content } : {}),
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : new Date(0).toISOString(),
    updatedBy: Number.isFinite(updatedBy) ? updatedBy : 0,
  };
}

function currentTailFrameUrl(slot: any): string {
  return cleanUrl(slot?.frames?.tail?.url || slot?.tailFrameUrl || '');
}

function legacyTailFramePrompt(slot: any): string {
  return cleanText(
    slot?.tailFrameBasePrompt?.content ||
    slot?.originalTailFramePrompt ||
    slot?.frames?.tail?.originalPrompt ||
    slot?.tailFramePrompt ||
    slot?.frames?.tail?.prompt ||
    '',
  );
}

function legacyTailFrameSourceHash(slot: any): string | null {
  return (
    (typeof slot?.tailFrameSourceHash === 'string' ? slot.tailFrameSourceHash : null) ||
    (typeof slot?.frames?.tail?.sourceHash === 'string' ? slot.frames.tail.sourceHash : null)
  );
}

function tailFrameFirstFrameUrl(slot: any): string {
  return cleanUrl(slot?.firstFrameUrl || slot?.frames?.first?.url || slot?.firstFrame?.currentUrl || '');
}

function normalizeHistoryItem(item: any): TailFrameHistoryItem | null {
  const url = cleanUrl(item?.url);
  if (!url || url.startsWith('blob:')) return null;
  const rawUrl = cleanUrl(item?.rawUrl);
  const mode = String(item?.mode || '').trim();
  const source = String(item?.source || '').trim();
  const sourceHash = typeof item?.sourceHash === 'string' ? item.sourceHash : null;
  const normalized: TailFrameHistoryItem = {
    url,
    ...(rawUrl && rawUrl !== url ? { rawUrl } : {}),
    at: item?.at || new Date().toISOString(),
    ...(source ? { source } : {}),
    ...(mode ? { mode } : {}),
    sourceHash,
    tailFrameBasePrompt: cleanText(item?.tailFrameBasePrompt || item?.originalPrompt || ''),
    submittedPrompt: cleanText(item?.submittedPrompt || item?.prompt || ''),
    ...(item?.prompt ? { prompt: cleanText(item.prompt) } : {}),
    ...(item?.originalPrompt ? { originalPrompt: cleanText(item.originalPrompt) } : {}),
    planSummary: item?.planSummary || null,
    safetyAudit: item?.safetyAudit || null,
  };
  if (Array.isArray(item?.shotIndices)) {
    normalized.shotIndices = item.shotIndices.filter((idx: unknown) => Number.isInteger(idx as number));
  }
  return normalized;
}

export function tailFrameHistoryItemFromCurrent(
  slot: any,
  args: { at?: string; source?: string } = {},
): TailFrameHistoryItem | null {
  const tail = slot?.frames?.tail || {};
  const url = currentTailFrameUrl(slot);
  if (!url || url.startsWith('blob:')) return null;
  const rawUrl = cleanUrl(tail?.rawUrl || slot?.tailFrameRawUrl || '');
  const shotIndices = Array.isArray(tail?.shotIndices)
    ? tail.shotIndices
    : (Array.isArray(slot?.shotIndices) ? slot.shotIndices : []);
  return normalizeHistoryItem({
    url,
    ...(rawUrl && rawUrl !== url ? { rawUrl } : {}),
    at: args.at || new Date().toISOString(),
    source: args.source || tail?.source || slot?.tailFrameMode || 'current_before_tail_frame_replace',
    mode: slot?.tailFrameMode || tail?.mode || 'structured_v1',
    sourceHash: legacyTailFrameSourceHash(slot),
    tailFrameBasePrompt: legacyTailFramePrompt(slot),
    submittedPrompt: slot?.tailFramePrompt || tail?.prompt || '',
    planSummary: slot?.tailFramePlanSummary || tail?.planSummary || null,
    safetyAudit: slot?.tailFrameSafetyAudit || tail?.safetyAudit || null,
    shotIndices,
  });
}

export function nextTailFrameHistory(
  existing: any,
  incoming: TailFrameHistoryItem | null,
  args: { excludeUrls?: string[]; limit?: number } = {},
): TailFrameHistoryItem[] {
  const excludeUrls = new Set((args.excludeUrls || []).map(cleanUrl).filter(Boolean));
  const limit = Math.max(1, Math.min(TAIL_FRAME_HISTORY_LIMIT, Math.floor(args.limit || TAIL_FRAME_HISTORY_LIMIT)));
  const result: TailFrameHistoryItem[] = [];
  const seen = new Set<string>();
  const push = (candidate: any) => {
    const item = normalizeHistoryItem(candidate);
    if (!item || excludeUrls.has(item.url) || seen.has(item.url)) return;
    seen.add(item.url);
    result.push(item);
  };
  push(incoming);
  if (Array.isArray(existing)) {
    existing.forEach(push);
  }
  return result.slice(0, limit);
}

export function isTailFrameEditDraftStale(
  draftSourceHash: string | null | undefined,
  currentSourceHash: string | null | undefined,
): boolean {
  if (!draftSourceHash || !currentSourceHash) return true;
  return draftSourceHash !== currentSourceHash;
}

export function currentTailFrameEditDraft(project: any, groupIdx: number): TailFrameEditDraftState {
  const slot = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] : null;
  return { draft: normalizeTailFrameDraft(slot?.tailFrameEditDraft) };
}

export function tailFrameDraftFingerprint(draft: any): string {
  const normalized = normalizeTailFrameDraft(draft);
  return hashText(stableJson({
    draft: normalized?.content ? { content: normalized.content } : {},
  }));
}

export function validateAndNormalizeTailFrameDraft(args: {
  input: any;
  sourceHash: string | null;
  userId: number;
}): TailFrameEditDraft {
  const rawContent = String(args.input?.content || '').trim();
  if (rawContent.length > MAX_TAIL_FRAME_PROMPT_CHARS) {
    throw new TailFrameDraftValidationException([
      { field: 'content', message: `Prompt 不能超过 ${MAX_TAIL_FRAME_PROMPT_CHARS} 字符` },
    ]);
  }
  return {
    sourceHash: args.sourceHash,
    ...(rawContent ? { content: rawContent } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: args.userId,
  };
}

function effectiveReferenceCap(plan: FrameImageGenerationPlan): number {
  return Math.min(FRAME_IMAGE_REFERENCE_IMAGE_BUDGET, Math.max(0, Math.floor(plan.modelSnapshot.multiRefImageCap || 0)));
}

export function computeTailFramePromptSourceHash(
  project: any,
  userId: number,
  groupIdx: number,
  plan?: FrameImageGenerationPlan | null,
): string | null {
  const baseSourceHash = computeTailFrameSourceHash(project, userId, groupIdx);
  if (!baseSourceHash || !plan) return baseSourceHash;
  return hashText(stableJson({
    frameType: 'tail_frame_edit',
    baseSourceHash,
    selectorVersion: 1,
    cap: effectiveReferenceCap(plan),
    model: {
      provider: plan.modelSnapshot.provider,
      model: plan.modelSnapshot.model,
      quality: plan.modelSnapshot.quality || null,
    },
    references: plan.referenceManifest.map((ref) => ({
      role: ref.role || '',
      assetId: ref.assetId || '',
      assetName: ref.assetName || '',
      remoteUrl: ref.remoteUrl || '',
      slot: ref.slot || 0,
      delivery: ref.delivery || '',
      droppedReason: ref.droppedReason || '',
    })),
  }));
}

function buildTailFramePlanPreview(args: {
  project: any;
  groupIdx: number;
  ownerId: number;
  user: any;
}): {
  plan: FrameImageGenerationPlan | null;
  planSummary: FrameImagePlanSummary | null;
  sourceHash: string | null;
  shotIndices: number[];
  modelSnapshot: FrameImageGenerationPlan['modelSnapshot'] | null;
  preflight: TailFramePromptPreflight;
} {
  const storyboards = Array.isArray(args.project?.storyboards) ? args.project.storyboards : [];
  const slot = storyboards[args.groupIdx] || {};
  const shotIndices = storyboardShotIndices(args.project, args.groupIdx, slot, {
    mode: 'single-shot-strict',
    explicitShotIndices: Array.isArray(slot?.shotIndices) && slot.shotIndices.length ? undefined : [args.groupIdx],
  });
  const firstFramePreflight = checkTailFramePreflight(slot);
  if (firstFramePreflight) {
    return {
      plan: null,
      planSummary: null,
      sourceHash: computeTailFramePromptSourceHash(args.project, args.ownerId, args.groupIdx, null),
      shotIndices,
      modelSnapshot: null,
      preflight: {
        allowed: false,
        code: firstFramePreflight.reason,
        message: formatTailFramePreflightError(args.groupIdx, firstFramePreflight),
        firstFrameUrl: tailFrameFirstFrameUrl(slot),
      },
    };
  }
  const firstFrameUrl = tailFrameFirstFrameUrl(slot);
  const selfFirstFrameLocal = resolveLocalImagePath(firstFrameUrl, args.ownerId) || undefined;
  if (!selfFirstFrameLocal) {
    return {
      plan: null,
      planSummary: null,
      sourceHash: computeTailFramePromptSourceHash(args.project, args.ownerId, args.groupIdx, null),
      shotIndices,
      modelSnapshot: null,
      preflight: {
        allowed: false,
        code: 'first_frame_file_unresolvable',
        message: '首帧图片文件不可解析，无法生成尾帧。',
        firstFrameUrl,
      },
    };
  }
  const imgCfg = resolveLLMConfig(args.user, 'image');
  const capMulti = Math.max(1, Math.floor(imgCfg.capabilities?.image?.multiRefImage ?? 1));
  const modelSnapshot = {
    provider: imgCfg.provider,
    model: imgCfg.model,
    baseUrl: imgCfg.baseUrl,
    quality: imgCfg.imageQuality || 'medium',
    multiRefImageCap: capMulti,
  };
  const plan = buildFrameImageGenerationPlan({
    project: args.project,
    groupIdx: args.groupIdx,
    shotIndices,
    ownerId: args.ownerId,
    frameType: 'tail_frame',
    modelSnapshot,
    selfFirstFrame: {
      remoteUrl: firstFrameUrl,
      localPath: selfFirstFrameLocal,
    },
  });
  return {
    plan,
    planSummary: summarizePlanForAudit(plan),
    sourceHash: computeTailFramePromptSourceHash(args.project, args.ownerId, args.groupIdx, plan),
    shotIndices,
    modelSnapshot,
    preflight: {
      allowed: true,
      firstFrameUrl,
      selfFirstFrameLocal,
    },
  };
}

export function reconcileTailFramePromptStateInPatch(args: {
  project: any;
  user: any;
  groupIdx: number;
  now?: string;
}): TailFramePromptReconcileState {
  const storyboards = Array.isArray(args.project?.storyboards) ? args.project.storyboards : [];
  const slot = storyboards[args.groupIdx] || {};
  const now = args.now || new Date().toISOString();
  const { draft } = currentTailFrameEditDraft(args.project, args.groupIdx);
  const slotPatch: Record<string, any> = {};
  let tailFrameBasePrompt = normalizeTailFrameBasePrompt(slot.tailFrameBasePrompt);
  let tailFrameBackup = normalizeTailFrameBackup(slot.tailFrameBackup);

  const legacyPrompt = legacyTailFramePrompt(slot);
  const legacySourceHash = legacyTailFrameSourceHash(slot);
  if (!tailFrameBasePrompt && legacyPrompt) {
    tailFrameBasePrompt = {
      content: legacyPrompt,
      sourceHash: legacySourceHash,
      updatedAt: now,
      updatedBy: Number(args.user.id || 0),
      origin: 'system',
    };
    slotPatch.tailFrameBasePrompt = tailFrameBasePrompt;
  }
  if (!tailFrameBackup && legacyPrompt) {
    tailFrameBackup = {
      content: legacyPrompt,
      sourceHash: legacySourceHash,
      createdAt: now,
    };
    slotPatch.tailFrameBackup = tailFrameBackup;
  }

  const preview = buildTailFramePlanPreview({
    project: args.project,
    groupIdx: args.groupIdx,
    ownerId: args.user.id,
    user: args.user,
  });

  if (preview.plan) {
    const systemContent = cleanText(preview.plan.finalPrompt);
    const canAutoRefreshSystemPrompt = !draft && tailFrameBasePrompt?.origin === 'system';
    const baseHashChanged = !!(tailFrameBasePrompt && isTailFrameEditDraftStale(tailFrameBasePrompt.sourceHash, preview.sourceHash));
    const backupHashChanged = !!(tailFrameBackup && isTailFrameEditDraftStale(tailFrameBackup.sourceHash, preview.sourceHash));

    if (!tailFrameBasePrompt || (baseHashChanged && canAutoRefreshSystemPrompt)) {
      tailFrameBasePrompt = {
        content: systemContent,
        sourceHash: preview.sourceHash,
        updatedAt: now,
        updatedBy: Number(args.user.id || 0),
        origin: 'system',
      };
      slotPatch.tailFrameBasePrompt = tailFrameBasePrompt;
    }
    if (!tailFrameBackup || ((baseHashChanged || backupHashChanged) && canAutoRefreshSystemPrompt)) {
      tailFrameBackup = {
        content: systemContent,
        sourceHash: preview.sourceHash,
        createdAt: now,
      };
      slotPatch.tailFrameBackup = tailFrameBackup;
    }
  }

  return {
    plan: preview.plan,
    planSummary: preview.planSummary,
    sourceHash: preview.sourceHash,
    shotIndices: preview.shotIndices,
    modelSnapshot: preview.modelSnapshot,
    tailFrameBasePrompt,
    tailFrameBackup,
    tailFrameBasePromptStale: !!tailFrameBasePrompt && isTailFrameEditDraftStale(tailFrameBasePrompt.sourceHash, preview.sourceHash),
    tailFrameDraftStale: !!(draft && isTailFrameEditDraftStale(draft.sourceHash, preview.sourceHash)),
    preflight: preview.preflight,
    slotPatch: Object.keys(slotPatch).length ? slotPatch : null,
  };
}

export function reconcileTailFramePromptState(args: {
  projectId: string;
  user: any;
  groupIdx: number;
}): TailFramePromptReconcileState | null {
  let state: TailFramePromptReconcileState | null = null;
  patchProjectForUser(args.projectId, args.user.id, (fresh) => {
    if (!fresh) return null;
    state = reconcileTailFramePromptStateInPatch({
      project: fresh,
      user: args.user,
      groupIdx: args.groupIdx,
    });
    if (!state.slotPatch) return {};
    const storyboards = Array.isArray(fresh.storyboards) ? [...fresh.storyboards] : [];
    const prev = storyboards[args.groupIdx] || {};
    storyboards[args.groupIdx] = { ...prev, ...state.slotPatch };
    return { storyboards };
  });
  if (state) return state;
  const fresh = getProjectByIdForUser(args.projectId, args.user.id);
  return fresh ? reconcileTailFramePromptStateInPatch({ project: fresh, user: args.user, groupIdx: args.groupIdx }) : null;
}

export function tailFrameCurrentFramePayload(slot: any) {
  const tail = slot?.frames?.tail || {};
  const url = currentTailFrameUrl(slot);
  return {
    url,
    mode: slot?.tailFrameMode || tail?.mode || '',
    status: tail?.status || (slot?.tailFrameLastError ? 'failed' : (url ? 'ready' : 'missing')),
    sourceHash: slot?.tailFrameSourceHash || tail?.sourceHash || null,
    prompt: slot?.tailFramePrompt || tail?.prompt || '',
    planSummary: slot?.tailFramePlanSummary || tail?.planSummary || null,
  };
}
