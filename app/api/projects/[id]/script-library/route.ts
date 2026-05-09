import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { upsertScriptLibraryItem } from '@/lib/script-library-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  try {
    const item = upsertScriptLibraryItem(user.id, params.id, body);
    if (!item) return jsonError('项目不存在', 404);
    return jsonOk({ ok: true, item });
  } catch (e: any) {
    return jsonError(e?.message || '剧本库保存失败', e?.status || 400);
  }
}
