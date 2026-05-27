import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import {
  buildFirstFrameMaterialPanel,
  buildFirstFramePlanPreview,
  currentFirstFrameEditDraft,
  reconcileFirstFramePromptState,
} from '@/lib/first-frame-edit-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function groupIndicesForProject(project: any, requestedGroupIdx: number | null): number[] {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  if (requestedGroupIdx != null) return requestedGroupIdx < shots.length ? [requestedGroupIdx] : [];
  return shots.map((_shot: unknown, idx: number) => idx);
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const rawGroupIdx = url.searchParams.get('groupIdx');
  const groupIdx = rawGroupIdx == null ? null : parseGroupIdx(rawGroupIdx);

  if (!projectId) return jsonError('缺 projectId', 400);
  if (rawGroupIdx != null && groupIdx == null) return jsonError('groupIdx 无效', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  let activeProject = project;
  const reconciled = groupIdx == null ? null : reconcileFirstFramePromptState({ projectId, user, groupIdx });
  if (groupIdx != null && !reconciled) return jsonError('项目不存在', 404);
  if (reconciled) activeProject = getProjectByIdForUser(projectId, user.id) || project;

  const panels = groupIndicesForProject(activeProject, groupIdx).map((idx) => {
    try {
      const preview = reconciled && idx === groupIdx
        ? reconciled
        : buildFirstFramePlanPreview({
          project: activeProject,
          groupIdx: idx,
          ownerId: user.id,
          user,
        });
      const { draft } = currentFirstFrameEditDraft(activeProject, idx);
      const firstFrameMaterialPanel = buildFirstFrameMaterialPanel({
        project: activeProject,
        userId: user.id,
        plan: preview.plan,
        draft,
        sourceHash: preview.sourceHash,
      });
      return {
        groupIdx: idx,
        sourceHash: preview.sourceHash,
        firstFrameMaterialPanel,
      };
    } catch (err: any) {
      return {
        groupIdx: idx,
        sourceHash: null,
        firstFrameMaterialPanel: null,
        error: err?.message || 'material_panel_failed',
      };
    }
  });

  return jsonOk({
    projectId,
    projectUpdatedAt: (activeProject as any)?.updatedAt || null,
    panels,
  });
}
