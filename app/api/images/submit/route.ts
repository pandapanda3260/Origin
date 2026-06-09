import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { generateImage } from '@/lib/image-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { InsufficientCreditsError } from '@/lib/credits';
import { assertCanStartPaidOperation } from '@/lib/usage-billing';
import {
  AssetQuotaError,
  assertCanStartAssetGeneration,
  createGenerationBatch,
  finishGenerationBatch,
  recordGenerationFailure,
} from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function stageForImage(kind: string, assetRef: string | undefined) {
  if (kind === 'character') return 'asset_character';
  if (kind === 'scene') return 'asset_scene';
  if (kind === 'prop') return 'asset_prop';
  if (kind === 'storyboard') return 'storyboard';
  if (/firstFrame/i.test(String(assetRef || ''))) return 'first_frame';
  if (/tailFrame/i.test(String(assetRef || ''))) return 'tail_frame';
  return 'image';
}

/**
 * 单图同步生成入口（不走 batch）。
 * 适用场景：用户在某个角色卡片上单独点"重新生成参考图"等。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const prompt: string = (body.prompt || body.imagePrompt || '').toString().trim();
  if (!prompt) return jsonError('缺 prompt', 400);

  const kind = (body.kind || 'other').toString();
  const projectId: string | undefined = body.projectId;
  const assetRef: string | undefined = body.assetRef;
  // 单图重生时如果调用方没指定 size，按 kind 给出与 batch executor 一致的默认值，
  // 这样"重新生成参考图"出来的图也是 1536×1024 的 4 宫格 / 6 宫格布局，而不是
  // 1024×1024 的方图（之前会塞不下 4/6 个 panel，画面被压缩得很糊）。
  const sizeDefault = kind === 'character' || kind === 'scene' ? '1536x1024' : '1024x1024';
  const size = body.size || sizeDefault;
  const style = body.style || (kind === 'storyboard' ? 'pencil' : 'natural');
  // 单图重生与 batch 保持一致：character/scene 用 medium 画质，prop / 其它用 low
  const qualityDefault = (kind === 'character' || kind === 'scene') ? 'medium' : 'low';
  const quality = body.quality || qualityDefault;
  // 角色非人/真人区分（从 body.entityType 显式传入；不传默认 human）
  const entityType: 'human' | 'non-human' | undefined =
    kind === 'character' ? (body.entityType === 'non-human' ? 'non-human' : 'human') : undefined;
	  try {
	    assertCanStartAssetGeneration(user.id);
      assertCanStartPaidOperation(user.id);
	  } catch (error: any) {
	    if (error instanceof AssetQuotaError) return jsonError(error.message, error.status);
      if (error instanceof InsufficientCreditsError) return jsonError(error.message, 402);
	    throw error;
	  }
  const batchId = createGenerationBatch({
    ownerId: user.id,
    projectId: projectId || null,
    stage: stageForImage(kind, assetRef),
    requestedCount: 1,
    contextSnapshot: {
      route: 'api_images_submit',
      kind,
      assetRef: assetRef || null,
      size,
      style,
      quality,
    },
    source: projectId ? 'project' : 'toolbox',
  });

  try {
    const result = await generateImage(user, {
      prompt,
      size,
      style,
      kind: ['character', 'scene', 'prop', 'storyboard'].includes(kind) ? kind : 'other',
      entityType,
      quality,
      projectId,
      assetRef,
      assetLibrary: {
        batchId,
        stage: stageForImage(kind, assetRef),
        source: projectId ? 'generated' : 'toolbox',
        makeCurrent: !!projectId,
      },
    } as any);
    finishGenerationBatch(batchId, user.id);
    return jsonOk({
      ok: true,
      taskId: result.id,
      url: result.url,
      width: result.width,
      height: result.height,
      mode: result.mode,
    });
  } catch (e: any) {
    recordGenerationFailure({
      batchId,
      ownerId: user.id,
      failureReason: 'provider_error',
      errorMessage: e?.message || String(e),
    });
    finishGenerationBatch(batchId, user.id, 'failed');
    return jsonError('图像生成失败：' + (e?.message || String(e)), 502);
  }
}
