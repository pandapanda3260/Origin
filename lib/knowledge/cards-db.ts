import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import type { KnowledgeCard, KnowledgeCardInput, KnowledgeCardQueryOptions } from './types';

type KnowledgeCardRow = {
  id: string;
  owner_id: number | null;
  scope: 'system' | 'user';
  module: string;
  card_type: string;
  title: string;
  status: string;
  lifecycle: string;
  priority: number;
  tags_json: string;
  data_json: string;
  source_ref_json: string;
  schema_version: number;
  version: number;
  published_at: string | null;
  published_by: number | null;
  previous_version_id: string | null;
  seeded_at: string | null;
  created_at: string;
  updated_at: string;
};

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    return [];
  }
}

function toCard(row: KnowledgeCardRow): KnowledgeCard {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scope: row.scope,
    module: row.module,
    cardType: row.card_type,
    title: row.title,
    status: row.status,
    lifecycle: row.lifecycle || 'published',
    priority: row.priority,
    tags: parseStringArray(row.tags_json),
    data: parseObject(row.data_json),
    sourceRef: parseObject(row.source_ref_json),
    schemaVersion: row.schema_version || 1,
    version: row.version || 1,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    previousVersionId: row.previous_version_id,
    seededAt: row.seeded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  return Array.from(new Set((tags || []).map((tag) => tag.trim()).filter(Boolean))).sort();
}

function queryLimit(opts?: KnowledgeCardQueryOptions): number {
  const limit = Number(opts?.limit || 50);
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

export function listSystemAndUserCards(
  ownerId: number,
  module: string,
  opts?: KnowledgeCardQueryOptions,
): KnowledgeCard[] {
  const db = getDb();
  const statusClause = opts?.includeInactive ? '' : "AND status = 'active'";
  const lifecycleClause = opts?.includeInactive ? '' : "AND lifecycle = 'published'";
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_cards
       WHERE module = ?
         ${statusClause}
         ${lifecycleClause}
         AND (
           (scope = 'system' AND owner_id IS NULL)
           OR (scope = 'user' AND owner_id = ?)
         )
       ORDER BY priority ASC, version DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(module, ownerId, queryLimit(opts)) as KnowledgeCardRow[];

  const byId = new Map<string, KnowledgeCard>();
  for (const card of rows.map(toCard)) {
    if (!byId.has(card.id)) byId.set(card.id, card);
  }
  return Array.from(byId.values());
}

export function listCardsByModuleAndTag(
  ownerId: number,
  module: string,
  tag: string,
  opts?: KnowledgeCardQueryOptions,
): KnowledgeCard[] {
  return listSystemAndUserCards(ownerId, module, opts).filter((card) => card.tags.includes(tag));
}

export function getUserCard(ownerId: number, id: string): KnowledgeCard | null {
  if (!ownerId || !id) return null;
  const row = getDb()
    .prepare('SELECT * FROM knowledge_cards WHERE id = ? AND owner_id = ? AND scope = ?')
    .get(id, ownerId, 'user') as KnowledgeCardRow | undefined;
  return row ? toCard(row) : null;
}

export function listArchivedUserCards(ownerId: number, module: string, opts?: KnowledgeCardQueryOptions): KnowledgeCard[] {
  if (!ownerId) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_cards
       WHERE scope = 'user'
         AND owner_id = ?
         AND module = ?
         AND lifecycle = 'archived'
       ORDER BY priority ASC, version DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(ownerId, module, queryLimit(opts)) as KnowledgeCardRow[];
  return rows.map(toCard);
}

export function upsertUserCard(ownerId: number, input: KnowledgeCardInput): KnowledgeCard {
  if (!ownerId) throw new Error('upsertUserCard requires ownerId');
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id || `user-card-${randomUUID()}`;
  const existing = db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get(id) as KnowledgeCardRow | undefined;
  if (existing && (existing.scope !== 'user' || existing.owner_id !== ownerId)) {
    throw new Error(`knowledge card ${id} is not writable by this user`);
  }
  db.prepare(
    `INSERT INTO knowledge_cards
       (id, owner_id, scope, module, card_type, title, status, lifecycle, priority,
        tags_json, data_json, source_ref_json, schema_version, version, created_at, updated_at)
     VALUES
       (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       module = excluded.module,
       card_type = excluded.card_type,
       title = excluded.title,
       status = excluded.status,
       lifecycle = excluded.lifecycle,
       priority = excluded.priority,
       tags_json = excluded.tags_json,
       data_json = excluded.data_json,
       source_ref_json = excluded.source_ref_json,
       schema_version = excluded.schema_version,
       version = knowledge_cards.version + 1,
       updated_at = excluded.updated_at
     WHERE knowledge_cards.scope = 'user' AND knowledge_cards.owner_id = excluded.owner_id`,
  ).run(
    id,
    ownerId,
    input.module,
    input.cardType,
    input.title,
    input.status || 'active',
    input.lifecycle || 'published',
    input.priority ?? 100,
    JSON.stringify(normalizeTags(input.tags)),
    JSON.stringify(input.data || {}),
    JSON.stringify(input.sourceRef || {}),
    input.schemaVersion || 1,
    input.version || 1,
    now,
    now,
  );
  const row = db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get(id) as KnowledgeCardRow;
  return toCard(row);
}

export function deleteUserCard(ownerId: number, id: string): boolean {
  if (!ownerId) throw new Error('deleteUserCard requires ownerId');
  const db = getDb();
  const result = db
    .prepare("DELETE FROM knowledge_cards WHERE id = ? AND owner_id = ? AND scope = 'user'")
    .run(id, ownerId);
  return result.changes > 0;
}
