import { NextRequest } from 'next/server';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BGM_DIR = join(process.cwd(), 'data', 'bgm');

/**
 * 扫描 data/bgm/ 目录返回所有可用的背景音乐文件。
 * 用户可以把自己的 mp3/wav 放到这个目录，立即就出现在前端 BGM 列表里。
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  if (!existsSync(BGM_DIR)) {
    mkdirSync(BGM_DIR, { recursive: true });
    return jsonOk({
      items: [],
      total: 0,
      hint: '把 .mp3 / .wav 文件放到 data/bgm/ 目录就能在这里看到',
    });
  }

  const items: any[] = [];
  for (const f of readdirSync(BGM_DIR)) {
    if (!/\.(mp3|wav|m4a|aac|ogg)$/i.test(f)) continue;
    const stat = statSync(join(BGM_DIR, f));
    items.push({
      id: f,
      name: f.replace(/\.[^.]+$/, ''),
      url: `/api/edit/bgm/${encodeURIComponent(f)}`,
      sizeBytes: stat.size,
      mood: '',
    });
  }

  return jsonOk({ items, total: items.length });
}
