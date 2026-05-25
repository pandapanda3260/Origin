import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { withAdminAudit } from '@/lib/admin-audit';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/api-helpers';
import { timeUsageCsvStream } from '@/lib/time-usage/csv';
import { listTimeUsageFeatures } from '@/lib/time-usage/classification';
import {
  countTimeUsageRows,
  listTimeUsageEvents,
  listTimeUsageExportRows,
  summarizeTimeUsage,
  summarizeTimeUsageByCategory,
  summarizeTimeUsageByUser,
} from '@/lib/time-usage/queries';
import { resolveTimeUsageRange } from '@/lib/time-usage/range';
import type { TimeUsageFilters } from '@/lib/time-usage/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXPORT_LIMIT = 20_000;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const url = new URL(req.url);
  const view = String(url.searchParams.get('view') || 'summary');
  const { filters, range } = filtersFromSearchParams(url.searchParams);
  const opts = { bypassCache: url.searchParams.get('nocache') === '1' };
  const meta = responseMeta(filters, range, view === 'summary');

  if (view === 'summary') {
    return jsonOk({ ok: true, ...meta, summary: summarizeTimeUsage(filters, opts) }, { headers: noStoreHeaders });
  }
  if (view === 'users') {
    return jsonOk({ ok: true, ...meta, users: summarizeTimeUsageByUser(filters, limitFrom(url, 100, 500), opts) }, { headers: noStoreHeaders });
  }
  if (view === 'categories') {
    return jsonOk({ ok: true, ...meta, categories: summarizeTimeUsageByCategory(filters, limitFrom(url, 100, 500), opts) }, { headers: noStoreHeaders });
  }
  if (view === 'details') {
    const details = listTimeUsageEvents({
      ...filters,
      limit: limitFrom(url, 100, 500),
      offset: offsetFrom(url),
    }, opts);
    return jsonOk({ ok: true, ...meta, ...details }, { headers: noStoreHeaders });
  }
  return jsonError('unsupported view', 400);
}

export const POST = withAdminAudit(async function exportTimeStats(_req: NextRequest, audit) {
  const body = audit.body || {};
  if (String(body.action || 'export') !== 'export') return jsonError('unsupported action', 400);
  const { filters, range } = filtersFromPlainObject(body);
  const total = countTimeUsageRows(filters);
  audit.setAuditTarget({ type: 'time_usage_export', ids: [filters.since] });
  audit.setAuditDiff({
    before: { filters, limit: EXPORT_LIMIT },
    after: { exportedRows: total > EXPORT_LIMIT ? 0 : total, total },
  });

  if (total > EXPORT_LIMIT) {
    return NextResponse.json(
      {
        ok: false,
        code: 'EXPORT_TOO_LARGE',
        detail: `匹配 ${total} 行，超过 ${EXPORT_LIMIT} 行导出上限，请收窄筛选范围。`,
        total,
        limit: EXPORT_LIMIT,
      },
      { status: 413, headers: noStoreHeaders },
    );
  }

  const details = listTimeUsageExportRows(filters, EXPORT_LIMIT, { bypassCache: body.nocache === '1' });
  const generatedAt = new Date().toISOString();
  const stream = timeUsageCsvStream(details.rows, { generatedAt, timezone: `${range.timezone} ${range.timezoneOffset}` });
  const filename = `time-usage-${generatedAt.slice(0, 10)}.csv`;
  return new NextResponse(stream as any, {
    status: 200,
    headers: {
      ...noStoreHeaders,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}, 'time_stats.export', {
  category: 'observability',
  requireReason: false,
});

function responseMeta(filters: TimeUsageFilters, range: ReturnType<typeof resolveTimeUsageRange>, includeFeatures = false) {
  return {
    generatedAt: new Date().toISOString(),
    filters,
    range,
    ...(includeFeatures ? { features: listTimeUsageFeatures() } : {}),
    notes: [
      '时间统计使用 Asia/Shanghai (+08:00) 自然日边界。',
      'V1 只统计任务表可派生的生成等待时间，不统计剧本直连生成、单次视频提示词微调、资产抽取和 VevDemo 回调端到端等待。',
      '视频段等待时间来自 batch_tasks（批量入口）和 generation_batches（单次入口），V1 不直接读取 video_tasks。',
      '失败、取消、部分成功与成功任务分开统计，不混入同一个平均值。',
    ],
  };
}

function filtersFromSearchParams(params: URLSearchParams) {
  return normalizeFilters({
    range: params.get('range'),
    from: params.get('from'),
    to: params.get('to'),
    ownerId: params.get('ownerId'),
    moduleKey: params.get('moduleKey'),
    featureKey: params.get('featureKey'),
    status: params.get('status'),
    q: params.get('q'),
  });
}

function filtersFromPlainObject(body: any) {
  return normalizeFilters({
    range: body.range,
    from: body.from,
    to: body.to,
    ownerId: body.ownerId,
    moduleKey: body.moduleKey,
    featureKey: body.featureKey,
    status: body.status,
    q: body.q,
  });
}

function normalizeFilters(raw: Record<string, unknown>) {
  const range = resolveTimeUsageRange({ range: raw.range, from: raw.from, to: raw.to });
  return {
    range,
    filters: {
      since: range.since,
      until: range.until,
      ownerId: intOrNull(raw.ownerId),
      moduleKey: text(raw.moduleKey, 120),
      featureKey: text(raw.featureKey, 120),
      status: text(raw.status, 80),
      query: text(raw.q, 160),
    } satisfies TimeUsageFilters,
  };
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
