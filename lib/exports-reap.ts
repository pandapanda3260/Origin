/**
 * 启动时回收上次进程退出时仍处于 queued/running 的 exports：
 *   - 标记 status='failed'
 *   - 退还 5 积分（CREDIT_PRICES.export）
 *
 * 单进程单机场景下是"直接失败"，不尝试续跑（与 batches.reapOrphanBatches 一致）。
 */

import { getDb } from './db';
import { CREDIT_PRICES, refundCredits } from './credits';
import { markExportFailureInEditData } from './edit-auto-compose-state';
import { patchProjectForUser } from './projects-db';

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
    for (const r of orphans) {
      const info = db.prepare(
        "UPDATE exports SET status='failed', error_msg='orphaned by server restart', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','running')",
      ).run(r.id);
      if (info.changes > 0) {
        try {
          refundCredits({
            userId: r.owner_id,
            amount: CREDIT_PRICES.export,
            reason: 'orphan export reap',
            refId: r.id,
            refundRefId: `export:${r.id}`,
          });
        } catch (e) {
          console.error('[export] reap refund failed:', r.id, e);
        }
        if (r.project_id) {
          try {
            patchProjectForUser(String(r.project_id), Number(r.owner_id), (current) => ({
              editData: markExportFailureInEditData(current.editData || {}, {
                exportTaskId: String(r.id),
                errorCode: 'EXPORT_FAILED',
                errorMessage: 'orphaned by server restart',
              }),
            }));
          } catch (e) {
            console.error('[export] reap project cleanup failed:', r.id, e);
          }
        }
      }
    }
  } catch (e) {
    console.error('[export] reap orphan failed:', e);
  }
}
