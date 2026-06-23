import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getVideoCreationHistoryForGroup } from '@/lib/video-creation/history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const groupIdx = Number(url.searchParams.get('groupIdx'));
  if (!projectId) return jsonError('缺 projectId', 400);
  const result = getVideoCreationHistoryForGroup({
    req,
    projectId,
    ownerId: user.id,
    groupIdx,
  });
  if (result.status === 200) return jsonOk(result.body);
  return Response.json(result.body, { status: result.status });
}
