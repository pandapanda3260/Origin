import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { readSystemConfig, writeSystemConfig } from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT = { enabled: false, message: '', startsAt: null as string | null, endsAt: null as string | null };

export async function GET() {
  return jsonOk(readBanner());
}

export const PUT = withAdminAudit(async function updateMaintenanceBanner(_req: NextRequest, ctx) {
  const before = readBanner();
  const body = ctx.body || {};
  const v = {
    enabled: !!body.enabled,
    message: String(body.message || '').slice(0, 500),
    startsAt: body.startsAt || null,
    endsAt: body.endsAt || null,
  };
  ctx.setAuditTarget({ type: 'system_config', ids: ['maintenance_banner'] });
  ctx.setAuditDiff({ items: [{ id: 'maintenance_banner', before, after: v }] });
  if (ctx.dryRun) return jsonOk(dryRunPayload('config.maintenance_banner.update', ctx.target, ctx.diff));
  saveBanner(v);
  return jsonOk(v);
}, 'config.maintenance_banner.update', {
  category: 'config',
  requireReason: true,
  supportDryRun: true,
  idempotent: true,
});

function readBanner() {
  return { ...DEFAULT, ...readSystemConfig('maintenance_banner', DEFAULT) };
}
function saveBanner(v: any) {
  writeSystemConfig('maintenance_banner', v);
}
