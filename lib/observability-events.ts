import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type ObservabilityEventType =
  | 'model_call'
  | 'system_warn'
  | 'system_error'
  | 'provider_cancel'
  | 'admin_runtime'
  | 'task_lifecycle'
  | 'content_disposition';

export type ObservabilityEventInput = {
  type: ObservabilityEventType | string;
  slot?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: string | null;
  statusCode?: number | null;
  errorCode?: string | null;
  latencyMs?: number | null;
  fallbackUsed?: boolean;
  message?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
};

export type ObservabilityEventRow = {
  id: string;
  type: string;
  slot: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  statusCode: number | null;
  errorCode: string | null;
  latencyMs: number | null;
  fallbackUsed: boolean;
  message: string;
  meta: Record<string, unknown>;
  createdAt: string;
};

const DEFAULT_RETENTION_DAYS = 14;
let lastLazyCleanupAt = 0;
let lastWriteErrorLogAt = 0;

export function recordObservabilityEvent(input: ObservabilityEventInput): string | null {
  try {
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO observability_events
          (id, type, slot, provider, model, status, status_code, error_code,
           latency_ms, fallback_used, message, meta_json, created_at)
         VALUES
          (@id, @type, @slot, @provider, @model, @status, @statusCode, @errorCode,
           @latencyMs, @fallbackUsed, @message, @metaJson, @createdAt)`,
      )
      .run({
        id,
        type: String(input.type || 'admin_runtime').slice(0, 80),
        slot: nullableString(input.slot, 80),
        provider: nullableString(input.provider, 120),
        model: nullableString(input.model, 160),
        status: String(input.status || 'info').slice(0, 80),
        statusCode: Number.isFinite(Number(input.statusCode)) ? Math.floor(Number(input.statusCode)) : null,
        errorCode: nullableString(input.errorCode, 160),
        latencyMs: Number.isFinite(Number(input.latencyMs)) ? Math.max(0, Math.floor(Number(input.latencyMs))) : null,
        fallbackUsed: input.fallbackUsed ? 1 : 0,
        message: String(input.message || '').slice(0, 2000),
        metaJson: cappedJson(input.meta || {}),
        createdAt: input.createdAt || new Date().toISOString(),
      });
    return id;
  } catch (error) {
    maybeLogObservabilityWriteError(error);
    return null;
  }
}

export function listObservabilityEvents(args: {
  type?: string;
  since?: string;
  limit?: number;
  level?: 'warning' | 'all';
} = {}): ObservabilityEventRow[] {
  maybeCleanupObservabilityEvents();
  const where: string[] = ['1=1'];
  const params: Record<string, unknown> = {
    limit: clampInt(args.limit, 100, 1, 500),
  };
  if (args.type) {
    where.push('type = @type');
    params.type = args.type;
  }
  if (args.since) {
    where.push('created_at >= @since');
    params.since = args.since;
  }
  if (args.level === 'warning') {
    where.push("(status IN ('warn','warning','error','failed','rate_limited') OR type IN ('system_warn','system_error'))");
  }
  return getDb()
    .prepare<Record<string, unknown>, any>(
      `SELECT id, type, slot, provider, model, status, status_code AS statusCode,
              error_code AS errorCode, latency_ms AS latencyMs, fallback_used AS fallbackUsed,
              message, meta_json AS metaJson, created_at AS createdAt
         FROM observability_events
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT @limit`,
    )
    .all(params)
    .map(decodeRow);
}

export function modelMetricsSnapshot(minutes = 10) {
  maybeCleanupObservabilityEvents();
  const since = new Date(Date.now() - Math.max(1, minutes) * 60 * 1000).toISOString();
  const rows = getDb()
    .prepare<{ since: string }, any>(
      `SELECT COALESCE(slot, 'unknown') AS slot,
              COALESCE(provider, 'unknown') AS provider,
              COALESCE(model, 'unknown') AS model,
              COUNT(*) AS total,
              SUM(CASE WHEN status IN ('ok','success','completed') THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status IN ('failed','error') THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status IN ('rate_limited') OR status_code = 429 THEN 1 ELSE 0 END) AS rateLimited,
              SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) AS fallbackUsed,
              MAX(created_at) AS lastAt
         FROM observability_events
        WHERE type = 'model_call'
          AND created_at >= @since
        GROUP BY slot, provider, model
        ORDER BY failed DESC, rateLimited DESC, total DESC`,
    )
    .all({ since });
  return { since, minutes, rows };
}

export function cleanupObservabilityEvents(retentionDays = DEFAULT_RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = getDb()
    .prepare('DELETE FROM observability_events WHERE created_at < @cutoff')
    .run({ cutoff });
  return Number(result.changes || 0);
}

function maybeCleanupObservabilityEvents() {
  const now = Date.now();
  if (now - lastLazyCleanupAt < 60 * 60 * 1000) return;
  lastLazyCleanupAt = now;
  try {
    cleanupObservabilityEvents();
  } catch {
    // Keep observability best-effort; business paths must not fail because cleanup failed.
  }
}

function maybeLogObservabilityWriteError(error: unknown) {
  const now = Date.now();
  if (now - lastWriteErrorLogAt < 60_000 && Math.random() >= 0.01) return;
  lastWriteErrorLogAt = now;
  console.error('[observability] write failed', error);
}

function nullableString(value: unknown, max: number) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function cappedJson(value: unknown) {
  const raw = JSON.stringify(value ?? {});
  return raw.length <= 8000 ? raw : JSON.stringify({ truncated: true, preview: raw.slice(0, 8000) });
}

function decodeRow(row: any): ObservabilityEventRow {
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metaJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {}
  return {
    id: row.id,
    type: row.type,
    slot: row.slot || null,
    provider: row.provider || null,
    model: row.model || null,
    status: row.status || 'info',
    statusCode: row.statusCode == null ? null : Number(row.statusCode),
    errorCode: row.errorCode || null,
    latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
    fallbackUsed: !!row.fallbackUsed,
    message: row.message || '',
    meta,
    createdAt: row.createdAt,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
