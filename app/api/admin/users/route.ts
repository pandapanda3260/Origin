import { NextRequest } from 'next/server';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { clearUserAuthCache } from '@/lib/user-auth-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AdminUserListRow = {
  id: number;
  username: string;
  phone: string | null;
  email: string | null;
  display_name: string;
  email_verified: number;
  disabled_at: string | null;
  token_revoked_at: string | null;
  created_at: string;
  updated_at: string;
  total_credits: number | null;
  project_count: number;
  ledger_count: number;
  last_ledger_at: string | null;
};

type UserSnapshot = {
  id: number;
  username: string;
  phone: string | null;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  disabledAt: string | null;
  tokenRevokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  totalCredits?: number;
  projectCount?: number;
  ledgerCount?: number;
  lastLedgerAt?: string | null;
};

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
  const params = {
    q,
    like: `%${escapeLike(q)}%`,
    limit,
  };
  const searchClause = q
    ? `AND (
	         CAST(u.id AS TEXT) = @q
	         OR u.username LIKE @like ESCAPE '\\'
	         OR COALESCE(u.phone, '') LIKE @like ESCAPE '\\'
	         OR COALESCE(u.email, '') LIKE @like ESCAPE '\\'
	         OR u.display_name LIKE @like ESCAPE '\\'
       )`
    : '';
  const rows = getDb()
    .prepare<typeof params, AdminUserListRow>(
      `SELECT
	         u.id,
	         u.username,
	         u.phone,
	         u.email,
         u.display_name,
         u.email_verified,
         u.disabled_at,
         u.token_revoked_at,
         u.created_at,
         u.updated_at,
         COALESCE(c.total_credits, 0) AS total_credits,
         (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS project_count,
         (SELECT COUNT(*) FROM credit_ledger l WHERE l.user_id = u.id) AS ledger_count,
         (SELECT MAX(l.created_at) FROM credit_ledger l WHERE l.user_id = u.id) AS last_ledger_at
       FROM users u
       LEFT JOIN user_credits c ON c.user_id = u.id
       WHERE u.username NOT GLOB '__shadow__*'
       ${searchClause}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT @limit`,
    )
    .all(params);

  return jsonOk({
    items: rows.map(toSnapshot),
    q,
    limit,
  });
}

export const POST = withAdminAudit(async function mutateUserAccount(_req: NextRequest, ctx) {
  const body = ctx.body || {};
  const action = String(body.action || '').trim();
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) return jsonError('invalid userId', 400);
  if (!['disable', 'restore', 'force_logout'].includes(action)) return jsonError('invalid action', 400);

  const before = readUserSnapshot(userId);
  if (!before) return jsonError('用户不存在', 404);
  if (before.username.startsWith('__shadow__')) {
    return jsonError('shadow user 不能在用户管理中操作', 400);
  }

  const now = new Date().toISOString();
  const after = planAfter(before, action, now);
  ctx.setAuditTarget({ type: 'user', ids: [String(userId)] });
  ctx.setAuditDiff({ items: [{ id: String(userId), before, after }] });

  if (ctx.dryRun) {
    return jsonOk(dryRunPayload(`user.account.${action}`, ctx.target, ctx.diff));
  }

  applyUserAction(userId, action, now);
  clearUserAuthCache(userId);
  return jsonOk({
    ok: true,
    action,
    user: readUserSnapshot(userId) || after,
  });
}, 'user.account.update', {
  category: 'user_account',
  requireReason: true,
  supportDryRun: true,
  idempotent: true,
});

function readUserSnapshot(userId: number): UserSnapshot | null {
  const row = getDb()
    .prepare<{ id: number }, AdminUserListRow>(
      `SELECT
	         u.id,
	         u.username,
	         u.phone,
	         u.email,
         u.display_name,
         u.email_verified,
         u.disabled_at,
         u.token_revoked_at,
         u.created_at,
         u.updated_at,
         COALESCE(c.total_credits, 0) AS total_credits,
         (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS project_count,
         (SELECT COUNT(*) FROM credit_ledger l WHERE l.user_id = u.id) AS ledger_count,
         (SELECT MAX(l.created_at) FROM credit_ledger l WHERE l.user_id = u.id) AS last_ledger_at
       FROM users u
       LEFT JOIN user_credits c ON c.user_id = u.id
       WHERE u.id = @id
       LIMIT 1`,
    )
    .get({ id: userId });
  return row ? toSnapshot(row) : null;
}

function applyUserAction(userId: number, action: string, now: string) {
  const db = getDb();
  if (action === 'disable') {
    db.prepare<{ id: number; now: string }>(
      `UPDATE users
          SET disabled_at = COALESCE(disabled_at, @now),
              token_revoked_at = @now,
              updated_at = @now
        WHERE id = @id`,
    ).run({ id: userId, now });
    return;
  }
  if (action === 'restore') {
    db.prepare<{ id: number; now: string }>(
      `UPDATE users
          SET disabled_at = NULL,
              updated_at = @now
        WHERE id = @id`,
    ).run({ id: userId, now });
    return;
  }
  if (action === 'force_logout') {
    db.prepare<{ id: number; now: string }>(
      `UPDATE users
          SET token_revoked_at = @now,
              updated_at = @now
        WHERE id = @id`,
    ).run({ id: userId, now });
  }
}

function planAfter(before: UserSnapshot, action: string, now: string): UserSnapshot {
  if (action === 'disable') {
    return { ...before, disabledAt: before.disabledAt || now, tokenRevokedAt: now, updatedAt: now };
  }
  if (action === 'restore') {
    return { ...before, disabledAt: null, updatedAt: now };
  }
  if (action === 'force_logout') {
    return { ...before, tokenRevokedAt: now, updatedAt: now };
  }
  return before;
}

function toSnapshot(row: AdminUserListRow): UserSnapshot {
  return {
	    id: row.id,
	    username: row.username,
	    phone: row.phone,
	    email: row.email,
    displayName: row.display_name,
    emailVerified: !!row.email_verified,
    disabledAt: row.disabled_at,
    tokenRevokedAt: row.token_revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalCredits: Number(row.total_credits || 0),
    projectCount: Number(row.project_count || 0),
    ledgerCount: Number(row.ledger_count || 0),
    lastLedgerAt: row.last_ledger_at,
  };
}

function escapeLike(input: string) {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}
