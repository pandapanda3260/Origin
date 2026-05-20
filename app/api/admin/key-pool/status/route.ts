import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getModelRoutingStatus } from '@/lib/model-routing';
import { modelMetricsSnapshot } from '@/lib/observability-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const status = getModelRoutingStatus(null);
  const metrics = modelMetricsSnapshot(10);
  const pools = (['brain', 'structured', 'styleBible', 'profileDerive', 'image', 'video'] as const).map((slot) => {
    const cfg = status[slot];
    const metric = aggregateSlotMetrics(metrics.rows.filter((row: any) => String(row.slot || '') === slot));
    return {
      name: slot,
      total: 1,
      healthy: cfg.mode === 'real' ? 1 : 0,
      exhausted: metric.rateLimited,
      mode: cfg.mode,
      source: cfg.source,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      provider: cfg.provider,
      endpoint: cfg.endpoint || cfg.imageGenerationEndpoint || null,
      reasoningEffort: cfg.reasoningEffort || null,
      lastUsed: metric.lastAt,
      metrics: metric,
    };
  });

  return jsonOk({ pools, env: status.env, metricsWindow: metrics.minutes, metricsSince: metrics.since, updatedAt: new Date().toISOString() });
}

function aggregateSlotMetrics(rows: any[]) {
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const success = rows.reduce((sum, row) => sum + Number(row.success || 0), 0);
  const failed = rows.reduce((sum, row) => sum + Number(row.failed || 0), 0);
  const rateLimited = rows.reduce((sum, row) => sum + Number(row.rateLimited || 0), 0);
  const fallbackUsed = rows.reduce((sum, row) => sum + Number(row.fallbackUsed || 0), 0);
  const lastAt = rows.map((row) => String(row.lastAt || '')).filter(Boolean).sort().pop() || null;
  return {
    total,
    success,
    failed,
    rateLimited,
    fallbackUsed,
    failureRate: total ? failed / total : 0,
    lastAt,
    status: total && (failed / total >= 0.3 || rateLimited > 0) ? 'red' : 'ok',
  };
}
