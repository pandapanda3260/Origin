import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { patchProjectForUser } from '@/lib/projects-db';
import {
  confirmCurrentShotPlanStillValidWithDownstreamSeed,
  ShotPlanConfirmInvalidStateError,
} from '@/lib/project-dependency-state';
import { describeArtifactStatus } from '@/lib/sentinel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(_req);
  if (!user) return jsonError('unauthorized', 401);
  const projectId = String(params?.id || '');
  if (!projectId) return jsonError('project id is required', 400);
  const includeDownstream = new URL(_req.url).searchParams.get('includeDownstream') === 'true';

  try {
    const project = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      return confirmCurrentShotPlanStillValidWithDownstreamSeed(fresh);
    });
    if (!project) return jsonError('项目不存在', 404);
    if (!includeDownstream) return jsonOk(project);
    const storyboards = Array.isArray((project as any).storyboards) ? (project as any).storyboards : [];
    const downstreamArtifacts = storyboards.flatMap((_: any, groupIdx: number) => ([
      describeArtifactStatus(project as any, { projectId, targetArtifact: 'storyboard_image', groupIdx }),
      describeArtifactStatus(project as any, { projectId, targetArtifact: 'video_prompt', groupIdx }),
      describeArtifactStatus(project as any, { projectId, targetArtifact: 'video_segment', groupIdx }),
    ]));
    return jsonOk({ project, downstreamArtifacts });
  } catch (error: any) {
    if (error instanceof ShotPlanConfirmInvalidStateError) {
      return Response.json(
        {
          code: error.code,
          detail: `镜头计划状态 ${error.currentState || 'unknown'} 不允许确认旧镜头仍可用，仅 stale / legacy_unknown 可用`,
          currentState: error.currentState || '',
        },
        { status: 409 },
      );
    }
    return jsonError(error?.message || '确认镜头计划失败', 500);
  }
}
