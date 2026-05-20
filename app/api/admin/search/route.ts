import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchItem = {
  entityType: 'user' | 'order' | 'project' | 'batch' | 'video_task' | 'export';
  id: string;
  title: string;
  subtitle: string;
  fields: Record<string, unknown>;
};

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonOk({ q, items: [], groups: emptyGroups() });

  const items: SearchItem[] = [
    ...findUsers(q),
    ...findOrders(q),
    ...findProjects(q),
    ...findBatches(q),
    ...findVideoTasks(q),
    ...findExports(q),
  ];

  return jsonOk({
    q,
    items,
    groups: groupItems(items),
  });
}

function findUsers(q: string): SearchItem[] {
  return getDb()
    .prepare<{ q: string }, any>(
      `SELECT u.id, u.username, u.email, u.display_name, u.disabled_at, u.created_at,
              COALESCE(c.total_credits, 0) AS total_credits,
              (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS project_count,
              (SELECT COUNT(*) FROM billing_orders o WHERE o.user_id = u.id) AS order_count,
              (SELECT COUNT(*) FROM credit_ledger l WHERE l.user_id = u.id) AS ledger_count
         FROM users u
         LEFT JOIN user_credits c ON c.user_id = u.id
        WHERE u.username NOT GLOB '__shadow__*'
          AND (CAST(u.id AS TEXT) = @q OR u.username = @q OR COALESCE(u.email, '') = @q)
        LIMIT 10`,
    )
    .all({ q })
    .map((row: any) => ({
      entityType: 'user' as const,
      id: String(row.id),
      title: row.username,
      subtitle: row.email || row.display_name || `user#${row.id}`,
      fields: {
        displayName: row.display_name,
        email: row.email,
        disabledAt: row.disabled_at,
        totalCredits: Number(row.total_credits || 0),
        projectCount: Number(row.project_count || 0),
        orderCount: Number(row.order_count || 0),
        ledgerCount: Number(row.ledger_count || 0),
        createdAt: row.created_at,
      },
    }));
}

function findOrders(q: string): SearchItem[] {
  return getDb()
    .prepare<{ q: string }, any>(
      `SELECT o.*, u.username
         FROM billing_orders o
         JOIN users u ON u.id = o.user_id
        WHERE o.id = @q OR COALESCE(o.provider_ref, '') = @q
        LIMIT 10`,
    )
    .all({ q })
    .map((row: any) => ({
      entityType: 'order' as const,
      id: row.id,
      title: `${row.provider} ${row.kind}`,
      subtitle: `${row.status} · ${row.username}`,
      fields: {
        userId: row.user_id,
        username: row.username,
        provider: row.provider,
        providerRef: row.provider_ref,
        kind: row.kind,
        planCode: row.plan_code,
        amountCents: row.amount_cents,
        currency: row.currency,
        creditsAdded: row.credits_added,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }));
}

function findProjects(q: string): SearchItem[] {
  return getDb()
    .prepare<{ q: string }, any>(
      `SELECT p.id, p.owner_id, p.title, p.status, p.cover_url, p.created_at, p.updated_at, u.username
         FROM projects p
         JOIN users u ON u.id = p.owner_id
        WHERE p.id = @q
        LIMIT 10`,
    )
    .all({ q })
    .map((row: any) => ({
      entityType: 'project' as const,
      id: row.id,
      title: row.title || row.id,
      subtitle: `${row.status} · ${row.username}`,
      fields: {
        ownerId: row.owner_id,
        username: row.username,
        status: row.status,
        coverUrl: row.cover_url,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }));
}

function findBatches(q: string): SearchItem[] {
  return getDb()
    .prepare<{ q: string }, any>(
      `SELECT b.*, u.username, p.title AS project_title
         FROM batches b
         JOIN users u ON u.id = b.owner_id
         LEFT JOIN projects p ON p.id = b.project_id
        WHERE b.id = @q
        LIMIT 10`,
    )
    .all({ q })
    .map((row: any) => ({
      entityType: 'batch' as const,
      id: row.id,
      title: row.batch_type,
      subtitle: `${row.status} · ${row.username}`,
      fields: {
        ownerId: row.owner_id,
        username: row.username,
        projectId: row.project_id,
        projectTitle: row.project_title,
        status: row.status,
        total: row.total,
        succeeded: row.succeeded,
        failed: row.failed,
        errorMessage: row.error_message,
        runnerId: row.runner_id,
        runnerHeartbeatAt: row.runner_heartbeat_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }));
}

function findVideoTasks(q: string): SearchItem[] {
  return getDb()
    .prepare<{ q: string }, any>(
      `SELECT vt.*, u.username, p.title AS project_title
         FROM video_tasks vt
         JOIN users u ON u.id = vt.owner_id
         LEFT JOIN projects p ON p.id = vt.project_id
        WHERE vt.id = @q OR COALESCE(vt.provider_task, '') = @q
        LIMIT 10`,
    )
    .all({ q })
    .map((row: any) => ({
      entityType: 'video_task' as const,
      id: row.id,
      title: `video · ${row.provider}`,
      subtitle: `${row.status} · ${row.username}`,
      fields: {
        ownerId: row.owner_id,
        username: row.username,
        projectId: row.project_id,
        projectTitle: row.project_title,
        groupIdx: row.group_idx,
        provider: row.provider,
        providerTask: row.provider_task,
        status: row.status,
        progress: row.progress,
        filename: row.filename,
        durationSec: row.duration_sec,
        errorMessage: row.error_message || row.error_msg,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }));
}

function findExports(q: string): SearchItem[] {
  return getDb()
    .prepare<{ q: string }, any>(
      `SELECT e.*, u.username, p.title AS project_title
         FROM exports e
         JOIN users u ON u.id = e.owner_id
         LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.id = @q OR COALESCE(e.external_export_id, '') = @q
        LIMIT 10`,
    )
    .all({ q })
    .map((row: any) => ({
      entityType: 'export' as const,
      id: row.id,
      title: `export · ${row.provider || 'local'}`,
      subtitle: `${row.status} · ${row.username}`,
      fields: {
        ownerId: row.owner_id,
        username: row.username,
        projectId: row.project_id,
        projectTitle: row.project_title,
        status: row.status,
        progress: row.progress,
        provider: row.provider,
        externalExportId: row.external_export_id,
        filename: row.filename,
        localDownloadStatus: row.local_download_status,
        errorMessage: row.error_message || row.error_msg,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }));
}

function emptyGroups(): Record<SearchItem['entityType'], SearchItem[]> {
  return {
    user: [],
    order: [],
    project: [],
    batch: [],
    video_task: [],
    export: [],
  };
}

function groupItems(items: SearchItem[]) {
  const groups: Record<SearchItem['entityType'], SearchItem[]> = emptyGroups();
  for (const item of items) {
    groups[item.entityType].push(item);
  }
  return groups;
}
