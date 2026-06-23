import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { importVideoGroupToEdit, type ImportGroupOutcome } from '@/lib/video-creation/import-to-edit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function outcomeResponse(outcome: ImportGroupOutcome) {
  if (outcome.status === 200) return jsonOk(outcome.body);
  return Response.json(outcome.body, { status: outcome.status });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = Number(body?.groupIdx);
  return outcomeResponse(importVideoGroupToEdit({
    projectId,
    ownerId: user.id,
    groupIdx,
  }));
}
