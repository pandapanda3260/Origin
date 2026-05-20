import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { dismissContentFlag, hideContentFlagWithDisposition } from '@/lib/content-disposition';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const url = new URL(req.url);
  const status = normalizeStatus(url.searchParams.get('status')) || 'pending';
  const q = String(url.searchParams.get('q') || '').trim();
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);

  return jsonOk({
    items: listFlags({ status, q, limit }),
    summary: flagSummary(),
    filters: { status, q, limit },
    generatedAt: new Date().toISOString(),
  });
}

export const POST = withAdminAudit(async function mutateContentFlag(_req: NextRequest, audit) {
  const body = audit.body || {};
  const id = String(body.id || body.flagId || '').trim();
  const action = String(body.action || '').trim();
  const reason = String(audit.reason || body.reason || '').trim();
  if (!id) return jsonError('flag id required', 400);
  if (!['hide', 'dismiss'].includes(action)) return jsonError('unsupported action', 400);

  const before = readFlag(id);
  if (!before) return jsonError('content flag not found', 404);
  if (!['pending', 'hidden', 'dismissed'].includes(before.status)) return jsonError('invalid flag status', 409);
  if (before.status !== 'pending') return jsonError('only pending flags can be reviewed', 409);

  const nextStatus = action === 'hide' ? 'hidden' : 'dismissed';
  const after = {
    ...before,
    status: nextStatus,
    reviewedBy: audit.admin.id,
    reviewedAt: new Date().toISOString(),
    reviewReason: reason,
    disposition: action === 'hide' && ['image', 'video'].includes(before.sourceType) ? { mode: 'quarantine_on_commit' } : { mode: 'metadata_only' },
  };
  audit.setAuditTarget({ type: 'content_flag', ids: [id] });
  audit.setAuditDiff({ before, after });
  if (audit.dryRun) {
    return jsonOk(dryRunPayload(`content.${action}`, { type: 'content_flag', ids: [id] }, { before, after }));
  }

  if (action === 'hide') {
    const disposition = hideContentFlagWithDisposition({
      flagId: id,
      adminId: audit.admin.id,
      adminUsername: audit.admin.username,
    });
    audit.setAuditDiff({ before, after: { ...after, disposition } });
    return jsonOk({ success: true, id, action, status: nextStatus, disposition });
  }

  const changed = dismissContentFlag(id, audit.admin.id);
  if (!changed) return jsonError('content flag review race', 409);
  return jsonOk({ success: true, id, action, status: nextStatus });
}, 'content.flag.review', {
  category: 'content',
  supportDryRun: true,
  idempotent: true,
});

function listFlags(args: { status: string; q: string; limit: number }) {
  return getDb().prepare<any, any>(
    `SELECT f.id,
            f.owner_id AS ownerId,
            u.username,
            f.project_id AS projectId,
            p.title AS projectTitle,
            f.source_type AS sourceType,
            f.source_id AS sourceId,
            f.raw_excerpt AS rawExcerpt,
            f.scan_reason AS scanReason,
            f.severity,
            f.status,
            f.created_at AS createdAt,
            f.reviewed_by AS reviewedBy,
            au.username AS reviewedByUsername,
            f.reviewed_at AS reviewedAt
       FROM content_flags f
       LEFT JOIN users u ON u.id = f.owner_id
       LEFT JOIN projects p ON p.id = f.project_id
       LEFT JOIN admin_users au ON au.id = f.reviewed_by
      WHERE (@status = '' OR f.status = @status)
        AND (
          @q = ''
          OR f.id = @q
          OR f.source_id = @q
          OR f.project_id = @q
          OR CAST(f.owner_id AS TEXT) = @q
          OR u.username LIKE @like
          OR f.scan_reason LIKE @like
          OR f.raw_excerpt LIKE @like
        )
      ORDER BY
        CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        f.created_at DESC
      LIMIT @limit`,
  ).all({ status: args.status, q: args.q, like: `%${args.q}%`, limit: args.limit });
}

function flagSummary() {
  return getDb().prepare<[], any>(
    `SELECT status, severity, COUNT(*) AS count
       FROM content_flags
      GROUP BY status, severity`,
  ).all().reduce((acc, row) => {
    const status = String(row.status || 'unknown');
    acc[status] = acc[status] || { total: 0, severity: {} };
    acc[status].total += Number(row.count || 0);
    acc[status].severity[String(row.severity || 'unknown')] = Number(row.count || 0);
    return acc;
  }, {} as Record<string, { total: number; severity: Record<string, number> }>);
}

function readFlag(id: string) {
  return getDb().prepare<{ id: string }, any>(
    `SELECT f.id,
            f.owner_id AS ownerId,
            u.username,
            f.project_id AS projectId,
            p.title AS projectTitle,
            f.source_type AS sourceType,
            f.source_id AS sourceId,
            f.raw_excerpt AS rawExcerpt,
            f.scan_reason AS scanReason,
            f.severity,
            f.status,
            f.created_at AS createdAt,
            f.reviewed_by AS reviewedBy,
            f.reviewed_at AS reviewedAt
       FROM content_flags f
       LEFT JOIN users u ON u.id = f.owner_id
       LEFT JOIN projects p ON p.id = f.project_id
      WHERE f.id = @id`,
  ).get({ id });
}

function normalizeStatus(value: unknown) {
  const status = String(value || '').trim();
  if (!status || ['pending', 'hidden', 'dismissed'].includes(status)) return status;
  return '';
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
