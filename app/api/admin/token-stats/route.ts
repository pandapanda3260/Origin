import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { withAdminAudit } from '@/lib/admin-audit';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/api-helpers';
import {
  buildTokenUsageCsv,
  listTokenUsageEvents,
  summarizeTokenUsage,
  summarizeTokenUsageByCategory,
  summarizeTokenUsageByUser,
  type TokenUsageFilters,
} from '@/lib/token-usage';

const EXPORT_LIMIT = 20_000;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const url = new URL(req.url);
  const view = String(url.searchParams.get('view') || 'summary');
  const filters = filtersFromSearchParams(url.searchParams);
  const generatedAt = new Date().toISOString();
  const meta = {
    generatedAt,
    filters,
    notes: [
      '统计起始日期：Token 账本上线后。',
      'usage_source=missing 的调用保留明细，但不计入总 Token。',
      'fallback / 重试按每次 attempt 记录。',
      'Token 统计不是现金成本统计。',
    ],
  };

  if (view === 'summary') {
    return jsonOk({ ok: true, ...meta, summary: summarizeTokenUsage(filters) }, { headers: noStoreHeaders });
  }
  if (view === 'users') {
    return jsonOk({ ok: true, ...meta, users: summarizeTokenUsageByUser(filters, limitFrom(url, 100, 500)) }, { headers: noStoreHeaders });
  }
  if (view === 'categories') {
    return jsonOk({ ok: true, ...meta, categories: summarizeTokenUsageByCategory(filters, limitFrom(url, 100, 500)) }, { headers: noStoreHeaders });
  }
  if (view === 'calls') {
    const details = listTokenUsageEvents({
      ...filters,
      limit: limitFrom(url, 100, 500),
      offset: offsetFrom(url),
    });
    return jsonOk({ ok: true, ...meta, ...details }, { headers: noStoreHeaders });
  }
  return jsonError('unsupported view', 400);
}

export const POST = withAdminAudit(async function exportTokenStats(_req: NextRequest, audit) {
  const body = audit.body || {};
  if (String(body.action || 'export') !== 'export') return jsonError('unsupported action', 400);
  const filters = filtersFromPlainObject(body);
  const details = listTokenUsageEvents({
    ...filters,
    limit: clampInt(body.limit, EXPORT_LIMIT, 1, EXPORT_LIMIT),
    offset: 0,
  });
  audit.setAuditTarget({ type: 'token_usage_export', ids: [filters.since || 'all'] });
  audit.setAuditDiff({
    before: { filters, limit: clampInt(body.limit, EXPORT_LIMIT, 1, EXPORT_LIMIT) },
    after: { exportedRows: details.rows.length, total: details.total },
  });

  const csv = buildTokenUsageCsv(details.rows);
  const filename = `token-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      ...noStoreHeaders,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}, 'token_stats.export', {
  category: 'observability',
  requireReason: false,
});

function filtersFromSearchParams(params: URLSearchParams): TokenUsageFilters {
  return normalizeFilters({
    range: params.get('range'),
    from: params.get('from'),
    to: params.get('to'),
    ownerId: params.get('ownerId'),
    moduleKey: params.get('moduleKey'),
    featureKey: params.get('featureKey'),
    provider: params.get('provider'),
    model: params.get('model'),
    status: params.get('status'),
    q: params.get('q'),
  });
}

function filtersFromPlainObject(body: any): TokenUsageFilters {
  return normalizeFilters({
    range: body.range,
    from: body.from,
    to: body.to,
    ownerId: body.ownerId,
    moduleKey: body.moduleKey,
    featureKey: body.featureKey,
    provider: body.provider,
    model: body.model,
    status: body.status,
    q: body.q,
  });
}

function normalizeFilters(raw: Record<string, unknown>): TokenUsageFilters {
  const range = String(raw.range || '7d');
  const now = Date.now();
  let since: string | null = null;
  let until: string | null = null;
  if (range === '1d') since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  else if (range === '30d') since = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  else if (range === 'custom') {
    since = dateStart(raw.from);
    until = dateEnd(raw.to);
  } else {
    since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return {
    since,
    until,
    ownerId: intOrNull(raw.ownerId),
    moduleKey: text(raw.moduleKey, 120),
    featureKey: text(raw.featureKey, 120),
    provider: text(raw.provider, 120),
    model: text(raw.model, 160),
    status: text(raw.status, 80),
    query: text(raw.q, 160),
  };
}

function dateStart(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = new Date(`${raw.slice(0, 10)}T00:00:00.000`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function dateEnd(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = new Date(`${raw.slice(0, 10)}T23:59:59.999`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function limitFrom(url: URL, fallback: number, max: number) {
  return clampInt(url.searchParams.get('limit'), fallback, 1, max);
}

function offsetFrom(url: URL) {
  return clampInt(url.searchParams.get('offset'), 0, 0, 100_000);
}

function text(value: unknown, max: number) {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, max) : null;
}

function intOrNull(value: unknown) {
  if (value == null || value === '') return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
