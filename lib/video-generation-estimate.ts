import type Database from 'better-sqlite3';

export type VideoGenerationEstimate = {
  averageSec: number | null;
  sampleSize: number;
  limit: number;
  source: 'recent_completed_batch_tasks' | 'recent_completed_video_tasks';
};

const MAX_REASONABLE_VIDEO_GENERATION_SEC = 45 * 60;
const MAX_QUERY_ROWS = 250;

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

function isReasonableGenerationSample(sec: number): boolean {
  return Number.isFinite(sec) && sec > 0 && sec <= MAX_REASONABLE_VIDEO_GENERATION_SEC;
}

function averageSamples(rows: Array<{ created_at: string; updated_at: string }>, limit: number): number | null {
  const samples = rows
    .map((row) => elapsedGenerationSeconds(row.created_at, row.updated_at))
    .filter((sec): sec is number => typeof sec === 'number' && isReasonableGenerationSample(sec))
    .slice(0, limit);

  return samples.length
    ? Math.max(1, Math.round(samples.reduce((sum, sec) => sum + sec, 0) / samples.length))
    : null;
}

export function estimateRecentVideoGenerationSeconds(
  db: Database.Database,
  ownerId: number,
  limitInput?: number | null,
): VideoGenerationEstimate {
  const limit = clampLimit(limitInput);
  const queryLimit = Math.min(MAX_QUERY_ROWS, Math.max(limit * 5, limit));
  const batchRows = db
    .prepare<{ ownerId: number; limit: number }, { created_at: string; updated_at: string }>(
      `SELECT bt.created_at, bt.updated_at
       FROM batch_tasks bt
       JOIN batches b ON b.id = bt.batch_id
       WHERE b.owner_id = @ownerId
         AND b.batch_type IN ('video_segments', 'videos')
         AND bt.status = 'completed'
         AND bt.created_at IS NOT NULL
         AND bt.updated_at IS NOT NULL
       ORDER BY bt.updated_at DESC
       LIMIT @limit`,
    )
    .all({ ownerId, limit: queryLimit });

  const batchAverageSec = averageSamples(batchRows, limit);
  if (batchAverageSec) {
    const sampleSize = batchRows
      .map((row) => elapsedGenerationSeconds(row.created_at, row.updated_at))
      .filter((sec): sec is number => typeof sec === 'number' && isReasonableGenerationSample(sec))
      .slice(0, limit).length;
    return {
      averageSec: batchAverageSec,
      sampleSize,
      limit,
      source: 'recent_completed_batch_tasks',
    };
  }

  const videoRows = db
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
    .all({ ownerId, limit: queryLimit });

  const validVideoSamples = videoRows
    .map((row) => elapsedGenerationSeconds(row.created_at, row.updated_at))
    .filter((sec): sec is number => typeof sec === 'number' && isReasonableGenerationSample(sec))
    .slice(0, limit);

  const averageSec = validVideoSamples.length
    ? Math.max(1, Math.round(validVideoSamples.reduce((sum, sec) => sum + sec, 0) / validVideoSamples.length))
    : null;

  return {
    averageSec,
    sampleSize: validVideoSamples.length,
    limit,
    source: 'recent_completed_video_tasks',
  };
}
