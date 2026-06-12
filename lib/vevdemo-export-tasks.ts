import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type VevDemoExportTaskStatus =
  | 'submitted'
  | 'remote_running'
  | 'remote_completed'
  | 'origin_downloading'
  | 'ready'
  | 'submit_failed'
  | 'remote_failed'
  | 'origin_download_failed'
  | 'needs_review';

export type VevDemoExportTaskRow = {
  id: string;
  owner_id: number;
  project_id: string;
  vev_project_id: string | null;
  vev_group_id: string | null;
  vev_space: string | null;
  provider_task_id: string | null;
  submit_request_json: string;
  submit_result_json: string;
  poll_result_json: string;
  output_url: string | null;
  output_vid: string | null;
  export_id: string | null;
  status: VevDemoExportTaskStatus;
  error_msg: string | null;
  retry_count: number;
  last_checked_at: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
};

export class VevDemoExportTaskError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'VevDemoExportTaskError';
    this.status = status;
  }
}

const TERMINAL_STATUSES = new Set<VevDemoExportTaskStatus>([
  'ready',
  'submit_failed',
  'remote_failed',
  'origin_download_failed',
  'needs_review',
]);

function nowIso() {
  return new Date().toISOString();
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function stringOrThrow(value: unknown, label: string): string {
  const trimmed = textOrNull(value);
  if (!trimmed) throw new VevDemoExportTaskError(`${label} is required`, 400);
  return trimmed;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function rowByProviderTaskId(providerTaskId: string): VevDemoExportTaskRow | null {
  return getDb()
    .prepare('SELECT * FROM vevdemo_export_tasks WHERE provider_task_id = ? LIMIT 1')
    .get(providerTaskId) as VevDemoExportTaskRow | undefined || null;
}

function rowById(id: string, ownerId?: number): VevDemoExportTaskRow | null {
  const params: Record<string, unknown> = { id };
  let sql = 'SELECT * FROM vevdemo_export_tasks WHERE id = @id';
  if (ownerId !== undefined) {
    sql += ' AND owner_id = @ownerId';
    params.ownerId = ownerId;
  }
  return getDb().prepare(sql).get(params) as VevDemoExportTaskRow | undefined || null;
}

function normalizePathValue(value: unknown): string | null {
  if (typeof value === 'string') return textOrNull(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizePathValue(item);
      if (normalized) return normalized;
    }
  }
  return null;
}

function readPath(source: unknown, path: string[]): unknown {
  let cur = source as any;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function extractVevDemoTaskIdFromSubmitResult(raw: unknown): string | null {
  const paths = [
    ['Result', 'TaskId'],
    ['Result', 'taskId'],
    ['Result', 'task_id'],
    ['Result', 'EditTaskId'],
    ['Result', 'editTaskId'],
    ['Result', 'TaskIds'],
    ['Result', 'TaskID'],
    ['TaskId'],
    ['taskId'],
    ['task_id'],
    ['EditTaskId'],
    ['editTaskId'],
    ['TaskID'],
  ];
  for (const path of paths) {
    const value = normalizePathValue(readPath(raw, path));
    if (value) return value;
  }
  return null;
}

export function isVevDemoExportTaskTerminal(status: VevDemoExportTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function recordVevDemoExportSubmission(input: {
  ownerId: number;
  projectId: string;
  vevProjectId?: string | null;
  vevGroupId?: string | null;
  vevSpace?: string | null;
  providerTaskId: string;
  submitRequest?: unknown;
  submitResult?: unknown;
  nowIso?: string;
}) {
  const ownerId = Number(input.ownerId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new VevDemoExportTaskError('ownerId is required', 400);
  }
  const projectId = stringOrThrow(input.projectId, 'projectId');
  const providerTaskId = stringOrThrow(input.providerTaskId, 'providerTaskId');
  const createdAt = input.nowIso || nowIso();
  const id = randomUUID();
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO vevdemo_export_tasks (
      id, owner_id, project_id, vev_project_id, vev_group_id, vev_space,
      provider_task_id, submit_request_json, submit_result_json, poll_result_json,
      status, created_at, updated_at
    ) VALUES (
      @id, @owner_id, @project_id, @vev_project_id, @vev_group_id, @vev_space,
      @provider_task_id, @submit_request_json, @submit_result_json, '{}',
      'submitted', @created_at, @updated_at
    )
  `).run({
    id,
    owner_id: ownerId,
    project_id: projectId,
    vev_project_id: textOrNull(input.vevProjectId),
    vev_group_id: textOrNull(input.vevGroupId),
    vev_space: textOrNull(input.vevSpace),
    provider_task_id: providerTaskId,
    submit_request_json: safeJson(input.submitRequest || {}),
    submit_result_json: safeJson(input.submitResult || {}),
    created_at: createdAt,
    updated_at: createdAt,
  });

  const row = insert.changes === 1 ? rowById(id) : rowByProviderTaskId(providerTaskId);
  if (!row) {
    throw new VevDemoExportTaskError('VevDemo export task was ignored and no existing row was found', 409);
  }
  if (Number(row.owner_id) !== ownerId) {
    throw new VevDemoExportTaskError('duplicate provider task id belongs to another user', 409);
  }
  return { task: row, duplicate: insert.changes !== 1 };
}

export function getVevDemoExportTaskById(id: string, ownerId?: number): VevDemoExportTaskRow | null {
  const taskId = stringOrThrow(id, 'id');
  return rowById(taskId, ownerId);
}

export function getVevDemoExportTaskByProviderTaskId(providerTaskId: string, ownerId?: number): VevDemoExportTaskRow | null {
  const task = rowByProviderTaskId(stringOrThrow(providerTaskId, 'providerTaskId'));
  if (!task) return null;
  if (ownerId !== undefined && Number(task.owner_id) !== Number(ownerId)) return null;
  return task;
}

export function getLatestVevDemoExportTaskForProject(input: {
  ownerId: number;
  projectId: string;
}): VevDemoExportTaskRow | null {
  return getDb()
    .prepare(`
      SELECT *
        FROM vevdemo_export_tasks
       WHERE owner_id = @ownerId
         AND project_id = @projectId
       ORDER BY
         CASE WHEN status IN ('ready', 'submit_failed', 'remote_failed', 'origin_download_failed', 'needs_review') THEN 1 ELSE 0 END,
         updated_at DESC
       LIMIT 1
    `)
    .get({
      ownerId: Number(input.ownerId),
      projectId: stringOrThrow(input.projectId, 'projectId'),
    }) as VevDemoExportTaskRow | undefined || null;
}

export function listDueVevDemoExportTasks(input: {
  statuses?: VevDemoExportTaskStatus[];
  limit?: number;
  nowIso?: string;
} = {}): VevDemoExportTaskRow[] {
  const statuses = input.statuses && input.statuses.length ? input.statuses : ['submitted', 'remote_running'];
  const limit = Math.max(1, Math.min(Number(input.limit || 20), 100));
  const placeholders = statuses.map((_, index) => `@status${index}`).join(', ');
  const params: Record<string, unknown> = {
    limit,
    now: input.nowIso || nowIso(),
  };
  statuses.forEach((status, index) => {
    params[`status${index}`] = status;
  });
  return getDb()
    .prepare(`
      SELECT *
        FROM vevdemo_export_tasks
       WHERE status IN (${placeholders})
         AND (next_retry_at IS NULL OR next_retry_at <= @now)
       ORDER BY updated_at ASC
       LIMIT @limit
    `)
    .all(params) as VevDemoExportTaskRow[];
}

export function updateVevDemoExportTaskStatus(input: {
  id: string;
  status: VevDemoExportTaskStatus;
  errorMsg?: string | null;
  pollResult?: unknown;
  outputUrl?: string | null;
  outputVid?: string | null;
  exportId?: string | null;
  lastCheckedAt?: string | null;
  nextRetryAt?: string | null;
  incrementRetry?: boolean;
  nowIso?: string;
}): VevDemoExportTaskRow {
  const now = input.nowIso || nowIso();
  const result = getDb()
    .prepare(`
      UPDATE vevdemo_export_tasks
         SET status = @status,
             error_msg = CASE WHEN @has_error_msg = 1 THEN @error_msg ELSE error_msg END,
             poll_result_json = CASE WHEN @has_poll_result = 1 THEN @poll_result_json ELSE poll_result_json END,
             output_url = CASE WHEN @has_output_url = 1 THEN @output_url ELSE output_url END,
             output_vid = CASE WHEN @has_output_vid = 1 THEN @output_vid ELSE output_vid END,
             export_id = CASE WHEN @has_export_id = 1 THEN @export_id ELSE export_id END,
             last_checked_at = CASE WHEN @has_last_checked_at = 1 THEN @last_checked_at ELSE last_checked_at END,
             next_retry_at = CASE WHEN @has_next_retry_at = 1 THEN @next_retry_at ELSE next_retry_at END,
             retry_count = retry_count + @retry_increment,
             updated_at = @updated_at
       WHERE id = @id
    `)
    .run({
      id: stringOrThrow(input.id, 'id'),
      status: input.status,
      has_error_msg: Object.prototype.hasOwnProperty.call(input, 'errorMsg') ? 1 : 0,
      error_msg: input.errorMsg ?? null,
      has_poll_result: Object.prototype.hasOwnProperty.call(input, 'pollResult') ? 1 : 0,
      poll_result_json: input.pollResult === undefined ? '{}' : safeJson(input.pollResult),
      has_output_url: Object.prototype.hasOwnProperty.call(input, 'outputUrl') ? 1 : 0,
      output_url: textOrNull(input.outputUrl),
      has_output_vid: Object.prototype.hasOwnProperty.call(input, 'outputVid') ? 1 : 0,
      output_vid: textOrNull(input.outputVid),
      has_export_id: Object.prototype.hasOwnProperty.call(input, 'exportId') ? 1 : 0,
      export_id: textOrNull(input.exportId),
      has_last_checked_at: Object.prototype.hasOwnProperty.call(input, 'lastCheckedAt') ? 1 : 0,
      last_checked_at: input.lastCheckedAt ?? null,
      has_next_retry_at: Object.prototype.hasOwnProperty.call(input, 'nextRetryAt') ? 1 : 0,
      next_retry_at: input.nextRetryAt ?? null,
      retry_increment: input.incrementRetry ? 1 : 0,
      updated_at: now,
    });
  if (result.changes !== 1) throw new VevDemoExportTaskError('VevDemo export task not found', 404);
  const row = rowById(input.id);
  if (!row) throw new VevDemoExportTaskError('VevDemo export task not found after update', 404);
  return row;
}

export function markVevDemoExportRemoteRunning(input: {
  id: string;
  pollResult?: unknown;
  nextRetryAt?: string | null;
  nowIso?: string;
}) {
  return updateVevDemoExportTaskStatus({
    id: input.id,
    status: 'remote_running',
    pollResult: input.pollResult,
    nextRetryAt: input.nextRetryAt ?? null,
    lastCheckedAt: input.nowIso || nowIso(),
    nowIso: input.nowIso,
  });
}

export function markVevDemoExportRemoteCompleted(input: {
  id: string;
  outputUrl?: string | null;
  outputVid?: string | null;
  pollResult?: unknown;
  nowIso?: string;
}) {
  return updateVevDemoExportTaskStatus({
    id: input.id,
    status: 'remote_completed',
    pollResult: input.pollResult,
    outputUrl: input.outputUrl ?? null,
    outputVid: input.outputVid ?? null,
    lastCheckedAt: input.nowIso || nowIso(),
    nowIso: input.nowIso,
  });
}

export function markVevDemoExportRemoteFailed(input: {
  id: string;
  errorMsg: string;
  pollResult?: unknown;
  nowIso?: string;
}) {
  return updateVevDemoExportTaskStatus({
    id: input.id,
    status: 'remote_failed',
    errorMsg: input.errorMsg,
    pollResult: input.pollResult,
    lastCheckedAt: input.nowIso || nowIso(),
    nowIso: input.nowIso,
  });
}

export function attachVevDemoExportRecord(input: {
  id: string;
  exportId: string;
  outputUrl?: string | null;
  outputVid?: string | null;
  nowIso?: string;
}) {
  return updateVevDemoExportTaskStatus({
    id: input.id,
    status: 'origin_downloading',
    exportId: input.exportId,
    outputUrl: input.outputUrl ?? null,
    outputVid: input.outputVid ?? null,
    nowIso: input.nowIso,
  });
}

export function reconcileVevDemoExportDownloadStatuses(input: {
  limit?: number;
  nowIso?: string;
} = {}) {
  const limit = Math.max(1, Math.min(Number(input.limit || 50), 200));
  const now = input.nowIso || nowIso();
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT t.*, e.status AS export_status, e.local_download_status AS export_local_download_status, e.error_msg AS export_error_msg
        FROM vevdemo_export_tasks t
        LEFT JOIN exports e
          ON e.id = t.export_id
         AND e.owner_id = t.owner_id
       WHERE t.status = 'origin_downloading'
         AND t.export_id IS NOT NULL
       ORDER BY t.updated_at ASC
       LIMIT @limit
    `)
    .all({ limit }) as Array<VevDemoExportTaskRow & {
      export_status?: string | null;
      export_local_download_status?: string | null;
      export_error_msg?: string | null;
    }>;
  let ready = 0;
  let failed = 0;
  let needsReview = 0;
  for (const row of rows) {
    if (!row.export_status) {
      updateVevDemoExportTaskStatus({
        id: row.id,
        status: 'needs_review',
        errorMsg: 'linked export row not found',
        nowIso: now,
      });
      needsReview += 1;
      continue;
    }
    if (row.export_status === 'completed' && row.export_local_download_status === 'completed') {
      updateVevDemoExportTaskStatus({
        id: row.id,
        status: 'ready',
        errorMsg: null,
        nowIso: now,
      });
      ready += 1;
      continue;
    }
    if (row.export_status === 'failed' || row.export_local_download_status === 'download_failed') {
      updateVevDemoExportTaskStatus({
        id: row.id,
        status: 'origin_download_failed',
        errorMsg: row.export_error_msg || 'origin download failed',
        nowIso: now,
      });
      failed += 1;
    }
  }
  return { scanned: rows.length, ready, failed, needsReview };
}

export function serializeVevDemoExportTask(row: VevDemoExportTaskRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: Number(row.owner_id),
    projectId: row.project_id,
    vevProjectId: row.vev_project_id,
    vevGroupId: row.vev_group_id,
    vevSpace: row.vev_space,
    providerTaskId: row.provider_task_id,
    status: row.status,
    exportId: row.export_id,
    outputUrl: row.output_url,
    outputVid: row.output_vid,
    errorMsg: row.error_msg,
    retryCount: Number(row.retry_count || 0),
    lastCheckedAt: row.last_checked_at,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminal: isVevDemoExportTaskTerminal(row.status),
    submitRequest: parseJson(row.submit_request_json),
    submitResult: parseJson(row.submit_result_json),
    pollResult: parseJson(row.poll_result_json),
  };
}
