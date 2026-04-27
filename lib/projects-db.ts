/**
 * 项目数据访问层（基于 SQLite）
 *
 * 项目的"宽数据"（剧本、资产、镜头、分镜、提示词、视频任务等）统一塞进 data_json 列。
 * 这样一来：
 *   - schema 简单（不需要 N 张子表）
 *   - 整个项目读一行就拿到全部，前端 saveProject() 直接整体覆盖
 *   - 后期需要做按字段查询时，再按需拆分
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

export function updateProjectForUser(id: string, userId: number, patch: any) {
  const db = getDb();
  const existing = db
    .prepare<{ id: string; uid: number }, ProjectRow>(
      'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
    )
    .get({ id, uid: userId });
  if (!existing) return null;

  let data: any = {};
  try { data = JSON.parse(existing.data_json || '{}'); } catch { data = {}; }
  // 浅合并：上层每次保存都把整个项目对象传过来
  const newData = { ...data, ...(patch || {}) };

  // name 和 title 同义，任一传入都更新到 title 列
  const title = patch.name ?? patch.title ?? existing.title;
  const description = patch.description ?? existing.description;
  const coverUrl = patch.coverUrl ?? existing.cover_url;
  const status = patch.status ?? existing.status;

  // 把列字段从 data_json 里清掉
  delete newData.id;
  delete newData.name;
  delete newData.title;
  delete newData.description;
  delete newData.coverUrl;
  delete newData.status;
  delete newData.createdAt;
  delete newData.updatedAt;
  delete newData.ownerId;

  db.prepare(
    `UPDATE projects
     SET title = ?, description = ?, cover_url = ?, status = ?, data_json = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND owner_id = ?`,
  ).run(title, description, coverUrl, status, JSON.stringify(newData), id, userId);

  return getProjectByIdForUser(id, userId);
}

export function deleteProjectForUser(id: string, userId: number) {
  const db = getDb();
  const info = db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, userId);
  return info.changes > 0;
}
