/**
 * exports 任务的两类回收（doExport 跑在 web 进程 setImmediate 里，
 * 没有任何恢复循环能续跑它，死了只能判失败让用户重试）：
 *
 *   1. reapOrphanExports —— 启动时回收上次进程退出时仍 queued/running 的行。
 *   2. reapStaleExports  —— 周期回收"行还在 running 但 updated_at 长时间不动"的行：
 *      ffmpeg 挂死、或进程死过但本次启动没赶上 reap（历史上 dev 模式 reapOnStart=false
 *      导致孤儿永久 running、前端永远"导出中 50%"——2026-06-10 实锤 4674f962）。
 *
 * 单进程单机场景下是"直接失败"，不尝试续跑（与 batches.reapOrphanBatches 一致）。
 */

import { getDb } from './db';
import { markExportFailureInEditData } from './edit-auto-compose-state';
import { patchProjectForUser } from './projects-db';

// doExport 只在阶段节点 setProg 刷 updated_at（5/20/50/65/80/100），阶段间隔
// 正常是秒~分钟级；30 分钟纹丝不动只能是挂死/进程死过，判死安全。
const STALE_EXPORT_MAX_AGE_MS = 30 * 60 * 1000;
const STALE_REAPER_INTERVAL_MS = 5 * 60 * 1000;

function failExportRows(rows: any[], errorMessage: string) {
  const db = getDb();
  for (const r of rows) {
    const info = db.prepare(
      "UPDATE exports SET status='failed', error_msg=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','running')",
    ).run(errorMessage, r.id);
    if (info.changes > 0) {
      if (r.project_id) {
        try {
          patchProjectForUser(String(r.project_id), Number(r.owner_id), (current) => ({
            editData: markExportFailureInEditData(current.editData || {}, {
              exportTaskId: String(r.id),
              errorCode: 'EXPORT_FAILED',
              errorMessage,
            }),
          }));
        } catch (e) {
          console.error('[export] reap project cleanup failed:', r.id, e);
        }
      }
    }
  }
}

export function reapOrphanExports() {
  const db = getDb();
  try {
    const orphans = db
      .prepare<[], any>(
        "SELECT id, owner_id, project_id FROM exports WHERE status IN ('queued','running')",
      )
      .all();
    if (!orphans.length) return;
    console.warn(`[export] reap: 发现 ${orphans.length} 个孤儿导出，标记 failed 并退款`);
    failExportRows(orphans, 'orphaned by server restart');
  } catch (e) {
    console.error('[export] reap orphan failed:', e);
  }
}

export function reapStaleExports(maxAgeMs: number = STALE_EXPORT_MAX_AGE_MS) {
  const db = getDb();
  try {
    const cutoff = new Date(Date.now() - Math.max(60_000, maxAgeMs)).toISOString();
    const stale = db
      .prepare<{ cutoff: string }, any>(
        "SELECT id, owner_id, project_id, updated_at FROM exports WHERE status IN ('queued','running') AND updated_at < @cutoff",
      )
      .all({ cutoff });
    if (!stale.length) return;
    console.warn(`[export] reap: 发现 ${stale.length} 个停滞导出（updated_at < ${cutoff}），标记 failed`);
    failExportRows(stale, 'export stalled: no progress for 30+ minutes');
  } catch (e) {
    console.error('[export] reap stale failed:', e);
  }
}

const staleReaperKey = '__qd_exports_stale_reaper__';

export function startExportsStaleReaper() {
  if ((globalThis as any)[staleReaperKey]) return;
  (globalThis as any)[staleReaperKey] = true;
  const timer = setInterval(() => {
    try { reapStaleExports(); } catch (e) { console.error('[export] stale reaper tick:', e); }
  }, STALE_REAPER_INTERVAL_MS);
  (timer as any).unref?.();
}
