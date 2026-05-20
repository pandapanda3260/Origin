import { chargeCredits, CREDIT_PRICES, refundCredits } from './credits';

export type ToolboxBillableTool = 'image' | 'video';

export function toolboxCreditPrice(toolType: ToolboxBillableTool): number {
  return toolType === 'video' ? CREDIT_PRICES.video : CREDIT_PRICES.image;
}

export function toolboxChargeRef(itemId: string) {
  return `toolbox:charge:${itemId}`;
}

export function toolboxRefundRef(itemId: string) {
  return `toolbox:refund:${itemId}`;
}

export function chargeToolboxCredits(opts: {
  userId: number;
  itemId: string;
  toolType: ToolboxBillableTool;
  amount?: number;
}) {
  const amount = opts.amount || toolboxCreditPrice(opts.toolType);
  return chargeCredits({
    userId: opts.userId,
    amount,
    kind: opts.toolType,
    reason: opts.toolType === 'video' ? '工具箱视频生成' : '工具箱图片生成',
    refId: opts.itemId,
    chargeRefId: toolboxChargeRef(opts.itemId),
    idempotencyKey: toolboxChargeRef(opts.itemId),
  });
}

export function refundToolboxCredits(opts: {
  userId: number;
  itemId: string;
  toolType: ToolboxBillableTool;
  amount?: number;
  reason?: string;
}) {
  const amount = opts.amount || toolboxCreditPrice(opts.toolType);
  return refundCredits({
    userId: opts.userId,
    amount,
    reason: opts.reason || (opts.toolType === 'video' ? '工具箱视频生成失败退款' : '工具箱图片生成失败退款'),
    refId: opts.itemId,
    refundRefId: toolboxRefundRef(opts.itemId),
    idempotencyKey: toolboxRefundRef(opts.itemId),
  });
}
