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
import { getDb, type ProjectRow } from './db';

const EMPTY_DATA = {
  oneSentence: '',
  scriptDraft: '',
  styleBible: { vision: '', narrative: '', camera: '', mood: '', promptHabits: '' },
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

function rowToPublic(r: ProjectRow) {
  let data: any = {};
  try { data = JSON.parse(r.data_json || '{}'); } catch { data = {}; }
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
    ...EMPTY_DATA,
    ...data,
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

export function listProjectsByUser(userId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, ProjectRow>(
      'SELECT * FROM projects WHERE owner_id = @uid ORDER BY updated_at DESC',
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
  return row ? rowToPublic(row) : null;
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
  delete newData.allowEmptyAssetUrls;

  return {
    title,
    description,
    coverUrl,
    status,
    dataJson: JSON.stringify(newData),
  };
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
    const applied = applyPatchToRow(existing, patch || {});
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
 *     while (sbs.length <= groupIdx) sbs.push({});
 *     sbs[groupIdx] = { ...sbs[groupIdx], imageUrl: url };
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
    const patch = patcher(current) || {};
    const applied = applyPatchToRow(existing, patch);
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
  const info = db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, userId);
  return info.changes > 0;
}
