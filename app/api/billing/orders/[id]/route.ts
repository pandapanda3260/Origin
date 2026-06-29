import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { fulfillPaidOrder } from '@/lib/billing-fulfill';
import { toBillingOrderPayload } from '@/lib/billing-order-payload';
import { getWechatPayConfig, queryWechatPaymentByOutTradeNo, WechatPayConfigError, WechatPayGatewayError } from '@/lib/wechat-pay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM billing_orders WHERE id = @id AND user_id = @uid')
    .get({ id: params.id, uid: user.id });
  if (!row) return jsonError('订单不存在', 404);
  const reconciled = await reconcileWechatOrderIfPaid(row);
  return jsonOk(toBillingOrderPayload(reconciled || row, user.id));
}

async function reconcileWechatOrderIfPaid(row: any) {
  if (row.provider !== 'wechat' || row.status !== 'pending') return row;
  try {
    const cfg = getWechatPayConfig();
    const result = await queryWechatPaymentByOutTradeNo(row.id);
    const tx = result.transaction;
    if (tx.appid !== cfg.appId || tx.mchid !== cfg.mchId) {
      throw new WechatPayGatewayError('微信支付订单查询商户号或 AppID 不匹配。', 400);
    }
    if (tx.trade_state !== 'SUCCESS') return row;
    if (Number(tx.amount?.total || 0) !== Number(row.amount_cents || 0)) {
      throw new WechatPayGatewayError('微信支付订单查询金额不匹配。', 400);
    }

    const meta = mergeMetaJson(row.meta_json, {
      wechat: {
        transactionId: tx.transaction_id || '',
        tradeState: tx.trade_state || '',
        successTime: tx.success_time || '',
        amount: tx.amount || null,
        queriedAt: new Date().toISOString(),
        queryVerified: result.responseVerified,
      },
    });
    const db = getDb();
    db.prepare(
      `UPDATE billing_orders
          SET provider_ref = COALESCE(NULLIF(?, ''), provider_ref),
              meta_json = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(tx.transaction_id || '', JSON.stringify(meta), row.id);
    fulfillPaidOrder({ userId: Number(row.user_id), orderId: row.id, via: '微信支付查询' });
    return db
      .prepare<{ id: string; uid: number }, any>('SELECT * FROM billing_orders WHERE id = @id AND user_id = @uid')
      .get({ id: row.id, uid: Number(row.user_id) });
  } catch (e: any) {
    if (e instanceof WechatPayConfigError || e instanceof WechatPayGatewayError) {
      console.warn('[wechat-pay] order query reconcile failed:', e.message);
      return row;
    }
    console.warn('[wechat-pay] order query reconcile failed:', e?.message || e);
    return row;
  }
}

function mergeMetaJson(raw: string, patch: Record<string, any>) {
  let base: Record<string, any> = {};
  try {
    base = raw ? JSON.parse(raw) : {};
  } catch {
    base = {};
  }
  return {
    ...base,
    ...patch,
    wechat: {
      ...(base.wechat || {}),
      ...(patch.wechat || {}),
    },
  };
}
