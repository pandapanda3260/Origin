import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { fulfillPaidOrder } from '@/lib/billing-fulfill';
import {
  decryptWechatPayResource,
  getWechatPayConfig,
  verifyWechatPayCallback,
  WechatPayConfigError,
  WechatPayGatewayError,
} from '@/lib/wechat-pay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WechatTransaction = {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  success_time?: string;
  amount?: {
    total?: number;
    currency?: string;
    payer_total?: number;
    payer_currency?: string;
  };
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  try {
    const cfg = getWechatPayConfig();
    verifyWechatPayCallback(req.headers, rawBody);
    const notice = JSON.parse(rawBody);
    const tx = decryptWechatPayResource<WechatTransaction>(notice.resource, cfg.apiV3Key);

    if (tx.appid !== cfg.appId || tx.mchid !== cfg.mchId) {
      throw new WechatPayGatewayError('微信支付回调商户号或 AppID 不匹配。', 400);
    }
    if (tx.trade_state !== 'SUCCESS') {
      return wechatSuccess();
    }

    const orderId = String(tx.out_trade_no || '').trim();
    const db = getDb();
    const row = db
      .prepare<{ id: string }, any>("SELECT * FROM billing_orders WHERE id = @id AND provider = 'wechat'")
      .get({ id: orderId });
    if (!row) {
      throw new WechatPayGatewayError('微信支付回调订单不存在。', 404);
    }
    if (Number(tx.amount?.total || 0) !== Number(row.amount_cents || 0)) {
      throw new WechatPayGatewayError('微信支付回调金额不匹配。', 400);
    }

    const meta = mergeMetaJson(row.meta_json, {
      wechat: {
        transactionId: tx.transaction_id || '',
        tradeState: tx.trade_state || '',
        successTime: tx.success_time || '',
        amount: tx.amount || null,
        notifiedAt: new Date().toISOString(),
      },
    });
    db.prepare(
      `UPDATE billing_orders
          SET provider_ref = COALESCE(NULLIF(?, ''), provider_ref),
              meta_json = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(tx.transaction_id || '', JSON.stringify(meta), row.id);

    fulfillPaidOrder({ userId: Number(row.user_id), orderId: row.id, via: '微信支付' });
    return wechatSuccess();
  } catch (e: any) {
    const status =
      e instanceof WechatPayConfigError || e instanceof WechatPayGatewayError ? e.status : Number(e?.status || 500);
    console.warn('[wechat-pay] notify failed:', e?.message || e);
    return NextResponse.json({ code: 'FAIL', message: e?.message || '微信支付通知处理失败' }, { status });
  }
}

function wechatSuccess() {
  return NextResponse.json({ code: 'SUCCESS', message: '成功' });
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
