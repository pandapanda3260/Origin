import { getDb } from '../db';
import {
  buildBatchTaskCallItemLabel,
  buildGenerationBatchCallItemLabel,
  buildProjectDisplay,
  classifyBatchTaskFeature,
  classifyExportFeature,
  classifyGenerationBatchFeature,
  classifyStyleBibleFeature,
  getTimeUsageFeature,
  listTimeUsageFeatures,
  normalizeTimeUsageStatus,
  terminalStatusesForSource,
} from './classification';
import type { TimeUsageDetailRow, TimeUsageFilters, TimeUsageMetricGroup, TimeUsageSummary } from './types';
import type { TimeUsageFeature, TimeUsageSourceTable } from './classification';

type QueryOptions = {
  bypassCache?: boolean;
};

type CachedRows = {
  expiresAt: number;
  rows: TimeUsageDetailRow[];
};

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;
const rowCache = new Map<string, CachedRows>();

export function listTimeUsageEvents(filters: TimeUsageFilters, opts: QueryOptions = {}) {
  const rows = getCachedRows(filters, opts);
  const offset = clampInt(filters.offset, 0, 0, 100_000);
  const limit = clampInt(filters.limit, 100, 1, 500);
  return {
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
  };
}

export function listTimeUsageExportRows(filters: TimeUsageFilters, limit: number, opts: QueryOptions = {}) {
  const rows = getCachedRows(filters, opts);
  return {
    rows: rows.slice(0, clampInt(limit, 20_000, 1, 20_000)),
    total: rows.length,
  };
}

export function countTimeUsageRows(filters: TimeUsageFilters) {
  const now = Date.now();
  pruneRowCache(now);
  const cached = rowCache.get(stableCacheKey(filters));
  if (cached && cached.expiresAt > now) return cached.rows.length;
  const groups = featureGroups(filters);
  return countBatchTaskRows(filters, groups.batch_tasks)
    + countGenerationBatchRows(filters, groups.generation_batches)
    + countExportRows(filters, groups.exports)
    + countStyleBibleRows(filters, groups.style_bible_runs);
}

export function summarizeTimeUsage(filters: TimeUsageFilters, opts: QueryOptions = {}): TimeUsageSummary {
  const rows = getCachedRows(filters, opts);
  const users = new Set(rows.map((row) => row.ownerId).filter((id): id is number => id != null));
  const terminal = rows.filter((row) => row.isTerminal);
  const active = rows.filter((row) => !row.isTerminal);
  return {
    total: rows.length,
    terminal: terminal.length,
    active: active.length,
    users: users.size,
    success: metricGroup(terminal.filter((row) => row.statusGroup === 'success')),
    partialSuccess: metricGroup(terminal.filter((row) => row.statusGroup === 'partial_success')),
    failed: metricGroup(terminal.filter((row) => row.statusGroup === 'failed')),
    cancelled: metricGroup(terminal.filter((row) => row.statusGroup === 'cancelled')),
    activeLongestWaitMs: maxWait(active),
  };
}

export function summarizeTimeUsageByUser(filters: TimeUsageFilters, limit = 100, opts: QueryOptions = {}) {
  const groups = new Map<string, TimeUsageDetailRow[]>();
  for (const row of getCachedRows(filters, opts)) {
    const key = String(row.ownerId ?? 'unknown');
    const current = groups.get(key) || [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const terminal = rows.filter((row) => row.isTerminal);
      return {
        ownerId: key === 'unknown' ? null : Number(key),
        username: rows.find((row) => row.username)?.username || 'unknown',
        total: rows.length,
        terminal: terminal.length,
        active: rows.length - terminal.length,
        success: terminal.filter((row) => row.statusGroup === 'success').length,
        failed: terminal.filter((row) => row.statusGroup === 'failed').length,
        avgWaitMs: metricGroup(terminal).avgWaitMs,
        p95WaitMs: metricGroup(terminal).p95WaitMs,
      };
    })
    .sort((a, b) => b.total - a.total || (b.avgWaitMs || 0) - (a.avgWaitMs || 0))
    .slice(0, clampInt(limit, 100, 1, 500));
}

export function summarizeTimeUsageByCategory(filters: TimeUsageFilters, limit = 100, opts: QueryOptions = {}) {
  const groups = new Map<string, TimeUsageDetailRow[]>();
  for (const row of getCachedRows(filters, opts)) {
    const key = `${row.moduleKey}:${row.featureKey}`;
    const current = groups.get(key) || [];
    current.push(row);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((rows) => {
      const first = rows[0];
      const terminal = rows.filter((row) => row.isTerminal);
      const metrics = metricGroup(terminal);
      return {
        moduleKey: first.moduleKey,
        moduleLabel: first.moduleLabel,
        featureKey: first.featureKey,
        featureLabel: first.featureLabel,
        total: rows.length,
        terminal: terminal.length,
        active: rows.length - terminal.length,
        success: terminal.filter((row) => row.statusGroup === 'success').length,
        failed: terminal.filter((row) => row.statusGroup === 'failed').length,
        cancelled: terminal.filter((row) => row.statusGroup === 'cancelled').length,
        partialSuccess: terminal.filter((row) => row.statusGroup === 'partial_success').length,
        avgWaitMs: metrics.avgWaitMs,
        p95WaitMs: metrics.p95WaitMs,
        maxWaitMs: metrics.maxWaitMs,
      };
    })
    .sort((a, b) => b.total - a.total || (b.avgWaitMs || 0) - (a.avgWaitMs || 0))
    .slice(0, clampInt(limit, 100, 1, 500));
}

export function clearTimeUsageQueryCache() {
  rowCache.clear();
}

function getCachedRows(filters: TimeUsageFilters, opts: QueryOptions) {
  const key = stableCacheKey(filters);
  const now = Date.now();
  pruneRowCache(now);
  if (!opts.bypassCache) {
    const cached = rowCache.get(key);
    if (cached && cached.expiresAt > now) {
      rowCache.delete(key);
      rowCache.set(key, cached);
      return cached.rows;
    }
  }
  const rows = loadRows(filters, now);
  rowCache.set(key, { rows, expiresAt: now + CACHE_TTL_MS });
  while (rowCache.size > MAX_CACHE_ENTRIES) {
    const oldest = rowCache.keys().next().value;
    if (!oldest) break;
    rowCache.delete(oldest);
  }
  return rows;
}

function loadRows(filters: TimeUsageFilters, nowMs: number): TimeUsageDetailRow[] {
  const groups = featureGroups(filters);
  // V1 keeps cross-source merge/pagination in JS to preserve the feature mapping rules in one place.
  // If row volume grows, this layer should move to normalized UNION ALL queries with SQL pagination.
  const rows = [
    ...loadBatchTaskRows(filters, nowMs, groups.batch_tasks),
    ...loadGenerationBatchRows(filters, nowMs, groups.generation_batches),
    ...loadExportRows(filters, nowMs, groups.exports),
    ...loadStyleBibleRows(filters, nowMs, groups.style_bible_runs),
  ]
    .filter((row) => matchesPostFilters(row, filters))
    .sort((a, b) => compareTimeDesc(a.createdAt, b.createdAt) || b.sourceId.localeCompare(a.sourceId));
  return rows;
}

function loadBatchTaskRows(filters: TimeUsageFilters, nowMs: number, features: TimeUsageFeature[]): TimeUsageDetailRow[] {
  if (!features.length) return [];
  const { where, params } = baseWhere('t.created_at', filters, 'b.owner_id');
  where.push(featureWhere('batch_tasks', features));
  appendStatusWhere(where, params, 't.status', 'batch_tasks', filters.status);
  appendQueryWhere(where, params, 'batch_tasks', features, filters.query, [
    't.id',
    'u.username',
    'b.project_id',
    'p.title',
    't.provider',
    "COALESCE(t.error_message, t.error_msg, t.status_reason, '')",
    "json_extract(t.target_json, '$.label')",
    "json_extract(t.target_json, '$.name')",
    "json_extract(t.target_json, '$.title')",
  ]);
  const rows = getDb().prepare<Record<string, unknown>, any>(`
    SELECT
      t.id AS sourceId,
      t.created_at AS createdAt,
      t.updated_at AS updatedAt,
      COALESCE(th.terminal_at, t.updated_at) AS terminalAt,
      t.status,
      t.seq,
      t.target_json AS targetJson,
      json_extract(t.target_json, '$.type') AS targetType,
      b.batch_type AS batchType,
      b.owner_id AS ownerId,
      u.username AS username,
      b.project_id AS projectId,
      p.title AS projectTitle,
      t.provider AS provider,
      COALESCE(t.error_message, t.error_msg, t.status_reason, '') AS errorMessage
    FROM batch_tasks t
    JOIN batches b ON b.id = t.batch_id
    LEFT JOIN users u ON u.id = b.owner_id
    LEFT JOIN projects p ON p.id = b.project_id
    LEFT JOIN (
      SELECT task_id, MAX(created_at) AS terminal_at
      FROM task_state_history
      WHERE to_state IN ('completed','failed','cancelled')
      GROUP BY task_id
    ) th ON th.task_id = t.id
    WHERE ${where.join(' AND ')}
  `).all(params);

  return rows.map((row) => {
    const feature = classifyBatchTaskFeature(row.batchType, row.targetType);
    if (!feature) return null;
    const status = normalizeTimeUsageStatus(row.status, 'batch_tasks');
    const startedAt = String(row.createdAt || '');
    const endedAt = status.isTerminal ? String(row.terminalAt || row.updatedAt || '') || null : null;
    return {
      sourceTable: 'batch_tasks' as const,
      sourceId: String(row.sourceId),
      createdAt: startedAt,
      startedAt,
      endedAt,
      waitMs: waitMs(startedAt, endedAt, nowMs, status.isTerminal),
      ownerId: row.ownerId == null ? null : Number(row.ownerId),
      username: row.username || null,
      projectId: row.projectId || null,
      projectTitle: row.projectTitle || null,
      projectDisplay: buildProjectDisplay(row.projectId, row.projectTitle, null),
      moduleKey: feature.moduleKey,
      moduleLabel: feature.moduleLabel,
      featureKey: feature.featureKey,
      featureLabel: feature.featureLabel,
      callItemType: feature.callItemType,
      callItemId: String(row.sourceId),
      callItemLabel: buildBatchTaskCallItemLabel(feature.featureKey, row.targetJson, row.seq),
      status: status.status,
      statusGroup: status.statusGroup,
      isTerminal: status.isTerminal,
      provider: row.provider || null,
      errorMessage: row.errorMessage || null,
    };
  }).filter(Boolean) as TimeUsageDetailRow[];
}

function loadGenerationBatchRows(filters: TimeUsageFilters, nowMs: number, features: TimeUsageFeature[]): TimeUsageDetailRow[] {
  if (!features.length) return [];
  const { where, params } = baseWhere('gb.created_at', filters, 'gb.owner_id');
  where.push(featureWhere('generation_batches', features));
  appendStatusWhere(where, params, 'gb.status', 'generation_batches', filters.status);
  appendQueryWhere(where, params, 'generation_batches', features, filters.query, [
    'gb.batch_id',
    'u.username',
    'gb.project_id',
    'p.title',
    'gb.shot_uid',
    'gb.legacy_shot_id',
    "COALESCE(gb.error_message, '')",
  ]);
  const rows = getDb().prepare<Record<string, unknown>, any>(`
    SELECT
      gb.batch_id AS sourceId,
      gb.batch_id AS batchId,
      gb.created_at AS createdAt,
      gb.started_at AS startedAt,
      gb.completed_at AS completedAt,
      gb.status,
      gb.stage,
      gb.source AS gbSource,
      gb.shot_uid AS shotUid,
      gb.legacy_shot_id AS legacyShotId,
      gb.owner_id AS ownerId,
      u.username AS username,
      gb.project_id AS projectId,
      p.title AS projectTitle,
      gb.error_message AS errorMessage
    FROM generation_batches gb
    LEFT JOIN users u ON u.id = gb.owner_id
    LEFT JOIN projects p ON p.id = gb.project_id
    WHERE ${where.join(' AND ')}
  `).all(params);

  return rows.map((row) => {
    const feature = classifyGenerationBatchFeature(row.stage, row.gbSource);
    if (!feature) return null;
    const status = normalizeTimeUsageStatus(row.status, 'generation_batches');
    const startedAt = String(row.startedAt || row.createdAt || '');
    const endedAt = status.isTerminal ? String(row.completedAt || '') || null : null;
    return {
      sourceTable: 'generation_batches' as const,
      sourceId: String(row.sourceId),
      createdAt: String(row.createdAt || startedAt),
      startedAt,
      endedAt,
      waitMs: waitMs(startedAt, endedAt, nowMs, status.isTerminal),
      ownerId: row.ownerId == null ? null : Number(row.ownerId),
      username: row.username || null,
      projectId: row.projectId || null,
      projectTitle: row.projectTitle || null,
      projectDisplay: buildProjectDisplay(row.projectId, row.projectTitle, row.gbSource),
      moduleKey: feature.moduleKey,
      moduleLabel: feature.moduleLabel,
      featureKey: feature.featureKey,
      featureLabel: feature.featureLabel,
      callItemType: feature.callItemType,
      callItemId: String(row.batchId),
      callItemLabel: buildGenerationBatchCallItemLabel({
        featureKey: feature.featureKey,
        batchId: row.batchId,
        shotUid: row.shotUid,
        legacyShotId: row.legacyShotId,
        stage: row.stage,
      }),
      status: status.status,
      statusGroup: status.statusGroup,
      isTerminal: status.isTerminal,
      provider: null,
      errorMessage: row.errorMessage || null,
    };
  }).filter(Boolean) as TimeUsageDetailRow[];
}

function loadExportRows(filters: TimeUsageFilters, nowMs: number, features: TimeUsageFeature[]): TimeUsageDetailRow[] {
  if (!features.length) return [];
  const { where, params } = baseWhere('e.created_at', filters, 'e.owner_id');
  where.push(featureWhere('exports', features));
  appendStatusWhere(where, params, 'e.status', 'exports', filters.status);
  appendQueryWhere(where, params, 'exports', features, filters.query, [
    'e.id',
    'u.username',
    'e.project_id',
    'p.title',
    'e.provider',
    "COALESCE(e.error_message, e.error_msg, '')",
  ]);
  const rows = getDb().prepare<Record<string, unknown>, any>(`
    SELECT
      e.id AS sourceId,
      e.created_at AS createdAt,
      e.updated_at AS updatedAt,
      e.status,
      e.owner_id AS ownerId,
      u.username AS username,
      e.project_id AS projectId,
      p.title AS projectTitle,
      e.provider AS provider,
      e.external_export_id AS externalExportId,
      COALESCE(e.error_message, e.error_msg, '') AS errorMessage
    FROM exports e
    LEFT JOIN users u ON u.id = e.owner_id
    LEFT JOIN projects p ON p.id = e.project_id
    WHERE ${where.join(' AND ')}
  `).all(params);

  return rows.map((row) => {
    const feature = classifyExportFeature(row.provider, row.externalExportId);
    if (!feature) return null;
    const status = normalizeTimeUsageStatus(row.status, 'exports');
    const startedAt = String(row.createdAt || '');
    const endedAt = status.isTerminal ? String(row.updatedAt || '') || null : null;
    return {
      sourceTable: 'exports' as const,
      sourceId: String(row.sourceId),
      createdAt: startedAt,
      startedAt,
      endedAt,
      waitMs: waitMs(startedAt, endedAt, nowMs, status.isTerminal),
      ownerId: row.ownerId == null ? null : Number(row.ownerId),
      username: row.username || null,
      projectId: row.projectId || null,
      projectTitle: row.projectTitle || null,
      projectDisplay: buildProjectDisplay(row.projectId, row.projectTitle, null),
      moduleKey: feature.moduleKey,
      moduleLabel: feature.moduleLabel,
      featureKey: feature.featureKey,
      featureLabel: feature.featureLabel,
      callItemType: feature.callItemType,
      callItemId: String(row.sourceId),
      callItemLabel: `导出 ${String(row.sourceId).slice(0, 8)}`,
      status: status.status,
      statusGroup: status.statusGroup,
      isTerminal: status.isTerminal,
      provider: row.provider || null,
      errorMessage: row.errorMessage || null,
    };
  }).filter(Boolean) as TimeUsageDetailRow[];
}

function loadStyleBibleRows(filters: TimeUsageFilters, nowMs: number, features: TimeUsageFeature[]): TimeUsageDetailRow[] {
  if (!features.length) return [];
  const { where, params } = baseWhere('s.created_at', filters, 's.owner_id');
  appendStatusWhere(where, params, 's.status', 'style_bible_runs', filters.status);
  appendQueryWhere(where, params, 'style_bible_runs', features, filters.query, [
    's.run_id',
    'u.username',
    's.project_id',
    'p.title',
    "COALESCE(s.error_code, s.error_message, '')",
  ]);
  const rows = getDb().prepare<Record<string, unknown>, any>(`
    SELECT
      s.run_id AS sourceId,
      s.run_id AS runId,
      s.created_at AS createdAt,
      s.started_at AS startedAt,
      s.completed_at AS completedAt,
      s.status,
      s.owner_id AS ownerId,
      u.username AS username,
      s.project_id AS projectId,
      p.title AS projectTitle,
      COALESCE(s.error_code, s.error_message, '') AS errorMessage
    FROM style_bible_runs s
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE ${where.join(' AND ')}
  `).all(params);

  const feature = classifyStyleBibleFeature();
  return rows.map((row) => {
    const status = normalizeTimeUsageStatus(row.status, 'style_bible_runs');
    const startedAt = String(row.startedAt || row.createdAt || '');
    const endedAt = status.isTerminal ? String(row.completedAt || '') || null : null;
    return {
      sourceTable: 'style_bible_runs' as const,
      sourceId: String(row.sourceId),
      createdAt: String(row.createdAt || startedAt),
      startedAt,
      endedAt,
      waitMs: waitMs(startedAt, endedAt, nowMs, status.isTerminal),
      ownerId: row.ownerId == null ? null : Number(row.ownerId),
      username: row.username || null,
      projectId: row.projectId || null,
      projectTitle: row.projectTitle || null,
      projectDisplay: buildProjectDisplay(row.projectId, row.projectTitle, null),
      moduleKey: feature.moduleKey,
      moduleLabel: feature.moduleLabel,
      featureKey: feature.featureKey,
      featureLabel: feature.featureLabel,
      callItemType: feature.callItemType,
      callItemId: String(row.runId || row.sourceId),
      callItemLabel: `风格圣经 ${String(row.runId || row.sourceId).slice(0, 8)}`,
      status: status.status,
      statusGroup: status.statusGroup,
      isTerminal: status.isTerminal,
      provider: null,
      errorMessage: row.errorMessage || null,
    };
  });
}

function countBatchTaskRows(filters: TimeUsageFilters, features: TimeUsageFeature[]) {
  if (!features.length) return 0;
  const { where, params } = baseWhere('t.created_at', filters, 'b.owner_id');
  where.push(featureWhere('batch_tasks', features));
  appendStatusWhere(where, params, 't.status', 'batch_tasks', filters.status);
  appendQueryWhere(where, params, 'batch_tasks', features, filters.query, [
    't.id',
    'u.username',
    'b.project_id',
    'p.title',
    't.provider',
    "COALESCE(t.error_message, t.error_msg, t.status_reason, '')",
    "json_extract(t.target_json, '$.label')",
    "json_extract(t.target_json, '$.name')",
    "json_extract(t.target_json, '$.title')",
  ]);
  return countSql(`
    SELECT COUNT(*) AS count
    FROM batch_tasks t
    JOIN batches b ON b.id = t.batch_id
    LEFT JOIN users u ON u.id = b.owner_id
    LEFT JOIN projects p ON p.id = b.project_id
    WHERE ${where.join(' AND ')}
  `, params);
}

function countGenerationBatchRows(filters: TimeUsageFilters, features: TimeUsageFeature[]) {
  if (!features.length) return 0;
  const { where, params } = baseWhere('gb.created_at', filters, 'gb.owner_id');
  where.push(featureWhere('generation_batches', features));
  appendStatusWhere(where, params, 'gb.status', 'generation_batches', filters.status);
  appendQueryWhere(where, params, 'generation_batches', features, filters.query, [
    'gb.batch_id',
    'u.username',
    'gb.project_id',
    'p.title',
    'gb.shot_uid',
    'gb.legacy_shot_id',
    "COALESCE(gb.error_message, '')",
  ]);
  return countSql(`
    SELECT COUNT(*) AS count
    FROM generation_batches gb
    LEFT JOIN users u ON u.id = gb.owner_id
    LEFT JOIN projects p ON p.id = gb.project_id
    WHERE ${where.join(' AND ')}
  `, params);
}

function countExportRows(filters: TimeUsageFilters, features: TimeUsageFeature[]) {
  if (!features.length) return 0;
  const { where, params } = baseWhere('e.created_at', filters, 'e.owner_id');
  where.push(featureWhere('exports', features));
  appendStatusWhere(where, params, 'e.status', 'exports', filters.status);
  appendQueryWhere(where, params, 'exports', features, filters.query, [
    'e.id',
    'u.username',
    'e.project_id',
    'p.title',
    'e.provider',
    "COALESCE(e.error_message, e.error_msg, '')",
  ]);
  return countSql(`
    SELECT COUNT(*) AS count
    FROM exports e
    LEFT JOIN users u ON u.id = e.owner_id
    LEFT JOIN projects p ON p.id = e.project_id
    WHERE ${where.join(' AND ')}
  `, params);
}

function countStyleBibleRows(filters: TimeUsageFilters, features: TimeUsageFeature[]) {
  if (!features.length) return 0;
  const { where, params } = baseWhere('s.created_at', filters, 's.owner_id');
  where.push(featureWhere('style_bible_runs', features));
  appendStatusWhere(where, params, 's.status', 'style_bible_runs', filters.status);
  appendQueryWhere(where, params, 'style_bible_runs', features, filters.query, [
    's.run_id',
    'u.username',
    's.project_id',
    'p.title',
    "COALESCE(s.error_code, s.error_message, '')",
  ]);
  return countSql(`
    SELECT COUNT(*) AS count
    FROM style_bible_runs s
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE ${where.join(' AND ')}
  `, params);
}

function featureGroups(filters: TimeUsageFilters): Record<TimeUsageSourceTable, TimeUsageFeature[]> {
  let features = listTimeUsageFeatures();
  if (filters.featureKey) {
    const feature = getTimeUsageFeature(filters.featureKey);
    features = feature ? [feature] : [];
  } else if (filters.moduleKey) {
    features = features.filter((feature) => feature.moduleKey === filters.moduleKey);
  }
  return {
    batch_tasks: features.filter((feature) => feature.sourceTable === 'batch_tasks'),
    generation_batches: features.filter((feature) => feature.sourceTable === 'generation_batches'),
    exports: features.filter((feature) => feature.sourceTable === 'exports'),
    style_bible_runs: features.filter((feature) => feature.sourceTable === 'style_bible_runs'),
  };
}

function featureWhere(sourceTable: TimeUsageSourceTable, features: TimeUsageFeature[]) {
  const clauses = features
    .map((feature) => featureClause(sourceTable, feature.featureKey))
    .filter(Boolean);
  // Keep the false fallback as a guard if a future caller forgets the empty-feature early return.
  return clauses.length ? `(${clauses.join(' OR ')})` : '0=1';
}

function featureClause(sourceTable: TimeUsageSourceTable, featureKey: string) {
  if (sourceTable === 'batch_tasks') {
    if (featureKey === 'asset_character_image_batch') return "(b.batch_type = 'asset_images' AND json_extract(t.target_json, '$.type') = 'char')";
    if (featureKey === 'asset_scene_image_batch') return "(b.batch_type = 'asset_images' AND json_extract(t.target_json, '$.type') = 'scene')";
    if (featureKey === 'asset_prop_image_batch') return "(b.batch_type = 'asset_images' AND json_extract(t.target_json, '$.type') = 'prop')";
    if (featureKey === 'storyboard_prompt_batch') return "b.batch_type = 'storyboard_prompts'";
    if (featureKey === 'first_frame_image_batch') return "b.batch_type = 'storyboard_images'";
    if (featureKey === 'tail_frame_image_batch') return "b.batch_type = 'tail_frame_images'";
    if (featureKey === 'shot_plan_batch_generate') return "b.batch_type = 'shots'";
    if (featureKey === 'video_prompt_batch_generate') return "b.batch_type = 'video_prompts'";
    if (featureKey === 'video_segment_batch_generate') return "b.batch_type IN ('video_segments','videos')";
  }
  if (sourceTable === 'generation_batches') {
    if (featureKey === 'asset_character_image_single') return "gb.stage = 'asset_character'";
    if (featureKey === 'asset_scene_image_single') return "gb.stage = 'asset_scene'";
    if (featureKey === 'asset_prop_image_single') return "gb.stage = 'asset_prop'";
    if (featureKey === 'video_segment_single_generate') return "(gb.stage = 'video_segment' AND gb.source = 'project')";
    if (featureKey === 'toolbox_image_generate') return "(gb.stage = 'toolbox_image' AND gb.source = 'toolbox')";
    if (featureKey === 'toolbox_video_generate') return "(gb.stage = 'toolbox_video' AND gb.source = 'toolbox')";
  }
  if (sourceTable === 'exports' && featureKey === 'edit_export_render') {
    return "(COALESCE(e.provider, '') = '' AND COALESCE(e.external_export_id, '') = '')";
  }
  if (sourceTable === 'style_bible_runs' && featureKey === 'style_bible_extract') return '1=1';
  return '';
}

function appendStatusWhere(
  where: string[],
  params: Record<string, unknown>,
  statusColumn: string,
  sourceTable: TimeUsageSourceTable,
  statusFilter: unknown,
) {
  const raw = String(statusFilter || '').trim();
  if (!raw) return;
  const terminal = [...terminalStatusesForSource(sourceTable)];
  if (raw === 'active') {
    where.push(`${statusColumn} NOT IN (${sqlStringList(terminal)})`);
    return;
  }
  const mapped = statusValuesForFilter(sourceTable, raw);
  if (!mapped.length) {
    where.push('0=1');
    return;
  }
  where.push(`${statusColumn} IN (${mapped.map((_, index) => `@statusValue${index}`).join(',')})`);
  mapped.forEach((value, index) => {
    params[`statusValue${index}`] = value;
  });
}

function statusValuesForFilter(sourceTable: TimeUsageSourceTable, raw: string) {
  if (raw === 'success') return sourceTable === 'generation_batches' ? ['success'] : ['completed'];
  if (raw === 'partial_success') return sourceTable === 'generation_batches' ? ['partial_success'] : [];
  if (raw === 'failed') return ['failed'];
  if (raw === 'cancelled') return ['cancelled'];
  return [raw];
}

function appendQueryWhere(
  where: string[],
  params: Record<string, unknown>,
  sourceTable: TimeUsageSourceTable,
  features: TimeUsageFeature[],
  queryValue: unknown,
  fields: string[],
) {
  const query = String(queryValue || '').trim().toLowerCase();
  if (!query) return;
  params.queryLike = `%${escapeLike(query)}%`;
  const fieldClauses = fields.map((field) => `LOWER(COALESCE(${field}, '')) LIKE @queryLike ESCAPE '!'`);
  const labelClauses = features
    .filter((feature) => featureMatchesQuery(feature, query))
    .map((feature) => featureClause(sourceTable, feature.featureKey))
    .filter(Boolean);
  where.push(`(${[...fieldClauses, ...labelClauses].join(' OR ') || '0=1'})`);
}

function featureMatchesQuery(feature: TimeUsageFeature, query: string) {
  return featureQueryConstants(feature).some((value) => value.toLowerCase().includes(query));
}

function featureQueryConstants(feature: TimeUsageFeature) {
  const values = [feature.moduleLabel, feature.featureLabel];
  if (feature.featureKey.startsWith('asset_character')) values.push('角色');
  if (feature.featureKey.startsWith('asset_scene')) values.push('场景');
  if (feature.featureKey.startsWith('asset_prop')) values.push('道具');
  if (feature.featureKey === 'shot_plan_batch_generate') values.push('镜头表任务');
  if (feature.featureKey === 'storyboard_prompt_batch') values.push('镜头');
  if (feature.featureKey === 'first_frame_image_batch') values.push('分镜组');
  if (feature.featureKey === 'tail_frame_image_batch') values.push('分镜组');
  if (feature.featureKey === 'video_prompt_batch_generate') values.push('分镜组');
  if (feature.featureKey === 'video_segment_batch_generate') values.push('视频段');
  if (feature.sourceTable === 'generation_batches') values.push('生成任务');
  if (feature.moduleKey === 'toolbox') values.push('工具箱');
  if (feature.sourceTable === 'exports') values.push('导出');
  if (feature.sourceTable === 'style_bible_runs') values.push('风格圣经');
  return values;
}

function countSql(sql: string, params: Record<string, unknown>) {
  const row = getDb().prepare<Record<string, unknown>, { count: number }>(sql).get(params);
  return Number(row?.count || 0);
}

function baseWhere(timeColumn: string, filters: TimeUsageFilters, ownerColumn: string) {
  const where = [`${timeColumn} >= @since`, `${timeColumn} < @until`];
  const params: Record<string, unknown> = {
    since: filters.since,
    until: filters.until,
  };
  if (filters.ownerId != null) {
    where.push(`${ownerColumn} = @ownerId`);
    params.ownerId = filters.ownerId;
  }
  return { where, params };
}

function matchesPostFilters(row: TimeUsageDetailRow, filters: TimeUsageFilters) {
  if (filters.moduleKey && row.moduleKey !== filters.moduleKey) return false;
  if (filters.featureKey && row.featureKey !== filters.featureKey) return false;
  if (filters.status && row.status !== filters.status && row.statusGroup !== filters.status) return false;
  if (filters.query) {
    const query = filters.query.toLowerCase();
    const haystack = [
      row.username,
      row.projectId,
      row.projectTitle,
      row.projectDisplay,
      row.moduleLabel,
      row.featureLabel,
      row.callItemId,
      row.callItemLabel,
      row.sourceId,
      row.provider,
      row.errorMessage,
    ].join(' ').toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function metricGroup(rows: TimeUsageDetailRow[]): TimeUsageMetricGroup {
  const waits = rows
    .map((row) => row.waitMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!waits.length) return { count: 0, avgWaitMs: null, p95WaitMs: null, maxWaitMs: null };
  const total = waits.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.max(0, Math.ceil(waits.length * 0.95) - 1);
  return {
    count: waits.length,
    avgWaitMs: Math.round(total / waits.length),
    p95WaitMs: waits[p95Index],
    maxWaitMs: waits[waits.length - 1],
  };
}

function maxWait(rows: TimeUsageDetailRow[]) {
  return rows.reduce((max, row) => Math.max(max, Number(row.waitMs || 0)), 0);
}

function pruneRowCache(now: number) {
  for (const [key, cached] of rowCache.entries()) {
    if (cached.expiresAt <= now) rowCache.delete(key);
  }
}

function waitMs(startedAt: string, endedAt: string | null, nowMs: number, isTerminal = false) {
  if (isTerminal && !endedAt) return null;
  const start = Date.parse(startedAt || '');
  const end = endedAt ? Date.parse(endedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round(end - start));
}

function compareTimeDesc(a: string, b: string) {
  const at = Date.parse(a || '');
  const bt = Date.parse(b || '');
  return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
}

function stableCacheKey(filters: TimeUsageFilters) {
  return JSON.stringify({
    since: filters.since,
    until: filters.until,
    ownerId: filters.ownerId ?? null,
    moduleKey: filters.moduleKey || '',
    featureKey: filters.featureKey || '',
    status: filters.status || '',
    query: filters.query || '',
  });
}

function sqlStringList(values: string[]) {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(',');
}

function escapeLike(value: string) {
  return value.replace(/[!%_]/g, (ch) => `!${ch}`);
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
