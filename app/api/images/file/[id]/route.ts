import { NextRequest } from 'next/server';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { verifySignedImageUrl } from '@/lib/signed-asset-url';
import { dataPath } from '@/lib/runtime-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseThumbWidth(req: NextRequest): number {
  const raw = new URL(req.url).searchParams.get('w');
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(48, Math.min(512, Math.round(n)));
}

async function resizeImage(buffer: Buffer, width: number): Promise<Buffer | null> {
  if (!width) return null;
  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod?.createCanvas || !canvasMod?.loadImage) return null;
  const image = await canvasMod.loadImage(buffer);
  if (!image?.width || !image?.height || image.width <= width) return null;
  const height = Math.max(1, Math.round(image.height * (width / image.width)));
  const canvas = canvasMod.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer('image/png') as Buffer;
}

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

  let fullPath = dataPath('images', String(row.owner_id), row.filename);
  if (!existsSync(fullPath) && (row.style === 'video-cover' || String(row.asset_ref || '').startsWith('video-cover/'))) {
    const videoCoverPath = dataPath('videos', String(row.owner_id), row.filename);
    if (existsSync(videoCoverPath)) fullPath = videoCoverPath;
  }
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const source = readFileSync(fullPath);
  let buf = source;
  let contentType = row.mime || 'image/png';
  try {
    const resized = await resizeImage(source, parseThumbWidth(req));
    if (resized) {
      buf = resized;
      contentType = 'image/png';
    }
  } catch (e) {
    console.warn('[images/file] thumbnail resize failed:', e);
  }
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.length || stat.size),
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
