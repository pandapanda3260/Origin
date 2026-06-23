import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { assertToolboxImageRefPath } from '@/lib/toolbox-media';
import type { ToolboxInputRef } from '@/lib/toolbox-modes';
import {
  createCustomSceneVersion,
  finalizeCustomSceneVersion,
  serializeCustomSceneVersion,
} from '@/lib/custom-scene-db';
import {
  buildCustomSceneFields,
  normalizeCustomSceneParams,
  resolveCustomSceneSourceType,
  toFriendlySceneError,
  type CustomSceneParams,
  type CustomSceneSourceType,
} from '@/lib/custom-scene-prompt';
import {
  assertReferenceImageGenerationSupported,
  generateCustomSceneEstablishing,
} from '@/lib/custom-scene-generation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FinalizeContext = {
  versionId: string;
  sceneId: string;
  projectId: string | null;
  prompt: string;
  params: CustomSceneParams;
  title: string;
};

function draftPlaceholderName(prompt: string, title?: string) {
  const explicit = String(title || '').trim();
  if (explicit) return explicit.slice(0, 80);
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  return text ? (text.replace(/[，。,.!！?？].*$/, '').slice(0, 14) || '草稿场景') : '草稿场景';
}

function failedDraftSceneData(ctx: FinalizeContext, error: any) {
  const rawMessage = String(error?.message || error || '场景生成失败').slice(0, 1000);
  const friendlyMessage = toFriendlySceneError(error);
  const now = new Date().toISOString();
  return {
    name: ctx.title || draftPlaceholderName(ctx.prompt),
    location: '',
    description: ctx.prompt || '（暂无场景描述）',
    timeSetting: ctx.params.timeSetting || '',
    weather: ctx.params.weather || '',
    lighting: ctx.params.lighting || '',
    atmosphere: ctx.params.atmosphere || '',
    elements: [],
    reference: {
      status: 'failed',
      updatedAt: now,
      lastFailedAt: now,
      lastError: {
        reason: 'custom_scene_generation_failed',
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
    const params = normalizeCustomSceneParams(body.params || {});
    const title = String(body.title || body.name || '').trim().slice(0, 80);
    if (!prompt && !mediaId) return jsonError('请先填写场景描述，或上传一张参考图', 400);

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

    const sourceType: CustomSceneSourceType = resolveCustomSceneSourceType(prompt, !!referenceImagePath);
    const placeholderName = draftPlaceholderName(prompt, title);
    const placeholder = createCustomSceneVersion({
      ownerId: user.id,
      projectId,
      title: placeholderName,
      generationStatus: 'running',
      sourceType,
      prompt,
      params,
      inputRefs,
      sceneData: { name: placeholderName },
      lifecycleStatus: 'draft',
    });
    const sceneId = placeholder.scene_id;
    const versionId = placeholder.id;
    const versionNo = placeholder.version_no;
    finalizeCtx = { versionId, sceneId, projectId, prompt, params, title: placeholderName };

    const structuredFields = await buildCustomSceneFields({
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
        routeName: 'scene-custom.generate',
        moduleKey: 'assets',
        moduleLabel: '资产生成',
        featureKey: 'custom_scene_vision',
        featureLabel: '自定义场景参考图识别',
        callItemType: 'custom_scene_version',
        callItemId: versionId,
        callItemLabel: placeholderName,
        operationKey: `custom-scene:${versionId}:vision`,
        operationLabel: '自定义场景参考图识别',
        meta: {
          sceneId,
          sourceType,
          hasReferenceImage: !!referenceImagePath,
        },
      },
    });
    if (title) structuredFields.name = title;
    const assetRef = `custom-scene/${sceneId}/versions/${versionNo}/views/establishing`;
    const generated = await generateCustomSceneEstablishing({
      user,
      fields: structuredFields,
      styleBible: (project as any)?.styleBible || {},
      projectId,
      assetRef,
      sourceType,
      referenceImagePath,
    });
    const version = finalizeCustomSceneVersion({
      versionId,
      ownerId: user.id,
      generationStatus: 'completed',
      sceneData: generated.sceneData,
      resultImageId: generated.result.id,
      title: generated.sceneData.name || structuredFields.name,
    });

    return jsonOk({
      ok: true,
      sceneId,
      version: serializeCustomSceneVersion(version),
      referenceStatus: 'ready',
      accepted: true,
    });
  } catch (error: any) {
    console.error('[scene-custom] generate failed:', error?.message || error);
    if (finalizeCtx) {
      try {
        const sceneData = failedDraftSceneData(finalizeCtx, error);
        const version = finalizeCustomSceneVersion({
          versionId: finalizeCtx.versionId,
          ownerId: user.id,
          generationStatus: 'failed',
          sceneData,
          resultImageId: null,
          errorMessage: sceneData.imageLastError,
          title: sceneData.name,
        });
        return jsonOk({
          ok: false,
          sceneId: finalizeCtx.sceneId,
          version: serializeCustomSceneVersion(version),
          error: sceneData.imageLastError,
        });
      } catch (finalizeError) {
        console.error('[scene-custom] failed to finalize failed draft:', finalizeError);
      }
    }
    return jsonError(toFriendlySceneError(error), error?.status || 500);
  }
}
