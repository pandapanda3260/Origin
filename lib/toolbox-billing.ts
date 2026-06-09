import { CREDIT_PRICES, getBalance } from './credits';

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
  const balance = getBalance(opts.userId);
  return { ledgerId: null, balanceAfter: balance.totalCredits, legacySkipped: true };
}

export function refundToolboxCredits(opts: {
  userId: number;
  itemId: string;
  toolType: ToolboxBillableTool;
  amount?: number;
  reason?: string;
}) {
  const balance = getBalance(opts.userId);
  return { ledgerId: null, balanceAfter: balance.totalCredits, alreadyApplied: true, legacySkipped: true };
}
