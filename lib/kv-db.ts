/**
 * 通用按用户键值存储（user_settings / user_profiles 共用）
 */
import { getDb } from './db';

type Table = 'user_settings' | 'user_profiles';

export function getJson<T = any>(table: Table, userId: number, fallback: T): T {
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, { data_json: string }>(
      `SELECT data_json FROM ${table} WHERE user_id = @uid`,
    )
    .get({ uid: userId });
  if (!row) return fallback;
  try { return JSON.parse(row.data_json) as T; } catch { return fallback; }
}

export function setJson<T = any>(table: Table, userId: number, data: T) {
  const db = getDb();
  const json = JSON.stringify(data ?? {});
  db.prepare(
    `INSERT INTO ${table} (user_id, data_json, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id) DO UPDATE SET
       data_json = excluded.data_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(userId, json);
  return data;
}

export function patchJson<T extends Record<string, any>>(
  table: Table,
  userId: number,
  patch: Partial<T>,
  fallback: T,
): T {
  const cur = getJson(table, userId, fallback);
  const merged = { ...cur, ...patch } as T;
  setJson(table, userId, merged);
  return merged;
}
