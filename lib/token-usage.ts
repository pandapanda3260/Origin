import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';
import type { ResolvedModelConfig, TextModelRole } from './model-routing';

export type TokenUsageContext = {
  ownerId?: number | null;
  usernameSnapshot?: string | null;
  projectId?: string | null;
  projectTitleSnapshot?: string | null;
  requestPath?: string | null;
  routeName?: string | null;
  moduleKey?: string | null;
  moduleLabel?: string | null;
  featureKey?: string | null;
  featureLabel?: string | null;
  callItemType?: string | null;
  callItemId?: string | null;
  callItemLabel?: string | null;
  batchId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  correlationId?: string | null;
  promptHash?: string | null;
  responseHash?: string | null;
  meta?: Record<string, unknown> | null;
};

export type TokenUsageEventInput = {
  cfg: ResolvedModelConfig;
  slot?: string | null;
  modelRole?: TextModelRole | string | null;
  traceName?: string | null;
  status: string;
  statusCode?: number | null;
  errorCode?: string | null;
  latencyMs?: number | null;
  usage?: Record<string, unknown> | null;
  tokenContext?: TokenUsageContext | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
};

export type TokenUsageFilters = {
  since?: string | null;
  until?: string | null;
  ownerId?: number | null;
  projectId?: string | null;
  moduleKey?: string | null;
  featureKey?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: string | null;
  query?: string | null;
  limit?: number;
  offset?: number;
};

export type TokenUsageEventRow = {
  id: string;
  createdAt: string;
  ownerId: number | null;
  usernameSnapshot: string | null;
  projectId: string | null;
  projectTitleSnapshot: string | null;
  requestPath: string | null;
  routeName: string | null;
  traceName: string | null;
  moduleKey: string;
  moduleLabel: string;
  featureKey: string;
  featureLabel: string;
  callItemType: string | null;
  callItemId: string | null;
  callItemLabel: string | null;
  provider: string | null;
  model: string | null;
  modelRole: string | null;
  slot: string | null;
  status: string;
  statusCode: number | null;
  errorCode: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  billableTokens: number | null;
  usageSource: string;
  promptHash: string | null;
  responseHash: string | null;
  batchId: string | null;
  taskId: string | null;
  runId: string | null;
  correlationId: string | null;
  meta: Record<string, unknown>;
};

const DEFAULT_RETENTION_DAYS = 180;
let lastLazyCleanupAt = 0;
let lastWriteErrorLogAt = 0;

export function recordTokenUsageEvent(input: TokenUsageEventInput): string | null {
  try {
    const usage = normalizeUsage(input.usage);
    const ctx = input.tokenContext || {};
    const classified = classifyTokenUsageContext(input.traceName, ctx);
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO token_usage_events
          (id, created_at, owner_id, username_snapshot, project_id, project_title_snapshot,
           request_path, route_name, trace_name, module_key, module_label, feature_key,
           feature_label, call_item_type, call_item_id, call_item_label, provider, model,
           model_role, slot, status, status_code, error_code, latency_ms, input_tokens,
           output_tokens, reasoning_tokens, cached_tokens, total_tokens, billable_tokens,
           usage_source, prompt_hash, response_hash, batch_id, task_id, run_id,
           correlation_id, meta_json)
         VALUES
          (@id, @createdAt, @ownerId, @usernameSnapshot, @projectId, @projectTitleSnapshot,
           @requestPath, @routeName, @traceName, @moduleKey, @moduleLabel, @featureKey,
           @featureLabel, @callItemType, @callItemId, @callItemLabel, @provider, @model,
           @modelRole, @slot, @status, @statusCode, @errorCode, @latencyMs, @inputTokens,
           @outputTokens, @reasoningTokens, @cachedTokens, @totalTokens, @billableTokens,
           @usageSource, @promptHash, @responseHash, @batchId, @taskId, @runId,
           @correlationId, @metaJson)`,
      )
      .run({
        id,
        createdAt: input.createdAt || new Date().toISOString(),
        ownerId: intOrNull(ctx.ownerId),
        usernameSnapshot: nullableString(ctx.usernameSnapshot, 160),
        projectId: nullableString(ctx.projectId, 120),
        projectTitleSnapshot: nullableString(ctx.projectTitleSnapshot, 240),
        requestPath: nullableString(ctx.requestPath, 240),
        routeName: nullableString(ctx.routeName, 160),
        traceName: nullableString(input.traceName, 160),
        moduleKey: classified.moduleKey,
        moduleLabel: classified.moduleLabel,
        featureKey: classified.featureKey,
        featureLabel: classified.featureLabel,
        callItemType: nullableString(ctx.callItemType, 80),
        callItemId: nullableString(ctx.callItemId, 160),
        callItemLabel: nullableString(ctx.callItemLabel, 240),
        provider: nullableString(input.cfg.provider, 120),
        model: nullableString(input.cfg.model, 160),
        modelRole: nullableString(input.modelRole || input.cfg.role, 80),
        slot: nullableString(input.slot, 80),
        status: String(input.status || 'unknown').slice(0, 80),
        statusCode: intOrNull(input.statusCode),
        errorCode: nullableString(input.errorCode, 160),
        latencyMs: intOrNull(input.latencyMs),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedTokens: usage.cachedTokens,
        totalTokens: usage.totalTokens,
        billableTokens: usage.billableTokens,
        usageSource: usage.usageSource,
        promptHash: nullableHash(ctx.promptHash),
        responseHash: nullableHash(ctx.responseHash),
        batchId: nullableString(ctx.batchId, 120),
        taskId: nullableString(ctx.taskId, 120),
        runId: nullableString(ctx.runId, 160),
        correlationId: nullableString(ctx.correlationId, 160),
        metaJson: cappedJson({
          ...(ctx.meta || {}),
          ...(input.meta || {}),
        }),
      });
    return id;
  } catch (error) {
    maybeLogTokenUsageWriteError(error);
    return null;
  }
}

export function listTokenUsageEvents(filters: TokenUsageFilters = {}): { rows: TokenUsageEventRow[]; total: number } {
  maybeCleanupTokenUsageEvents();
  const { where, params } = buildWhere(filters);
  const limit = clampInt(filters.limit, 100, 1, 500);
  const offset = clampInt(filters.offset, 0, 0, 100_000);
  const rows = getDb()
    .prepare<Record<string, unknown>, any>(
      `SELECT ${TOKEN_USAGE_SELECT}
         FROM token_usage_events
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset })
    .map(decodeTokenUsageRow);
  const total = getDb()
    .prepare<Record<string, unknown>, any>(
      `SELECT COUNT(*) AS count
         FROM token_usage_events
        WHERE ${where.join(' AND ')}`,
    )
    .get(params)?.count || 0;
  return { rows, total: Number(total) || 0 };
}

export function summarizeTokenUsage(filters: TokenUsageFilters = {}) {
  maybeCleanupTokenUsageEvents();
  const { where, params } = buildWhere(filters, { onlyCountedUsage: true });
  const row = getDb()
    .prepare<Record<string, unknown>, any>(
      `SELECT COUNT(*) AS calls,
              COUNT(DISTINCT owner_id) AS users,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(billable_tokens), 0) AS billableTokens
         FROM token_usage_events
        WHERE ${where.join(' AND ')}`,
    )
    .get(params) || {};
  const missingWhere = buildWhere(filters, { onlyMissingUsage: true });
  const missingUsage = getDb()
    .prepare<Record<string, unknown>, any>(
      `SELECT COUNT(*) AS calls
         FROM token_usage_events
        WHERE ${missingWhere.where.join(' AND ')}`,
    )
    .get(missingWhere.params)?.calls || 0;
  return normalizeSummaryRow({ ...row, missingUsageCalls: missingUsage });
}

export function summarizeTokenUsageByUser(filters: TokenUsageFilters = {}, limit = 100) {
  maybeCleanupTokenUsageEvents();
  const { where, params } = buildWhere(filters, { onlyCountedUsage: true });
  return getDb()
    .prepare<Record<string, unknown>, any>(
      `SELECT owner_id AS ownerId,
              COALESCE(username_snapshot, 'unknown') AS username,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(billable_tokens), 0) AS billableTokens
         FROM token_usage_events
        WHERE ${where.join(' AND ')}
        GROUP BY owner_id, username_snapshot
        ORDER BY totalTokens DESC, calls DESC
        LIMIT @limit`,
    )
    .all({ ...params, limit: clampInt(limit, 100, 1, 500) })
    .map(normalizeSummaryRow);
}

export function summarizeTokenUsageByCategory(filters: TokenUsageFilters = {}, limit = 100) {
  maybeCleanupTokenUsageEvents();
  const { where, params } = buildWhere(filters, { onlyCountedUsage: true });
  return getDb()
    .prepare<Record<string, unknown>, any>(
      `SELECT module_key AS moduleKey,
              module_label AS moduleLabel,
              feature_key AS featureKey,
              feature_label AS featureLabel,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COALESCE(SUM(billable_tokens), 0) AS billableTokens
         FROM token_usage_events
        WHERE ${where.join(' AND ')}
        GROUP BY module_key, module_label, feature_key, feature_label
        ORDER BY totalTokens DESC, calls DESC
        LIMIT @limit`,
    )
    .all({ ...params, limit: clampInt(limit, 100, 1, 500) })
    .map(normalizeSummaryRow);
}

export function buildTokenUsageCsv(rows: TokenUsageEventRow[]): string {
  const header = [
    'created_at',
    'owner_id',
    'username',
    'project_id',
    'project_title',
    'module',
    'feature',
    'call_item_type',
    'call_item_id',
    'call_item_label',
    'provider',
    'model',
    'model_role',
    'slot',
    'status',
    'status_code',
    'error_code',
    'latency_ms',
    'input_tokens',
    'output_tokens',
    'reasoning_tokens',
    'cached_tokens',
    'total_tokens',
    'billable_tokens',
    'usage_source',
    'trace_name',
    'request_path',
    'batch_id',
    'task_id',
    'run_id',
    'correlation_id',
    'prompt_hash',
    'response_hash',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.createdAt,
      row.ownerId ?? '',
      row.usernameSnapshot || '',
      row.projectId || '',
      row.projectTitleSnapshot || '',
      row.moduleKey,
      row.featureKey,
      row.callItemType || '',
      row.callItemId || '',
      row.callItemLabel || '',
      row.provider || '',
      row.model || '',
      row.modelRole || '',
      row.slot || '',
      row.status,
      row.statusCode ?? '',
      row.errorCode || '',
      row.latencyMs ?? '',
      row.inputTokens ?? '',
      row.outputTokens ?? '',
      row.reasoningTokens ?? '',
      row.cachedTokens ?? '',
      row.totalTokens ?? '',
      row.billableTokens ?? '',
      row.usageSource,
      row.traceName || '',
      row.requestPath || '',
      row.batchId || '',
      row.taskId || '',
      row.runId || '',
      row.correlationId || '',
      row.promptHash || '',
      row.responseHash || '',
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function cleanupTokenUsageEvents(retentionDays = DEFAULT_RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = getDb()
    .prepare('DELETE FROM token_usage_events WHERE created_at < @cutoff')
    .run({ cutoff });
  return Number(result.changes || 0);
}

function maybeCleanupTokenUsageEvents() {
  const now = Date.now();
  if (now - lastLazyCleanupAt < 60 * 60 * 1000) return;
  lastLazyCleanupAt = now;
  try {
    cleanupTokenUsageEvents();
  } catch (error) {
    maybeLogTokenUsageWriteError(error);
  }
}

const TOKEN_USAGE_SELECT = `
  id,
  created_at AS createdAt,
  owner_id AS ownerId,
  username_snapshot AS usernameSnapshot,
  project_id AS projectId,
  project_title_snapshot AS projectTitleSnapshot,
  request_path AS requestPath,
  route_name AS routeName,
  trace_name AS traceName,
  module_key AS moduleKey,
  module_label AS moduleLabel,
  feature_key AS featureKey,
  feature_label AS featureLabel,
  call_item_type AS callItemType,
  call_item_id AS callItemId,
  call_item_label AS callItemLabel,
  provider,
  model,
  model_role AS modelRole,
  slot,
  status,
  status_code AS statusCode,
  error_code AS errorCode,
  latency_ms AS latencyMs,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  reasoning_tokens AS reasoningTokens,
  cached_tokens AS cachedTokens,
  total_tokens AS totalTokens,
  billable_tokens AS billableTokens,
  usage_source AS usageSource,
  prompt_hash AS promptHash,
  response_hash AS responseHash,
  batch_id AS batchId,
  task_id AS taskId,
  run_id AS runId,
  correlation_id AS correlationId,
  meta_json AS metaJson
`;

function normalizeUsage(value: Record<string, unknown> | null | undefined) {
  const inputTokens = numberOrNull(value?.inputTokens, value?.input_tokens, value?.prompt_tokens);
  const outputTokens = numberOrNull(value?.outputTokens, value?.output_tokens, value?.completion_tokens);
  const reasoningTokens = numberOrNull(value?.reasoningTokens, value?.reasoning_tokens);
  const cachedTokens = numberOrNull(value?.cachedTokens, value?.cached_tokens);
  const explicitTotal = numberOrNull(value?.totalTokens, value?.total_tokens);
  const inferredTotal = nullableSum(inputTokens, outputTokens, reasoningTokens);
  const totalTokens = explicitTotal ?? inferredTotal;
  const billableTokens = totalTokens === null && cachedTokens === null
    ? null
    : Math.max(0, (totalTokens || 0) - (cachedTokens || 0));
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    billableTokens,
    usageSource: totalTokens === null ? 'missing' : 'provider',
  };
}

function classifyTokenUsageContext(traceName: string | null | undefined, ctx: TokenUsageContext) {
  if (ctx.moduleKey || ctx.featureKey) {
    return {
      moduleKey: safeKey(ctx.moduleKey, 'other'),
      moduleLabel: nullableString(ctx.moduleLabel, 80) || fallbackModuleLabel(ctx.moduleKey),
      featureKey: safeKey(ctx.featureKey, 'unknown'),
      featureLabel: nullableString(ctx.featureLabel, 120) || fallbackFeatureLabel(ctx.featureKey || traceName),
    };
  }
  const trace = String(traceName || '').toLowerCase();
  if (trace.includes('asset') || trace.includes('character') || trace.includes('scene') || trace.includes('prop')) {
    return category('assets', '资产生成', traceName || 'assets', fallbackFeatureLabel(traceName || '资产调用'));
  }
  if (trace.includes('shot') || trace.includes('storyboard')) {
    return category('shots', '镜头规划', traceName || 'shots', fallbackFeatureLabel(traceName || '镜头调用'));
  }
  if (trace.includes('video-prompt') || trace.includes('video_prompts') || trace.includes('prompt')) {
    return category('video_prompt', '视频提示词', traceName || 'video_prompt', fallbackFeatureLabel(traceName || '提示词调用'));
  }
  if (trace.includes('style')) {
    return category('style', '风格页面', traceName || 'style', fallbackFeatureLabel(traceName || '风格调用'));
  }
  if (trace.includes('script')) {
    return category('script', '剧本页面', traceName || 'script', fallbackFeatureLabel(traceName || '剧本调用'));
  }
  if (trace.includes('edit') || trace.includes('export')) {
    return category('edit_export', '剪辑导出', traceName || 'edit_export', fallbackFeatureLabel(traceName || '剪辑调用'));
  }
  if (trace.includes('knowledge')) {
    return category('knowledge', '知识库', traceName || 'knowledge', fallbackFeatureLabel(traceName || '知识库调用'));
  }
  return category('other', '其它', traceName || 'unknown', fallbackFeatureLabel(traceName || '未知调用'));
}

function category(moduleKey: string, moduleLabel: string, featureKey: string, featureLabel: string) {
  return {
    moduleKey: safeKey(moduleKey, 'other'),
    moduleLabel,
    featureKey: safeKey(featureKey, 'unknown'),
    featureLabel,
  };
}

function buildWhere(filters: TokenUsageFilters = {}, opts: { onlyCountedUsage?: boolean; onlyMissingUsage?: boolean } = {}) {
  const where = ['1=1'];
  const params: Record<string, unknown> = {};
  if (filters.since) {
    where.push('created_at >= @since');
    params.since = filters.since;
  }
  if (filters.until) {
    where.push('created_at < @until');
    params.until = filters.until;
  }
  if (filters.ownerId != null) {
    where.push('owner_id = @ownerId');
    params.ownerId = filters.ownerId;
  }
  if (filters.projectId) {
    where.push('project_id = @projectId');
    params.projectId = filters.projectId;
  }
  if (filters.moduleKey) {
    where.push('module_key = @moduleKey');
    params.moduleKey = filters.moduleKey;
  }
  if (filters.featureKey) {
    where.push('feature_key = @featureKey');
    params.featureKey = filters.featureKey;
  }
  if (filters.provider) {
    where.push('provider = @provider');
    params.provider = filters.provider;
  }
  if (filters.model) {
    where.push('model = @model');
    params.model = filters.model;
  }
  if (filters.status) {
    where.push('status = @status');
    params.status = filters.status;
  }
  if (filters.query) {
    where.push(`(
      username_snapshot LIKE @query OR project_title_snapshot LIKE @query OR project_id LIKE @query OR
      trace_name LIKE @query OR call_item_label LIKE @query OR call_item_id LIKE @query OR model LIKE @query
    )`);
    params.query = `%${filters.query}%`;
  }
  if (opts.onlyCountedUsage) where.push("usage_source != 'missing' AND total_tokens IS NOT NULL");
  if (opts.onlyMissingUsage) where.push("(usage_source = 'missing' OR total_tokens IS NULL)");
  return { where, params };
}

function decodeTokenUsageRow(row: any): TokenUsageEventRow {
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metaJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {}
  return {
    id: row.id,
    createdAt: row.createdAt,
    ownerId: row.ownerId == null ? null : Number(row.ownerId),
    usernameSnapshot: row.usernameSnapshot || null,
    projectId: row.projectId || null,
    projectTitleSnapshot: row.projectTitleSnapshot || null,
    requestPath: row.requestPath || null,
    routeName: row.routeName || null,
    traceName: row.traceName || null,
    moduleKey: row.moduleKey || 'other',
    moduleLabel: row.moduleLabel || '其它',
    featureKey: row.featureKey || 'unknown',
    featureLabel: row.featureLabel || '未知功能',
    callItemType: row.callItemType || null,
    callItemId: row.callItemId || null,
    callItemLabel: row.callItemLabel || null,
    provider: row.provider || null,
    model: row.model || null,
    modelRole: row.modelRole || null,
    slot: row.slot || null,
    status: row.status || 'unknown',
    statusCode: row.statusCode == null ? null : Number(row.statusCode),
    errorCode: row.errorCode || null,
    latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
    inputTokens: row.inputTokens == null ? null : Number(row.inputTokens),
    outputTokens: row.outputTokens == null ? null : Number(row.outputTokens),
    reasoningTokens: row.reasoningTokens == null ? null : Number(row.reasoningTokens),
    cachedTokens: row.cachedTokens == null ? null : Number(row.cachedTokens),
    totalTokens: row.totalTokens == null ? null : Number(row.totalTokens),
    billableTokens: row.billableTokens == null ? null : Number(row.billableTokens),
    usageSource: row.usageSource || 'missing',
    promptHash: row.promptHash || null,
    responseHash: row.responseHash || null,
    batchId: row.batchId || null,
    taskId: row.taskId || null,
    runId: row.runId || null,
    correlationId: row.correlationId || null,
    meta,
  };
}

function normalizeSummaryRow(row: any) {
  return {
    ...row,
    ownerId: row.ownerId == null ? null : Number(row.ownerId),
    calls: Number(row.calls || 0),
    users: Number(row.users || 0),
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    reasoningTokens: Number(row.reasoningTokens || 0),
    cachedTokens: Number(row.cachedTokens || 0),
    totalTokens: Number(row.totalTokens || 0),
    billableTokens: Number(row.billableTokens || 0),
    missingUsageCalls: Number(row.missingUsageCalls || 0),
  };
}

function nullableString(value: unknown, max: number) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function nullableHash(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
  return createHash('sha256').update(text).digest('hex');
}

function safeKey(value: unknown, fallback: string) {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .slice(0, 120) || fallback;
}

function fallbackModuleLabel(value: unknown) {
  const key = String(value || '').trim();
  if (!key) return '其它';
  return key.replace(/[_:-]+/g, ' ');
}

function fallbackFeatureLabel(value: unknown) {
  const key = String(value || '').trim();
  if (!key) return '未知功能';
  return key.replace(/[_:-]+/g, ' ');
}

function numberOrNull(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  }
  return null;
}

function intOrNull(value: unknown) {
  if (value == null || value === '') return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : null;
}

function nullableSum(...values: Array<number | null>) {
  let seen = false;
  let total = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      seen = true;
      total += value;
    }
  }
  return seen ? total : null;
}

function cappedJson(value: unknown) {
  const raw = JSON.stringify(value ?? {});
  return raw.length <= 8000 ? raw : JSON.stringify({ truncated: true, preview: raw.slice(0, 8000) });
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function maybeLogTokenUsageWriteError(error: unknown) {
  const now = Date.now();
  if (now - lastWriteErrorLogAt < 60_000 && Math.random() >= 0.01) return;
  lastWriteErrorLogAt = now;
  console.error('[token-usage] write failed', error);
}
