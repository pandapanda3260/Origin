import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { getBalance, InsufficientCreditsError, type CreditKind } from './credits';

export const POINTS_PER_CNY = 100;

export type BillingScope = 'billable' | 'internal_admin' | 'non_billable';
export type UsageConsumptionType =
  | 'text_token'
  | 'image_count'
  | 'image_text_input'
  | 'image_input'
  | 'image_output'
  | 'video_second';

export type BillingSessionInput = {
  userId: number;
  operationModule: string;
  operationFeature: string;
  operationKey?: string | null;
  operationLabel?: string | null;
  scope?: BillingScope;
  refId?: string | null;
  meta?: Record<string, unknown> | null;
};

export type BillingSession = BillingSessionInput & {
  id: string;
  scope: BillingScope;
  createdAt: string;
};

export type UsageChargeInput = {
  userId: number;
  kind: Extract<CreditKind, 'text' | 'image' | 'video'>;
  reason: string;
  refId?: string | null;
  chargeRefId: string;
  provider?: string | null;
  model?: string | null;
  modelRole?: string | null;
  operationModule?: string | null;
  operationFeature?: string | null;
  consumptionType: UsageConsumptionType;
  quantity?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  durationSec?: number | null;
  usageEventIds?: string[] | null;
};

export type NonTextUsageEventInput = {
  userId: number;
  usernameSnapshot?: string | null;
  kind: Extract<CreditKind, 'image' | 'video'>;
  reason: string;
  refId: string;
  chargeRefId: string;
  provider?: string | null;
  model?: string | null;
  modelRole?: string | null;
  operationModule: string;
  operationFeature: string;
  operationLabel: string;
  consumptionType: Exclude<UsageConsumptionType, 'text_token'>;
  quantity?: number | null;
  durationSec?: number | null;
  projectId?: string | null;
  routeName?: string | null;
  requestPath?: string | null;
  billingSessionId?: string | null;
  billingScope?: BillingScope | null;
  operationKey?: string | null;
  callItemType?: string | null;
  callItemId?: string | null;
  callItemLabel?: string | null;
  batchId?: string | null;
  taskId?: string | null;
  status?: string | null;
  latencyMs?: number | null;
  providerResponseHash?: string | null;
  meta?: Record<string, unknown> | null;
};

export type UsageChargeResult =
  | {
      settled: true;
      alreadySettled: boolean;
      ledgerId: string;
      balanceAfter: number;
      costCnyMicros: number;
      points: number;
    }
  | {
      settled: false;
      reason: 'missing_model' | 'missing_price' | 'missing_usage' | 'zero_cost';
      costCnyMicros?: number;
    };

type PriceRow = {
  id: string;
  provider: string | null;
  model: string;
  model_role: string | null;
  consumption_type: string;
  unit: string;
  price_cny_micros_per_unit: number;
  price_usd_micros_per_unit: number | null;
  original_currency: string;
  original_price: number | null;
  exchange_rate: number | null;
  source_note: string;
  status: string;
  effective_from: string;
  last_updated_at: string;
  last_updated_by: string | null;
};

type CostPart = {
  type: string;
  amount: number;
  price: PriceRow;
  costCnyMicros: number;
};

export function assertCanStartPaidOperation(userId: number) {
  const balance = getBalance(userId);
  if (balance.totalCredits <= 0) {
    throw new InsufficientCreditsError(1, balance.totalCredits);
  }
  return balance;
}

export function createBillingSession(input: BillingSessionInput): BillingSession {
  return {
    ...input,
    id: `bill:${randomUUID()}`,
    scope: input.scope || 'billable',
    createdAt: new Date().toISOString(),
  };
}

export function billingSessionContextJson(session: BillingSession): string {
  return JSON.stringify({
    id: session.id,
    userId: session.userId,
    operationModule: session.operationModule,
    operationFeature: session.operationFeature,
    operationKey: session.operationKey || null,
    operationLabel: session.operationLabel || null,
    scope: session.scope,
    refId: session.refId || null,
    meta: session.meta || null,
    createdAt: session.createdAt,
  });
}

export function pointsFromCnyMicros(costCnyMicros: number): number {
  if (!Number.isFinite(costCnyMicros) || costCnyMicros <= 0) return 0;
  return Math.max(1, Math.ceil((costCnyMicros * POINTS_PER_CNY) / 1_000_000));
}

export function settleUsageCharge(input: UsageChargeInput): UsageChargeResult {
  const model = normalizeString(input.model);
  if (!model) {
    markUsageEvents(input.usageEventIds, 'unsettled', null);
    return { settled: false, reason: 'missing_model' };
  }

  const cost = calculateUsageCost({
    provider: input.provider || '',
    model,
    modelRole: input.modelRole || '',
    consumptionType: input.consumptionType,
    quantity: input.quantity,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedTokens: input.cachedTokens,
    durationSec: input.durationSec,
  });
  if (!cost.ok) {
    markUsageEvents(input.usageEventIds, 'unsettled', null);
    return { settled: false, reason: cost.reason };
  }

  const points = pointsFromCnyMicros(cost.costCnyMicros);
  if (points <= 0) {
    markUsageEvents(input.usageEventIds, 'unsettled', null);
    return { settled: false, reason: 'zero_cost', costCnyMicros: cost.costCnyMicros };
  }

	  const db = getDb();
	  const ledgerId = randomUUID();
	  const usageEventIds = normalizeUsageEventIds(input.usageEventIds);
  getBalance(input.userId);
	  const priceSnapshotJson = JSON.stringify({
    parts: cost.parts.map((part) => ({
      type: part.type,
      amount: part.amount,
      unit: part.price.unit,
      priceCatalogId: part.price.id,
      priceCnyMicrosPerUnit: part.price.price_cny_micros_per_unit,
      priceUsdMicrosPerUnit: part.price.price_usd_micros_per_unit,
      status: part.price.status,
      lastUpdatedAt: part.price.last_updated_at,
      sourceNote: part.price.source_note,
    })),
  });
  const priceCatalogId = cost.parts.length === 1 ? cost.parts[0].price.id : null;

  const txn = db.transaction(() => {
    const cur = getBalance(input.userId);
    let remaining = points;
    const bonusUse = Math.min(remaining, cur.bonusCredits);
    remaining -= bonusUse;
    const topupUse = Math.min(remaining, cur.topupCredits);
    remaining -= topupUse;
    const subUse = Math.min(remaining, cur.subscriptionCredits);
    remaining -= subUse;
    const overdraftUse = remaining;

    const newBonus = cur.bonusCredits - bonusUse;
    const newTopup = cur.topupCredits - topupUse;
    const newSub = cur.subscriptionCredits - subUse;
    const newOverdraft = cur.overdraftCredits + overdraftUse;
    const newTotal = newBonus + newTopup + newSub - newOverdraft;
    const bucketsJson = JSON.stringify({
      bonus: bonusUse,
      topup: topupUse,
      subscription: subUse,
      overdraft: overdraftUse,
    });

    db.prepare(
      `INSERT INTO credit_ledger
        (id, user_id, amount, kind, reason, ref_id, provider, model, model_role,
         cost_micros, cost_currency, operation_module, operation_feature,
         consumption_type, quantity, input_tokens, output_tokens, cached_tokens,
         reasoning_tokens, duration_sec, price_catalog_id, price_snapshot_json,
         usage_event_ids_json, charge_ref_id, idempotency_key, balance_after, buckets_json)
       VALUES
        (@id, @userId, @amount, @kind, @reason, @refId, @provider, @model, @modelRole,
         @costMicros, 'CNY', @operationModule, @operationFeature,
         @consumptionType, @quantity, @inputTokens, @outputTokens, @cachedTokens,
         @reasoningTokens, @durationSec, @priceCatalogId, @priceSnapshotJson,
         @usageEventIdsJson, @chargeRefId, @chargeRefId, @balanceAfter, @bucketsJson)`,
    ).run({
      id: ledgerId,
      userId: input.userId,
      amount: -points,
      kind: input.kind,
      reason: input.reason.slice(0, 200),
      refId: input.refId || null,
      provider: input.provider || null,
      model,
      modelRole: input.modelRole || null,
      costMicros: cost.costCnyMicros,
      operationModule: input.operationModule || null,
      operationFeature: input.operationFeature || null,
      consumptionType: input.consumptionType,
      quantity: normalizeNumber(input.quantity),
      inputTokens: normalizeInteger(input.inputTokens),
      outputTokens: normalizeInteger(input.outputTokens),
      cachedTokens: normalizeInteger(input.cachedTokens),
      reasoningTokens: normalizeInteger(input.reasoningTokens),
      durationSec: normalizeNumber(input.durationSec),
      priceCatalogId,
      priceSnapshotJson,
      usageEventIdsJson: usageEventIds.length ? JSON.stringify(usageEventIds) : null,
      chargeRefId: input.chargeRefId,
      balanceAfter: newTotal,
      bucketsJson,
    });

    const info = db.prepare(
      `UPDATE user_credits SET
          subscription_credits = @subscription,
          topup_credits = @topup,
          bonus_credits = @bonus,
          overdraft_credits = @overdraft,
          total_credits = @total,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = @userId
          AND subscription_credits = @oldSubscription
          AND topup_credits = @oldTopup
          AND bonus_credits = @oldBonus
          AND overdraft_credits = @oldOverdraft`,
    ).run({
      userId: input.userId,
      subscription: newSub,
      topup: newTopup,
      bonus: newBonus,
      overdraft: newOverdraft,
      total: newTotal,
      oldSubscription: cur.subscriptionCredits,
      oldTopup: cur.topupCredits,
      oldBonus: cur.bonusCredits,
      oldOverdraft: cur.overdraftCredits,
    });
    if (info.changes !== 1) throw new Error('usage billing balance update conflict');
    markUsageEvents(usageEventIds, 'billed', ledgerId);
    return { balanceAfter: newTotal };
  });

  try {
    const applied = txn.immediate();
    return {
      settled: true,
      alreadySettled: false,
      ledgerId,
      balanceAfter: applied.balanceAfter,
      costCnyMicros: cost.costCnyMicros,
      points,
    };
  } catch (error: any) {
    if (isUniqueChargeRefError(error)) {
      const existing = db
        .prepare<{ ref: string }, any>('SELECT id, balance_after, cost_micros, amount FROM credit_ledger WHERE charge_ref_id = @ref LIMIT 1')
        .get({ ref: input.chargeRefId });
      if (existing) {
        markUsageEvents(usageEventIds, 'billed', String(existing.id));
        return {
          settled: true,
          alreadySettled: true,
          ledgerId: String(existing.id),
          balanceAfter: Number(existing.balance_after || 0),
          costCnyMicros: Number(existing.cost_micros || cost.costCnyMicros),
          points: Math.abs(Number(existing.amount || points)),
        };
      }
    }
    throw error;
  }
}

export function recordUsageEventAndSettleCharge(input: NonTextUsageEventInput): UsageChargeResult {
  const status = String(input.status || 'ok').toLowerCase();
  const scope = input.billingScope || 'billable';
  const usageEventId = randomUUID();
  const shouldSettle = status === 'ok' && scope === 'billable';
  const initialBillingStatus = shouldSettle ? 'pending' : scope === 'internal_admin' ? 'internal' : 'not_billable';
  getDb().prepare(
    `INSERT INTO token_usage_events
      (id, owner_id, username_snapshot, project_id, request_path, route_name, trace_name,
       module_key, module_label, feature_key, feature_label, call_item_type, call_item_id,
       call_item_label, provider, model, model_role, slot, status, latency_ms,
       usage_source, billing_session_id, billing_scope, operation_key, operation_label,
       consumption_type, quantity, duration_sec, billing_status, provider_response_hash,
       batch_id, task_id, meta_json)
     VALUES
      (@id, @ownerId, @usernameSnapshot, @projectId, @requestPath, @routeName, @traceName,
       @moduleKey, @moduleLabel, @featureKey, @featureLabel, @callItemType, @callItemId,
       @callItemLabel, @provider, @model, @modelRole, @slot, @status, @latencyMs,
       @usageSource, @billingSessionId, @billingScope, @operationKey, @operationLabel,
       @consumptionType, @quantity, @durationSec, @billingStatus, @providerResponseHash,
       @batchId, @taskId, @metaJson)`,
  ).run({
    id: usageEventId,
    ownerId: input.userId,
    usernameSnapshot: input.usernameSnapshot || null,
    projectId: input.projectId || null,
    requestPath: input.requestPath || null,
    routeName: input.routeName || null,
    traceName: input.operationFeature,
    moduleKey: input.operationModule || 'other',
    moduleLabel: moduleLabelForKey(input.operationModule),
    featureKey: input.operationFeature || 'unknown',
    featureLabel: input.operationLabel || input.reason,
    callItemType: input.callItemType || null,
    callItemId: input.callItemId || null,
    callItemLabel: input.callItemLabel || null,
    provider: input.provider || null,
    model: input.model || null,
    modelRole: input.modelRole || null,
    slot: input.kind,
    status,
    latencyMs: normalizeInteger(input.latencyMs),
    usageSource: 'provider',
    billingSessionId: input.billingSessionId || null,
    billingScope: scope,
    operationKey: input.operationKey || input.refId,
    operationLabel: input.operationLabel || input.reason,
    consumptionType: input.consumptionType,
    quantity: normalizeNumber(input.quantity),
    durationSec: normalizeNumber(input.durationSec),
    billingStatus: initialBillingStatus,
    providerResponseHash: input.providerResponseHash || null,
    batchId: input.batchId || null,
    taskId: input.taskId || null,
    metaJson: JSON.stringify(input.meta || {}),
  });
  if (!shouldSettle) {
    return { settled: false, reason: 'zero_cost' };
  }
  return settleUsageCharge({
    userId: input.userId,
    kind: input.kind,
    reason: input.reason,
    refId: input.refId,
    chargeRefId: input.chargeRefId,
    provider: input.provider || null,
    model: input.model || null,
    modelRole: input.modelRole || null,
    operationModule: input.operationModule,
    operationFeature: input.operationFeature,
    consumptionType: input.consumptionType,
    quantity: input.quantity,
    durationSec: input.durationSec,
    usageEventIds: [usageEventId],
  });
}

export function markUsageEvents(ids: string[] | null | undefined, status: string, ledgerId: string | null) {
  const usageEventIds = normalizeUsageEventIds(ids);
  if (!usageEventIds.length) return;
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE token_usage_events
        SET billing_status = @status,
            ledger_id = COALESCE(@ledgerId, ledger_id)
      WHERE id = @id`,
  );
  for (const id of usageEventIds) stmt.run({ id, status, ledgerId });
}

function calculateUsageCost(input: {
  provider: string;
  model: string;
  modelRole: string;
  consumptionType: UsageConsumptionType;
  quantity?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  durationSec?: number | null;
}): { ok: true; costCnyMicros: number; parts: CostPart[] } | { ok: false; reason: 'missing_price' | 'missing_usage' } {
  if (input.consumptionType === 'text_token') {
    const inputTokens = Math.max(0, Math.floor(Number(input.inputTokens || 0)));
    const outputTokens = Math.max(0, Math.floor(Number(input.outputTokens || 0)));
    const cachedTokens = Math.max(0, Math.min(inputTokens, Math.floor(Number(input.cachedTokens || 0))));
    if (inputTokens + outputTokens <= 0) return { ok: false, reason: 'missing_usage' };

    const parts: CostPart[] = [];
    const inputPrice = findPrice(input.provider, input.model, input.modelRole, 'text_input');
    const outputPrice = findPrice(input.provider, input.model, input.modelRole, 'text_output');
    const cachedPrice = cachedTokens > 0
      ? findPrice(input.provider, input.model, input.modelRole, 'text_cached') || inputPrice
      : null;
    if ((inputTokens > cachedTokens && !inputPrice) || (outputTokens > 0 && !outputPrice) || (cachedTokens > 0 && !cachedPrice)) {
      return { ok: false, reason: 'missing_price' };
    }
    if (inputTokens > cachedTokens && inputPrice) {
      parts.push(costPerMillion('text_input', inputTokens - cachedTokens, inputPrice));
    }
    if (cachedTokens > 0 && cachedPrice) {
      parts.push(costPerMillion('text_cached', cachedTokens, cachedPrice));
    }
    if (outputTokens > 0 && outputPrice) {
      parts.push(costPerMillion('text_output', outputTokens, outputPrice));
    }
    return { ok: true, costCnyMicros: sumCost(parts), parts };
  }

  const price = findPrice(input.provider, input.model, input.modelRole, input.consumptionType);
  if (!price) return { ok: false, reason: 'missing_price' };
  const amount = input.consumptionType === 'video_second'
    ? Number(input.durationSec || input.quantity || 0)
    : Number(input.quantity || 0);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'missing_usage' };
  const costCnyMicros = Math.ceil(amount * Number(price.price_cny_micros_per_unit || 0));
  return {
    ok: true,
    costCnyMicros,
    parts: [{ type: input.consumptionType, amount, price, costCnyMicros }],
  };
}

function findPrice(provider: string, model: string, modelRole: string, consumptionType: string): PriceRow | null {
  const rows = getDb()
    .prepare<any, PriceRow>(
      `SELECT *
         FROM api_price_catalog
        WHERE model = @model
          AND consumption_type = @consumptionType
          AND status = 'active'
          AND (provider = @provider OR provider = '' OR provider IS NULL)
          AND (model_role = @modelRole OR model_role = '' OR model_role IS NULL)
        ORDER BY
          CASE WHEN provider = @provider THEN 0 WHEN provider = '' OR provider IS NULL THEN 1 ELSE 2 END,
          CASE WHEN model_role = @modelRole THEN 0 WHEN model_role = '' OR model_role IS NULL THEN 1 ELSE 2 END,
          last_updated_at DESC
        LIMIT 1`,
    )
    .all({ provider, model, modelRole, consumptionType });
  return rows[0] || null;
}

function costPerMillion(type: string, tokens: number, price: PriceRow): CostPart {
  const costCnyMicros = Math.ceil((tokens * Number(price.price_cny_micros_per_unit || 0)) / 1_000_000);
  return { type, amount: tokens, price, costCnyMicros };
}

function sumCost(parts: CostPart[]): number {
  return parts.reduce((sum, part) => sum + part.costCnyMicros, 0);
}

function normalizeUsageEventIds(ids: string[] | null | undefined): string[] {
  return Array.from(new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean)));
}

function normalizeString(value: unknown): string {
  return String(value || '').trim();
}

function normalizeInteger(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function normalizeNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUniqueChargeRefError(error: any): boolean {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('unique') && message.includes('credit_ledger') && message.includes('charge_ref');
}

function moduleLabelForKey(key: string): string {
  if (key === 'assets') return '资产生成';
  if (key === 'toolbox') return '工具箱';
  if (key === 'shots') return '镜头规划';
  if (key === 'video') return '视频生成';
  if (key === 'storyboard') return '分镜';
  return '其它';
}
