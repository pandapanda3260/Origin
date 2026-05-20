import { randomUUID } from 'node:crypto';
import { getDb } from './db';

type StyleTemplateRow = {
  id: string;
  owner_id: number | null;
  name: string;
  category: string;
  summary: string;
  data_json: string;
  source: string;
  created_at: string;
  updated_at: string;
};

type MappingRow = {
  world_template_owner_id: number;
  world_template_id: string;
  style_template_id: string;
};

function cleanId(value: any, fallbackPrefix = 'style') {
  const id = String(value || '').trim();
  if (id && id.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(id)) return id;
  return `${fallbackPrefix}_${randomUUID()}`;
}

function cleanString(value: any, max: number) {
  return String(value ?? '').trim().slice(0, max);
}

function parseData(row: StyleTemplateRow) {
  try { return JSON.parse(row.data_json || '{}'); } catch { return {}; }
}

function normalizeTemplateInput(input: any, forced: { ownerId: number | null; source: 'system' | 'user' }) {
  const raw = input && typeof input === 'object' ? input : {};
  const id = cleanId(raw.id);
  const name = cleanString(raw.name || raw.title || '未命名风格模板', 120) || '未命名风格模板';
  const category = cleanString(raw.category || '', 120);
  const summary = cleanString(raw.summary || raw.description || '', 500);
  const data = {
    ...raw,
    id,
    name,
    category,
    summary,
    source: forced.source,
    ownerId: forced.ownerId,
  };
  delete data.owner_id;
  return { id, name, category, summary, data, ownerId: forced.ownerId, source: forced.source };
}

function rowToPublic(row: StyleTemplateRow) {
  const data = parseData(row);
  return {
    ...data,
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    category: row.category || data.category || '',
    summary: row.summary || data.summary || '',
    source: row.source || data.source || 'user',
    createdAt: data.createdAt || row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listStyleTemplates(userId: number) {
  const rows = getDb()
    .prepare<{ uid: number }, StyleTemplateRow>(
      `SELECT * FROM style_templates
       WHERE source = 'system' OR owner_id = @uid
       ORDER BY CASE WHEN source = 'system' THEN 0 ELSE 1 END, updated_at DESC, name ASC`,
    )
    .all({ uid: userId });
  return rows.map(rowToPublic);
}

export function getStyleTemplateForUser(userId: number, id: string) {
  const row = getDb()
    .prepare<{ id: string; uid: number }, StyleTemplateRow>(
      `SELECT * FROM style_templates
       WHERE id = @id AND (source = 'system' OR owner_id = @uid)
       LIMIT 1`,
    )
    .get({ id, uid: userId });
  return row ? rowToPublic(row) : null;
}

function getStyleTemplateRow(id: string) {
  return getDb()
    .prepare<{ id: string }, StyleTemplateRow>('SELECT * FROM style_templates WHERE id = @id LIMIT 1')
    .get({ id });
}

export function createUserStyleTemplate(userId: number, input: any) {
  const tpl = normalizeTemplateInput(input, { ownerId: userId, source: 'user' });
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO style_templates
         (id, owner_id, name, category, summary, data_json, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
    )
    .run(tpl.id, userId, tpl.name, tpl.category, tpl.summary, JSON.stringify(tpl.data), now, now);
  return getStyleTemplateForUser(userId, tpl.id)!;
}

export function updateUserStyleTemplate(userId: number, id: string, input: any) {
  const row = getStyleTemplateRow(id);
  if (!row) return { error: 'not_found' as const };
  if (row.source === 'system' || row.owner_id !== userId) return { error: 'forbidden' as const };

  const current = rowToPublic(row);
  const raw = input && typeof input === 'object' ? input : {};
  const name = cleanString(raw.name ?? current.name, 120) || current.name;
  const category = cleanString(raw.category ?? current.category, 120);
  const summary = cleanString(raw.summary ?? current.summary, 500);
  const data = {
    ...current,
    ...raw,
    id,
    name,
    category,
    summary,
    source: 'user',
    ownerId: userId,
  };
  delete data.owner_id;
  getDb()
    .prepare(
      `UPDATE style_templates
       SET name = ?, category = ?, summary = ?, data_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    )
    .run(name, category, summary, JSON.stringify(data), id, userId);
  return { template: getStyleTemplateForUser(userId, id)! };
}

export function deleteUserStyleTemplate(userId: number, id: string) {
  const row = getStyleTemplateRow(id);
  if (!row) return { error: 'not_found' as const };
  if (row.source === 'system' || row.owner_id !== userId) return { error: 'forbidden' as const };
  getDb().prepare('DELETE FROM style_templates WHERE id = ? AND owner_id = ?').run(id, userId);
  return { ok: true as const };
}

function normalizeWorldOwnerId(userId: number, value: any) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : userId;
}

function assertWorldTemplateExists(worldOwnerId: number, worldTemplateId: string) {
  const row = getDb()
    .prepare<{ owner: number; id: string }, { id: string }>(
      'SELECT id FROM world_templates WHERE owner_id = @owner AND id = @id LIMIT 1',
    )
    .get({ owner: worldOwnerId, id: worldTemplateId });
  return !!row;
}

export function setDefaultWorldStyleMapping(opts: {
  worldTemplateOwnerId: number;
  worldTemplateId: string;
  styleTemplateId: string;
}) {
  const worldTemplateId = cleanString(opts.worldTemplateId, 100);
  const styleTemplateId = cleanString(opts.styleTemplateId, 100);
  if (!worldTemplateId || !styleTemplateId) return { error: 'invalid' as const };
  if (!assertWorldTemplateExists(opts.worldTemplateOwnerId, worldTemplateId)) return { error: 'world_not_found' as const };
  const style = getStyleTemplateRow(styleTemplateId);
  if (!style) return { error: 'style_not_found' as const };
  if (style.source !== 'system') return { error: 'style_not_system' as const };

  const db = getDb();
  const id = cleanId(`default_${opts.worldTemplateOwnerId}_${worldTemplateId}_${styleTemplateId}`, 'map');
  db.transaction(() => {
    db.prepare(
      `UPDATE world_style_default_mappings
       SET is_default = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE world_template_owner_id = ? AND world_template_id = ? AND is_default = 1`,
    ).run(opts.worldTemplateOwnerId, worldTemplateId);
    db.prepare(
      `INSERT INTO world_style_default_mappings
         (id, world_template_owner_id, world_template_id, style_template_id, is_default)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         style_template_id = excluded.style_template_id,
         is_default = 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(id, opts.worldTemplateOwnerId, worldTemplateId, styleTemplateId);
  })();
  return { ok: true as const };
}

export function setRecentWorldStyleMapping(userId: number, opts: {
  worldTemplateOwnerId?: number;
  worldTemplateId: string;
  styleTemplateId: string;
}) {
  const worldTemplateOwnerId = normalizeWorldOwnerId(userId, opts.worldTemplateOwnerId);
  const worldTemplateId = cleanString(opts.worldTemplateId, 100);
  const styleTemplateId = cleanString(opts.styleTemplateId, 100);
  if (!worldTemplateId || !styleTemplateId) return { error: 'invalid' as const };
  if (!assertWorldTemplateExists(worldTemplateOwnerId, worldTemplateId)) return { error: 'world_not_found' as const };
  if (!getStyleTemplateForUser(userId, styleTemplateId)) return { error: 'style_not_found' as const };

  getDb()
    .prepare(
      `INSERT INTO user_world_style_recent_mappings
         (user_id, world_template_owner_id, world_template_id, style_template_id, last_used_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, world_template_owner_id, world_template_id) DO UPDATE SET
         style_template_id = excluded.style_template_id,
         last_used_at = excluded.last_used_at`,
    )
    .run(userId, worldTemplateOwnerId, worldTemplateId, styleTemplateId, new Date().toISOString());
  return { ok: true as const };
}

function getRecentMapping(userId: number, worldOwnerId: number, worldTemplateId: string) {
  return getDb()
    .prepare<{ uid: number; owner: number; id: string }, MappingRow>(
      `SELECT world_template_owner_id, world_template_id, style_template_id
       FROM user_world_style_recent_mappings
       WHERE user_id = @uid AND world_template_owner_id = @owner AND world_template_id = @id
       LIMIT 1`,
    )
    .get({ uid: userId, owner: worldOwnerId, id: worldTemplateId });
}

function getDefaultMapping(worldOwnerId: number, worldTemplateId: string) {
  return getDb()
    .prepare<{ owner: number; id: string }, MappingRow>(
      `SELECT world_template_owner_id, world_template_id, style_template_id
       FROM world_style_default_mappings
       WHERE world_template_owner_id = @owner AND world_template_id = @id AND is_default = 1
       LIMIT 1`,
    )
    .get({ owner: worldOwnerId, id: worldTemplateId });
}

export function recommendStyleTemplateForWorld(userId: number, input: {
  worldTemplateId: string;
  worldTemplateOwnerId?: number;
}) {
  const worldTemplateId = cleanString(input.worldTemplateId, 100);
  const worldTemplateOwnerId = normalizeWorldOwnerId(userId, input.worldTemplateOwnerId);
  if (!worldTemplateId) return { source: 'none' as const, styleTemplate: null };

  const recent = getRecentMapping(userId, worldTemplateOwnerId, worldTemplateId);
  if (recent) {
    const styleTemplate = getStyleTemplateForUser(userId, recent.style_template_id);
    if (styleTemplate) return { source: 'user_recent' as const, styleTemplate };
  }

  const globalDefault = getDefaultMapping(worldTemplateOwnerId, worldTemplateId);
  if (globalDefault) {
    const styleTemplate = getStyleTemplateForUser(userId, globalDefault.style_template_id);
    if (styleTemplate) return { source: 'global_default' as const, styleTemplate };
  }

  return { source: 'none' as const, styleTemplate: null };
}

