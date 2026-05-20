import { existsSync } from 'node:fs';
import { getDb } from './db';
import { dataPath } from './runtime-paths';
import type { ToolboxInputRef } from './toolbox-modes';

function imagePathForId(ownerId: number, id: string) {
  const row = getDb()
    .prepare<{ id: string; ownerId: number }, any>(
      'SELECT filename FROM images WHERE id = @id AND owner_id = @ownerId LIMIT 1',
    )
    .get({ id, ownerId });
  if (!row?.filename) return null;
  const fullPath = dataPath('images', String(ownerId), row.filename);
  return existsSync(fullPath) ? fullPath : null;
}

function uploadImagePathForId(ownerId: number, id: string) {
  const row = getDb()
    .prepare<{ id: string; ownerId: number }, any>(
      `SELECT filename, kind FROM uploads
        WHERE id = @id AND owner_id = @ownerId LIMIT 1`,
    )
    .get({ id, ownerId });
  if (!row?.filename || row.kind !== 'image') return null;
  const fullPath = dataPath('uploads', String(ownerId), row.filename);
  return existsSync(fullPath) ? fullPath : null;
}

export function resolveToolboxImageRefPath(ownerId: number, ref: ToolboxInputRef | null | undefined) {
  if (!ref?.refId) return null;
  return ref.refType === 'image'
    ? imagePathForId(ownerId, ref.refId)
    : uploadImagePathForId(ownerId, ref.refId);
}

export function assertToolboxImageRefPath(ownerId: number, ref: ToolboxInputRef | null | undefined, label: string) {
  const path = resolveToolboxImageRefPath(ownerId, ref);
  if (!path) {
    const err = new Error(`${label} 不存在或已删除`);
    (err as any).status = 400;
    throw err;
  }
  return path;
}
