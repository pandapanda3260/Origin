/**
 * 积分系统：余额查询 / 预扣 / 退还 / 入账 / 明细
 *
 * 计费表（单位：积分）：
 *   text       1 积分/请求      （剧本/资产抽取/镜头/EDL/Agent 等所有 LLM 文本）
 *   image      30 积分/张        （角色/场景/道具/分镜图）
 *   video      150 积分/段       （单段视频生成；时长 ≤6s 算一段）
 *   export     5 积分/次         （FFmpeg 导出成片）
 *
 * 这是一份示例计费，可以在这里集中调整。
 *
 * 并发安全：所有修改余额的操作都放进 db.transaction(...) 并使用条件 UPDATE，
 * 即使多进程 / 未来改异步也不会出现 TOCTOU 双花。
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db';

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
  return {
    totalCredits: row.total_credits || 0,
    subscriptionCredits: row.subscription_credits || 0,
    topupCredits: row.topup_credits || 0,
    bonusCredits: row.bonus_credits || 0,
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
      planCode: 'free',
      planStatus: 'active',
      periodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }
  return rowToBalance(row);
}

/**
 * 预扣积分。如果余额不足抛 InsufficientCreditsError。
 * 返回 ledger entry id（可用于失败时退还）。
 *
 * 所有读-改-写放在一个 IMMEDIATE 事务中，并对 total_credits >= amount 做条件 UPDATE。
 */
export function chargeCredits(opts: {
  userId: number;
  amount: number;
  kind: CreditKind;
  reason: string;
  refId?: string;
}): { ledgerId: string; balanceAfter: number } {
  if (!Number.isInteger(opts.amount) || opts.amount <= 0) {
    throw new Error('amount 必须是正整数');
  }
  const db = getDb();
  let out: { ledgerId: string; balanceAfter: number } | null = null;
  const txn = db.transaction(() => {
    const cur = getBalance(opts.userId);
    if (cur.totalCredits < opts.amount) {
      throw new InsufficientCreditsError(opts.amount, cur.totalCredits);
    }

    // 扣减优先级：bonus > topup > subscription
    let remaining = opts.amount;
    const bonusUse = Math.min(remaining, cur.bonusCredits);
    remaining -= bonusUse;
    const topupUse = Math.min(remaining, cur.topupCredits);
    remaining -= topupUse;
    const subUse = Math.min(remaining, cur.subscriptionCredits);
    remaining -= subUse;
    if (remaining > 0) throw new InsufficientCreditsError(opts.amount, cur.totalCredits);

    const newBonus = cur.bonusCredits - bonusUse;
    const newTopup = cur.topupCredits - topupUse;
    const newSub = cur.subscriptionCredits - subUse;
    const newTotal = newBonus + newTopup + newSub;

    // 条件 UPDATE：只在原余额仍不少于 amount 时才生效；changes=0 说明中途被别的事务扣掉了
    const info = db.prepare(
      `UPDATE user_credits SET
        bonus_credits = ?, topup_credits = ?, subscription_credits = ?, total_credits = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?
         AND bonus_credits = ?
         AND topup_credits = ?
         AND subscription_credits = ?
         AND total_credits >= ?`,
    ).run(
      newBonus, newTopup, newSub, newTotal,
      opts.userId,
      cur.bonusCredits, cur.topupCredits, cur.subscriptionCredits,
      opts.amount,
    );
    if (info.changes !== 1) {
      throw new InsufficientCreditsError(opts.amount, cur.totalCredits);
    }

    const ledgerId = randomUUID();
    const bucketsJson = JSON.stringify({
      bonus: bonusUse,
      topup: topupUse,
      subscription: subUse,
    });
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after, buckets_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ledgerId, opts.userId, -opts.amount, opts.kind, opts.reason.slice(0, 200), opts.refId || null, newTotal, bucketsJson);

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
  bucket?: 'subscription' | 'topup' | 'bonus';
}) {
  if (!Number.isInteger(opts.amount) || opts.amount <= 0) return;
  const db = getDb();

  // 解析退款分布
  let refund = { bonus: 0, topup: 0, subscription: 0 };
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
        const origTotal = Number(b.bonus || 0) + Number(b.topup || 0) + Number(b.subscription || 0);
        if (origTotal > 0) {
          // 按原 charge 的桶比例退：多数情况 opts.amount === origTotal，就是完全还原
          const ratio = opts.amount / origTotal;
          refund.bonus = Math.round(Number(b.bonus || 0) * ratio);
          refund.topup = Math.round(Number(b.topup || 0) * ratio);
          refund.subscription = opts.amount - refund.bonus - refund.topup;
          if (refund.subscription < 0) refund.subscription = 0;
        }
      } catch (_) {}
    }
  }
  // 兜底
  const total = refund.bonus + refund.topup + refund.subscription;
  if (total !== opts.amount) {
    refund = { bonus: opts.amount, topup: 0, subscription: 0 };
  }

  const txn = db.transaction(() => {
    const cur = getBalance(opts.userId);
    const newSub = cur.subscriptionCredits + refund.subscription;
    const newTop = cur.topupCredits + refund.topup;
    const newBon = cur.bonusCredits + refund.bonus;
    const newTotal = newSub + newTop + newBon;

    db.prepare(
      `UPDATE user_credits SET
        subscription_credits = ?, topup_credits = ?, bonus_credits = ?, total_credits = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?`,
    ).run(newSub, newTop, newBon, newTotal, opts.userId);

    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after, buckets_json)
       VALUES (?, ?, ?, 'refund', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      opts.userId,
      opts.amount,
      opts.reason.slice(0, 200),
      opts.refId || null,
      newTotal,
      JSON.stringify(refund),
    );
  });
  txn.immediate();
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
    if (bucket === 'subscription') newSub += opts.amount;
    else if (bucket === 'topup') newTop += opts.amount;
    else newBon += opts.amount;
    const newTotal = newSub + newTop + newBon;

    db.prepare(
      `UPDATE user_credits SET
        subscription_credits = ?, topup_credits = ?, bonus_credits = ?, total_credits = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?`,
    ).run(newSub, newTop, newBon, newTotal, opts.userId);

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
      `SELECT * FROM credit_ledger WHERE user_id = @uid
       ORDER BY created_at DESC LIMIT @lim OFFSET @off`,
    )
    .all({ uid: userId, lim, off });
  return rows.map((r: any) => ({
    id: r.id,
    amount: r.amount,
    kind: r.kind,
    reason: r.reason,
    refId: r.ref_id,
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
