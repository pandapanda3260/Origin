import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  buildFirstFramePlanPreview,
  currentFirstFrameEditDraft,
  firstFrameDraftFingerprint,
  validateAndNormalizeFirstFrameDraft,
  FirstFrameDraftValidationException,
} from '@/lib/first-frame-edit-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function validationResponse(errors: Array<{ field: string; message: string }>) {
  return Response.json(
    {
      error: errors[0]?.message || 'validation_failed',
      code: 'validation_failed',
      errors,
    },
    { status: 422 },
  );
}

class SavedDraftChangedException extends Error {
  actualFingerprint: string;
  expectedFingerprint: string;

  constructor(expectedFingerprint: string, actualFingerprint: string) {
    super('saved_draft_changed');
    this.name = 'SavedDraftChangedException';
    this.expectedFingerprint = expectedFingerprint;
    this.actualFingerprint = actualFingerprint;
  }
}

function savedDraftChangedResponse(err: SavedDraftChangedException) {
  return Response.json(
    {
      error: '草稿已在其他位置更新，请刷新后重试，或确认覆盖。',
      code: 'saved_draft_changed',
      expectedSavedDraftFingerprint: err.expectedFingerprint,
      actualSavedDraftFingerprint: err.actualFingerprint,
    },
    { status: 409 },
  );
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const input = body?.draft || {};
  const expectedSavedDraftFingerprint = String(body?.expectedSavedDraftFingerprint || '').trim();
  const force = body?.force === true;

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  try {
    let draft: any = null;
    let sourceHash: string | null = null;
    let savedDraftFingerprint = '';
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const preview = buildFirstFramePlanPreview({ project: fresh, groupIdx, ownerId: user.id, user });
      sourceHash = preview.sourceHash;
      const { draft: currentDraft } = currentFirstFrameEditDraft(fresh, groupIdx);
      const actualSavedDraftFingerprint = firstFrameDraftFingerprint(sourceHash, currentDraft);
      if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint && !force) {
        throw new SavedDraftChangedException(expectedSavedDraftFingerprint, actualSavedDraftFingerprint);
      }
      if (force && expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint) {
        console.warn('[first-frame-edit-draft] force overwrite after saved draft changed', {
          userId: user.id,
          projectId,
          groupIdx,
          expectedSavedDraftFingerprint,
          actualSavedDraftFingerprint,
        });
      }
      draft = validateAndNormalizeFirstFrameDraft({
        project: fresh,
        groupIdx,
        userId: user.id,
        input,
        plan: preview.plan,
      });
      savedDraftFingerprint = firstFrameDraftFingerprint(sourceHash, draft);
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx] || {};
      storyboards[groupIdx] = {
        ...prev,
        firstFrameEditDraft: draft,
      };
      return { storyboards };
    });
    return jsonOk({
      draft,
      sourceHash,
      savedDraftFingerprint,
      baselineFingerprint: savedDraftFingerprint,
      projectUpdatedAt: (updated as any)?.updatedAt || null,
    });
  } catch (err: any) {
    if (err instanceof SavedDraftChangedException) return savedDraftChangedResponse(err);
    if (err instanceof FirstFrameDraftValidationException) {
      return validationResponse(err.errors);
    }
    return jsonError(err?.message || '保存草稿失败', 500);
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const expectedSavedDraftFingerprint = String(body?.expectedSavedDraftFingerprint || '').trim();
  const force = body?.force === true;

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  try {
    let sourceHash: string | null = null;
    let savedDraftFingerprint = '';
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const preview = buildFirstFramePlanPreview({ project: fresh, groupIdx, ownerId: user.id, user });
      sourceHash = preview.sourceHash;
      const { draft: currentDraft } = currentFirstFrameEditDraft(fresh, groupIdx);
      const actualSavedDraftFingerprint = firstFrameDraftFingerprint(sourceHash, currentDraft);
      if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint && !force) {
        throw new SavedDraftChangedException(expectedSavedDraftFingerprint, actualSavedDraftFingerprint);
      }
      if (force && expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint) {
        console.warn('[first-frame-edit-draft] force delete after saved draft changed', {
          userId: user.id,
          projectId,
          groupIdx,
          expectedSavedDraftFingerprint,
          actualSavedDraftFingerprint,
        });
      }
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx] || {};
      if (!prev || !prev.firstFrameEditDraft) {
        savedDraftFingerprint = firstFrameDraftFingerprint(sourceHash, null);
        return {};
      }
      const next = { ...prev };
      delete next.firstFrameEditDraft;
      storyboards[groupIdx] = next;
      savedDraftFingerprint = firstFrameDraftFingerprint(sourceHash, null);
      return { storyboards };
    });
    return jsonOk({
      ok: true,
      sourceHash,
      savedDraftFingerprint,
      baselineFingerprint: savedDraftFingerprint,
      projectUpdatedAt: (updated as any)?.updatedAt || null,
    });
  } catch (err: any) {
    if (err instanceof SavedDraftChangedException) return savedDraftChangedResponse(err);
    return jsonError(err?.message || '删除草稿失败', 500);
  }
}
