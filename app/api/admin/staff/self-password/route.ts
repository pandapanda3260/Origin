import { NextRequest } from 'next/server';
import { changeOwnAdminPassword, toPublicAdmin } from '@/lib/admin-auth';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAdminAudit(async function changeSelfPassword(_req: NextRequest, ctx) {
  const body = ctx.body || {};
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (!oldPassword) return jsonError('oldPassword required', 400);
  if (!newPassword) return jsonError('newPassword required', 400);

  const before = toPublicAdmin(ctx.admin);
  const after = { ...before, tokenRevokedAt: new Date().toISOString(), passwordChanged: true };
  ctx.setAuditTarget({ type: 'admin_user', ids: [String(ctx.admin.id)] });
  ctx.setAuditDiff({ items: [{ id: String(ctx.admin.id), before, after }] });

  if (ctx.dryRun) {
    return jsonOk(dryRunPayload('admin.self.change_password', ctx.target, ctx.diff));
  }

  try {
    const ok = await changeOwnAdminPassword(ctx.admin.id, oldPassword, newPassword);
    if (!ok) return jsonError('旧密码不正确或账号不可用', 400);
    return jsonOk({ ok: true });
  } catch (error: any) {
    return jsonError(error?.message || 'change password failed', 400);
  }
}, 'admin.self.change_password', {
  category: 'admin_self',
  safe: true,
  supportDryRun: true,
  idempotent: true,
});
