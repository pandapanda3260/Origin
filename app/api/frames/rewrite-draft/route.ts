import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { chatCompleteJsonWithRetry } from '@/lib/llm';
import { checkAndRecordFirstFrameRewriteCall } from '@/lib/first-frame-rewrite-rate-limit';
import {
  parseFirstFrameRewriteResult,
  type FirstFrameRewriteOperations,
  type FirstFrameRewriteResult,
} from '@/lib/first-frame-rewrite-patch';
import {
  applyFirstFrameDraftToPlan,
  availableFirstFrameAssets,
  buildFirstFramePlanPreview,
  currentFirstFrameEditDraft,
  firstFrameDraftFingerprint,
  validateAndNormalizeFirstFrameDraftWithWarnings,
  type FirstFrameDraftWarning,
  FirstFrameDraftValidationException,
  MAX_NEGATIVE_PROMPT_CHARS,
  MAX_PROMPT_OVERRIDE_CHARS,
} from '@/lib/first-frame-edit-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIRST_FRAME_REWRITE_DISABLED_MESSAGE = '首帧对话改写功能已暂时下线。请使用手动编辑提示词、负向词和参考图后保存。';

function isFirstFrameRewriteEnabled(): boolean {
  return false;
}

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

const ConversationItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(1200),
}).strict();

const ConversationHistorySchema = z.array(ConversationItemSchema).max(20);

const BaselineDraftSchema = z.object({
  promptOverride: z.string().optional(),
  negativePromptOverride: z.string().optional(),
  referenceOverrides: z.object({
    excluded: z.array(z.object({
      role: z.string().optional(),
      assetId: z.string().optional(),
      assetName: z.string().optional(),
      slot: z.number().optional(),
      imageNo: z.number().optional(),
    }).passthrough()).optional(),
    added: z.array(z.object({
      role: z.enum(['character', 'scene', 'prop']),
      assetId: z.string(),
    }).strict()).optional(),
  }).strict().optional(),
}).passthrough();

function changedDraftFields(oldDraft: any, nextDraft: any) {
  const fields = ['promptOverride', 'referenceOverrides', 'negativePromptOverride'];
  return fields
    .filter((field) => JSON.stringify(oldDraft?.[field] ?? null) !== JSON.stringify(nextDraft?.[field] ?? null))
    .map((field) => field);
}

function validationResponse(errors: Array<{ field: string; message: string }>) {
  return Response.json(
    {
      error: errors[0]?.message || 'validation_failed',
      code: 'validation_failed',
      errors,
    },
    { status: 422 },
  );
}

function warning(code: string, message: string, field?: FirstFrameDraftWarning['field'], scope?: FirstFrameDraftWarning['scope']): FirstFrameDraftWarning {
  return { code, message, severity: 'warn', ...(field ? { field } : {}), ...(scope ? { scope } : {}) };
}

function clipText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function splitNegativePrompt(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw
    .split(/[,，;；\n]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeNegativePrompt(items: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.join(', ').slice(0, MAX_NEGATIVE_PROMPT_CHARS);
}

function selectorKey(selector: { role?: string; assetId?: string; assetName?: string }) {
  return [
    selector.role || '',
    selector.assetId || '',
    selector.assetName || '',
  ].join('|').toLowerCase();
}

function addKey(item: { role: string; assetId: string }) {
  return `${item.role}:${item.assetId}`.toLowerCase();
}

function resolveAddByNameOrId(project: any, input: { role: 'character' | 'scene' | 'prop'; assetId?: string; assetName?: string }, warnings: FirstFrameDraftWarning[]) {
  const assetId = String(input.assetId || '').trim();
  if (assetId) return { role: input.role, assetId };
  const assetName = String(input.assetName || '').trim().toLowerCase();
  if (!assetName) {
    warnings.push(warning('reference_add_missing_asset', '补充参考图缺少资产名称或 ID，已跳过。', 'referenceOverrides', 'list'));
    return null;
  }
  const matches = availableFirstFrameAssets(project).filter((asset) => (
    asset.role === input.role && String(asset.assetName || '').trim().toLowerCase() === assetName
  ));
  if (matches.length === 1) return { role: input.role, assetId: matches[0].assetId };
  warnings.push(warning(
    matches.length > 1 ? 'reference_name_ambiguous' : 'reference_name_not_found',
    matches.length > 1
      ? `找到多个名为「${input.assetName}」的参考资产，已跳过。`
      : `未找到名为「${input.assetName}」的参考资产，已跳过。`,
    'referenceOverrides',
    'list',
  ));
  return null;
}

function selectorMatchesAdd(selector: { role?: string; assetId?: string; assetName?: string }, add: { role: string; assetId: string }, project: any) {
  if (selector.role && selector.role !== add.role) return false;
  if (selector.assetId && selector.assetId === add.assetId) return true;
  if (!selector.assetName) return false;
  const asset = availableFirstFrameAssets(project).find((item) => item.role === add.role && item.assetId === add.assetId);
  return String(asset?.assetName || '').trim().toLowerCase() === String(selector.assetName || '').trim().toLowerCase();
}

function selectorMatchesPlanReference(selector: { role?: string; assetId?: string; assetName?: string }, ref: any) {
  if (selector.role && selector.role !== ref.role) return false;
  if (selector.assetId && selector.assetId === ref.assetId) return true;
  if (selector.assetName && String(selector.assetName).trim().toLowerCase() === String(ref.assetName || '').trim().toLowerCase()) return true;
  return false;
}

function applyRewriteOperations(args: {
  project: any;
  baseDraft: any;
  operations: FirstFrameRewriteOperations | null | undefined;
  planReferenceManifest: any[];
}): { draftInput: any; warnings: FirstFrameDraftWarning[] } {
  const base = args.baseDraft && typeof args.baseDraft === 'object' ? args.baseDraft : {};
  const operations = args.operations || {};
  const next: Record<string, any> = { ...base };
  const warnings: FirstFrameDraftWarning[] = [];

  const promptPatch = operations.promptOverride;
  if (promptPatch?.op === 'set') {
    const prompt = String(promptPatch.value || '').trim().slice(0, MAX_PROMPT_OVERRIDE_CHARS);
    if (prompt) next.promptOverride = prompt;
    else warnings.push(warning('prompt_empty_kept', 'AI 试图把提示词改为空，已保留原提示词。', 'promptOverride', 'field'));
  } else if (promptPatch?.op === 'clear') {
    delete next.promptOverride;
  }

  const negativePatch = operations.negativePromptOverride;
  if (negativePatch) {
    const current = splitNegativePrompt(base.negativePromptOverride);
    if (negativePatch.op === 'set') next.negativePromptOverride = serializeNegativePrompt(splitNegativePrompt(negativePatch.value));
    if (negativePatch.op === 'append') next.negativePromptOverride = serializeNegativePrompt(current.concat(splitNegativePrompt(negativePatch.value)));
    if (negativePatch.op === 'remove') {
      const remove = new Set(splitNegativePrompt(negativePatch.value).map((item) => item.toLowerCase()));
      next.negativePromptOverride = serializeNegativePrompt(current.filter((item) => !remove.has(item.toLowerCase())));
    }
    if (negativePatch.op === 'clear') delete next.negativePromptOverride;
    if (next.negativePromptOverride === '') delete next.negativePromptOverride;
  }

  const refPatch = operations.referenceOverrides;
  if (refPatch?.op === 'clear') {
    delete next.referenceOverrides;
  } else if (refPatch?.op === 'update') {
    const baseRefs = base.referenceOverrides && typeof base.referenceOverrides === 'object' ? base.referenceOverrides : {};
    let added = Array.isArray(baseRefs.added) ? baseRefs.added.slice() : [];
    let excluded = Array.isArray(baseRefs.excluded) ? baseRefs.excluded.slice() : [];

    for (const item of refPatch.removeAdded || []) {
      added = added.filter((add: any) => !selectorMatchesAdd(item, add, args.project));
    }
    for (const item of refPatch.add || []) {
      const resolved = resolveAddByNameOrId(args.project, item, warnings);
      if (resolved) added.push(resolved);
    }
    for (const item of refPatch.exclude || []) {
      const matched = args.planReferenceManifest.some((ref) => selectorMatchesPlanReference(item, ref));
      if (matched) excluded.push(item);
      else warnings.push(warning('reference_exclude_not_found', '未找到要排除的参考图，已跳过该项。', 'referenceOverrides', 'list'));
    }

    const seenAdds = new Set<string>();
    added = added.filter((item: any) => {
      const key = addKey(item);
      if (seenAdds.has(key)) {
        warnings.push(warning('reference_add_deduped', '重复补充的参考图已自动去重。', 'referenceOverrides', 'list'));
        return false;
      }
      seenAdds.add(key);
      return true;
    });
    const seenExcluded = new Set<string>();
    excluded = excluded.filter((item: any) => {
      const key = selectorKey(item);
      if (seenExcluded.has(key)) return false;
      seenExcluded.add(key);
      return true;
    });
    excluded = excluded.filter((item: any) => {
      const conflicts = added.some((add: any) => selectorMatchesAdd(item, add, args.project));
      if (conflicts) warnings.push(warning('reference_conflict_normalized', '同一参考资产同时新增和排除，已按新增优先处理。', 'referenceOverrides', 'list'));
      return !conflicts;
    });

    if (added.length || excluded.length) {
      next.referenceOverrides = {
        ...(excluded.length ? { excluded } : {}),
        ...(added.length ? { added } : {}),
      };
    } else {
      delete next.referenceOverrides;
    }
  }

  return { draftInput: next, warnings };
}

export async function POST(req: NextRequest) {
  if (!isFirstFrameRewriteEnabled()) {
    return Response.json(
      {
        error: FIRST_FRAME_REWRITE_DISABLED_MESSAGE,
        code: 'feature_disabled',
        detail: FIRST_FRAME_REWRITE_DISABLED_MESSAGE,
      },
      { status: 410 },
    );
  }

  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const userMessage = String(body?.userMessage || body?.message || '').trim();
  const conversationParse = ConversationHistorySchema.safeParse(body?.conversationHistory || []);
  const requestSourceHash = String(body?.sourceHash || '').trim();
  const expectedSavedDraftFingerprint = String(body?.expectedSavedDraftFingerprint || '').trim();
  const baselineFingerprint = String(body?.baselineFingerprint || '').trim();
  const baselineDraftParse = typeof body?.baselineDraft === 'undefined'
    ? { success: true as const, data: undefined }
    : BaselineDraftSchema.safeParse(body.baselineDraft);

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (!userMessage) return jsonError('消息不能为空', 400);
  if (!conversationParse.success) {
    return Response.json(
      { error: 'conversation_history_invalid', code: 'conversation_history_invalid', detail: '对话历史格式无效或超过 20 条。' },
      { status: 400 },
    );
  }
  if (!baselineDraftParse.success) {
    return Response.json(
      { error: 'baseline_draft_invalid', code: 'baseline_draft_invalid', detail: '对话基线草稿格式无效。' },
      { status: 400 },
    );
  }

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);
  const rateLimit = checkAndRecordFirstFrameRewriteCall({ userId: user.id, projectId, groupIdx });
  if (rateLimit.failOpen) {
    console.warn('[first-frame-draft-rewrite] rate limit failed open', { userId: user.id, projectId, groupIdx });
  }
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error: rateLimit.message || 'rate_limited',
        code: rateLimit.code || 'rate_limited',
        retryAfterMs: rateLimit.retryAfterMs || 1000,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.max(1, Math.ceil((rateLimit.retryAfterMs || 1000) / 1000))),
        },
      },
    );
  }
  const preview = buildFirstFramePlanPreview({ project, groupIdx, ownerId: user.id, user });
  if (requestSourceHash && preview.sourceHash && requestSourceHash !== preview.sourceHash) {
    return Response.json(
      { error: '镜头或项目内容已变更，请刷新首帧编辑器后重试。', code: 'source_changed', sourceHash: preview.sourceHash },
      { status: 409 },
    );
  }
  const { draft: savedDraftValue } = currentFirstFrameEditDraft(project, groupIdx);
  const savedDraft = savedDraftValue || {};
  const actualSavedDraftFingerprint = firstFrameDraftFingerprint(preview.sourceHash, savedDraft);
  if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint) {
    return Response.json(
      {
        error: '草稿已在其他位置更新，请刷新后重试，或确认覆盖。',
        code: 'saved_draft_changed',
        actualSavedDraftFingerprint,
        expectedSavedDraftFingerprint,
      },
      { status: 409 },
    );
  }
  let currentDraft: any = savedDraft;
  const baselineDraft = baselineDraftParse.data;
  if (baselineDraft) {
    let baselineValidation;
    try {
      baselineValidation = validateAndNormalizeFirstFrameDraftWithWarnings({
        project,
        groupIdx,
        userId: user.id,
        input: baselineDraft,
        plan: preview.plan,
      });
    } catch (err: any) {
      if (err instanceof FirstFrameDraftValidationException) return validationResponse(err.errors);
      throw err;
    }
    const actualBaselineFingerprint = firstFrameDraftFingerprint(preview.sourceHash, baselineValidation.draft);
    if (baselineFingerprint && baselineFingerprint !== actualBaselineFingerprint) {
      return Response.json(
        {
          error: '对话基线已过期，请刷新首帧编辑器后重试。',
          code: 'baseline_fingerprint_mismatch',
          actualBaselineFingerprint,
          expectedBaselineFingerprint: baselineFingerprint,
        },
        { status: 409 },
      );
    }
    currentDraft = baselineValidation.draft;
  }
  const conversationHistory = conversationParse.data;

  const messages = [
    {
      role: 'system' as const,
      content:
        '你是首帧图片生成草稿编辑器。你必须只输出 JSON。' +
        '用户用什么语言提问，assistantMessage 就用什么语言回复。' +
        '只能修改 promptOverride、referenceOverrides、negativePromptOverride。' +
        '禁止修改 styleRuleOverrides/provider/model/quality/size/style/sourceHash/updatedBy/updatedAt；用户要求修改这些字段时，draftPatch 全部 keep，并在 assistantMessage 说明不能通过对话修改。' +
        '用户要求更冷、更暖、更电影感等风格变化时，必须转写到 promptOverride 或 negativePromptOverride，不要输出 styleRuleOverrides。' +
        'assistantMessage 控制在 80 字以内，只点明建议意图，不要说已经完成修改。' +
        '输出 schema: {"assistantMessage":"...","intentSummary":"...","draftPatch":{...}}。' +
        'promptOverride 只能使用 {"op":"set","value":"..."}、keep 或 clear，value 不能是数组。' +
        'negativePromptOverride 可用 set/append/remove/clear，set.value 可为字符串或数组。' +
        'referenceOverrides.update 是累积修改，clear 表示恢复默认参考图，不是清空所有参考图。' +
        '参考资产优先使用 role+assetId；不知道 assetId 时可用 role+assetName，不要编造 ID。',
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        systemPlan: {
          finalPrompt: preview.plan.finalPrompt,
          styleLock: preview.plan.styleLock,
          referenceManifest: preview.plan.referenceManifest,
        },
        currentDraft,
        conversationHistory,
        userMessage,
      }),
    },
  ];

  let result: FirstFrameRewriteResult;
  try {
    result = await chatCompleteJsonWithRetry(
      user,
      messages,
      { modelRole: 'structured', maxTokens: 1200, temperature: 0.2, maxAttempts: 3, requestTimeoutMs: 30000 },
      parseFirstFrameRewriteResult,
      'first-frame-draft-rewrite',
    );
  } catch (err) {
    console.warn('[first-frame-draft-rewrite] model output failed:', err);
    return Response.json(
      { error: 'AI 暂时无法响应，请稍后重试。', code: 'llm_unavailable', detail: 'AI 改写失败，请稍后重试。' },
      { status: 503 },
    );
  }

  const operationResult = applyRewriteOperations({
    project,
    baseDraft: currentDraft,
    operations: result?.draftPatch,
    planReferenceManifest: preview.plan.referenceManifest,
  });
  let rawNextDraft = operationResult.draftInput;
  const collectedWarnings = [
    ...(result.parserWarnings || []),
    ...operationResult.warnings,
  ];

  try {
    let normalizedResult = validateAndNormalizeFirstFrameDraftWithWarnings({
      project,
      groupIdx,
      userId: user.id,
      input: rawNextDraft,
      plan: preview.plan,
    });
    let normalized = normalizedResult.draft;
    let allWarnings = collectedWarnings.concat(normalizedResult.warnings);
    const fields = changedDraftFields(currentDraft, normalized);
    if (fields.includes('referenceOverrides')) {
      try {
        validateAndNormalizeFirstFrameDraftWithWarnings({
          project,
          groupIdx,
          userId: user.id,
          input: normalized,
          plan: preview.plan,
        });
      } catch (_err) {
        rawNextDraft = { ...rawNextDraft, referenceOverrides: currentDraft.referenceOverrides };
        normalizedResult = validateAndNormalizeFirstFrameDraftWithWarnings({
          project,
          groupIdx,
          userId: user.id,
          input: rawNextDraft,
          plan: preview.plan,
        });
        normalized = normalizedResult.draft;
        allWarnings = collectedWarnings.concat(normalizedResult.warnings, [warning(
          'reference_patch_rejected',
          'AI 的参考图修改会导致可用参考图不足，已保留原参考图设置。',
          'referenceOverrides',
          'list',
        )]);
      }
    }
    const finalPlan = applyFirstFrameDraftToPlan({ project, userId: user.id, plan: preview.plan, draft: normalized });
    const nextBaselineFingerprint = firstFrameDraftFingerprint(preview.sourceHash, normalized);
    return jsonOk({
      assistantMessage: clipText(result?.assistantMessage || '已生成草稿修改建议。', 120),
      intentSummary: result?.intentSummary ? clipText(result.intentSummary, 160) : '',
      warnings: allWarnings,
      patch: {
        changedFields: changedDraftFields(currentDraft, normalized),
        operations: result?.draftPatch || {},
        nextDraft: normalized,
      },
      preview: {
        finalPrompt: finalPlan.finalPrompt,
        referenceManifest: finalPlan.referenceManifest,
      },
      sourceHash: preview.sourceHash,
      baselineFingerprint: nextBaselineFingerprint,
      savedDraftFingerprint: actualSavedDraftFingerprint,
    });
  } catch (err: any) {
    if (err instanceof FirstFrameDraftValidationException) {
      if (err.errors.some((item) => item.field === 'referenceOverrides')) {
        return Response.json(
          {
            error: err.errors[0]?.message || 'reference_empty',
            code: 'reference_empty',
            errors: err.errors,
            warnings: collectedWarnings,
          },
          { status: 422 },
        );
      }
      return validationResponse(err.errors);
    }
    return jsonError(err?.message || '改写草稿失败', 500);
  }
}
