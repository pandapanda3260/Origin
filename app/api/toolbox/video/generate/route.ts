import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getBalance, InsufficientCreditsError } from '@/lib/credits';
import { generateVideo } from '@/lib/video-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { chargeToolboxCredits, refundToolboxCredits, toolboxCreditPrice } from '@/lib/toolbox-billing';
import {
  countRunningVideoToolboxItems,
  createToolboxItem,
  serializeToolboxItem,
  syncRunningVideoToolboxItems,
  updateToolboxItem,
} from '@/lib/toolbox-db';
import { TOOLBOX_VIDEO_RUNNING_LIMIT } from '@/lib/toolbox-limits';
import {
  AssetQuotaError,
  assertCanStartAssetGeneration,
  createGenerationBatch,
  finishGenerationBatch,
  recordGenerationFailure,
} from '@/lib/asset-library';
import { assertToolboxImageRefPath } from '@/lib/toolbox-media';
import {
  buildToolboxVideoPrompt,
  normalizeToolboxMode,
  normalizeToolboxVideoRatio,
  normalizeToolboxVideoResolution,
  type ToolboxInputRef,
} from '@/lib/toolbox-modes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function findRef(refs: ToolboxInputRef[], role: ToolboxInputRef['role']) {
  return refs.find((ref) => ref.role === role) || null;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  syncRunningVideoToolboxItems(user.id);
  if (countRunningVideoToolboxItems(user.id) >= TOOLBOX_VIDEO_RUNNING_LIMIT) {
    return jsonError('当前已有视频生成任务进行中，请稍后再试', 409);
  }

  const body = await req.json().catch(() => ({} as any));
  const mode = normalizeToolboxMode(body.mode);
  if (mode !== 'image_to_video' && mode !== 'first_last_frame_video') return jsonError('视频生成模式无效', 400);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return jsonError('缺少提示词', 400);
  const params = body.params && typeof body.params === 'object' ? body.params : {};
  const inputRefs = Array.isArray(body.inputRefs) ? body.inputRefs as ToolboxInputRef[] : [];
  const firstRef = findRef(inputRefs, 'first_frame') || findRef(inputRefs, 'reference');
  if (!firstRef) return jsonError('视频生成需要首帧图', 400);
  const tailRef = findRef(inputRefs, 'tail_frame');
  let ratio;
  try {
    ratio = normalizeToolboxVideoRatio(params.ratio || body.ratio || '9:16');
  } catch {
    return jsonError('视频画面比例无效', 400);
  }
  const resolution = normalizeToolboxVideoResolution(params.resolution);
  let firstFramePath: string;
  let tailFramePath: string | null = null;
  try {
    firstFramePath = assertToolboxImageRefPath(user.id, firstRef, '首帧图');
    tailFramePath = mode === 'first_last_frame_video'
      ? assertToolboxImageRefPath(user.id, tailRef, '尾帧图')
      : null;
  } catch (error: any) {
    return jsonError(error?.message || '参考图不存在或已删除', error?.status || 400);
  }

  const creditAmount = toolboxCreditPrice('video');
  const balance = getBalance(user.id);
  if (balance.totalCredits < creditAmount) {
    return jsonError(`积分不足：本次需 ${creditAmount} 积分，当前余额 ${balance.totalCredits} 积分`, 402);
  }
  try {
    assertCanStartAssetGeneration(user.id);
  } catch (error: any) {
    if (error instanceof AssetQuotaError) return jsonError(error.message, error.status);
    throw error;
  }

  const itemId = randomUUID();
  const videoTaskId = randomUUID();
  try {
    chargeToolboxCredits({ userId: user.id, itemId, toolType: 'video', amount: creditAmount });
  } catch (error: any) {
    if (error instanceof InsufficientCreditsError) return jsonError(error.message, error.status);
    throw error;
  }

  const storedParams = {
    ...params,
    ratio,
    resolution,
    durationSec: Number(params.durationSec || 4),
    billing: { creditAmount },
  };
  const item = createToolboxItem({
    id: itemId,
    ownerId: user.id,
    toolType: 'video',
    mode,
    sourceType: 'generated',
    status: 'running',
    prompt,
    params: storedParams,
    inputRefs,
    resultRefType: 'video',
    resultRefId: videoTaskId,
  });
  const batchId = createGenerationBatch({
    batchId: itemId,
    ownerId: user.id,
    stage: 'toolbox_video',
    requestedCount: 1,
    contextSnapshot: {
      route: 'api_toolbox_video_generate',
      itemId,
      videoTaskId,
      mode,
      ratio,
      resolution,
      durationSec: storedParams.durationSec,
    },
    source: 'toolbox',
  });

  try {
    const result = await generateVideo(user, {
      taskId: videoTaskId,
      prompt: buildToolboxVideoPrompt(prompt, storedParams),
      ratio: storedParams.ratio,
      resolution: storedParams.resolution,
      durationSec: storedParams.durationSec,
      referenceImagePath: firstFramePath,
      referenceImageRole: 'first_frame',
      seedanceImageMode: 'strict_first_frame',
      firstLastFrameMode: tailFramePath
        ? {
          firstFramePath,
          lastFramePath: tailFramePath,
          modeReason: 'toolbox_first_last_frame',
        }
        : undefined,
      assetLibrary: {
        batchId,
        stage: 'toolbox_video',
        source: 'toolbox',
        makeCurrent: false,
      },
    });
    if (result.status === 'failed') {
      recordGenerationFailure({
        batchId,
        ownerId: user.id,
        failureReason: 'provider_error',
        errorMessage: '视频生成失败',
      });
      finishGenerationBatch(batchId, user.id, 'failed');
      refundToolboxCredits({ userId: user.id, itemId, toolType: 'video', amount: creditAmount });
      const updated = updateToolboxItem(item.id, user.id, {
        status: 'failed',
        errorMessage: '视频生成失败',
      });
      return jsonOk({ ok: true, item: serializeToolboxItem(updated || item) });
    }
    if (result.status === 'completed') {
      finishGenerationBatch(batchId, user.id);
      const updated = updateToolboxItem(item.id, user.id, {
        status: 'completed',
        errorMessage: null,
      });
      return jsonOk({ ok: true, item: serializeToolboxItem(updated || item) });
    }
    return jsonOk({ ok: true, item: serializeToolboxItem(item) });
  } catch (error: any) {
    const message = String(error?.message || error || '视频生成失败').slice(0, 1000);
    recordGenerationFailure({
      batchId,
      ownerId: user.id,
      failureReason: 'provider_error',
      errorMessage: message,
    });
    finishGenerationBatch(batchId, user.id, 'failed');
    refundToolboxCredits({ userId: user.id, itemId, toolType: 'video', amount: creditAmount });
    const updated = updateToolboxItem(item.id, user.id, {
      status: 'failed',
      errorMessage: message,
    });
    return jsonOk({ ok: true, item: serializeToolboxItem(updated || item) });
  }
}
