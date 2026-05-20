import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getBalance, InsufficientCreditsError } from '@/lib/credits';
import { generateImage } from '@/lib/image-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { chargeToolboxCredits, refundToolboxCredits, toolboxCreditPrice } from '@/lib/toolbox-billing';
import { createToolboxItem, serializeToolboxItem, updateToolboxItem } from '@/lib/toolbox-db';
import { TOOLBOX_IMAGE_GENERATION_MAX_COUNT, TOOLBOX_IMAGE_REFERENCE_MAX_COUNT } from '@/lib/toolbox-limits';
import { assertToolboxImageRefPath } from '@/lib/toolbox-media';
import {
  imageSizeForToolboxRatio,
  normalizeToolboxImageRatio,
  normalizeToolboxMode,
  type ToolboxInputRef,
} from '@/lib/toolbox-modes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeCount(raw: unknown) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 1;
  return Math.min(TOOLBOX_IMAGE_GENERATION_MAX_COUNT, n);
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const mode = normalizeToolboxMode(body.mode);
  if (mode !== 'text_to_image' && mode !== 'image_to_image') return jsonError('图片生成模式无效', 400);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return jsonError('缺少提示词', 400);
  const params = body.params && typeof body.params === 'object' ? body.params : {};
  const count = normalizeCount(params.count ?? body.count);
  const inputRefs = Array.isArray(body.inputRefs) ? body.inputRefs as ToolboxInputRef[] : [];
  if (mode === 'image_to_image' && inputRefs.length < 1) return jsonError('图生图需要 1 张参考图', 400);
  if (inputRefs.length > TOOLBOX_IMAGE_REFERENCE_MAX_COUNT) return jsonError('图生图 MVP 最多支持 1 张参考图', 400);
  const ratio = normalizeToolboxImageRatio(params.ratio || body.ratio || '1:1');
  if (!ratio) return jsonError('图片比例无效', 400);
  const imageSize = imageSizeForToolboxRatio(ratio);

  const totalCost = toolboxCreditPrice('image') * count;
  const balance = getBalance(user.id);
  if (balance.totalCredits < totalCost) {
    return jsonError(`积分不足：本次需 ${totalCost} 积分，当前余额 ${balance.totalCredits} 积分`, 402);
  }

  let referencePath: string | null = null;
  try {
    referencePath = mode === 'image_to_image'
      ? assertToolboxImageRefPath(user.id, inputRefs[0], '参考图')
      : null;
  } catch (error: any) {
    return jsonError(error?.message || '参考图不存在或已删除', error?.status || 400);
  }
  const items: any[] = [];
  for (let i = 0; i < count; i += 1) {
    const itemId = randomUUID();
    const creditAmount = toolboxCreditPrice('image');
    try {
      chargeToolboxCredits({ userId: user.id, itemId, toolType: 'image', amount: creditAmount });
    } catch (error: any) {
      if (error instanceof InsufficientCreditsError) {
        if (items.length > 0) {
          return jsonOk({ ok: true, items, partial: true, error: error.message });
        }
        return jsonError(error.message, error.status);
      }
      throw error;
    }
    const item = createToolboxItem({
      id: itemId,
      ownerId: user.id,
      toolType: 'image',
      mode,
      sourceType: 'generated',
      status: 'running',
      prompt,
      params: {
        ...params,
        count,
        ratio,
        billing: { creditAmount },
      },
      inputRefs,
      resultRefType: 'image',
      resultRefId: null,
    });
    try {
      const result = await generateImage(user, {
        prompt,
        size: imageSize,
        style: 'natural',
        quality: params.quality || 'medium',
        kind: 'other',
        assetRef: `toolbox/${itemId}`,
        referenceImagePath: referencePath || undefined,
      });
      const updated = updateToolboxItem(item.id, user.id, {
        status: 'completed',
        resultRefId: result.id,
        errorMessage: null,
      });
      items.push(serializeToolboxItem(updated || item));
    } catch (error: any) {
      const message = String(error?.message || error || '图片生成失败').slice(0, 1000);
      refundToolboxCredits({ userId: user.id, itemId, toolType: 'image', amount: creditAmount });
      const updated = updateToolboxItem(item.id, user.id, {
        status: 'failed',
        errorMessage: message,
      });
      items.push(serializeToolboxItem(updated || item));
    }
  }

  return jsonOk({ ok: true, items });
}
