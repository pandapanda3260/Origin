import { NextRequest } from 'next/server';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { verifySignedImageUrl } from '@/lib/signed-asset-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 提供生成图文件的下载/预览。
 *
 * 鉴权：必须登录，且只能读自己 owner_id 的图片。
 * <img src="..."> 不能带 Authorization 头，所以前端需要改成 fetch+blob 或 signed URL；
 * 为了向后兼容，仍然接受 ?token=... 但要求 Accept: text/event-stream 或 Bearer 头。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT * FROM images WHERE id = @id').get({ id });
  if (!row) return new Response('not found', { status: 404 });

  const user = await getCurrentUser(req);
  if (user) {
    if (Number(row.owner_id) !== Number(user.id)) return new Response('forbidden', { status: 403 });
  } else {
    const url = new URL(req.url);
    const signedOk = verifySignedImageUrl({
      imageId: id,
      ownerId: Number(row.owner_id),
      exp: url.searchParams.get('exp'),
      sig: url.searchParams.get('sig'),
    });
    if (!signedOk) return new Response('unauthorized', { status: 401 });
  }

  let fullPath = join(process.cwd(), 'data', 'images', String(row.owner_id), row.filename);
  if (!existsSync(fullPath) && (row.style === 'video-cover' || String(row.asset_ref || '').startsWith('video-cover/'))) {
    const videoCoverPath = join(process.cwd(), 'data', 'videos', String(row.owner_id), row.filename);
    if (existsSync(videoCoverPath)) fullPath = videoCoverPath;
  }
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const buf = readFileSync(fullPath);
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': row.mime || 'image/png',
      'Content-Length': String(stat.size),
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
