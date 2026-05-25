import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getExternalEnvLoadResult, readExternalEnvSnapshot } from '@/lib/env';
import { getModelRoutingStatus } from '@/lib/model-routing';
import { listObservabilityEvents, modelMetricsSnapshot } from '@/lib/observability-events';

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
  const externalEnv = readExternalEnvSnapshot();
  const runtimeEnv = getExternalEnvLoadResult();
  const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const runtimeLoadedAt = runtimeEnv.loadedAt || null;
  const runtimeLoadedMs = runtimeLoadedAt ? Date.parse(runtimeLoadedAt) : NaN;
  const fileNewerThanProcessEnv =
    externalEnv.fileMaxModifiedMs != null &&
    Number.isFinite(runtimeLoadedMs) &&
    externalEnv.fileMaxModifiedMs > runtimeLoadedMs + 1000;
  const recentFallbackEvents = listObservabilityEvents({
    type: 'model_call',
    since: metrics.since,
    limit: 100,
  })
    .filter((event) => event.slot === 'image' && event.fallbackUsed)
    .slice(0, 10)
    .map((event) => ({
      id: event.id,
      slot: event.slot,
      provider: event.provider,
      model: event.model,
      status: event.status,
      statusCode: event.statusCode,
      errorCode: event.errorCode,
      message: event.message,
      meta: {
        traceName: event.meta.traceName || null,
        kind: event.meta.kind || null,
        assetRef: event.meta.assetRef || null,
        projectId: event.meta.projectId || null,
        correlationId: event.meta.correlationId || null,
        attempt: event.meta.attempt ?? null,
      },
      createdAt: event.createdAt,
    }));
  const pools = (['brain', 'structured', 'styleBible', 'profileDerive', 'continuity', 'image', 'video'] as const).map((slot) => {
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
      fallbacks: Array.isArray(cfg.fallbackConfigs)
        ? cfg.fallbackConfigs.map((fallback: any) => ({
            mode: fallback.mode,
            source: fallback.source,
            model: fallback.model,
            baseUrl: fallback.baseUrl,
            provider: fallback.provider,
            endpoint: fallback.endpoint || fallback.imageGenerationEndpoint || null,
            fallbackOf: fallback.fallbackOf || null,
          }))
        : [],
      reasoningEffort: cfg.reasoningEffort || null,
      lastUsed: metric.lastAt,
      metrics: metric,
    };
  });

  return jsonOk({
    pools,
    env: status.env,
    envSync: {
      processStartedAt,
      runtimeLoadedAt,
      runtimeLoadedKeys: runtimeEnv.keys || [],
      runtimeLoadError: runtimeEnv.error || null,
      externalFiles: externalEnv.files.map((file) => ({
        path: file.path,
        exists: file.exists,
        mtime: file.mtime || null,
        size: file.size || null,
        keys: file.keys,
        error: file.error || null,
      })),
      externalLoaded: externalEnv.loaded,
      externalReadAt: externalEnv.readAt,
      fileMaxModifiedAt: externalEnv.fileMaxModifiedAt,
      fileNewerThanProcessEnv,
      modelRoutingReadsExternalEnvLive: true,
    },
    metricsWindow: metrics.minutes,
    metricsSince: metrics.since,
    recentFallbackEvents,
    updatedAt: new Date().toISOString(),
  });
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
