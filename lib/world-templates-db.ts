import { randomUUID } from 'node:crypto';
import { getDb } from './db';

type WorldTemplateRow = {
  id: string;
  owner_id: number;
  name: string;
  source_project_id: string | null;
  cover_image_id: string | null;
  schema_version: number;
  source: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

function cleanId(value: any) {
  const id = String(value || '').trim();
  if (id && id.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(id)) return id;
  return `tpl_${randomUUID()}`;
}

function cleanString(value: any, max: number) {
  return String(value || '').trim().slice(0, max);
}

function parseData(row: WorldTemplateRow) {
  try { return JSON.parse(row.data_json || '{}'); } catch { return {}; }
}

function rowToPublic(row: WorldTemplateRow) {
  const data = parseData(row);
  return {
    ...data,
    id: row.id,
    name: row.name,
    sourceProjectId: row.source_project_id || data.sourceProjectId || null,
    coverImageId: row.cover_image_id || data.coverImageId || null,
    schemaVersion: row.schema_version || data.schemaVersion || 1,
    source: row.source || data.source || 'user',
    createdAt: data.createdAt || row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: WorldTemplateRow) {
  const data = parseData(row);
  const characters = Array.isArray(data.characters) ? data.characters : [];
  const characterPreviewUrls = characters
    .map((ch: any) => ch?.realPhotoUrl || ch?.rawUrl || ch?.imageUrl || ch?.pencilUrl || '')
    .filter(Boolean)
    .slice(0, 4);
  return {
    id: row.id,
    name: row.name,
    sourceProjectId: row.source_project_id || data.sourceProjectId || null,
    coverImageId: row.cover_image_id || data.coverImageId || null,
    coverImageUrl: data.coverImageUrl || characterPreviewUrls[0] || null,
    schemaVersion: row.schema_version || data.schemaVersion || 1,
    source: row.source || data.source || 'user',
    migrationKey: data.migrationKey || templateFingerprint(data),
    characterCount: characters.length,
    characterPreviewUrls,
    hasStyleBible: !!data.styleBible,
    createdAt: data.createdAt || row.created_at,
    updatedAt: row.updated_at,
    summaryOnly: true,
  };
}

function stableTemplateValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableTemplateValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    const v = stableTemplateValue(value[key]);
    if (typeof v !== 'undefined') out[key] = v;
  }
  return out;
}

function templateFingerprint(input: any) {
  const root = { ...(input && typeof input === 'object' ? input : {}) };
  for (const key of [
    'id',
    'createdAt',
    'updatedAt',
    'created_at',
    'updated_at',
    'source',
    'legacyId',
    'migrationKey',
    'schemaVersion',
    'schema_version',
  ]) {
    delete root[key];
  }
  let h = 2166136261;
  const text = JSON.stringify(stableTemplateValue(root));
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function normalizeTemplate(input: any) {
  const raw = input && typeof input === 'object' ? input : {};
  const id = cleanId(raw.id);
  const name = cleanString(raw.name || raw.title || '未命名世界观模板', 120) || '未命名世界观模板';
  const sourceProjectId = cleanString(raw.sourceProjectId || raw.source_project_id || raw.projectId || '', 120) || null;
  const coverImageId = cleanString(raw.coverImageId || raw.cover_image_id || '', 120) || null;
  const schemaVersion = Math.max(1, Math.min(99, Number(raw.schemaVersion || raw.schema_version || 1) || 1));
  const source = cleanString(raw.source || 'user', 80) || 'user';
  const data = {
    ...raw,
    id,
    name,
    sourceProjectId,
    coverImageId,
    schemaVersion,
    source,
  };
  return { id, name, sourceProjectId, coverImageId, schemaVersion, source, data };
}

function resolveCoverImageId(userId: number, coverImageId: string | null) {
  if (!coverImageId) return null;
  const row = getDb()
    .prepare<{ id: string; uid: number }, { id: string }>(
      'SELECT id FROM images WHERE id = @id AND owner_id = @uid LIMIT 1',
    )
    .get({ id: coverImageId, uid: userId });
  return row ? coverImageId : null;
}

export function listWorldTemplates(userId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, WorldTemplateRow>(
      `SELECT * FROM world_templates WHERE owner_id = @uid ORDER BY updated_at DESC, created_at DESC`,
    )
    .all({ uid: userId });
  return rows.map(rowToPublic);
}

export function listWorldTemplateSummaries(userId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, WorldTemplateRow>(
      `SELECT * FROM world_templates WHERE owner_id = @uid ORDER BY updated_at DESC, created_at DESC`,
    )
    .all({ uid: userId });
  return rows.map(rowToSummary);
}

export function getWorldTemplate(userId: number, id: string) {
  const db = getDb();
  const row = db
    .prepare<{ uid: number; id: string }, WorldTemplateRow>(
      `SELECT * FROM world_templates WHERE owner_id = @uid AND id = @id`,
    )
    .get({ uid: userId, id });
  return row ? rowToPublic(row) : null;
}

export function upsertWorldTemplate(userId: number, input: any) {
  const tpl = normalizeTemplate(input);
  const db = getDb();
  const coverImageId = resolveCoverImageId(userId, tpl.coverImageId);
  const data = { ...tpl.data, coverImageId };
  db.prepare(
    `INSERT INTO world_templates
       (id, owner_id, name, source_project_id, cover_image_id, schema_version, source, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, id) DO UPDATE SET
       name = excluded.name,
       source_project_id = excluded.source_project_id,
       cover_image_id = excluded.cover_image_id,
       schema_version = excluded.schema_version,
       source = excluded.source,
       data_json = excluded.data_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    tpl.id,
    userId,
    tpl.name,
    tpl.sourceProjectId,
    coverImageId,
    tpl.schemaVersion,
    tpl.source,
    JSON.stringify(data),
  );
  return getWorldTemplate(userId, tpl.id)!;
}

export function deleteWorldTemplate(userId: number, id: string) {
  const db = getDb();
  const info = db
    .prepare('DELETE FROM world_templates WHERE owner_id = ? AND id = ?')
    .run(userId, id);
  return info.changes > 0;
}
