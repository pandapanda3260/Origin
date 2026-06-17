import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { ADMIN_MANUAL_ADJUST_LIMITS } from '@/lib/billing-config';
import { getBalance } from '@/lib/credits';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

	  const url = new URL(req.url);
	  const q = String(url.searchParams.get('q') || '').trim();
	  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 100);
  const filters = ledgerFiltersFromUrl(url, q, limit);
  if (String(url.searchParams.get('format') || '').toLowerCase() === 'csv') {
    const csv = ledgerCsv(listLedger(filters, 5000));
    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="origin-credit-ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

	  return jsonOk({
	    users: listCreditUsers(q, limit),
	    orders: listOrders(q, limit),
	    ledger: listLedger(filters, limit),
	    redeemCodes: listRedeemCodes(limit),
	    cost: costSnapshot(),
      priceCatalog: listPriceCatalog(),
	    limits: ADMIN_MANUAL_ADJUST_LIMITS,
	    generatedAt: new Date().toISOString(),
	  });
	}

export const POST = withAdminAudit(async function mutateBilling(_req: NextRequest, audit) {
  const body = audit.body || {};
  const action = String(body.action || '').trim();
  if (action !== 'manual_adjust') return jsonError('unsupported action', 400);

  const userKey = String(body.userId ?? body.accountId ?? '').trim();
  const amount = Math.floor(Number(body.amount));
  const reason = String(audit.reason || body.reason || '').trim();
  const confirmText = String(body.confirmText || '').trim();
  if (!userKey) return jsonError('valid accountId or userId required', 400);
  if (!Number.isInteger(amount) || amount === 0) return jsonError('non-zero integer amount required', 400);
  if (reason.length < 4) return jsonError('reason too short', 400);

  const user = getDb()
    .prepare<{ key: string }, any>(
      `SELECT u.id, u.account_id AS accountId, u.username, u.phone, u.display_name AS displayName, c.total_credits AS totalCredits
         FROM users u
         LEFT JOIN user_credits c ON c.user_id = u.id
        WHERE CAST(u.id AS TEXT) = @key
           OR u.account_id = @key`,
    )
    .get({ key: userKey });
  if (!user) return jsonError('user not found', 404);
  if (String(user.username || '').startsWith('__shadow__')) return jsonError('shadow user cannot be adjusted manually', 400);

  const userId = Number(user.id);
  const guard = manualAdjustGuard({ adminId: audit.admin.id, amount, confirmText });
  if (guard.blocked) return jsonError(guard.reason, guard.status);

  const before = creditSnapshot(userId);
  const after = previewAdjustment(before, amount);
  audit.setAuditTarget({ type: 'user', ids: [String(userId)] });
  audit.setAuditDiff({ before: { user, credits: before }, after: { user, credits: after, amount } });

  if (audit.dryRun) {
    return jsonOk(dryRunPayload('billing.manual_adjust', { type: 'user', ids: [String(userId)] }, {
      before: { user, credits: before },
      after: { user, credits: after, amount },
    }, guard.warnings));
  }

  const result = applyManualAdjustment({
    userId,
    adminId: audit.admin.id,
    amount,
    reason,
    idempotencyKey: audit.idempotencyKey,
  });
  return jsonOk({ success: true, action, userId, accountId: user.accountId || '', amount, result });
	}, 'billing.manual_adjust', {
	  category: 'billing',
	  supportDryRun: true,
	  idempotent: true,
	});

type LedgerFilters = {
  q: string;
  from: string;
  to: string;
  module: string;
  provider: string;
  model: string;
  consumptionType: string;
};

function ledgerFiltersFromUrl(url: URL, q: string, _limit: number): LedgerFilters {
  return {
    q,
    from: String(url.searchParams.get('from') || '').trim(),
    to: String(url.searchParams.get('to') || '').trim(),
    module: String(url.searchParams.get('module') || '').trim(),
    provider: String(url.searchParams.get('provider') || '').trim(),
    model: String(url.searchParams.get('model') || '').trim(),
    consumptionType: String(url.searchParams.get('consumptionType') || '').trim(),
  };
}

function ledgerWhere(filters: LedgerFilters) {
  const where = [
    `u.username NOT LIKE '__shadow__%'`,
  ];
  const params: Record<string, unknown> = {
    q: filters.q,
    like: `%${filters.q}%`,
  };
  if (filters.q) {
    where.push(`(
      l.id = @q
      OR l.ref_id = @q
      OR l.charge_ref_id = @q
      OR CAST(l.user_id AS TEXT) = @q
      OR u.account_id = @q
      OR u.username LIKE @like
      OR COALESCE(u.phone, '') LIKE @like
      OR COALESCE(u.email, '') LIKE @like
      OR COALESCE(u.display_name, '') LIKE @like
    )`);
  }
  if (filters.from) {
    where.push(`l.created_at >= @from`);
    params.from = filters.from;
  }
  if (filters.to) {
    where.push(`l.created_at <= @to`);
    params.to = filters.to;
  }
  if (filters.module) {
    where.push(`COALESCE(l.operation_module, '') = @module`);
    params.module = filters.module;
  }
  if (filters.provider) {
    where.push(`COALESCE(l.provider, '') = @provider`);
    params.provider = filters.provider;
  }
  if (filters.model) {
    where.push(`COALESCE(l.model, '') LIKE @modelLike`);
    params.modelLike = `%${filters.model}%`;
  }
  if (filters.consumptionType) {
    where.push(`COALESCE(l.consumption_type, '') = @consumptionType`);
    params.consumptionType = filters.consumptionType;
  }
  return { sql: where.join(' AND '), params };
}

function listCreditUsers(q: string, limit: number) {
  return getDb().prepare<any, any>(
    `SELECT u.id,
            u.account_id AS accountId,
            u.username,
            u.phone,
            u.display_name AS displayName,
            u.email,
            u.disabled_at AS disabledAt,
            COALESCE(c.total_credits, 0) AS totalCredits,
	            COALESCE(c.subscription_credits, 0) AS subscriptionCredits,
	            COALESCE(c.topup_credits, 0) AS topupCredits,
            COALESCE(c.bonus_credits, 0) AS bonusCredits,
              COALESCE(c.overdraft_credits, 0) AS overdraftCredits,
            COALESCE((
              SELECT SUM(-l.amount)
                FROM credit_ledger l
               WHERE l.user_id = u.id
                 AND l.amount < 0
            ), 0) AS consumedCredits,
	            c.plan_code AS planCode,
            c.updated_at AS creditsUpdatedAt
       FROM users u
       LEFT JOIN user_credits c ON c.user_id = u.id
      WHERE u.username NOT LIKE '__shadow__%'
        AND (
          @q = ''
          OR CAST(u.id AS TEXT) = @q
          OR u.account_id = @q
          OR u.username LIKE @like
          OR COALESCE(u.phone, '') LIKE @like
          OR COALESCE(u.email, '') LIKE @like
          OR COALESCE(u.display_name, '') LIKE @like
        )
      ORDER BY COALESCE(c.updated_at, u.created_at) DESC
      LIMIT @limit`,
  ).all({ q, like: `%${q}%`, limit });
}

function listOrders(q: string, limit: number) {
  return getDb().prepare<any, any>(
    `SELECT o.id,
            o.user_id AS userId,
            u.account_id AS accountId,
            u.username,
            u.phone,
            o.kind,
            o.plan_code AS planCode,
            o.provider,
            o.provider_ref AS providerRef,
            o.amount_cents AS amountCents,
            o.currency,
            o.credits_added AS creditsAdded,
            o.status,
            o.created_at AS createdAt,
            o.updated_at AS updatedAt
       FROM billing_orders o
       JOIN users u ON u.id = o.user_id
      WHERE @q = ''
         OR o.id = @q
         OR o.provider_ref = @q
         OR CAST(o.user_id AS TEXT) = @q
         OR u.account_id = @q
         OR u.username LIKE @like
         OR COALESCE(u.phone, '') LIKE @like
      ORDER BY o.created_at DESC
      LIMIT @limit`,
  ).all({ q, like: `%${q}%`, limit });
}

function listLedger(filters: LedgerFilters, limit: number) {
  const where = ledgerWhere(filters);
  return getDb().prepare<any, any>(
    `SELECT l.id,
            l.user_id AS userId,
            u.account_id AS accountId,
            u.username,
            u.phone,
            u.display_name AS displayName,
            l.amount,
            l.kind,
            l.reason,
            l.ref_id AS refId,
            l.provider,
            l.model,
            l.model_role AS modelRole,
            l.cost_micros AS costMicros,
            l.cost_currency AS costCurrency,
            l.operation_module AS operationModule,
            l.operation_feature AS operationFeature,
            l.consumption_type AS consumptionType,
            l.quantity,
            l.input_tokens AS inputTokens,
            l.output_tokens AS outputTokens,
            l.cached_tokens AS cachedTokens,
            l.reasoning_tokens AS reasoningTokens,
            l.duration_sec AS durationSec,
            l.price_catalog_id AS priceCatalogId,
            l.charge_ref_id AS chargeRefId,
            l.usage_event_ids_json AS usageEventIdsJson,
            l.admin_user_id AS adminUserId,
            au.username AS adminUsername,
            l.balance_after AS balanceAfter,
            l.created_at AS createdAt
       FROM credit_ledger l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN admin_users au ON au.id = l.admin_user_id
      WHERE ${where.sql}
      ORDER BY l.created_at DESC
      LIMIT @limit`,
  ).all({ ...where.params, limit });
}

function listRedeemCodes(limit: number) {
  return getDb().prepare<any, any>(
    `SELECT code, credits, plan_code AS planCode, max_uses AS maxUses, used_count AS usedCount,
            expires_at AS expiresAt, memo, created_at AS createdAt
       FROM redeem_codes
      ORDER BY created_at DESC
      LIMIT @limit`,
  ).all({ limit });
}

function costSnapshot() {
  const db = getDb();
  const revenue = db.prepare<[], any>(
      `SELECT currency, SUM(amount_cents) AS amountCents, COUNT(*) AS orders
       FROM billing_orders
      WHERE status IN ('paid', 'applied')
        AND amount_cents > 0
      GROUP BY currency`,
  ).all();
  const gifts = db.prepare<[], any>(
    `SELECT kind, SUM(amount) AS credits, COUNT(*) AS count
       FROM credit_ledger
      WHERE amount > 0 AND kind IN ('redeem','gift','adjust')
      GROUP BY kind`,
  ).all();
  const creditSpend = db.prepare<[], any>(
    `SELECT kind,
            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS chargedCredits,
            SUM(CASE WHEN kind='refund' AND amount > 0 THEN amount ELSE 0 END) AS refundedCredits,
            COUNT(*) AS count
       FROM credit_ledger
      GROUP BY kind
      ORDER BY chargedCredits DESC`,
  ).all();
	  const modelCost = db.prepare<[], any>(
	    `SELECT COALESCE(provider, 'unknown') AS provider,
	            COALESCE(model, 'unknown') AS model,
	            COALESCE(model_role, 'unknown') AS modelRole,
              COALESCE(consumption_type, 'unknown') AS consumptionType,
	            SUM(COALESCE(cost_micros, 0)) AS costMicros,
	            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS chargedCredits,
              SUM(COALESCE(quantity, 0)) AS quantity,
              SUM(COALESCE(input_tokens, 0)) AS inputTokens,
              SUM(COALESCE(output_tokens, 0)) AS outputTokens,
              SUM(COALESCE(duration_sec, 0)) AS durationSec,
	            COUNT(*) AS count
	       FROM credit_ledger
	      WHERE provider IS NOT NULL OR model IS NOT NULL OR cost_micros IS NOT NULL
	      GROUP BY provider, model, model_role, consumption_type
	      ORDER BY costMicros DESC, chargedCredits DESC
	      LIMIT 30`,
	  ).all();
  const providerCost = db.prepare<[], any>(
    `SELECT COALESCE(provider, 'unknown') AS provider,
            SUM(COALESCE(cost_micros, 0)) AS costMicros,
            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS chargedCredits,
            COUNT(*) AS count
       FROM credit_ledger
      WHERE provider IS NOT NULL OR model IS NOT NULL OR cost_micros IS NOT NULL
      GROUP BY provider
      ORDER BY costMicros DESC, chargedCredits DESC
      LIMIT 30`,
  ).all();
  const userCost = db.prepare<[], any>(
    `SELECT l.user_id AS userId,
            u.account_id AS accountId,
            u.username,
            u.phone,
            u.display_name AS displayName,
            SUM(COALESCE(l.cost_micros, 0)) AS costMicros,
            SUM(CASE WHEN l.amount < 0 THEN -l.amount ELSE 0 END) AS chargedCredits,
            COUNT(*) AS count
       FROM credit_ledger l
       JOIN users u ON u.id = l.user_id
      WHERE l.provider IS NOT NULL OR l.model IS NOT NULL OR l.cost_micros IS NOT NULL
      GROUP BY l.user_id
      ORDER BY costMicros DESC, chargedCredits DESC
      LIMIT 30`,
  ).all();
	  const start = db.prepare<[], any>(
	    `SELECT MIN(created_at) AS firstAt
	       FROM credit_ledger
      WHERE provider IS NOT NULL OR model IS NOT NULL OR cost_micros IS NOT NULL`,
  ).get();
  return {
    revenue,
    gifts,
	    creditSpend,
      providerCost,
	    modelCost,
      userCost,
      pointsRule: { cnyToCredits: 100, label: '1 元 = 100 积分' },
	    statisticsStartAt: start?.firstAt || null,
	    notes: [
      '收入统计 billing_orders status=paid/applied 且 amount_cents>0 的真实支付订单。',
      'redeem / gift / positive adjust 单独列为赠送支出，不计入现金收入。',
      '模型维度成本只统计 ledger 新字段上线后的 provider/model/cost_micros 数据。',
    ],
  };
	}

function listPriceCatalog() {
  return getDb().prepare<[], any>(
    `SELECT id,
            provider,
            model,
            model_role AS modelRole,
            consumption_type AS consumptionType,
            unit,
            price_cny_micros_per_unit AS priceCnyMicrosPerUnit,
            price_usd_micros_per_unit AS priceUsdMicrosPerUnit,
            original_currency AS originalCurrency,
            original_price AS originalPrice,
            exchange_rate AS exchangeRate,
            source_note AS sourceNote,
            status,
            effective_from AS effectiveFrom,
            last_updated_at AS lastUpdatedAt,
            last_updated_by AS lastUpdatedBy
       FROM api_price_catalog
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'requires_probe' THEN 1 ELSE 2 END,
        model,
        consumption_type`,
  ).all();
}

function ledgerCsv(rows: any[]) {
  const header = [
    'createdAt',
    'ledgerId',
    'userId',
    'accountId',
    'username',
    'amount',
    'balanceAfter',
    'kind',
    'reason',
    'operationModule',
    'operationFeature',
    'provider',
    'model',
    'modelRole',
    'consumptionType',
    'quantity',
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'durationSec',
    'costCny',
    'priceCatalogId',
    'refId',
    'chargeRefId',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((key) => {
      const value = key === 'costCny'
        ? (Number(row.costMicros || 0) / 1_000_000).toFixed(6)
        : row[key];
      return csvCell(value);
    }).join(','));
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

function csvCell(value: unknown) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function manualAdjustGuard(args: { adminId: number; amount: number; confirmText: string }) {
  const abs = Math.abs(args.amount);
  const warnings: string[] = [];
  if (abs > ADMIN_MANUAL_ADJUST_LIMITS.absoluteBlockAbove) {
    return { blocked: true, status: 403, reason: `single adjustment above ${ADMIN_MANUAL_ADJUST_LIMITS.absoluteBlockAbove} is blocked`, warnings };
  }
  if (abs > ADMIN_MANUAL_ADJUST_LIMITS.secondConfirmAbove && args.confirmText !== 'CONFIRM') {
    return { blocked: true, status: 400, reason: 'CONFIRM required for large manual adjustment', warnings };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const row = getDb().prepare<{ adminId: number; since: string }, any>(
    `SELECT SUM(ABS(amount)) AS total
       FROM credit_ledger
      WHERE admin_user_id = @adminId
        AND kind = 'adjust'
        AND created_at >= @since`,
  ).get({ adminId: args.adminId, since: today.toISOString() });
  const used = Number(row?.total || 0);
  if (used + abs > ADMIN_MANUAL_ADJUST_LIMITS.dailyAdminAbsCap) {
    return { blocked: true, status: 403, reason: 'daily manual adjustment cap exceeded', warnings };
  }
  if (abs > ADMIN_MANUAL_ADJUST_LIMITS.secondConfirmAbove) warnings.push('大额调账已通过 CONFIRM 二次确认');
  return { blocked: false, status: 200, reason: '', warnings };
}

function creditSnapshot(userId: number) {
  return getBalance(userId);
}

function previewAdjustment(before: ReturnType<typeof getBalance>, amount: number) {
  if (amount > 0) {
    const overdraftReduction = Math.min(before.overdraftCredits || 0, amount);
    const bonusIncrease = amount - overdraftReduction;
    return {
      ...before,
      totalCredits: before.totalCredits + amount,
      bonusCredits: before.bonusCredits + bonusIncrease,
      overdraftCredits: (before.overdraftCredits || 0) - overdraftReduction,
    };
  }
  const abs = Math.abs(amount);
  if (before.totalCredits < abs) throw statusError('insufficient credits for manual debit', 402);
  let remaining = abs;
  const bonusUse = Math.min(remaining, before.bonusCredits);
  remaining -= bonusUse;
  const topupUse = Math.min(remaining, before.topupCredits);
  remaining -= topupUse;
  const subUse = Math.min(remaining, before.subscriptionCredits);
  return {
    ...before,
    totalCredits: before.totalCredits - abs,
    bonusCredits: before.bonusCredits - bonusUse,
    topupCredits: before.topupCredits - topupUse,
    subscriptionCredits: before.subscriptionCredits - subUse,
  };
}

function applyManualAdjustment(args: {
  userId: number;
  adminId: number;
  amount: number;
  reason: string;
  idempotencyKey: string;
}) {
  const db = getDb();
	  const txn = db.transaction(() => {
	    const before = getBalance(args.userId);
	    const after = previewAdjustment(before, args.amount);
	    const buckets = args.amount > 0
	      ? {
          bonus: after.bonusCredits - before.bonusCredits,
          topup: 0,
          subscription: 0,
          overdraft: after.overdraftCredits - before.overdraftCredits,
        }
	      : {
	          bonus: after.bonusCredits - before.bonusCredits,
	          topup: after.topupCredits - before.topupCredits,
	          subscription: after.subscriptionCredits - before.subscriptionCredits,
            overdraft: 0,
	        };
	    db.prepare(
	      `UPDATE user_credits
	          SET total_credits = @totalCredits,
	              subscription_credits = @subscriptionCredits,
	              topup_credits = @topupCredits,
	              bonus_credits = @bonusCredits,
                overdraft_credits = @overdraftCredits,
	              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
	        WHERE user_id = @userId`,
	    ).run({
	      userId: args.userId,
	      totalCredits: after.totalCredits,
	      subscriptionCredits: after.subscriptionCredits,
	      topupCredits: after.topupCredits,
	      bonusCredits: after.bonusCredits,
        overdraftCredits: after.overdraftCredits,
	    });
    const ledgerId = randomUUID();
    db.prepare(
      `INSERT INTO credit_ledger
        (id, user_id, amount, kind, reason, ref_id, admin_user_id, idempotency_key, balance_after, buckets_json)
       VALUES
        (@id, @userId, @amount, 'adjust', @reason, @refId, @adminId, @idempotencyKey, @balanceAfter, @bucketsJson)`,
    ).run({
      id: ledgerId,
      userId: args.userId,
      amount: args.amount,
      reason: args.reason.slice(0, 200),
      refId: `admin_adjust:${args.idempotencyKey || ledgerId}`,
      adminId: args.adminId,
      idempotencyKey: args.idempotencyKey || null,
      balanceAfter: after.totalCredits,
      bucketsJson: JSON.stringify(buckets),
    });
    return { ledgerId, before, after };
  });
  return txn.immediate();
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function statusError(message: string, status: number) {
  const error = new Error(message);
  (error as any).status = status;
  return error;
}
