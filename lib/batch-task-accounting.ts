import { CREDIT_PRICES, type CreditKind } from './credits';
import { getDb } from './db';

export function costForBatchType(batchType: string): number {
  if (
    batchType === 'asset_images' ||
    batchType === 'storyboard_images' ||
    batchType === 'tail_frame_images'
  ) {
    return CREDIT_PRICES.image;
  }
  if (batchType === 'video_segments' || batchType === 'videos') return CREDIT_PRICES.video;
  if (batchType === 'storyboard_prompts' || batchType === 'video_prompts') return CREDIT_PRICES.text;
  return 0;
}

export function creditKindForBatchType(batchType: string): CreditKind {
  if (batchType === 'video_segments' || batchType === 'videos') return 'video';
  if (batchType === 'storyboard_prompts' || batchType === 'video_prompts') return 'text';
  return 'image';
}

export function taskChargeRef(taskId: string) {
  return `charge:${taskId}`;
}

export function taskRefundRef(taskId: string) {
  return `refund:${taskId}`;
}

export function finalizeBatchFromTasks(batchId: string) {
  const db = getDb();
  const current = db
    .prepare<{ id: string }, { status: string }>('SELECT status FROM batches WHERE id = @id')
    .get({ id: batchId });
  const counts = db
    .prepare<{ bid: string }, any>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) AS needs_review,
         SUM(CASE WHEN status IN ('queued','running','retry_pending','upstream_pending') THEN 1 ELSE 0 END) AS active
       FROM batch_tasks
       WHERE batch_id = @bid`,
    )
    .get({ bid: batchId }) || {};
  const total = Number(counts.total || 0);
  const completed = Number(counts.completed || 0);
  const failed = Number(counts.failed || 0);
  const cancelled = Number(counts.cancelled || 0);
  const needsReview = Number(counts.needs_review || 0);
  const active = Number(counts.active || 0);
  const status =
    total === 0
      ? (current?.status || 'queued')
      : needsReview > 0 || active > 0
        ? 'running'
        : completed === total
          ? 'completed'
          : cancelled === total
            ? 'cancelled'
            : failed === total
              ? 'failed'
              : 'partial';
  db.prepare(
    `UPDATE batches
       SET status=?,
           succeeded=?,
           failed=?,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=?`,
  ).run(status, completed, failed, batchId);
  return { status, total, completed, failed, cancelled, needsReview, active };
}
