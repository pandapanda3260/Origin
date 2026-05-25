import type Database from 'better-sqlite3';

export type VideoGenerationEstimate = {
  averageSec: number | null;
  sampleSize: number;
  limit: number;
  source: 'recent_completed_video_tasks';
};

function clampLimit(limit: number | null | undefined): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, n));
}

export function elapsedGenerationSeconds(createdAt: unknown, updatedAt: unknown): number | null {
  const startedMs = Date.parse(String(createdAt || ''));
  const endedMs = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null;
  if (endedMs <= startedMs) return null;
  return (endedMs - startedMs) / 1000;
}

export function estimateRecentVideoGenerationSeconds(
  db: Database.Database,
  ownerId: number,
  limitInput?: number | null,
): VideoGenerationEstimate {
  const limit = clampLimit(limitInput);
  const rows = db
    .prepare<{ ownerId: number; limit: number }, { created_at: string; updated_at: string }>(
      `SELECT created_at, updated_at
       FROM video_tasks
       WHERE owner_id = @ownerId
         AND status = 'completed'
         AND created_at IS NOT NULL
         AND updated_at IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT @limit`,
    )
    .all({ ownerId, limit });

  const samples = rows
    .map((row) => elapsedGenerationSeconds(row.created_at, row.updated_at))
    .filter((sec): sec is number => typeof sec === 'number' && Number.isFinite(sec) && sec > 0);

  const averageSec = samples.length
    ? Math.max(1, Math.round(samples.reduce((sum, sec) => sum + sec, 0) / samples.length))
    : null;

  return {
    averageSec,
    sampleSize: samples.length,
    limit,
    source: 'recent_completed_video_tasks',
  };
}
