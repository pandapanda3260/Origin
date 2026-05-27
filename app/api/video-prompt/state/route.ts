import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  buildVideoPromptBackupBackfillPatch,
  currentDisplayVideoPrompt,
  videoPromptDraftFingerprint,
} from '@/lib/video-prompt-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const groupIdx = parseGroupIdx(url.searchParams.get('groupIdx'));

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);

  let project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  const backfillPatch = buildVideoPromptBackupBackfillPatch(project);
  if (backfillPatch) {
    project = patchProjectForUser(projectId, user.id, (fresh) => buildVideoPromptBackupBackfillPatch(fresh)) || project;
  }

  const storyboards = Array.isArray((project as any).storyboards) ? (project as any).storyboards : [];
  const sb = storyboards[groupIdx] || null;
  if (!sb) return jsonError('片段不存在', 404);

  const draft = sb.videoPromptEditDraft || null;
  const draftSourceHash = draft?.sourceHash || null;
  const savedDraftFingerprint = draft
    ? (draft.savedDraftFingerprint || videoPromptDraftFingerprint(draftSourceHash, draft))
    : videoPromptDraftFingerprint(null, null);

  return jsonOk({
    projectId,
    groupIdx,
    displayPrompt: currentDisplayVideoPrompt(sb),
    displaySource: draft?.content ? 'draft' : (sb.videoPrompt ? 'videoPrompt' : 'empty'),
    videoPrompt: sb.videoPrompt || '',
    videoPromptStatus: sb.videoPromptStatus || '',
    videoPromptRunId: sb.videoPromptRunId || '',
    videoPromptSourceHash: sb.videoPromptSourceHash || null,
    videoPromptUpdatedAt: sb.videoPromptUpdatedAt || null,
    videoPromptLastError: sb.videoPromptLastError || null,
    videoPromptEditDraft: draft,
    videoPromptBackup: sb.videoPromptBackup || null,
    savedDraftFingerprint,
  });
}
