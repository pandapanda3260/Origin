import { NextRequest } from 'next/server';
import {
  createAdminUserWithShadow,
  disableAdminUser,
  requireAdmin,
  resetAdminPassword,
  revokeAdminTokens,
  toPublicAdmin,
} from '@/lib/admin-auth';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb, type AdminUserRow } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }
  const rows = getDb()
    .prepare<[], AdminUserRow>('SELECT * FROM admin_users ORDER BY created_at DESC, id DESC')
    .all();
  const recentActions = getDb()
    .prepare<[], any>(
      `SELECT aa.id,
              aa.category,
              aa.action,
              aa.target_type AS targetType,
              aa.target_id AS targetId,
              aa.reason,
              aa.dry_run AS dryRun,
              aa.status,
              aa.response_status AS responseStatus,
              aa.created_at AS createdAt,
              au.username AS adminUsername
         FROM admin_actions aa
         LEFT JOIN admin_users au ON au.id = aa.admin_user_id
        WHERE aa.category IN ('admin_account', 'admin_self')
        ORDER BY aa.created_at DESC
        LIMIT 80`,
    )
    .all();
  return jsonOk({
    items: rows.map(toPublicAdmin),
    recentActions: recentActions.map((row: any) => ({
      ...row,
      dryRun: !!row.dryRun,
    })),
  });
}

export const POST = withAdminAudit(async function createStaffAdmin(_req: NextRequest, ctx) {
  const body = ctx.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username) return jsonError('username required', 400);
  if (!password) return jsonError('password required', 400);

  const existing = getDb()
    .prepare<{ username: string }, { id: number; username: string }>(
      'SELECT id, username FROM admin_users WHERE username = @username LIMIT 1',
    )
    .get({ username });
  if (existing) return jsonError('admin username already exists', 409);

  const before = null;
  const planned = { username, disabledAt: null, previewUserId: 'will_create_shadow' };
  ctx.setAuditTarget({ type: 'admin_user', ids: [username] });
  ctx.setAuditDiff({ items: [{ id: username, before, after: planned }] });
  if (ctx.dryRun) {
    return jsonOk(dryRunPayload('staff.admin.create', ctx.target, ctx.diff));
  }

  try {
    const admin = await createAdminUserWithShadow({ username, password });
    ctx.setAuditTarget({ type: 'admin_user', ids: [String(admin.id)] });
    ctx.setAuditDiff({ items: [{ id: String(admin.id), before, after: toPublicAdmin(admin) }] });
    return jsonOk({ ok: true, admin: toPublicAdmin(admin) });
  } catch (error: any) {
    return jsonError(error?.message || 'create admin failed', /UNIQUE constraint/i.test(String(error?.message || '')) ? 409 : 400);
  }
}, 'staff.admin.create', {
  category: 'admin_account',
  requireReason: true,
  supportDryRun: true,
  idempotent: true,
});

export const PATCH = withAdminAudit(async function mutateStaffAdmin(_req: NextRequest, ctx) {
  const body = ctx.body || {};
  const action = String(body.action || '').trim();
  const adminId = Number(body.adminId);
  if (!Number.isInteger(adminId) || adminId <= 0) return jsonError('invalid adminId', 400);
  if (!['disable', 'revoke_tokens', 'reset_password'].includes(action)) return jsonError('invalid action', 400);

  const before = readAdminSnapshot(adminId);
  if (!before) return jsonError('admin not found', 404);

  if (action === 'disable') {
    if (adminId === ctx.admin.id) return jsonError('不能禁用当前登录的 admin，请使用另一个 admin 账号执行', 400);
    if (activeAdminCount() <= 1) return jsonError('不能禁用最后一个可用 admin', 400);
  }
  if (action === 'reset_password' && adminId === ctx.admin.id) {
    return jsonError('重置自己的密码请使用自我改密入口', 400);
  }

  const now = new Date().toISOString();
  const after = planAdminAfter(before, action, now);
  ctx.setAuditTarget({ type: 'admin_user', ids: [String(adminId)] });
  ctx.setAuditDiff({ items: [{ id: String(adminId), before, after }] });

  if (ctx.dryRun) {
    return jsonOk(dryRunPayload(`staff.admin.${action}`, ctx.target, ctx.diff));
  }

  try {
    let ok = false;
    if (action === 'disable') ok = disableAdminUser(adminId);
    if (action === 'revoke_tokens') ok = revokeAdminTokens(adminId);
    if (action === 'reset_password') {
      const newPassword = String(body.newPassword || '');
      if (!newPassword) return jsonError('newPassword required', 400);
      ok = await resetAdminPassword(adminId, newPassword);
    }
    if (!ok) return jsonError('admin update failed', 400);
    const updated = readAdminSnapshot(adminId);
    ctx.setAuditDiff({ items: [{ id: String(adminId), before, after: updated || after }] });
    return jsonOk({ ok: true, action, admin: updated || after });
  } catch (error: any) {
    return jsonError(error?.message || 'admin update failed', 400);
  }
}, 'staff.admin.update', {
  category: 'admin_account',
  requireReason: true,
  supportDryRun: true,
  idempotent: true,
});

function readAdminSnapshot(adminId: number) {
  const row = getDb()
    .prepare<{ id: number }, AdminUserRow>('SELECT * FROM admin_users WHERE id = @id LIMIT 1')
    .get({ id: adminId });
  return row ? toPublicAdmin(row) : null;
}

function activeAdminCount(): number {
  return getDb()
    .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM admin_users WHERE disabled_at IS NULL')
    .get()?.c || 0;
}

function planAdminAfter(before: ReturnType<typeof readAdminSnapshot>, action: string, now: string) {
  if (!before) return null;
  if (action === 'disable') return { ...before, disabledAt: before.disabledAt || now, tokenRevokedAt: now };
  if (action === 'revoke_tokens') return { ...before, tokenRevokedAt: now };
  if (action === 'reset_password') return { ...before, tokenRevokedAt: now, passwordReset: true };
  return before;
}
