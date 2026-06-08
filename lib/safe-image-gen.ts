import { createHash, randomUUID } from 'node:crypto';
import { composeFinalImagePrompt, generateImage, type ImageGenInput, type ImageGenResult } from './image-gen';
import type { UserRow } from './db';
import { getDb } from './db';
import {
  extractImageModerationError,
  inferImagePromptSafetyHints,
  preflightImageModerationPrompt,
  rewriteImagePromptForModeration,
  type ImagePromptModerationRewrite,
  type ImagePromptSafetyHint,
  type RewriteDiff,
  type ViolationCategory,
} from './content-sanitize';
import { recordContentFlag } from './content-flags';
import { rewriteImagePromptForModerationLLM, type ImageSafetyRewriteInvalidReason } from './image-safety-rewrite';

type RewriteAttemptNote = {
  source: 'llm';
  attempt: number;
  changed: boolean;
  invalidReason?: ImageSafetyRewriteInvalidReason | string;
  invalidDetail?: string;
};

export type ImageGenerationSafetyAudit = {
  correlationId: string;
  startedAt: string;
  originalPromptHash: string;
  originalPromptPreview: string;
  originalPromptLength: number;
  finalSubmittedPromptHash?: string;
  finalSubmittedPromptPreview?: string;
  finalSubmittedPromptLength?: number;
  finalComposedPromptHash?: string;
  finalComposedPromptPreview?: string;
  finalComposedPromptLength?: number;
  finalComposedPreflight?: ReturnType<typeof preflightImageModerationPrompt>;
  preflight: ReturnType<typeof preflightImageModerationPrompt>;
  safetyDiagnostics?: {
    providerCategory: ViolationCategory[];
    providerReturnedSpecificCategory: boolean;
    likelySensitiveFragments: ImagePromptSafetyHint[];
    note: string;
  };
  attempts: Array<{
    attempt: 0 | 1 | 2;
    submittedPromptHash: string;
    submittedPromptPreview: string;
    submittedPromptLength: number;
    requestId?: string;
    safetyViolations?: ViolationCategory[];
    errorCode?: string;
    rewriteDiff?: Array<RewriteDiff & {
      fromPreview?: string;
      fromLength?: number;
      toPreview?: string;
      toLength?: number;
    }>;
    rewriteAttemptNotes?: RewriteAttemptNote[];
    rewriteFailureReason?: string;
    errorMessage?: string;
  }>;
  visualAnchorDescription?: ImagePromptModerationRewrite['visualAnchorDescription'];
  moderationRecovered: boolean;
  generatedImageId?: string;
};

type FullImageGenerationSafetyAudit = Omit<
  ImageGenerationSafetyAudit,
  'originalPromptHash' | 'originalPromptPreview' | 'originalPromptLength' | 'finalSubmittedPromptHash' | 'finalSubmittedPromptPreview' | 'finalSubmittedPromptLength' | 'attempts'
> & {
  originalPrompt: string;
  finalSubmittedPrompt?: string;
  finalComposedPrompt?: string;
  attempts: Array<{
    attempt: 0 | 1 | 2;
    submittedPrompt: string;
    requestId?: string;
    safetyViolations?: ViolationCategory[];
    errorCode?: string;
    rewriteDiff?: RewriteDiff[];
    rewriteAttemptNotes?: RewriteAttemptNote[];
    rewriteFailureReason?: string;
    errorMessage?: string;
  }>;
};

export type SafeImageGenResult = ImageGenResult & {
  submittedPrompt: string;
  safetyAudit: ImageGenerationSafetyAudit;
  visualAnchorDescription: ImagePromptModerationRewrite['visualAnchorDescription'];
};

function hashText(text: string): string {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function previewText(text: string, max = 300): string {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max) : value;
}

function compactRewriteDiff(diff: RewriteDiff[] | undefined): ImageGenerationSafetyAudit['attempts'][number]['rewriteDiff'] {
  return (diff || []).map((item) => ({
    ...item,
    from: undefined as any,
    to: undefined as any,
    fromPreview: previewText(item.from, 200),
    fromLength: String(item.from || '').length,
    toPreview: previewText(item.to, 200),
    toLength: String(item.to || '').length,
  }));
}

function promptFingerprint(text: string) {
  const value = String(text || '');
  return {
    hash: hashText(value),
    preview: previewText(value),
    length: value.length,
  };
}

function compactImageSafetyAudit(audit: FullImageGenerationSafetyAudit): ImageGenerationSafetyAudit {
  const original = promptFingerprint(audit.originalPrompt);
  const finalPrompt = audit.finalSubmittedPrompt ? promptFingerprint(audit.finalSubmittedPrompt) : null;
  const composedPrompt = audit.finalComposedPrompt ? promptFingerprint(audit.finalComposedPrompt) : null;
  const providerCategory = auditSafetyViolations(audit);
  const providerReturnedSpecificCategory = providerCategory.some((category) => category !== 'unknown');
  const likelySensitiveFragments = inferImagePromptSafetyHints(
    [audit.originalPrompt, audit.finalSubmittedPrompt].filter(Boolean).join('\n'),
    8,
  );
  return {
    correlationId: audit.correlationId,
    startedAt: audit.startedAt,
    originalPromptHash: original.hash,
    originalPromptPreview: original.preview,
    originalPromptLength: original.length,
    finalSubmittedPromptHash: finalPrompt?.hash,
    finalSubmittedPromptPreview: finalPrompt?.preview,
    finalSubmittedPromptLength: finalPrompt?.length,
    finalComposedPromptHash: composedPrompt?.hash,
    finalComposedPromptPreview: composedPrompt?.preview,
    finalComposedPromptLength: composedPrompt?.length,
    finalComposedPreflight: audit.finalComposedPrompt
      ? preflightImageModerationPrompt(audit.finalComposedPrompt)
      : undefined,
    preflight: audit.preflight,
    safetyDiagnostics: {
      providerCategory,
      providerReturnedSpecificCategory,
      likelySensitiveFragments,
      note: providerReturnedSpecificCategory
        ? '图像服务返回了安全类别；片段为本地规则辅助定位。'
        : '图像服务未返回具体拦截词或类别；片段为系统按 prompt 启发式推断的优先排查项。',
    },
    attempts: audit.attempts.map((attempt) => {
      const submitted = promptFingerprint(attempt.submittedPrompt);
      return {
        attempt: attempt.attempt,
        submittedPromptHash: submitted.hash,
        submittedPromptPreview: submitted.preview,
        submittedPromptLength: submitted.length,
        requestId: attempt.requestId,
        safetyViolations: attempt.safetyViolations,
        errorCode: attempt.errorCode,
        rewriteDiff: compactRewriteDiff(attempt.rewriteDiff),
        rewriteAttemptNotes: attempt.rewriteAttemptNotes,
        rewriteFailureReason: attempt.rewriteFailureReason,
        errorMessage: attempt.errorMessage,
      };
    }),
    visualAnchorDescription: audit.visualAnchorDescription,
    moderationRecovered: audit.moderationRecovered,
    generatedImageId: audit.generatedImageId,
  };
}

function auditSafetyViolations(audit: FullImageGenerationSafetyAudit): ViolationCategory[] {
  const out: ViolationCategory[] = [];
  for (const attempt of audit.attempts) {
    for (const item of attempt.safetyViolations || []) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

function persistImageGenerationAudit(
  user: UserRow,
  input: ImageGenInput,
  audit: FullImageGenerationSafetyAudit,
) {
  try {
    getDb().prepare(
      `INSERT INTO image_generation_audits (
        correlation_id, owner_id, project_id, asset_ref, kind, generated_image_id,
        moderation_recovered, original_prompt, final_submitted_prompt, final_composed_prompt, attempts_json,
        safety_violations_json, metadata_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(correlation_id) DO UPDATE SET
        generated_image_id=excluded.generated_image_id,
        moderation_recovered=excluded.moderation_recovered,
        final_submitted_prompt=excluded.final_submitted_prompt,
        final_composed_prompt=excluded.final_composed_prompt,
        attempts_json=excluded.attempts_json,
        safety_violations_json=excluded.safety_violations_json,
        metadata_json=excluded.metadata_json,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(
      audit.correlationId,
      user.id,
      input.projectId || null,
      input.assetRef || null,
      input.kind || null,
      audit.generatedImageId || null,
      audit.moderationRecovered ? 1 : 0,
      audit.originalPrompt,
      audit.finalSubmittedPrompt || '',
      audit.finalComposedPrompt || '',
      JSON.stringify(audit.attempts || []),
      JSON.stringify(auditSafetyViolations(audit)),
      JSON.stringify(input.imageAuditMetadata || {}),
    );
  } catch (error) {
    console.warn('[safe-image-gen] failed to persist image generation audit:', error);
  }
}

function appendRewriteAttemptNote(audit: FullImageGenerationSafetyAudit, note: RewriteAttemptNote) {
  const last = audit.attempts[audit.attempts.length - 1];
  if (!last) return;
  last.rewriteAttemptNotes = [...(last.rewriteAttemptNotes || []), note];
}

function markRewriteFailure(audit: FullImageGenerationSafetyAudit, reason: string) {
  const last = audit.attempts[audit.attempts.length - 1];
  if (!last) return;
  last.rewriteFailureReason = reason;
}

export async function generateImageWithModerationRecovery(
  user: UserRow,
  input: ImageGenInput,
  deps: {
    generateImageImpl?: typeof generateImage;
    rewriteLLMImpl?: typeof rewriteImagePromptForModerationLLM;
  } = {},
): Promise<SafeImageGenResult> {
  const originalPrompt = String(input.prompt || '');
  const audit: FullImageGenerationSafetyAudit = {
    correlationId: randomUUID(),
    startedAt: new Date().toISOString(),
    originalPrompt,
    preflight: preflightImageModerationPrompt(originalPrompt),
    attempts: [],
    moderationRecovered: false,
  };

  let submittedPrompt = originalPrompt;
  let visualAnchorDescription: ImagePromptModerationRewrite['visualAnchorDescription'] = {
    originalText: originalPrompt,
    effectiveText: originalPrompt,
    source: 'original',
    rewriteDiff: [],
  };
  let nextRewriteDiff: RewriteDiff[] | undefined;

  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      const imageGen = deps.generateImageImpl || generateImage;
      const result = await imageGen(user, { ...input, prompt: submittedPrompt, correlationId: audit.correlationId });
      audit.attempts.push({
        attempt: attempt as 0 | 1 | 2,
        submittedPrompt,
        rewriteDiff: nextRewriteDiff,
      });
      audit.finalSubmittedPrompt = submittedPrompt;
      audit.finalComposedPrompt = composeFinalImagePrompt({ ...input, prompt: submittedPrompt });
      audit.visualAnchorDescription = visualAnchorDescription;
      audit.moderationRecovered = attempt > 0;
      audit.generatedImageId = result.id;
      persistImageGenerationAudit(user, input, audit);
      const compactAudit = compactImageSafetyAudit(audit);
      return {
        ...result,
        submittedPrompt,
        safetyAudit: compactAudit,
        visualAnchorDescription,
      };
    } catch (e: any) {
      const info = extractImageModerationError(e, { preflight: audit.preflight });
      if (info.blocked) {
        try {
          recordContentFlag({
            ownerId: user.id,
            projectId: input.projectId || null,
            sourceType: 'image',
            sourceId: audit.correlationId,
            rawExcerpt: submittedPrompt,
            scanReason: `image_moderation:${(info.safetyViolations || ['unknown']).join(',')}`,
            severity: 'high',
          });
        } catch (flagError) {
          console.warn('[safe-image-gen] failed to persist content flag:', flagError);
        }
      }
      audit.attempts.push({
        attempt: attempt as 0 | 1 | 2,
        submittedPrompt,
        requestId: info.requestId,
        safetyViolations: info.safetyViolations,
        errorCode: info.errorCode,
        rewriteDiff: nextRewriteDiff,
        errorMessage: String(e?.message || e).slice(0, 1000),
      });
      if (!info.blocked || attempt >= 2) {
        persistImageGenerationAudit(user, input, {
          ...audit,
          finalSubmittedPrompt: submittedPrompt,
          finalComposedPrompt: composeFinalImagePrompt({ ...input, prompt: submittedPrompt }),
          visualAnchorDescription,
        });
        (e as any).imageSafetyAudit = {
          ...compactImageSafetyAudit({
            ...audit,
            finalSubmittedPrompt: submittedPrompt,
            finalComposedPrompt: composeFinalImagePrompt({ ...input, prompt: submittedPrompt }),
            visualAnchorDescription,
          }),
        };
        throw e;
      }
      // 快路径:关键词改写。图像审核常见 unknown 类别 → 这里多半 0 改动。
      const kw = rewriteImagePromptForModeration(
        submittedPrompt,
        info.safetyViolations.length ? info.safetyViolations : ['unknown'],
      );
      let nextPrompt = kw.rewrittenPrompt;
      let nextDiff: RewriteDiff[] = kw.rewriteDiff;
      let nextAnchor = kw.visualAnchorDescription;
      if (!kw.rewriteDiff.length || kw.rewrittenPrompt === submittedPrompt) {
        // 方向 B:关键词改写没动 → 用 LLM 把提示词中性化再重试;LLM 也救不回才放弃。
        const rewriteLLM = deps.rewriteLLMImpl || rewriteImagePromptForModerationLLM;
        let llm = await rewriteLLM(user, submittedPrompt, {
          traceName: 'image-moderation-rewrite',
        });
        appendRewriteAttemptNote(audit, {
          source: 'llm',
          attempt: 1,
          changed: !!llm.changed,
          invalidReason: llm.invalidReason,
          invalidDetail: llm.invalidDetail,
        });
        if (!llm.changed) {
          llm = await rewriteLLM(user, submittedPrompt, {
            traceName: 'image-moderation-rewrite-retry',
          });
          appendRewriteAttemptNote(audit, {
            source: 'llm',
            attempt: 2,
            changed: !!llm.changed,
            invalidReason: llm.invalidReason,
            invalidDetail: llm.invalidDetail,
          });
        }
        if (!llm.changed) {
          const reason = llm.invalidReason || 'no_change';
          const detail = llm.invalidDetail ? `:${llm.invalidDetail}` : '';
          markRewriteFailure(audit, `rewrite_failed:${reason}${detail}`);
          persistImageGenerationAudit(user, input, {
            ...audit,
            finalSubmittedPrompt: submittedPrompt,
            finalComposedPrompt: composeFinalImagePrompt({ ...input, prompt: submittedPrompt }),
            visualAnchorDescription,
          });
          (e as any).imageSafetyAudit = {
            ...compactImageSafetyAudit({
              ...audit,
              finalSubmittedPrompt: submittedPrompt,
              finalComposedPrompt: composeFinalImagePrompt({ ...input, prompt: submittedPrompt }),
              visualAnchorDescription,
            }),
          };
          throw e;
        }
        nextPrompt = llm.rewrittenPrompt;
        nextDiff = llm.rewriteDiff;
        nextAnchor = llm.visualAnchorDescription;
      }
      submittedPrompt = nextPrompt;
      visualAnchorDescription = nextAnchor;
      nextRewriteDiff = nextDiff;
    }
  }

  throw new Error('unreachable image moderation recovery state');
}
