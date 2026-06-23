import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  deleteCurrentVideoForGroup,
  setCurrentVideoForGroup,
  type VideoCurrentOutcome,
} from '@/lib/video-creation/current-video';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function outcomeResponse(outcome: VideoCurrentOutcome) {
  if (outcome.status === 200) return jsonOk(outcome.body);
  return Response.json(outcome.body, { status: outcome.status });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  return outcomeResponse(setCurrentVideoForGroup({
    projectId: String(body?.projectId || '').trim(),
    ownerId: user.id,
    groupIdx: Number(body?.groupIdx),
    taskId: String(body?.taskId || '').trim(),
  }));
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  return outcomeResponse(deleteCurrentVideoForGroup({
    projectId: String(body?.projectId || url.searchParams.get('projectId') || '').trim(),
    ownerId: user.id,
    groupIdx: Number(body?.groupIdx ?? url.searchParams.get('groupIdx')),
  }));
}
