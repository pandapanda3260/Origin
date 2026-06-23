import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getVideoCreationState } from '@/lib/video-creation/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  if (!projectId) return jsonError('缺 projectId', 400);
  const state = getVideoCreationState({ projectId, ownerId: user.id });
  if (!state) return jsonError('项目不存在', 404);
  return jsonOk(state);
}
