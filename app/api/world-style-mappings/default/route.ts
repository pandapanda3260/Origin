import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { setDefaultWorldStyleMapping } from '@/lib/style-templates-db';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = withAdminAudit(async function updateDefaultWorldStyleMapping(_req: NextRequest, ctx) {
  const body = ctx.body || {};
  const worldTemplateOwnerId = Number(body.worldTemplateOwnerId || body.worldOwnerId || 0);
  if (!worldTemplateOwnerId) return jsonError('需提供 worldTemplateOwnerId', 400);
  const target = {
    worldTemplateOwnerId,
    worldTemplateId: body.worldTemplateId || body.worldId || '',
    styleTemplateId: body.styleTemplateId || body.styleId || '',
  };
  ctx.setAuditTarget({ type: 'world_style_default_mapping', ids: [String(worldTemplateOwnerId), target.worldTemplateId].filter(Boolean) });
  ctx.setAuditDiff({ items: [{ id: `${worldTemplateOwnerId}:${target.worldTemplateId}`, before: null, after: target }] });
  if (ctx.dryRun) return jsonOk(dryRunPayload('config.world_style_default_mapping.update', ctx.target, ctx.diff));
  const result = setDefaultWorldStyleMapping({
    worldTemplateOwnerId,
    worldTemplateId: target.worldTemplateId,
    styleTemplateId: target.styleTemplateId,
  });
  if (result.error === 'invalid') return jsonError('参数不完整', 400);
  if (result.error === 'world_not_found') return jsonError('世界观模板不存在', 404);
  if (result.error === 'style_not_found') return jsonError('风格模板不存在', 404);
  if (result.error === 'style_not_system') return jsonError('全局默认只能指向系统风格模板', 400);
  return jsonOk({ ok: true });
}, 'config.world_style_default_mapping.update', {
  category: 'config',
  requireReason: true,
  supportDryRun: true,
  idempotent: true,
});
