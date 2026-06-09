import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getBalance } from '@/lib/credits';
import { generateImage } from '@/lib/image-gen';
import { generateVideo } from '@/lib/video-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { chargeToolboxCredits, refundToolboxCredits, toolboxCreditPrice } from '@/lib/toolbox-billing';
import {
  countRunningVideoToolboxItems,
  createToolboxItem,
  getToolboxItemForUser,
  serializeToolboxItem,
  syncRunningVideoToolboxItems,
  updateToolboxItem,
} from '@/lib/toolbox-db';
import { TOOLBOX_VIDEO_RUNNING_LIMIT } from '@/lib/toolbox-limits';
import { assertToolboxImageRefPath } from '@/lib/toolbox-media';
import {
  AssetQuotaError,
  assertCanStartAssetGeneration,
  createGenerationBatch,
  finishGenerationBatch,
  recordGenerationFailure,
} from '@/lib/asset-library';
import {
  buildToolboxVideoPrompt,
  imageSizeForToolboxRatio,
  normalizeToolboxVideoRatio,
  toolboxImageFriendlyError,
  toolboxVideoFriendlyError,
  type ToolboxInputRef,
} from '@/lib/toolbox-modes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseJson(value: string | null | undefined, fallback: any) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function findRef(refs: ToolboxInputRef[], role: ToolboxInputRef['role']) {
  return refs.find((ref) => ref.role === role) || null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const parent = getToolboxItemForUser(params.id, user.id);
  if (!parent) return jsonError('工具箱历史不存在', 404);
  if (parent.status !== 'completed') return jsonError('只有已完成结果可以重绘高清', 400);
  if (parent.source_type === 'upload') return jsonError('上传项不支持重绘高清', 400);
  if (!parent.result_ref_id) return jsonError('原结果已删除，无法重绘高清', 400);

  const parentParams = parseJson(parent.params_json, {});
  const inputRefs = parseJson(parent.input_refs_json, []) as ToolboxInputRef[];
  const toolType = parent.tool_type;

  if (toolType === 'image') {
    let referencePath: string | null = null;
    try {
      referencePath = parent.mode === 'image_to_image'
        ? assertToolboxImageRefPath(user.id, inputRefs[0], '参考图')
        : null;
    } catch (error: any) {
      return jsonError(error?.message || '参考图不存在或已删除', error?.status || 400);
    }
    let imageSize;
    try {
      imageSize = imageSizeForToolboxRatio(parentParams.ratio || '1:1');
    } catch {
      return jsonError('图片比例无效，无法重绘高清', 400);
    }
    const creditAmount = toolboxCreditPrice('image');
    const balance = getBalance(user.id);
    if (balance.totalCredits <= 0) {
      return jsonError(`积分不足：当前余额 ${balance.totalCredits} 积分，请充值后再试`, 402);
    }
    try {
      assertCanStartAssetGeneration(user.id);
    } catch (error: any) {
      if (error instanceof AssetQuotaError) return jsonError(error.message, error.status);
      throw error;
    }
    const itemId = randomUUID();
    chargeToolboxCredits({ userId: user.id, itemId, toolType: 'image', amount: creditAmount });
    const item = createToolboxItem({
      id: itemId,
      ownerId: user.id,
      toolType: 'image',
      mode: parent.mode,
      sourceType: 'enhance',
      status: 'running',
      prompt: parent.prompt,
      params: {
        ...parentParams,
        count: 1,
        enhance: true,
        billing: { creditAmount },
      },
      inputRefs,
      resultRefType: 'image',
      resultRefId: null,
      parentItemId: parent.id,
    });
    const batchId = createGenerationBatch({
      ownerId: user.id,
      stage: 'toolbox_image',
      requestedCount: 1,
      contextSnapshot: {
        route: 'api_toolbox_image_enhance',
        itemId,
        parentItemId: parent.id,
        mode: parent.mode,
        ratio: parentParams.ratio,
        imageSize,
      },
      source: 'toolbox',
    });
    try {
      const result = await generateImage(user, {
        prompt: parent.prompt,
        size: imageSize,
        style: 'natural',
        quality: 'high',
        kind: 'other',
        assetRef: `toolbox/${itemId}`,
        referenceImagePath: referencePath || undefined,
        assetLibrary: {
          batchId,
          stage: 'toolbox_image',
          source: 'toolbox',
          makeCurrent: false,
        },
      });
      finishGenerationBatch(batchId, user.id);
      const updated = updateToolboxItem(item.id, user.id, {
        status: 'completed',
        resultRefId: result.id,
        errorMessage: null,
      });
      return jsonOk({ ok: true, item: serializeToolboxItem(updated || item) });
    } catch (error: any) {
      const message = String(error?.message || error || '图片重绘失败').slice(0, 1000);
      console.error('[toolbox][image][enhance] failed', { mode: parent.mode, message });
      recordGenerationFailure({
        batchId,
        ownerId: user.id,
        failureReason: 'provider_error',
        errorMessage: message,
      });
      finishGenerationBatch(batchId, user.id, 'failed');
      refundToolboxCredits({ userId: user.id, itemId, toolType: 'image', amount: creditAmount });
      const updated = updateToolboxItem(item.id, user.id, {
        status: 'failed',
        errorMessage: toolboxImageFriendlyError(message),
      });
      return jsonOk({ ok: true, item: serializeToolboxItem(updated || item) });
    }
  }

  syncRunningVideoToolboxItems(user.id);
  if (countRunningVideoToolboxItems(user.id) >= TOOLBOX_VIDEO_RUNNING_LIMIT) {
    return jsonError('当前已有视频生成任务进行中，请稍后再试', 409);
  }
  if (parentParams.resolution !== '720p') return jsonError('当前视频已经是最高可用清晰度', 400);
  const nextParams = {
    ...parentParams,
    resolution: '1080p',
    enhance: true,
  };
  let videoRatio;
  try {
    videoRatio = normalizeToolboxVideoRatio(nextParams.ratio || '9:16');
  } catch {
    return jsonError('视频画面比例无效，无法重绘高清', 400);
  }
  const firstRef = findRef(inputRefs, 'first_frame') || findRef(inputRefs, 'reference');
  const tailRef = findRef(inputRefs, 'tail_frame');
  let firstFramePath: string;
  let tailFramePath: string | null = null;
  try {
    firstFramePath = assertToolboxImageRefPath(user.id, firstRef, '首帧图');
    tailFramePath = parent.mode === 'first_last_frame_video'
      ? assertToolboxImageRefPath(user.id, tailRef, '尾帧图')
      : null;
  } catch (error: any) {
    return jsonError(error?.message || '参考图不存在或已删除', error?.status || 400);
  }
  const creditAmount = toolboxCreditPrice('video');
  nextParams.billing = { creditAmount };
  const balance = getBalance(user.id);
  if (balance.totalCredits <= 0) {
    return jsonError(`积分不足：当前余额 ${balance.totalCredits} 积分，请充值后再试`, 402);
  }
  const itemId = randomUUID();
  chargeToolboxCredits({ userId: user.id, itemId, toolType: 'video', amount: creditAmount });
  const videoTaskId = randomUUID();
  const item = createToolboxItem({
    id: itemId,
    ownerId: user.id,
    toolType: 'video',
    mode: parent.mode,
    sourceType: 'enhance',
    status: 'running',
    prompt: parent.prompt,
    params: nextParams,
    inputRefs,
    resultRefType: 'video',
    resultRefId: videoTaskId,
    parentItemId: parent.id,
  });
  // 后台异步重绘：请求立即返回 running，完成/失败由后台回调回写并在失败时退款（保留既有产物逻辑，不改主线）。
  void (async () => {
    try {
      const result = await generateVideo(user, {
        taskId: videoTaskId,
        prompt: buildToolboxVideoPrompt(parent.prompt, nextParams),
        ratio: videoRatio,
        resolution: '1080p',
        durationSec: Number(nextParams.durationSec || 4),
        referenceImagePath: firstFramePath,
        referenceImageRole: 'first_frame',
        seedanceImageMode: 'strict_first_frame',
        firstLastFrameMode: tailFramePath
          ? {
            firstFramePath,
            lastFramePath: tailFramePath,
            modeReason: 'toolbox_enhance_first_last_frame',
          }
          : undefined,
      });
      if (result.status === 'completed') {
        updateToolboxItem(item.id, user.id, { status: 'completed', errorMessage: null });
      } else {
        refundToolboxCredits({ userId: user.id, itemId, toolType: 'video', amount: creditAmount });
        updateToolboxItem(item.id, user.id, { status: 'failed', errorMessage: '视频重绘失败，请稍后重试' });
      }
    } catch (error: any) {
      const message = String(error?.message || error || '视频重绘失败').slice(0, 1000);
      console.error('[toolbox][video][enhance] failed', { mode: parent.mode, message });
      refundToolboxCredits({ userId: user.id, itemId, toolType: 'video', amount: creditAmount });
      updateToolboxItem(item.id, user.id, { status: 'failed', errorMessage: toolboxVideoFriendlyError(message, parent.mode) });
    }
  })();

  return jsonOk({ ok: true, item: serializeToolboxItem(item) });
}
