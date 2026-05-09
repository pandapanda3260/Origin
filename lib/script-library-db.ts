import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';

type ScriptLibraryRow = {
  id: string;
  owner_id: number;
  project_id: string;
  name: string;
  content: string;
  content_hash: string;
  source: string;
  schema_version: number;
  meta_json: string;
  created_at: string;
  updated_at: string;
};

function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function cleanString(value: any, max: number) {
  return String(value || '').trim().slice(0, max);
}

function parseMeta(row: ScriptLibraryRow) {
  try { return JSON.parse(row.meta_json || '{}'); } catch { return {}; }
}

function rowToPublic(row: ScriptLibraryRow) {
  const meta = parseMeta(row);
  return {
    ...meta,
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    content: row.content,
    source: row.source,
    schemaVersion: row.schema_version || 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertProjectForUser(projectId: string, userId: number) {
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, { id: string }>(
      'SELECT id FROM projects WHERE id = @id AND owner_id = @uid',
    )
    .get({ id: projectId, uid: userId });
  return !!row;
}

export function listScriptLibraryItems(userId: number, projectId: string) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number; pid: string }, ScriptLibraryRow>(
      `SELECT * FROM script_library_items
       WHERE owner_id = @uid AND project_id = @pid
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 100`,
    )
    .all({ uid: userId, pid: projectId });
  return rows.map(rowToPublic);
}

export function upsertScriptLibraryItem(userId: number, projectId: string, input: any) {
  if (!assertProjectForUser(projectId, userId)) return null;
  const content = cleanString(input?.content, 200_000);
  if (!content) {
    const err: any = new Error('剧本内容不能为空');
    err.status = 400;
    throw err;
  }
  const name = cleanString(input?.name || input?.title || '未命名剧本', 60) || '未命名剧本';
  const source = cleanString(input?.source || 'generated', 40) || 'generated';
  const schemaVersion = Math.max(1, Math.min(99, Number(input?.schemaVersion || input?.schema_version || 1) || 1));
  const id = cleanString(input?.id, 100) || `script_${randomUUID()}`;
  const contentHash = hashContent(content);
  const meta = {
    ...(input?.styleBible ? { styleBible: input.styleBible } : {}),
    ...(input?.meta && typeof input.meta === 'object' ? input.meta : {}),
  };
  const db = getDb();
  const finalId = db.transaction(() => {
    let itemId = id;
    const existingById = db
      .prepare<{ uid: number; id: string }, ScriptLibraryRow>(
        `SELECT * FROM script_library_items WHERE owner_id = @uid AND id = @id`,
      )
      .get({ uid: userId, id: itemId });
    const existingByHash = db
      .prepare<{ uid: number; pid: string; h: string }, ScriptLibraryRow>(
        `SELECT * FROM script_library_items
         WHERE owner_id = @uid AND project_id = @pid AND content_hash = @h`,
      )
      .get({ uid: userId, pid: projectId, h: contentHash });

    if (existingById && existingById.project_id === projectId) {
      if (existingByHash && existingByHash.id !== itemId) {
        db.prepare('DELETE FROM script_library_items WHERE owner_id = ? AND project_id = ? AND id = ?')
          .run(userId, projectId, itemId);
        db.prepare(
          `UPDATE script_library_items
           SET name = ?, source = ?, schema_version = ?, meta_json = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE owner_id = ? AND project_id = ? AND id = ?`,
        ).run(name, source, schemaVersion, JSON.stringify(meta), userId, projectId, existingByHash.id);
        itemId = existingByHash.id;
      } else {
        db.prepare(
          `UPDATE script_library_items
           SET name = ?, content = ?, content_hash = ?, source = ?, schema_version = ?, meta_json = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE owner_id = ? AND project_id = ? AND id = ?`,
        ).run(name, content, contentHash, source, schemaVersion, JSON.stringify(meta), userId, projectId, itemId);
      }
    } else {
      if (existingById && existingById.project_id !== projectId) {
        itemId = `script_${randomUUID()}`;
      }
      db.prepare(
        `INSERT INTO script_library_items
           (id, owner_id, project_id, name, content, content_hash, source, schema_version, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, project_id, content_hash) DO UPDATE SET
           name = excluded.name,
           source = excluded.source,
           schema_version = excluded.schema_version,
           meta_json = excluded.meta_json,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(itemId, userId, projectId, name, content, contentHash, source, schemaVersion, JSON.stringify(meta));
      const rowByHash = db
        .prepare<{ uid: number; pid: string; h: string }, ScriptLibraryRow>(
          `SELECT * FROM script_library_items
           WHERE owner_id = @uid AND project_id = @pid AND content_hash = @h`,
        )
        .get({ uid: userId, pid: projectId, h: contentHash });
      itemId = rowByHash?.id || itemId;
    }

    // Keep the project-level library bounded. The frontend already expects 100.
    db.prepare(
      `DELETE FROM script_library_items
       WHERE owner_id = ? AND project_id = ? AND id NOT IN (
         SELECT id FROM script_library_items
         WHERE owner_id = ? AND project_id = ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 100
       )`,
    ).run(userId, projectId, userId, projectId);

    return itemId;
  }).immediate();

  const row = db
    .prepare<{ uid: number; pid: string; id: string }, ScriptLibraryRow>(
      `SELECT * FROM script_library_items
       WHERE owner_id = @uid AND project_id = @pid AND id = @id`,
    )
    .get({ uid: userId, pid: projectId, id: finalId });
  return row ? rowToPublic(row) : null;
}

export function updateScriptLibraryItem(userId: number, projectId: string, itemId: string, input: any) {
  if (!assertProjectForUser(projectId, userId)) return null;
  const db = getDb();
  const existing = db
    .prepare<{ uid: number; pid: string; id: string }, ScriptLibraryRow>(
      `SELECT * FROM script_library_items
       WHERE owner_id = @uid AND project_id = @pid AND id = @id`,
    )
    .get({ uid: userId, pid: projectId, id: itemId });
  if (!existing) return null;

  const meta = parseMeta(existing);
  if (input?.styleBible) meta.styleBible = input.styleBible;
  if (input?.meta && typeof input.meta === 'object') Object.assign(meta, input.meta);
  const name = input?.name == null
    ? existing.name
    : (cleanString(input.name, 60) || existing.name);
  db.prepare(
    `UPDATE script_library_items
     SET name = ?, meta_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE owner_id = ? AND project_id = ? AND id = ?`,
  ).run(name, JSON.stringify(meta), userId, projectId, itemId);
  const row = db
    .prepare<{ uid: number; pid: string; id: string }, ScriptLibraryRow>(
      `SELECT * FROM script_library_items
       WHERE owner_id = @uid AND project_id = @pid AND id = @id`,
    )
    .get({ uid: userId, pid: projectId, id: itemId });
  return row ? rowToPublic(row) : null;
}

export function deleteScriptLibraryItem(userId: number, projectId: string, itemId: string) {
  if (!assertProjectForUser(projectId, userId)) return false;
  const info = getDb()
    .prepare('DELETE FROM script_library_items WHERE owner_id = ? AND project_id = ? AND id = ?')
    .run(userId, projectId, itemId);
  return info.changes > 0;
}
