import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { computeCharacterConsistencyStale } from '@/lib/character-consistency-gate';
import { computeFrameWorkflowStaleFlags } from '@/lib/frame-workflow-state';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || body?.id || '');
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : body?.project;
  if (!project) return jsonError('projectId is required', 400);
  return jsonOk({
    stale: computeCharacterConsistencyStale(project),
    staleFlags: computeFrameWorkflowStaleFlags(project, user.id),
    updatedAt: new Date().toISOString(),
  });
}
