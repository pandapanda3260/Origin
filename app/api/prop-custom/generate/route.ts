import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { assertToolboxImageRefPath } from '@/lib/toolbox-media';
import type { ToolboxInputRef } from '@/lib/toolbox-modes';
import {
  createCustomPropVersion,
  finalizeCustomPropVersion,
  serializeCustomPropVersion,
} from '@/lib/custom-prop-db';
import {
  buildCustomPropFields,
  normalizeCustomPropParams,
  resolveCustomPropSourceType,
  toFriendlyPropError,
  type CustomPropParams,
  type CustomPropSourceType,
} from '@/lib/custom-prop-prompt';
import {
  assertReferenceImageGenerationSupported,
  generateCustomPropImage,
} from '@/lib/custom-prop-generation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FinalizeContext = {
  versionId: string;
  propId: string;
  projectId: string | null;
  prompt: string;
  params: CustomPropParams;
  title: string;
};

function draftPlaceholderName(prompt: string, title?: string) {
  const explicit = String(title || '').trim();
  if (explicit) return explicit.slice(0, 80);
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  return text ? (text.replace(/[，。,.!！?？].*$/, '').slice(0, 14) || '草稿道具') : '草稿道具';
}

function failedDraftPropData(ctx: FinalizeContext, error: any) {
  const rawMessage = String(error?.message || error || '道具生成失败').slice(0, 1000);
  const friendlyMessage = toFriendlyPropError(error);
  const now = new Date().toISOString();
  return {
    name: ctx.title || draftPlaceholderName(ctx.prompt),
    propType: ctx.params.propType || '道具',
    description: ctx.prompt || '（暂无道具描述）',
    material: ctx.params.material || '',
    dimensionality: ctx.params.dimensionality === 'flat' || ctx.params.dimensionality === 'volumetric' ? ctx.params.dimensionality : 'volumetric',
    reference: {
      status: 'failed',
      updatedAt: now,
      lastFailedAt: now,
      lastError: {
        reason: 'custom_prop_generation_failed',
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
    const params = normalizeCustomPropParams(body.params || {});
    const title = String(body.title || body.name || '').trim().slice(0, 80);
    if (!prompt && !mediaId) return jsonError('请先填写道具描述，或上传一张参考图', 400);

    const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
    if (projectId && !project) return jsonError('没有找到对应的项目，请刷新页面后再试', 404);

    const inputRefs: ToolboxInputRef[] = [];
    let referenceImagePath: string | undefined;
    if (mediaId) {
      const ref: ToolboxInputRef = { role: 'reference', refType: 'upload', refId: mediaId };
      referenceImagePath = assertToolboxImageRefPath(user.id, ref, '参考图');
      assertReferenceImageGenerationSupported(user);
      inputRefs.push(ref);
    }

    const sourceType: CustomPropSourceType = resolveCustomPropSourceType(prompt, !!referenceImagePath);
    const placeholderName = draftPlaceholderName(prompt, title);
    const placeholder = createCustomPropVersion({
      ownerId: user.id,
      projectId,
      title: placeholderName,
      generationStatus: 'running',
      sourceType,
      prompt,
      params,
      inputRefs,
      propData: { name: placeholderName },
      lifecycleStatus: 'draft',
    });
    const propId = placeholder.prop_id;
    const versionId = placeholder.id;
    const versionNo = placeholder.version_no;
    finalizeCtx = { versionId, propId, projectId, prompt, params, title: placeholderName };

    const structuredFields = await buildCustomPropFields({
      user,
      prompt,
      imagePath: referenceImagePath,
      params,
      sourceType,
      tokenContext: {
        ownerId: user.id,
        usernameSnapshot: user.phone || user.display_name || user.username || null,
        projectId,
        projectTitleSnapshot: (project as any)?.title || null,
        requestPath: req.nextUrl.pathname,
        routeName: 'prop-custom.generate',
        moduleKey: 'assets',
        moduleLabel: '资产生成',
        featureKey: 'custom_prop_vision',
        featureLabel: '自定义道具参考图识别',
        callItemType: 'custom_prop_version',
        callItemId: versionId,
        callItemLabel: placeholderName,
        operationKey: `custom-prop:${versionId}:vision`,
        operationLabel: '自定义道具参考图识别',
        meta: {
          propId,
          sourceType,
          hasReferenceImage: !!referenceImagePath,
        },
      },
    });
    if (title) structuredFields.name = title;
    const assetRef = `custom-prop/${propId}/versions/${versionNo}`;
    const generated = await generateCustomPropImage({
      user,
      fields: structuredFields,
      styleBible: (project as any)?.styleBible || {},
      projectId,
      assetRef,
      sourceType,
      referenceImagePath,
      version: versionNo,
    });
    const version = finalizeCustomPropVersion({
      versionId,
      ownerId: user.id,
      generationStatus: 'completed',
      propData: generated.propData,
      resultImageId: generated.result.id,
      errorMessage: generated.splitResult && !generated.splitResult.ok ? generated.splitResult.error : null,
      title: generated.propData.name || structuredFields.name,
    });

    return jsonOk({
      ok: generated.accepted,
      propId,
      version: serializeCustomPropVersion(version),
      referenceStatus: generated.referenceStatus,
      accepted: generated.accepted,
      viewsError: generated.splitResult && !generated.splitResult.ok ? generated.splitResult.error : undefined,
    });
  } catch (error: any) {
    console.error('[prop-custom] generate failed:', error?.message || error);
    if (finalizeCtx) {
      try {
        const propData = failedDraftPropData(finalizeCtx, error);
        const version = finalizeCustomPropVersion({
          versionId: finalizeCtx.versionId,
          ownerId: user.id,
          generationStatus: 'failed',
          propData,
          resultImageId: null,
          errorMessage: propData.imageLastError,
          title: propData.name,
        });
        return jsonOk({
          ok: false,
          propId: finalizeCtx.propId,
          version: serializeCustomPropVersion(version),
          error: propData.imageLastError,
        });
      } catch (finalizeError) {
        console.error('[prop-custom] failed to finalize failed draft:', finalizeError);
      }
    }
    return jsonError(toFriendlyPropError(error), error?.status || 500);
  }
}
