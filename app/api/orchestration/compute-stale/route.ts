import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { computeCharacterConsistencyStale } from '@/lib/character-consistency-gate';
import { computeFrameWorkflowStaleFlags } from '@/lib/frame-workflow-state';
import { computeAssetStyleStaleFlags } from '@/lib/asset-style-lock';
import { SHOT_PLAN_STALE_FLAG } from '@/lib/project-dependency-state';
import {
  describeProjectArtifactStatus,
  PROJECT_STATUS_ARTIFACTS,
  type TargetArtifact,
} from '@/lib/sentinel';

export const dynamic = 'force-dynamic';

function parseArtifacts(value: unknown): Set<TargetArtifact> {
  const raw = String(value || '').trim();
  if (!raw) return new Set(PROJECT_STATUS_ARTIFACTS);
  const allowed = new Set<TargetArtifact>(PROJECT_STATUS_ARTIFACTS);
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean) as TargetArtifact[];
  const picked = values.filter((item) => allowed.has(item));
  return new Set(picked.length ? picked : PROJECT_STATUS_ARTIFACTS);
}

async function handle(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const body = req.method === 'POST' ? await req.json().catch(() => ({} as any)) : {};
  const projectId = String(url.searchParams.get('projectId') || body?.projectId || body?.id || '');
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : body?.project;
  if (!project) return jsonError('projectId is required', 400);
  const artifacts = parseArtifacts(url.searchParams.get('artifacts') || body?.artifacts);
  const includeSnapshots = String(url.searchParams.get('includeSnapshots') ?? body?.includeSnapshots ?? 'false') === 'true';
  const includeUsable = String(url.searchParams.get('includeUsable') ?? body?.includeUsable ?? 'false') === 'true';
  const projectStaleFlags = (project as any)._staleFlags && typeof (project as any)._staleFlags === 'object'
    ? (project as any)._staleFlags
    : {};
  const shotPlanStaleFlags = projectStaleFlags[SHOT_PLAN_STALE_FLAG]
    ? { [SHOT_PLAN_STALE_FLAG]: true }
    : {};
  return jsonOk({
    stale: computeCharacterConsistencyStale(project),
    staleFlags: {
      ...shotPlanStaleFlags,
      ...computeFrameWorkflowStaleFlags(project, user.id),
      ...computeAssetStyleStaleFlags(project),
    },
    artifacts: describeProjectArtifactStatus(project, projectId || String((project as any).id || ''), {
      artifacts,
      includeSnapshots,
      includeUsable,
      consumerOperation: 'compute_stale',
    }),
    updatedAt: new Date().toISOString(),
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
