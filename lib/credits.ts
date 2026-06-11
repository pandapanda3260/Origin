/**
 * 积分系统：余额查询 / 扣减 / 退还 / 入账 / 明细。
 *
 * CREDIT_PRICES 只保留给迁移期 legacy 固定扣费路径和旧任务退款使用；
 * 新的 API 用量计费走 usage-billing.ts + api_price_catalog。
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { getPlan, isDevAutopayEnabled } from './billing-config';

export type CreditKind = 'text' | 'image' | 'video' | 'export' | 'topup' | 'redeem' | 'refund' | 'gift' | 'adjust';

export const CREDIT_PRICES: Record<'text' | 'image' | 'video' | 'export', number> = {
  text: 1,
  image: 30,
  video: 150,
  export: 5,
};

export class InsufficientCreditsError extends Error {
  status = 402;
  errorCode = 'INSUFFICIENT_CREDITS';
  required: number;
  balance: number;
  constructor(required: number, balance: number) {
    super(`积分不足：本次需 ${required} 积分，当前余额 ${balance} 积分`);
    this.required = required;
    this.balance = balance;
  }
}

function rowToBalance(row: any) {
  const subscriptionCredits = Number(row.subscription_credits || 0);
  const topupCredits = Number(row.topup_credits || 0);
  const bonusCredits = Number(row.bonus_credits || 0);
  const overdraftCredits = Number(row.overdraft_credits || 0);
  return {
    totalCredits: subscriptionCredits + topupCredits + bonusCredits - overdraftCredits,
    subscriptionCredits,
    topupCredits,
    bonusCredits,
    overdraftCredits,
    planCode: row.plan_code || 'free',
    planStatus: row.plan_status || 'active',
    periodEnd: row.period_end,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
  };
}

export function getBalance(userId: number): {
  totalCredits: number;
  subscriptionCredits: number;
  topupCredits: number;
	  bonusCredits: number;
	  overdraftCredits: number;
	  planCode: string;
  planStatus: string;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
} {
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, any>('SELECT * FROM user_credits WHERE user_id = @uid')
    .get({ uid: userId });
  if (!row) {
    // 自动开户（兜底）——用事务保证 user_credits + ledger 一起写
    const openTxn = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO user_credits (user_id, total_credits, subscription_credits, plan_code)
         VALUES (?, 100, 100, 'free') ON CONFLICT(user_id) DO NOTHING`,
      ).run(userId);
      if (info.changes === 1) {
        db.prepare(
          `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), userId, 100, 'gift', '开户赠送 100 积分', null, 100);
      }
    });
    openTxn.immediate();
    // 重新读，防止极端情况下别的事务抢先开户
    const fresh = db
      .prepare<{ uid: number }, any>('SELECT * FROM user_credits WHERE user_id = @uid')
      .get({ uid: userId });
    if (fresh) return rowToBalance(fresh);
    return {
      totalCredits: 100,
      subscriptionCredits: 100,
      topupCredits: 0,
      bonusCredits: 0,
      overdraftCredits: 0,
      planCode: 'free',
      planStatus: 'active',
      periodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }
  return rowToBalance(row);
}

/**
 * 到期降级（惰性结算）。
 *
 * 当用户已申请到期取消（cancel_at_period_end=1）、当前是付费档、且 period_end 已过时，
 * 把订阅降级为 free：清零订阅积分、plan_code 回 free、复位取消标记、清空 period_end，
 * 并写一条 kind='adjust' 流水留痕。返回是否真的发生了降级。
 *
 * 设计取舍：只在"读取入口"（如 GET /api/billing/me）调用，**不** 放进 chargeCredits/
 * refundCredits 等扣费路径——避免扩大对正常计费逻辑的影响面，也避免事务嵌套。
 * 只回收订阅桶；topup / bonus / overdraft 桶不动，total 按 sub+topup+bonus-overdraft 重算。
 */
export function settleExpiredSubscription(userId: number): boolean {
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, any>(
      `SELECT plan_code, period_end, cancel_at_period_end,
              subscription_credits, topup_credits, bonus_credits, overdraft_credits
       FROM user_credits WHERE user_id = @uid`,
    )
    .get({ uid: userId });
  if (!row) return false;
  if (!row.cancel_at_period_end) return false;
  if (!row.plan_code || row.plan_code === 'free') return false;
  if (!row.period_end) return false;
  const end = Date.parse(String(row.period_end));
  if (!Number.isFinite(end) || end > Date.now()) return false;

  const subCredits = Number(row.subscription_credits || 0);
  const newTotal =
    Number(row.topup_credits || 0) + Number(row.bonus_credits || 0) - Number(row.overdraft_credits || 0);
  let downgraded = false;
  const txn = db.transaction(() => {
    // 条件 UPDATE：仍是"已申请取消的该付费档"才生效，避免与并发 resume / 后台改档打架。
    const info = db.prepare(
      `UPDATE user_credits SET
         plan_code = 'free', subscription_credits = 0, total_credits = ?,
         cancel_at_period_end = 0, period_end = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ? AND cancel_at_period_end = 1 AND plan_code = ?`,
    ).run(newTotal, userId, row.plan_code);
    if (info.changes !== 1) return;
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
       VALUES (?, ?, ?, 'adjust', ?, ?, ?)`,
    ).run(randomUUID(), userId, -subCredits, '订阅到期降级为免费版', null, newTotal);
    downgraded = true;
  });
  txn.immediate();
  return downgraded;
}

// 订阅周期：自然月粗粒度（setUTCMonth +1）。月末日期会向后滚（1/31 → 3/2 一类），
// 模拟支付阶段可接受；真支付网关接入时以网关账期为准，这里只是兜底口径。
function addMonthsIso(fromMs: number, months: number): string {
  const d = new Date(fromMs);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

/**
 * 订阅生效（购买/换档统一入口，由 lib/billing-fulfill.ts 在支付成功后调用）。
 *
 * 语义（2026-06-10 拍板，"每月重置"）：订阅桶**覆盖重置**为该档 monthly_credits（不叠加，
 * 换档同理：plus→pro 重置为 400000，反向换档同样覆盖）；period_end = 现在 +1 月；
 * 清取消标记。topup / bonus / overdraft 桶不动。流水 kind='adjust' 记录桶差额留痕。
 */
export function activatePlanSubscription(
  userId: number,
  planCode: string,
  opts?: { reasonPrefix?: string; refId?: string },
): { periodEnd: string; creditsSet: number } {
  const plan = getPlan(planCode);
  if (!plan) throw new Error('未知订阅档位：' + planCode);
  if (!Number(plan.price_cents) || planCode === 'free') throw new Error('免费档无需订阅');
  const monthly = Number(plan.monthly_credits || 0);
  const db = getDb();
  getBalance(userId); // 确保开户
  const periodEnd = addMonthsIso(Date.now(), 1);
  let out: { periodEnd: string; creditsSet: number } | null = null;
  const txn = db.transaction(() => {
    const cur = getBalance(userId);
    const newTotal = monthly + cur.topupCredits + cur.bonusCredits - cur.overdraftCredits;
    const info = db.prepare(
      `UPDATE user_credits SET
         plan_code = ?, plan_status = 'active', subscription_credits = ?, total_credits = ?,
         cancel_at_period_end = 0, period_end = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?
         AND subscription_credits = ? AND topup_credits = ? AND bonus_credits = ? AND overdraft_credits = ?`,
    ).run(
      plan.code, monthly, newTotal, periodEnd, userId,
      cur.subscriptionCredits, cur.topupCredits, cur.bonusCredits, cur.overdraftCredits,
    );
    if (info.changes !== 1) throw new Error('积分余额更新冲突，请重试');
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
       VALUES (?, ?, ?, 'adjust', ?, ?, ?)`,
    ).run(
      randomUUID(), userId, monthly - cur.subscriptionCredits,
      `${opts?.reasonPrefix || ''}订阅 ${plan.title} 生效：订阅积分重置为 ${monthly}`.slice(0, 200),
      opts?.refId || null, newTotal,
    );
    out = { periodEnd, creditsSet: monthly };
  });
  txn.immediate();
  return out!;
}

/**
 * 到期续费（惰性，模拟支付专用）。
 *
 * 仅在模拟支付开关开启时生效（isDevAutopayEnabled，方向B 2026-06-10 拍板）：付费档、
 * 未申请取消、period_end 已过 → 视为"自动扣款成功"，订阅桶覆盖重置为 monthly_credits，
 * period_end 按月顺延到未来（跨多月只重置一次，不叠发）。与 settleExpiredSubscription
 * 互斥（cancel 标记分流），同样只挂在读取入口（me / config/client / projects POST），
 * 不进扣费路径。真支付网关接入后，这段由"续费扣款回调"替代，开关关掉即停。
 */
export function renewDueSubscription(userId: number): boolean {
  if (!isDevAutopayEnabled()) return false;
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, any>(
      `SELECT plan_code, plan_status, period_end, cancel_at_period_end,
              subscription_credits, topup_credits, bonus_credits, overdraft_credits
       FROM user_credits WHERE user_id = @uid`,
    )
    .get({ uid: userId });
  if (!row) return false;
  if (row.cancel_at_period_end) return false;
  if (!row.plan_code || row.plan_code === 'free') return false;
  if (!row.period_end) return false;
  const oldEnd = Date.parse(String(row.period_end));
  if (!Number.isFinite(oldEnd) || oldEnd > Date.now()) return false;
  const plan = getPlan(String(row.plan_code));
  if (!plan || !Number(plan.price_cents)) return false;

  const monthly = Number(plan.monthly_credits || 0);
  // period_end 按月顺延直到未来（封顶 240 次防御异常数据死循环）
  let endMs = oldEnd;
  for (let i = 0; i < 240 && endMs <= Date.now(); i++) {
    endMs = Date.parse(addMonthsIso(endMs, 1));
  }
  const newEnd = new Date(endMs).toISOString();
  const oldSub = Number(row.subscription_credits || 0);
  const newTotal =
    monthly + Number(row.topup_credits || 0) + Number(row.bonus_credits || 0) - Number(row.overdraft_credits || 0);
  let renewed = false;
  const txn = db.transaction(() => {
    const info = db.prepare(
      `UPDATE user_credits SET
         subscription_credits = ?, total_credits = ?, period_end = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ? AND plan_code = ? AND period_end = ? AND cancel_at_period_end = 0`,
    ).run(monthly, newTotal, newEnd, userId, row.plan_code, row.period_end);
    if (info.changes !== 1) return;
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
       VALUES (?, ?, ?, 'adjust', ?, ?, ?)`,
    ).run(
      randomUUID(), userId, monthly - oldSub,
      `[模拟支付] 订阅 ${plan.title} 续费：订阅积分重置为 ${monthly}`.slice(0, 200),
      null, newTotal,
    );
    renewed = true;
  });
  txn.immediate();
  return renewed;
}

/**
 * 迁移期 legacy 扣减。只在余额 <= 0 时拦截，允许本次扣减后变成负余额。
 * 新 API 用量扣费优先使用 usage-billing.ts。
 */
export function chargeCredits(opts: {
  userId: number;
  amount: number;
  kind: CreditKind;
  reason: string;
  refId?: string;
  chargeRefId?: string;
  idempotencyKey?: string;
}): { ledgerId: string; balanceAfter: number } {
  if (!Number.isInteger(opts.amount) || opts.amount <= 0) {
    throw new Error('amount 必须是正整数');
  }
  const db = getDb();
  let out: { ledgerId: string; balanceAfter: number } | null = null;
  const txn = db.transaction(() => {
    if (opts.chargeRefId) {
      const existing = db
        .prepare<{ ref: string }, any>(
          'SELECT id, balance_after FROM credit_ledger WHERE charge_ref_id = @ref LIMIT 1',
        )
        .get({ ref: opts.chargeRefId });
      if (existing) {
        out = { ledgerId: String(existing.id), balanceAfter: Number(existing.balance_after || 0) };
        return;
      }
    }

    const cur = getBalance(opts.userId);
    if (cur.totalCredits <= 0) {
      throw new InsufficientCreditsError(1, cur.totalCredits);
    }

    // 扣减优先级：subscription > bonus > topup（2026-06-10 反转，与 usage-billing.ts 同步改）。
    // 理由：订阅桶随月度重置会"过期"，必须先烧；topup 是花钱买的永久积分，最后才动；bonus 赠送居中。
    let remaining = opts.amount;
    const subUse = Math.min(remaining, cur.subscriptionCredits);
    remaining -= subUse;
    const bonusUse = Math.min(remaining, cur.bonusCredits);
    remaining -= bonusUse;
    const topupUse = Math.min(remaining, cur.topupCredits);
    remaining -= topupUse;
    const overdraftUse = remaining;

    const newBonus = cur.bonusCredits - bonusUse;
    const newTopup = cur.topupCredits - topupUse;
    const newSub = cur.subscriptionCredits - subUse;
    const newOverdraft = cur.overdraftCredits + overdraftUse;
    const newTotal = newBonus + newTopup + newSub - newOverdraft;

    // 条件 UPDATE：仍校验旧桶值，避免并发写覆盖；不再要求 total_credits >= amount。
    const info = db.prepare(
      `UPDATE user_credits SET
        bonus_credits = ?, topup_credits = ?, subscription_credits = ?, overdraft_credits = ?, total_credits = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?
         AND bonus_credits = ?
         AND topup_credits = ?
         AND subscription_credits = ?
         AND overdraft_credits = ?`,
    ).run(
      newBonus, newTopup, newSub, newOverdraft, newTotal,
      opts.userId,
      cur.bonusCredits, cur.topupCredits, cur.subscriptionCredits, cur.overdraftCredits,
    );
    if (info.changes !== 1) {
      throw new Error('积分余额更新冲突，请重试');
    }

    const ledgerId = randomUUID();
    const bucketsJson = JSON.stringify({
      bonus: bonusUse,
      topup: topupUse,
      subscription: subUse,
      overdraft: overdraftUse,
    });
    db.prepare(
      `INSERT INTO credit_ledger
        (id, user_id, amount, kind, reason, ref_id, idempotency_key, charge_ref_id, balance_after, buckets_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ledgerId,
      opts.userId,
      -opts.amount,
      opts.kind,
      opts.reason.slice(0, 200),
      opts.refId || null,
      opts.idempotencyKey || null,
      opts.chargeRefId || null,
      newTotal,
      bucketsJson,
    );

    out = { ledgerId, balanceAfter: newTotal };
  });
  txn.immediate();
  return out!;
}

/**
 * 退还（生成失败时调用）。amount 应是正数。
 * 退款策略：
 *  1) 如果调用者传了 bucket，按指定桶退（高优先级）。
 *  2) 否则如果能通过 refId 找到原始 charge 的 buckets_json，按原桶按比例退还。
 *  3) 兜底：退到 bonus 桶。
 *
 * 这样可以避免"订阅桶扣的钱退款后变成永久 bonus 积分"的漏洞。
 */
export function refundCredits(opts: {
  userId: number;
  amount: number;
  reason: string;
  refId?: string;
  refundRefId?: string;
  idempotencyKey?: string;
  bucket?: 'subscription' | 'topup' | 'bonus';
}): { ledgerId: string | null; balanceAfter: number | null; alreadyApplied: boolean } | void {
  if (!Number.isInteger(opts.amount) || opts.amount <= 0) return;
  const db = getDb();

  // 解析退款分布
  let refund = { bonus: 0, topup: 0, subscription: 0, overdraft: 0 };
  if (opts.bucket) {
    refund[opts.bucket] = opts.amount;
  } else if (opts.refId) {
    const src = db
      .prepare<{ uid: number; rid: string }, any>(
        `SELECT buckets_json, amount FROM credit_ledger
         WHERE user_id = @uid AND ref_id = @rid AND amount < 0
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get({ uid: opts.userId, rid: opts.refId });
    if (src && src.buckets_json) {
      try {
        const b = JSON.parse(src.buckets_json);
          const origTotal = Number(b.bonus || 0) + Number(b.topup || 0) + Number(b.subscription || 0) + Number(b.overdraft || 0);
          if (origTotal > 0) {
          // 按原 charge 的桶比例退：多数情况 opts.amount === origTotal，就是完全还原
          const ratio = opts.amount / origTotal;
            refund.bonus = Math.round(Number(b.bonus || 0) * ratio);
            refund.topup = Math.round(Number(b.topup || 0) * ratio);
            refund.overdraft = Math.round(Number(b.overdraft || 0) * ratio);
            refund.subscription = opts.amount - refund.bonus - refund.topup - refund.overdraft;
            if (refund.subscription < 0) refund.subscription = 0;
          }
      } catch (_) {}
    }
  }
  // 兜底
  const total = refund.bonus + refund.topup + refund.subscription + refund.overdraft;
  if (total !== opts.amount) {
    refund = { bonus: opts.amount, topup: 0, subscription: 0, overdraft: 0 };
  }

  const txn = db.transaction(() => {
    if (opts.refundRefId) {
      const existing = db
        .prepare<{ ref: string }, any>(
          'SELECT id, balance_after FROM credit_ledger WHERE refund_ref_id = @ref LIMIT 1',
        )
        .get({ ref: opts.refundRefId });
      if (existing) {
        return {
          ledgerId: String(existing.id),
          balanceAfter: Number(existing.balance_after || 0),
          alreadyApplied: true,
        };
      }
    }

    const cur = getBalance(opts.userId);
    const overdraftReduction = Math.min(cur.overdraftCredits, refund.overdraft);
    const overflowFromOverdraft = refund.overdraft - overdraftReduction;
    const newSub = cur.subscriptionCredits + refund.subscription;
    const newTop = cur.topupCredits + refund.topup;
    const newBon = cur.bonusCredits + refund.bonus + overflowFromOverdraft;
    const newOverdraft = cur.overdraftCredits - overdraftReduction;
    const newTotal = newSub + newTop + newBon - newOverdraft;

    db.prepare(
      `UPDATE user_credits SET
        subscription_credits = ?, topup_credits = ?, bonus_credits = ?, overdraft_credits = ?, total_credits = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?`,
    ).run(newSub, newTop, newBon, newOverdraft, newTotal, opts.userId);

    const ledgerId = randomUUID();
    db.prepare(
      `INSERT INTO credit_ledger
        (id, user_id, amount, kind, reason, ref_id, idempotency_key, refund_ref_id, balance_after, buckets_json)
       VALUES (?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?)`,
    ).run(
      ledgerId,
      opts.userId,
      opts.amount,
      opts.reason.slice(0, 200),
      opts.refId || null,
      opts.idempotencyKey || null,
      opts.refundRefId || null,
      newTotal,
      JSON.stringify(refund),
    );
    return { ledgerId, balanceAfter: newTotal, alreadyApplied: false };
  });
  return txn.immediate();
}

/**
 * 入账（兑换码 / 充值 / 订阅生效）。
 */
export function grantCredits(opts: {
  userId: number;
  amount: number;
  kind: 'topup' | 'redeem' | 'gift' | 'adjust';
  reason: string;
  /** 走 subscription 还是 topup 桶 */
  bucket?: 'subscription' | 'topup' | 'bonus';
  refId?: string;
}) {
  if (!Number.isInteger(opts.amount) || opts.amount <= 0) return;
  const db = getDb();
  const bucket = opts.bucket || (opts.kind === 'redeem' || opts.kind === 'topup' ? 'topup' : 'bonus');
  const txn = db.transaction(() => {
    const cur = getBalance(opts.userId);
    let newSub = cur.subscriptionCredits;
    let newTop = cur.topupCredits;
    let newBon = cur.bonusCredits;
    const overdraftReduction = Math.min(cur.overdraftCredits, opts.amount);
    const remainingGrant = opts.amount - overdraftReduction;
    const newOverdraft = cur.overdraftCredits - overdraftReduction;
    if (bucket === 'subscription') newSub += remainingGrant;
    else if (bucket === 'topup') newTop += remainingGrant;
    else newBon += remainingGrant;
    const newTotal = newSub + newTop + newBon - newOverdraft;

    db.prepare(
      `UPDATE user_credits SET
        subscription_credits = ?, topup_credits = ?, bonus_credits = ?, overdraft_credits = ?, total_credits = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?`,
    ).run(newSub, newTop, newBon, newOverdraft, newTotal, opts.userId);

    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), opts.userId, opts.amount, opts.kind, opts.reason.slice(0, 200), opts.refId || null, newTotal);
  });
  txn.immediate();
}

/**
 * 取明细（最近 N 条）。
 */
export function listLedger(userId: number, limit = 50, offset = 0) {
  const db = getDb();
  const lim = Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : 50;
  const off = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  const rows = db
    .prepare<{ uid: number; lim: number; off: number }, any>(
      `SELECT l.*,
              COALESCE(
                NULLIF(p_video.title, ''),
                NULLIF(p_batch.title, ''),
                NULLIF(p_image.title, ''),
                NULLIF(p_export.title, ''),
                NULLIF(p_event.title, ''),
                NULLIF(e.project_title_snapshot, ''),
                NULLIF(p_ref.title, ''),
                NULLIF(e.call_item_label, '')
              ) AS task_name
         FROM credit_ledger l
         LEFT JOIN video_tasks vt
           ON vt.id = l.ref_id AND vt.owner_id = l.user_id
         LEFT JOIN projects p_video
           ON p_video.id = vt.project_id AND p_video.owner_id = l.user_id
         LEFT JOIN batch_tasks bt
           ON bt.id = l.ref_id
         LEFT JOIN batches b
           ON b.id = bt.batch_id AND b.owner_id = l.user_id
         LEFT JOIN projects p_batch
           ON p_batch.id = b.project_id AND p_batch.owner_id = l.user_id
         LEFT JOIN images i
           ON i.id = l.ref_id AND i.owner_id = l.user_id
         LEFT JOIN projects p_image
           ON p_image.id = i.project_id AND p_image.owner_id = l.user_id
         LEFT JOIN exports x
           ON x.id = l.ref_id AND x.owner_id = l.user_id
         LEFT JOIN projects p_export
           ON p_export.id = x.project_id AND p_export.owner_id = l.user_id
         LEFT JOIN token_usage_events e
           ON e.id = (
             SELECT e2.id
               FROM token_usage_events e2
              WHERE e2.owner_id = l.user_id
                AND (
                  e2.ledger_id = l.id
                  OR l.charge_ref_id = ('usage:text:' || e2.id)
                  OR l.charge_ref_id = ('usage:image:' || e2.id)
                  OR l.charge_ref_id = ('usage:video:' || e2.id)
                )
              ORDER BY e2.created_at DESC
              LIMIT 1
           )
         LEFT JOIN projects p_event
           ON p_event.id = e.project_id AND p_event.owner_id = l.user_id
         LEFT JOIN projects p_ref
           ON p_ref.id = l.ref_id AND p_ref.owner_id = l.user_id
        WHERE l.user_id = @uid
        ORDER BY l.created_at DESC LIMIT @lim OFFSET @off`,
    )
    .all({ uid: userId, lim, off });
  return rows.map((r: any) => ({
    id: r.id,
    amount: r.amount,
    kind: r.kind,
    reason: r.reason,
    refId: r.ref_id,
    taskName: r.task_name || null,
    balanceAfter: r.balance_after,
    createdAt: r.created_at,
  }));
}

export function countLedger(userId: number): number {
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, any>('SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = @uid')
    .get({ uid: userId });
  return Number(row?.c || 0);
}
