/**
 * 项目数据访问层（基于 SQLite）
 *
 * 项目的"宽数据"（剧本、资产、镜头、分镜、提示词、视频任务等）统一塞进 data_json 列。
 * 这样一来：
 *   - schema 简单（不需要 N 张子表）
 *   - 整个项目读一行就拿到全部，前端 saveProject() 直接整体覆盖
 *   - 后期需要做按字段查询时，再按需拆分
 *
 * 并发安全：
 *   - updateProjectForUser 把读 + 合并 + 写整体放进 db.transaction().immediate()，
 *     在同一事务内部再读一次最新 data_json 再合并，避免 TOCTOU 丢写。
 *   - 对于"读全项目 → 在 JS 里改数组某一项 → 写回"的典型模式（batch 执行器常用），
 *     应使用 patchProjectForUser(id, uid, patcher)：patcher 在事务里拿到最新数据，
 *     返回 patch 对象；这样多个 batch task 并发时每个都基于最新状态计算。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getDb, type ProjectRow } from './db';
import {
  buildFrameWorkflowNormalizationPatch,
  markTailFrameStaleForFirstFrameChange,
  maybeAssertStoryboardsAlignedWithShots,
} from './frame-workflow-state';
import { buildShotPlanDependencyPatch } from './project-dependency-state';
import { resolveStoryboardFirstFrameUrl } from './visual-reference-state';
import { maybeMarkStyleBibleStale } from './script-style-state';
import { dataPath } from './runtime-paths';

const STYLE_ASPECT_DEFAULT_VERSION = '2026-05-14-9x16';

const EMPTY_DATA = {
  oneSentence: '',
  scriptDraft: '',
  scriptAnalysis: null as any,
  styleBible: { vision: '', narrative: '', camera: '', mood: '', promptHabits: '' },
  styleOptions: { aspectRatio: '9:16', aspectRatioDefaultVersion: STYLE_ASPECT_DEFAULT_VERSION },
  styleBibleStatus: '',
  styleBibleError: '',
  styleBibleGeneratedAt: null as any,
  styleBibleSource: null as any,
  styleBibleRunId: null as any,
  styleBibleStartedAt: null as any,
  styleBibleGenerationContext: null as any,
  styleBibleSourceHash: null as any,
  styleBibleStaleReason: null as any,
  styleBibleStaleSince: null as any,
  styleBibleManuallyEditedAt: null as any,
  selectedWorldTemplateId: null as any,
  worldTemplateSnapshot: null as any,
  selectedStyleTemplateId: null as any,
  styleTemplateSnapshot: null as any,
  characters: [] as any[],
  environments: [] as any[],
  props: [] as any[],
  shots: [] as any[],
  storyboards: [] as any[],
  videoPrompts: [] as any[],
  videoTasks: [] as any[],
  episodes: [] as any[],
  preferences: null as any,
};

function normalizeProjectStyleDefaults(data: any) {
  const next = { ...(data || {}) };
  const styleOptions = { ...(next.styleOptions || {}) };
  if (!styleOptions.aspectRatioDefaultVersion) {
    if (!styleOptions.aspectRatio || styleOptions.aspectRatio === '16:9') {
      styleOptions.aspectRatio = '9:16';
    }
    styleOptions.aspectRatioDefaultVersion = STYLE_ASPECT_DEFAULT_VERSION;
  }
  next.styleOptions = styleOptions;
  return next;
}

const PROTECTED_ASSET_URL_KEYS = new Set([
  'imageUrl',
  'rawUrl',
  'realPhotoUrl',
  'pencilUrl',
  'coverUrl',
]);

function isEmptyAssetUrlValue(value: any) {
  return value === '' || value === null || typeof value === 'undefined';
}

function preserveExistingAssetUrls(existing: any, next: any) {
  if (!existing || !next || typeof existing !== 'object' || typeof next !== 'object') return;
  if (Array.isArray(existing) && Array.isArray(next)) {
    for (let i = 0; i < next.length; i += 1) preserveExistingAssetUrls(existing[i], next[i]);
    return;
  }
  if (Array.isArray(existing) || Array.isArray(next)) return;

  for (const key of Object.keys(next)) {
    if (PROTECTED_ASSET_URL_KEYS.has(key)) {
      if (isEmptyAssetUrlValue(next[key]) && !isEmptyAssetUrlValue(existing[key])) {
        next[key] = existing[key];
      }
      continue;
    }
    preserveExistingAssetUrls(existing[key], next[key]);
  }
}

const STYLE_BIBLE_LIFECYCLE_KEYS = [
  'styleBibleStatus',
  'styleBibleError',
  'styleBibleErrorCode',
  'styleBibleRunId',
  'styleBibleStartedAt',
  'styleBibleStage',
  'styleBibleProgress',
  'styleBibleNextRetryAt',
  'styleBibleHeartbeatAt',
] as const;

const STYLE_BIBLE_CONTENT_KEYS = [
  'styleBible',
  'styleBibleGeneratedAt',
  'styleBibleSource',
  'styleBibleSourceHash',
  'styleBibleGenerationContext',
  'styleBibleStaleReason',
  'styleBibleStaleSince',
  'styleBibleManuallyEditedAt',
] as const;

function preserveStyleBibleFields(existing: any, next: any, patch: any) {
  if (patch?.allowStyleBibleRunOverwrite === true) return;
  for (const key of [...STYLE_BIBLE_LIFECYCLE_KEYS, ...STYLE_BIBLE_CONTENT_KEYS]) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
      next[key] = existing?.[key] ?? null;
    }
  }
}

function rowToPublic(r: ProjectRow) {
  let data: any = {};
  try { data = JSON.parse(r.data_json || '{}'); } catch { data = {}; }
  const normalized = normalizeProjectStyleDefaults({
    ...EMPTY_DATA,
    ...data,
  });
  return {
    id: r.id,
    ownerId: r.owner_id,
    // 原站前端代码同时使用 name 与 title，两者保持同值供任意一处读取
    name: r.title,
    title: r.title,
    description: r.description,
    coverUrl: r.cover_url,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...normalized,
  };
}

function rowToSummary(r: ProjectRow) {
  return {
    id: r.id,
    name: r.title,
    title: r.title,
    description: r.description,
    coverUrl: r.cover_url,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function buildExportedEdlVersionBackfillPatch(project: any) {
  const editData = project?.editData;
  if (!editData || !editData.exportUrl) return null;
  if (typeof editData.exportedEdlVersion !== 'undefined') return null;
  const edlVersion = Number(editData?.edl?.version);
  if (!Number.isFinite(edlVersion)) return null;
  return {
    editData: {
      ...editData,
      exportedEdlVersion: edlVersion,
    },
  };
}

export function listProjectsByUser(userId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, ProjectRow>(
      'SELECT * FROM projects WHERE owner_id = @uid ORDER BY created_at DESC',
    )
    .all({ uid: userId });
  return rows.map(rowToSummary);
}

export function getProjectByIdForUser(id: string, userId: number) {
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, ProjectRow>(
      'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
    )
    .get({ id, uid: userId });
  if (!row) return null;
  const project = rowToPublic(row);
  const normalizationPatch = buildFrameWorkflowNormalizationPatch(project, userId);
  const backfillPatch = buildExportedEdlVersionBackfillPatch({
    ...project,
    ...(normalizationPatch || {}),
  });
  const combinedPatch = normalizationPatch || backfillPatch
    ? { ...(normalizationPatch || {}), ...(backfillPatch || {}) }
    : null;
  if (combinedPatch) {
    const applied = applyPatchToRow(row, combinedPatch);
    db.prepare(
      `UPDATE projects
       SET title = ?, description = ?, cover_url = ?, status = ?, data_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    ).run(applied.title, applied.description, applied.coverUrl, applied.status, applied.dataJson, id, userId);
    return {
      ...project,
      ...combinedPatch,
    };
  }
  return project;
}

export function createProjectForUser(userId: number, payload: any = {}) {
  const db = getDb();
  const id = (payload.id && typeof payload.id === 'string' && payload.id.length <= 100) ? payload.id : randomUUID();
  // 原站前端可能用 name 或 title 任一字段创建项目
  const title = (payload.name || payload.title || '未命名项目').toString().slice(0, 200);
  const description = (payload.description || '').toString().slice(0, 1000);
  const oneSentence = (payload.oneSentence || payload.idea || '').toString().slice(0, 2000);
  const data = {
    ...EMPTY_DATA,
    ...(payload || {}),
    oneSentence,
  };
  // 把 name/title/description/coverUrl/status/id 这些"列字段"从 data_json 里去掉，避免重复
  delete data.id;
  delete data.name;
  delete data.title;
  delete data.description;
  delete data.coverUrl;
  delete data.status;
  delete data.createdAt;
  delete data.updatedAt;
  delete data.ownerId;
  db.prepare(
    'INSERT INTO projects (id, owner_id, title, description, status, data_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, title, description, 'draft', JSON.stringify(data));
  return getProjectByIdForUser(id, userId)!;
}

function applyPatchToRow(existing: ProjectRow, patch: any): {
  title: string;
  description: string;
  coverUrl: string | null;
  status: string;
  dataJson: string;
} {
  let data: any = {};
  try { data = JSON.parse(existing.data_json || '{}'); } catch { data = {}; }
  const newData = { ...data, ...(patch || {}) };
	  const shouldPreserveAssetUrls = !patch?.allowEmptyAssetUrls;
	  if (shouldPreserveAssetUrls) preserveExistingAssetUrls(data, newData);
  preserveStyleBibleFields(data, newData, patch || {});
	  if (Object.prototype.hasOwnProperty.call(patch || {}, 'script')) {
	    const staleProbe = { ...data };
	    if (maybeMarkStyleBibleStale(staleProbe, newData.script, 'script_changed')) {
	      newData.styleBibleStaleReason = staleProbe.styleBibleStaleReason;
	      newData.styleBibleStaleSince = staleProbe.styleBibleStaleSince;
	    }
	  }

	  const title = patch.name ?? patch.title ?? existing.title;
  const description = patch.description ?? existing.description;
  const coverUrl = shouldPreserveAssetUrls
    && Object.prototype.hasOwnProperty.call(patch || {}, 'coverUrl')
    && isEmptyAssetUrlValue(patch.coverUrl)
    && !isEmptyAssetUrlValue(existing.cover_url)
    ? existing.cover_url
    : patch.coverUrl ?? existing.cover_url;
  const status = patch.status ?? existing.status;

  delete newData.id;
  delete newData.name;
  delete newData.title;
  delete newData.description;
  delete newData.coverUrl;
  delete newData.status;
  delete newData.createdAt;
  delete newData.updatedAt;
  delete newData.ownerId;
  delete newData.scriptLibrary;
  if (newData.scriptAnalysis && newData.scriptAnalysis.status === 'degraded') {
    delete newData.scriptAnalysis;
  }
  delete newData.allowEmptyAssetUrls;
  delete newData.allowStyleBibleRunOverwrite;

  return {
    title,
    description,
    coverUrl,
    status,
    dataJson: JSON.stringify(newData),
  };
}

function applyPutFirstFrameChangeGuard(current: any, patch: any): any {
  if (!Array.isArray(patch?.storyboards)) return patch;
  const currentStoryboards = Array.isArray(current?.storyboards) ? current.storyboards : [];
  const nextStoryboards = [...patch.storyboards];
  const nextVideoTasks = Array.isArray(patch?.videoTasks)
    ? [...patch.videoTasks]
    : (Array.isArray(current?.videoTasks) ? [...current.videoTasks] : []);
  let storyboardsChanged = false;
  let videoTasksChanged = false;

  for (let groupIdx = 0; groupIdx < nextStoryboards.length; groupIdx += 1) {
    const oldFirstFrameUrl = resolveStoryboardFirstFrameUrl(currentStoryboards[groupIdx] || {});
    const newFirstFrameUrl = resolveStoryboardFirstFrameUrl(nextStoryboards[groupIdx] || {});
    if (oldFirstFrameUrl === newFirstFrameUrl) continue;

    const nextStoryboard = markTailFrameStaleForFirstFrameChange(nextStoryboards[groupIdx] || {});
    if (nextStoryboard !== nextStoryboards[groupIdx]) {
      nextStoryboards[groupIdx] = nextStoryboard;
      storyboardsChanged = true;
    }
    if (nextVideoTasks[groupIdx]) {
      delete nextVideoTasks[groupIdx];
      videoTasksChanged = true;
    }
  }

  if (!storyboardsChanged && !videoTasksChanged) return patch;
  return {
    ...patch,
    ...(storyboardsChanged ? { storyboards: nextStoryboards } : {}),
    ...(videoTasksChanged ? { videoTasks: nextVideoTasks } : {}),
  };
}

function applyPutShotPlanDependencyGuard(current: any, patch: any): any {
  if (!patch || typeof patch !== 'object') return patch;
  const candidate = { ...(current || {}), ...(patch || {}) };
  const dependencyPatch = buildShotPlanDependencyPatch({
    current,
    candidate,
    changedPatch: patch,
  });
  return dependencyPatch ? { ...patch, ...dependencyPatch } : patch;
}

/**
 * 用 patch 覆盖/合并指定字段。在事务里重新读最新行再合并，防止 TOCTOU。
 * 注意：如果 patch 里的某个键是数组（如 storyboards），这里仍然是整体替换，
 *      和其他并发 writer 的数组修改之间仍然可能冲突——这类场景请用 patchProjectForUser。
 */
export function updateProjectForUser(id: string, userId: number, patch: any) {
  const db = getDb();
  let hit = false;
  const txn = db.transaction(() => {
    const existing = db
      .prepare<{ id: string; uid: number }, ProjectRow>(
        'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
      )
      .get({ id, uid: userId });
    if (!existing) return;
    hit = true;
    const current = rowToPublic(existing);
    const normalizationPatch = buildFrameWorkflowNormalizationPatch(current, userId);
    const normalizedCurrent = normalizationPatch ? { ...current, ...normalizationPatch } : current;
    const rawPatch = patch || {};
    const firstFrameGuardedPatch = applyPutFirstFrameChangeGuard(normalizedCurrent, rawPatch);
    const guardedPatch = applyPutShotPlanDependencyGuard(normalizedCurrent, firstFrameGuardedPatch);
    const combinedPatch = normalizationPatch ? { ...normalizationPatch, ...guardedPatch } : guardedPatch;
    const touchesFrameStructure = ['shots', 'storyboards', 'videoTasks'].some((key) => (
      Object.prototype.hasOwnProperty.call(combinedPatch, key)
    ));
    if (touchesFrameStructure) {
      maybeAssertStoryboardsAlignedWithShots(
        { ...normalizedCurrent, ...combinedPatch },
        'updateProjectForUser',
      );
    }
    const applied = applyPatchToRow(existing, combinedPatch);
    db.prepare(
      `UPDATE projects
       SET title = ?, description = ?, cover_url = ?, status = ?, data_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    ).run(applied.title, applied.description, applied.coverUrl, applied.status, applied.dataJson, id, userId);
  });
  txn.immediate();
  return hit ? getProjectByIdForUser(id, userId) : null;
}

/**
 * 读-改-写原子版：在事务内 SELECT 当前行，把解析出的项目对象交给 patcher，
 * patcher 返回 patch 对象（字段会浅合并到 data_json）。整个过程在 IMMEDIATE
 * 事务里完成，多个并发 batch task 串行化。
 *
 * 使用示例（批量执行器）：
 *   patchProjectForUser(projectId, userId, (current) => {
 *     const sbs = Array.isArray(current.storyboards) ? [...current.storyboards] : [];
 *     sbs[groupIdx] = { ...sbs[groupIdx], shotIndices: [groupIdx], imageUrl: url };
 *     return { storyboards: sbs };
 *   });
 */
export function patchProjectForUser(
  id: string,
  userId: number,
  patcher: (current: any) => any | null | undefined,
) {
  const db = getDb();
  let hit = false;
  const txn = db.transaction(() => {
    const existing = db
      .prepare<{ id: string; uid: number }, ProjectRow>(
        'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
      )
      .get({ id, uid: userId });
    if (!existing) return;
    hit = true;
    const current = rowToPublic(existing);
    const normalizationPatch = buildFrameWorkflowNormalizationPatch(current, userId);
    const normalizedCurrent = normalizationPatch ? { ...current, ...normalizationPatch } : current;
    const patch = patcher(normalizedCurrent) || {};
    const combinedPatch = normalizationPatch ? { ...normalizationPatch, ...patch } : patch;
    const touchesFrameStructure = ['shots', 'storyboards', 'videoTasks'].some((key) => (
      Object.prototype.hasOwnProperty.call(combinedPatch, key)
    ));
    if (touchesFrameStructure) {
      maybeAssertStoryboardsAlignedWithShots(
        { ...normalizedCurrent, ...combinedPatch },
        'patchProjectForUser',
      );
    }
    const applied = applyPatchToRow(existing, combinedPatch);
    db.prepare(
      `UPDATE projects
       SET title = ?, description = ?, cover_url = ?, status = ?, data_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    ).run(applied.title, applied.description, applied.coverUrl, applied.status, applied.dataJson, id, userId);
  });
  txn.immediate();
  return hit ? getProjectByIdForUser(id, userId) : null;
}

export function deleteProjectForUser(id: string, userId: number) {
  const db = getDb();
  const existing = db
    .prepare<{ id: string; uid: number }, { id: string }>(
      'SELECT id FROM projects WHERE id = @id AND owner_id = @uid',
    )
    .get({ id, uid: userId });
  if (!existing) return false;

  const imageRows = db
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT filename, style, asset_ref FROM images WHERE owner_id = @uid AND project_id = @pid`,
    )
    .all({ uid: userId, pid: id });
  const videoRows = db
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT id, filename FROM video_tasks WHERE owner_id = @uid AND project_id = @pid`,
    )
    .all({ uid: userId, pid: id });
  const uploadRows = db
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT filename FROM uploads WHERE owner_id = @uid AND project_id = @pid`,
    )
    .all({ uid: userId, pid: id });
  const exportRows = db
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT id, filename FROM exports WHERE owner_id = @uid AND project_id = @pid`,
    )
    .all({ uid: userId, pid: id });

  let deleted = false;
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM batch_tasks
       WHERE batch_id IN (SELECT id FROM batches WHERE owner_id = ? AND project_id = ?)`,
    ).run(userId, id);
    db.prepare('DELETE FROM batches WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM continuity_cache WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM style_bible_runs WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM script_library_items WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM images WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM video_tasks WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM uploads WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM exports WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM project_knowledge_contexts WHERE owner_id = ? AND project_id = ?').run(userId, id);
    // Keep derived world templates: they may be reused by other projects. Only sever provenance.
    db.prepare('UPDATE world_templates SET source_project_id = NULL WHERE owner_id = ? AND source_project_id = ?').run(userId, id);
    const info = db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, userId);
    deleted = info.changes > 0;
  });
  txn.immediate();
  if (!deleted) return false;

  const files = new Set<string>();
  const addFile = (bucket: string, filename: any) => {
    const name = String(filename || '').trim();
    if (!name) return;
    files.add(`${bucket}\u0000${name}`);
  };

  for (const row of imageRows) {
    const isVideoCover = row?.style === 'video-cover' || String(row?.asset_ref || '').startsWith('video-cover/');
    addFile(isVideoCover ? 'videos' : 'images', row?.filename);
  }
  for (const row of videoRows) {
    addFile('videos', row?.filename);
    addFile('videos', row?.id ? `${row.id}.cover.png` : '');
  }
  for (const row of uploadRows) addFile('uploads', row?.filename);
  for (const row of exportRows) {
    addFile('exports', row?.filename);
    if (row?.id) {
      addFile('exports', `${row.id}.concat.mp4`);
      addFile('exports', `${row.id}.subbed.mp4`);
      addFile('exports', `${row.id}.sfx.mp4`);
      addFile('exports', `${row.id}.srt`);
    }
  }

  for (const key of files) {
    const [bucket, filename] = key.split('\u0000');
    unlinkProjectDataFile(bucket, userId, filename);
  }

  return true;
}

function unlinkProjectDataFile(bucket: string, userId: number, filename: string) {
  const base = resolve(dataPath(bucket, String(userId)));
  const target = resolve(base, filename);
  if (target === base || !target.startsWith(base + sep)) {
    console.warn('[ProjectDelete] Skip unsafe file path:', bucket, filename);
    return;
  }
  try {
    if (existsSync(target)) unlinkSync(target);
  } catch (e) {
    console.warn('[ProjectDelete] Failed to remove file:', target, e);
  }
}
