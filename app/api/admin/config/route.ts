import { NextRequest } from 'next/server';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT,
  DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT,
  MAX_GLOBAL_CONCURRENCY_LIMIT,
  MIN_GLOBAL_CONCURRENCY_LIMIT,
  getGlobalImageConcurrencyLimit,
  getGlobalVideoConcurrencyLimit,
  isExportEnabled,
  isRegistrationEnabled,
  isVideoGenerationEnabled,
  readSystemConfig,
  writeSystemConfig,
} from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_BANNER = { enabled: false, message: '', startsAt: null as string | null, endsAt: null as string | null };

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }
  return jsonOk(readAdminConfig());
}

export const POST = withAdminAudit(async function updateConfig(_req: NextRequest, audit) {
  const body = audit.body || {};
  const next = normalizeConfig(body.config || body);
  const before = readAdminConfig();
  audit.setAuditTarget({ type: 'system_config', ids: Object.keys(next) });
  audit.setAuditDiff({ before, after: { ...before, ...next } });
  if (audit.dryRun) {
    return jsonOk(dryRunPayload('config.update', audit.target, audit.diff));
  }
  for (const [key, value] of Object.entries(next)) writeSystemConfig(key, value);
  return jsonOk(readAdminConfig());
}, 'config.update', {
  category: 'config',
  supportDryRun: true,
  idempotent: true,
});

function readAdminConfig() {
  return {
    maintenance_banner: { ...DEFAULT_BANNER, ...readSystemConfig('maintenance_banner', DEFAULT_BANNER) },
    registration_enabled: isRegistrationEnabled(),
    video_generation_enabled: isVideoGenerationEnabled(),
    export_enabled: isExportEnabled(),
    global_video_concurrency_limit: getGlobalVideoConcurrencyLimit(DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT),
    global_image_concurrency_limit: getGlobalImageConcurrencyLimit(DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT),
    notes: {
      concurrencyScope: 'P1 concurrency limits are process-global and shared by all users; they are not per-user quotas.',
      concurrencyCache: 'P1 assumes a single Next.js process; multi-process cache coherence is deferred to P2 pub/sub.',
    },
  };
}

function normalizeConfig(raw: any) {
  const out: Record<string, unknown> = {};
  if ('maintenance_banner' in raw) {
    const banner = raw.maintenance_banner || {};
    out.maintenance_banner = {
      enabled: !!banner.enabled,
      message: String(banner.message || '').slice(0, 500),
      startsAt: banner.startsAt || null,
      endsAt: banner.endsAt || null,
    };
  }
  for (const key of ['registration_enabled', 'video_generation_enabled', 'export_enabled']) {
    if (key in raw) out[key] = !!raw[key];
  }
  if ('global_video_concurrency_limit' in raw) {
    out.global_video_concurrency_limit = clampInt(
      raw.global_video_concurrency_limit,
      DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT,
      MIN_GLOBAL_CONCURRENCY_LIMIT,
      MAX_GLOBAL_CONCURRENCY_LIMIT,
    );
  }
  if ('global_image_concurrency_limit' in raw) {
    out.global_image_concurrency_limit = clampInt(
      raw.global_image_concurrency_limit,
      DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT,
      MIN_GLOBAL_CONCURRENCY_LIMIT,
      MAX_GLOBAL_CONCURRENCY_LIMIT,
    );
  }
  return out;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
