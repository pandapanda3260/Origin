import { NextRequest } from 'next/server';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 提供生成图文件的下载/预览。
 *
 * 鉴权策略：图片本质上属于单个用户，但 <img src="..."> 不会带 Authorization 头，
 * 所以这里允许：
 *   1) 任何已有 image 记录的图都允许公开读（仅本机/开发用）
 *   2) 如果未来上线生产，可以改成签名 URL（image_id + HMAC + expires）
 * 简单起见，阶段三先开放本机读取。
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT * FROM images WHERE id = @id').get({ id });
  if (!row) return new Response('not found', { status: 404 });

  const fullPath = join(process.cwd(), 'data', 'images', String(row.owner_id), row.filename);
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const buf = readFileSync(fullPath);
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': row.mime || 'image/png',
      'Content-Length': String(stat.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
