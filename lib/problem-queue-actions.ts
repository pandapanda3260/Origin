import { createHash } from 'node:crypto';

export type BulkRequeueFailureReason =
  | 'status_not_allowed'
  | 'task_not_found'
  | 'retry_count_exceeded'
  | 'concurrent_modification'
  | 'internal_error';

export function normalizeTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function bulkRequeueIdempotencyKey(taskIds: string[], force: boolean) {
  const normalized = normalizeTaskIds(taskIds).sort();
  const hash = createHash('sha256')
    .update(`${normalized.join(',')}:${force ? 'f' : 'n'}`)
    .digest('hex');
  return `bulk_requeue:${hash}`;
}
