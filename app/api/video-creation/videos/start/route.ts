import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { startVideoSegmentRun, type VideoCreationStartOutcome } from '@/lib/video-creation/start-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeTargets(body: any) {
  let targets: any[] = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length && Array.isArray(body.storyboardIndices)) {
    targets = body.storyboardIndices
      .map((value: any) => Number(value))
      .filter((idx: number) => Number.isFinite(idx) && idx >= 0)
      .map((idx: number) => ({ groupIdx: idx, idx, storyboardIdx: idx }));
  }
  return targets;
}

function outcomeResponse(outcome: VideoCreationStartOutcome) {
  if (outcome.status === 200) return jsonOk(outcome.body);
  return Response.json(outcome.body, { status: outcome.status });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body.projectId || '').trim();
  const targets = normalizeTargets(body);
  return outcomeResponse(startVideoSegmentRun({
    user,
    projectId,
    batchType: 'video_segments',
    targets,
    options: body.options || {},
  }));
}
