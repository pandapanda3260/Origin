import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = join(process.cwd(), 'data');
const IMAGES_DIR = join(DATA_DIR, 'images');

/**
 * 用户上传一张自定义角色照片做参考图。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const projectId = (form.get('projectId') || '').toString();
    const assetRef = (form.get('assetRef') || '').toString();

    if (!file) return jsonError('没有上传文件', 400);
    const buf = Buffer.from(await file.arrayBuffer());
    const id = randomUUID();
    const dir = join(IMAGES_DIR, String(user.id));
    mkdirSync(dir, { recursive: true });
    const ext = guessExt((file as any).type || '');
    const filename = `${id}.${ext}`;
    writeFileSync(join(dir, filename), buf);

    const db = getDb();
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (?, ?, ?, 'character', ?, ?, ?, ?, 0, 0, '[uploaded]', null)`,
    ).run(
      id,
      user.id,
      projectId || null,
      assetRef || null,
      filename,
      (file as any).type || 'image/jpeg',
      buf.length,
    );

    return jsonOk({
      ok: true,
      url: `/api/images/file/${id}`,
      message: '上传成功',
    });
  } catch (e: any) {
    return jsonError('上传失败：' + (e?.message || String(e)), 400);
  }
}

function guessExt(mime: string) {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}
