import type Database from 'better-sqlite3';
import { hashSync } from 'bcryptjs';
import { randomUUID } from 'node:crypto';

export const ADMIN_SHADOW_USERNAME_PREFIX = '__shadow__';

export type ShadowAdminRef = {
  id: number;
  username: string;
  preview_user_id?: number | null;
};

export function ensureAdminPreviewUser(db: Database.Database, admin: ShadowAdminRef): number {
  if (admin.preview_user_id) {
    const existing = db
      .prepare<{ id: number }, { id: number }>('SELECT id FROM users WHERE id = @id LIMIT 1')
      .get({ id: admin.preview_user_id });
    if (existing) return existing.id;
  }

  const username = shadowUsernameForAdmin(admin.id);
  const existingShadow = db
    .prepare<{ username: string }, { id: number }>('SELECT id FROM users WHERE username = @username LIMIT 1')
    .get({ username });
  const shadowId = existingShadow?.id || db
    .prepare<{ username: string; displayName: string; passwordHash: string }, { id: number }>(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (@username, NULL, @displayName, @passwordHash, 1)
       RETURNING id`,
    )
    .get({
      username,
      displayName: `Shadow of ${admin.username}`,
      passwordHash: hashSync(randomUUID(), 10),
    })!.id;

  db.prepare<{ id: number; previewUserId: number }>(
    `UPDATE admin_users
        SET preview_user_id = @previewUserId
      WHERE id = @id`,
  ).run({ id: admin.id, previewUserId: shadowId });
  return shadowId;
}

export function shadowUsernameForAdmin(adminId: number): string {
  return `${ADMIN_SHADOW_USERNAME_PREFIX}${adminId}`;
}

export function isShadowUsername(username: string): boolean {
  return String(username || '').startsWith(ADMIN_SHADOW_USERNAME_PREFIX);
}
