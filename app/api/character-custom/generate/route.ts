import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { assertToolboxImageRefPath } from '@/lib/toolbox-media';
import type { ToolboxInputRef } from '@/lib/toolbox-modes';
import {
  createCustomCharacterVersion,
  finalizeCustomCharacterVersion,
  serializeCustomCharacterVersion,
} from '@/lib/custom-character-db';
import {
  buildCustomCharacterFields,
  buildCustomCharacterImagePrompt,
  type CustomCharacterParams,
  type CustomCharacterSourceType,
  normalizeCustomCharacterParams,
  resolveCustomCharacterSourceType,
  toFriendlyCharacterError,
} from '@/lib/custom-character-prompt';
import { generateImageWithModerationRecovery } from '@/lib/safe-image-gen';
import { splitCharacterPanels } from '@/lib/character-panels';
import { deriveCharacterReferenceUpdate, deriveCrowdReferenceUpdate } from '@/lib/character-reference-update';
import { resolveLLMConfig } from '@/lib/llm';
import { characterAssetModeFor, isAnonymousCrowdAsset } from '@/lib/crowd-character';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FinalizeContext = {
  versionId: string;
  characterId: string;
  projectId: string | null;
  prompt: string;
  params: CustomCharacterParams;
  userName: string;
};

function fallbackEntityType(params: CustomCharacterParams): 'human' | 'non-human' {
  return params.entityType === 'non-human' ? 'non-human' : 'human';
}

function supportsReferenceImageGeneration(cfg: any): boolean {
  const provider = String(cfg?.provider || '');
  const model = String(cfg?.model || '').toLowerCase();
  return provider === 'volcengine_seedream' || model.includes('gpt-image') || model.includes('dall-e-2');
}

function assertReferenceImageGenerationSupported(user: any) {
  const cfg = resolveLLMConfig(user, 'image');
  if (cfg.mode === 'real' && supportsReferenceImageGeneration(cfg)) return;
  const provider = String(cfg?.provider || cfg?.mode || 'unknown');
  const model = String(cfg?.model || 'unknown');
  throw new Error(`当前图片模型不支持参考图生成：${provider}/${model}。请切换为 gpt-image、dall-e-2 或 Seedream 图片模型后重试`);
}

function draftPlaceholderName(prompt: string, params: CustomCharacterParams): string {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (text) return (text.replace(/[，。,.!！?？].*$/, '').slice(0, 12) || '草稿角色');
  return params.entityType === 'non-human' ? '非人草稿角色' : '草稿角色';
}

function failedDraftFields(ctx: FinalizeContext, error: any) {
  const rawMessage = String(error?.message || error || '角色生成失败').slice(0, 1000);
  const friendlyMessage = toFriendlyCharacterError(error);
  const now = new Date().toISOString();
  const entityType = fallbackEntityType(ctx.params);
  return {
    name: ctx.userName || draftPlaceholderName(ctx.prompt, ctx.params),
    role: entityType === 'non-human' ? '非人叙事实体' : '自定义角色',
    identity: '生成失败的角色草稿',
    entityType,
    description: ctx.prompt || '（暂无角色描述）',
    reference: {
      status: 'failed',
      updatedAt: now,
      lastFailedAt: now,
      lastError: {
        reason: 'custom_character_generation_failed',
        message: friendlyMessage,
        rawMessage,
      },
    },
    imageFailedAt: now,
    imageLastError: friendlyMessage,
  };
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  let finalizeCtx: FinalizeContext | null = null;
  try {
    const body = await req.json().catch(() => ({} as any));
    const projectId = String(body.projectId || '').trim() || null;
    const prompt = String(body.prompt || '').trim();
    const mediaId = String(body.mediaId || body.uploadId || '').trim();
    const params = normalizeCustomCharacterParams(body.params || {});
    const userName = String(body.name || '').trim().slice(0, 80);
    if (!prompt && !mediaId) return jsonError('请先填写角色描述，或上传一张参考图', 400);

    const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
    if (projectId && !project) return jsonError('没有找到对应的项目，请刷新页面后再试', 404);

    const inputRefs: ToolboxInputRef[] = [];
    let referenceImagePath: string | undefined;
    if (mediaId) {
      const ref: ToolboxInputRef = { role: 'reference', refType: 'upload', refId: mediaId };
      referenceImagePath = assertToolboxImageRefPath(user.id, ref, '参考图');
      inputRefs.push(ref);
    }

    const sourceType = resolveCustomCharacterSourceType(prompt, !!referenceImagePath);

    // 阶段一：点了「生成」就先落一条「生成中」草稿，把输入（提示词/参数/参考图）存好。
    // 这样即使后面慢生成跑到一半被刷新/中断，输入也不会丢，草稿箱里能找回。
    // 每次生成都新建一条独立草稿（不复用旧角色）。
    const placeholderName = userName || draftPlaceholderName(prompt, params);
    const placeholder = createCustomCharacterVersion({
      ownerId: user.id,
      projectId,
      title: placeholderName,
      status: 'running',
      sourceType,
      prompt,
      params,
      inputRefs,
      fields: { name: placeholderName },
      lifecycleStatus: 'draft',
    });
    const characterId = placeholder.character_id;
    const versionId = placeholder.id;
    const versionNo = placeholder.version_no;
    finalizeCtx = { versionId, characterId, projectId, prompt, params, userName };

    if (referenceImagePath) assertReferenceImageGenerationSupported(user);

    // 阶段二：实际生成；跑完把上面的 running 占位回填成完成/失败。
    const structuredFields = await buildCustomCharacterFields({
      user,
      prompt,
      imagePath: referenceImagePath,
      params,
      sourceType,
    });
    const isCrowd = isAnonymousCrowdAsset(structuredFields);
    const rawStyleBible = (project as any)?.styleBible || {};
    const script = (project as any)?.script || (project as any)?.scriptDraft || '';
    const { prompt: imagePrompt, styleLockContext } = buildCustomCharacterImagePrompt({
      fields: structuredFields,
      styleBible: rawStyleBible,
      script,
      sourceType,
    });
    const styleMeta = {
      styleBibleSignature: styleLockContext.signature,
      styleLockVersion: styleLockContext.styleLockVersion,
      resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
    };

    const assetRef = `custom/${characterId}/versions/${versionNo}`;
    const result = await generateImageWithModerationRecovery(user, {
      prompt: imagePrompt,
      size: '1536x1024',
      style: 'natural',
      kind: 'character',
      entityType: structuredFields.entityType,
      characterAssetMode: characterAssetModeFor(structuredFields),
      projectId: projectId || undefined,
      assetRef,
      quality: 'medium',
      referenceImagePath,
      styleLockApplied: styleLockContext.hasMeaningfulStyle,
      styleBackdropColor: styleLockContext.resolvedBackdropColor,
      imageAuditMetadata: {
        styleBibleSignature: styleMeta.styleBibleSignature,
        styleBibleSignatureType: styleLockContext.signatureType,
        resolvedBackdropColor: styleMeta.resolvedBackdropColor || null,
        styleLockVersion: styleMeta.styleLockVersion,
        source: 'custom_character',
      },
      assetLibrary: {
        stage: 'custom_character',
        source: 'generated',
        makeCurrent: false,
      },
    });

    const panelResult = isCrowd ? null : await splitCharacterPanels({
      user,
      projectId,
      assetRef,
      sourceImageUrl: result.url,
      entityType: structuredFields.entityType,
      prompt: result.submittedPrompt,
      version: versionNo,
    });
    const referenceBase = {
      ...structuredFields,
      imagePrompt: structuredFields.imagePrompt,
    };
    const referenceUpdate = isCrowd
      ? deriveCrowdReferenceUpdate(referenceBase, result, styleMeta)
      : deriveCharacterReferenceUpdate(
          referenceBase,
          result,
          panelResult,
          structuredFields.entityType,
          styleMeta,
        );
    const fields = {
      ...referenceUpdate.nextAsset,
      id: characterId,
      imagePrompt: structuredFields.imagePrompt,
      submittedImagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
    };
    // 用户在表单里填了角色名就以它为准；留空才用 AI 生成的名字。
    if (userName) fields.name = userName;
    const version = finalizeCustomCharacterVersion({
      versionId,
      ownerId: user.id,
      status: 'completed',
      fields,
      resultImageId: result.id,
      title: fields.name || structuredFields.name,
    });

    return jsonOk({
      ok: true,
      characterId,
      version: serializeCustomCharacterVersion(version),
      referenceStatus: referenceUpdate.referenceStatus,
      accepted: referenceUpdate.accepted,
      panelError: panelResult && !panelResult.ok ? panelResult.error : null,
    });
  } catch (error: any) {
    console.error('[character-custom] generate failed:', error?.message || error);
    if (finalizeCtx) {
      try {
        const fields = failedDraftFields(finalizeCtx, error);
        const version = finalizeCustomCharacterVersion({
          versionId: finalizeCtx.versionId,
          ownerId: user.id,
          status: 'failed',
          fields,
          resultImageId: null,
          errorMessage: fields.imageLastError,
          title: fields.name,
        });
        return jsonOk({
          ok: false,
          characterId: finalizeCtx.characterId,
          version: serializeCustomCharacterVersion(version),
          error: fields.imageLastError,
        });
      } catch (persistError) {
        console.warn('[character-custom] failed to persist failed generation attempt:', persistError);
      }
    }
    return jsonError(toFriendlyCharacterError(error), error?.status || 500);
  }
}
