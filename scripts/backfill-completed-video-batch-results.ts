import type Database from 'better-sqlite3';
import { getDb } from '../lib/db';
import { getProjectByIdForUser } from '../lib/projects-db';
import { buildVideoSegmentNamesForRow } from '../lib/video-segment-names';
import { backupSqliteDatabase } from './backup-sqlite';

type SqliteDb = Database.Database;

type DirtyBatchTaskRow = {
  id: string;
  provider_task_id: string | null;
  result_json: string;
};

type VideoTaskRow = {
  id: string;
  owner_id: number;
  project_id: string | null;
  group_idx: number | null;
  provider_task: string | null;
  status: string;
  filename: string | null;
  duration_sec: number | null;
  cover_image_id: string | null;
};

function emptyJsonPath(alias: string, path: string) {
  return `(json_extract(${alias}.result_json, '${path}') IS NULL OR json_extract(${alias}.result_json, '${path}') = '')`;
}

export function dirtyCompletedVideoBatchWhere(alias = 'bt') {
  return [
    `${alias}.provider = 'volcengine_seedance_video'`,
    `${alias}.status = 'completed'`,
    `json_valid(${alias}.result_json)`,
    emptyJsonPath(alias, '$.resultUrl'),
    emptyJsonPath(alias, '$.patch.url'),
    emptyJsonPath(alias, '$.extra.protectedUrl'),
  ].join(' AND ');
}

function safeParseJson(value: string | null | undefined) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

export function countDirtyCompletedVideoBatchTasks(db: SqliteDb = getDb()) {
  const row = db
    .prepare<[], { count: number }>(
      `SELECT COUNT(*) AS count
         FROM batch_tasks bt
        WHERE ${dirtyCompletedVideoBatchWhere('bt')}`,
    )
    .get();
  return Number(row?.count || 0);
}

function readDirtyCompletedVideoBatchTasks(db: SqliteDb) {
  return db
    .prepare<[], DirtyBatchTaskRow>(
      `SELECT bt.id, bt.provider_task_id, bt.result_json
         FROM batch_tasks bt
        WHERE ${dirtyCompletedVideoBatchWhere('bt')}
        ORDER BY bt.updated_at ASC, bt.id ASC`,
    )
    .all();
}

function readCompletedVideoForBatchTask(db: SqliteDb, task: DirtyBatchTaskRow): VideoTaskRow | null {
  const localVideoTaskId = String(safeParseJson(task.result_json)?.providerSubmission?.localVideoTaskId || '').trim();
  if (localVideoTaskId) {
    const row = db
      .prepare<{ id: string }, VideoTaskRow>(
        `SELECT id, owner_id, project_id, group_idx, provider_task, status, filename, duration_sec, cover_image_id
           FROM video_tasks
          WHERE id = @id
            AND status = 'completed'
            AND COALESCE(filename, '') <> ''`,
      )
      .get({ id: localVideoTaskId });
    if (row) return row;
  }

  const providerTaskId = String(task.provider_task_id || '').trim();
  if (!providerTaskId) return null;
  return db
    .prepare<{ providerTaskId: string }, VideoTaskRow>(
      `SELECT id, owner_id, project_id, group_idx, provider_task, status, filename, duration_sec, cover_image_id
         FROM video_tasks
        WHERE provider_task = @providerTaskId
          AND status = 'completed'
          AND COALESCE(filename, '') <> ''
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get({ providerTaskId }) || null;
}

export function buildCompletedVideoBatchResult(videoRow: VideoTaskRow) {
  const project = videoRow.project_id
    ? getProjectByIdForUser(String(videoRow.project_id), Number(videoRow.owner_id))
    : null;
  const names = buildVideoSegmentNamesForRow(videoRow, project);
  const protectedUrl = `/api/videos/file/${videoRow.id}`;
  const coverUrl = videoRow.cover_image_id ? `/api/images/file/${videoRow.cover_image_id}` : null;
  const durationSec = Number(videoRow.duration_sec) || 0;

  return {
    resultUrl: protectedUrl,
    patch: {
      type: 'video_segment',
      groupIdx: videoRow.group_idx,
      url: protectedUrl,
      coverUrl,
      durationSec,
      filename: names.filename,
      displayName: names.displayName,
      downloadFilename: names.downloadFilename,
      taskId: videoRow.id,
    },
    extra: {
      mode: 'real',
      groupIdx: videoRow.group_idx,
      durationSec,
      protectedUrl,
      filename: names.filename,
      displayName: names.displayName,
      downloadFilename: names.downloadFilename,
    },
  };
}

export async function backfillCompletedVideoBatchResults(opts: {
  apply?: boolean;
  requireBackup?: boolean;
  db?: SqliteDb;
} = {}) {
  const db = opts.db || getDb();
  const apply = opts.apply === true;
  const requireBackup = opts.requireBackup !== false;
  const dirtyTasks = readDirtyCompletedVideoBatchTasks(db);
  const matched = dirtyTasks
    .map((task) => ({ task, video: readCompletedVideoForBatchTask(db, task) }))
    .filter((item): item is { task: DirtyBatchTaskRow; video: VideoTaskRow } => Boolean(item.video));
  const skipped = dirtyTasks
    .filter((task) => !matched.some((item) => item.task.id === task.id))
    .map((task) => task.id);

  let backup: Awaited<ReturnType<typeof backupSqliteDatabase>> | null = null;
  let updated = 0;
  if (apply && matched.length) {
    if (requireBackup) {
      backup = await backupSqliteDatabase();
    }
    const update = db.prepare<{ resultJson: string; id: string }>(
      `UPDATE batch_tasks
          SET result_json = @resultJson,
              error_msg = NULL,
              error_message = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id
          AND provider = 'volcengine_seedance_video'
          AND status = 'completed'`,
    );
    const transaction = db.transaction((items: typeof matched) => {
      let count = 0;
      for (const item of items) {
        const resultJson = JSON.stringify(buildCompletedVideoBatchResult(item.video));
        count += update.run({ id: item.task.id, resultJson }).changes;
      }
      return count;
    });
    updated = transaction(matched);
  }

  const remainingDirtyCompletedVideoBatches = countDirtyCompletedVideoBatchTasks(db);
  if (apply && updated !== matched.length) {
    throw new Error(`matched rows were not fully updated: matched=${matched.length} updated=${updated}`);
  }

  return {
    ok: true,
    apply,
    scanned: dirtyTasks.length,
    matched: matched.length,
    skippedCount: skipped.length,
    skipped,
    updated,
    fullyClean: remainingDirtyCompletedVideoBatches === 0,
    remainingDirtyCompletedVideoBatches,
    backup,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await backfillCompletedVideoBatchResults({ apply });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill-completed-video-batch-results] failed:', error?.message || error);
    process.exit(1);
  });
}
