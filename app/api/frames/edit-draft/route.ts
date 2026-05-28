import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  currentFirstFrameEditDraft,
  firstFrameDraftFingerprint,
  reconcileFirstFramePromptStateInPatch,
  validateAndNormalizeFirstFrameDraft,
  FirstFrameDraftValidationException,
} from '@/lib/first-frame-edit-draft';
import {
  TailFrameDraftValidationException,
  currentTailFrameEditDraft,
  reconcileTailFramePromptStateInPatch,
  tailFrameDraftFingerprint,
  validateAndNormalizeTailFrameDraft,
} from '@/lib/tail-frame-edit-draft';

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
  const frameType = String(body?.frameType || 'first_frame');
  const input = body?.draft || {};
  const expectedSavedDraftFingerprint = String(body?.expectedSavedDraftFingerprint || '').trim();
  const force = body?.force === true;

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (frameType !== 'first_frame' && frameType !== 'tail_frame') return jsonError('当前仅支持 first_frame / tail_frame', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  if (frameType === 'tail_frame') {
    try {
      let draft: any = null;
      let sourceHash: string | null = null;
      let savedDraftFingerprint = '';
      const updated = patchProjectForUser(projectId, user.id, (fresh) => {
        if (!fresh) return null;
        const promptState = reconcileTailFramePromptStateInPatch({ project: fresh, user, groupIdx });
        sourceHash = promptState.sourceHash;
        const { draft: currentDraft } = currentTailFrameEditDraft(fresh, groupIdx);
        const actualSavedDraftFingerprint = tailFrameDraftFingerprint(currentDraft);
        if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint && !force) {
          throw new SavedDraftChangedException(expectedSavedDraftFingerprint, actualSavedDraftFingerprint);
        }
        if (force && expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint) {
          console.warn('[tail-frame-edit-draft] force overwrite after saved draft changed', {
            userId: user.id,
            projectId,
            groupIdx,
            expectedSavedDraftFingerprint,
            actualSavedDraftFingerprint,
          });
        }
        draft = validateAndNormalizeTailFrameDraft({
          input,
          sourceHash: promptState.sourceHash,
          userId: user.id,
        });
        savedDraftFingerprint = tailFrameDraftFingerprint(draft);
        const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
        const prev = storyboards[groupIdx] || {};
        storyboards[groupIdx] = {
          ...prev,
          ...(promptState.slotPatch || {}),
          tailFrameEditDraft: draft,
        };
        return { storyboards };
      });
      return jsonOk({
        draft,
        sourceHash,
        savedDraftFingerprint,
        baselineFingerprint: savedDraftFingerprint,
        tailFrameBasePrompt: (updated as any)?.storyboards?.[groupIdx]?.tailFrameBasePrompt || null,
        tailFrameBackup: (updated as any)?.storyboards?.[groupIdx]?.tailFrameBackup || null,
        projectUpdatedAt: (updated as any)?.updatedAt || null,
      });
    } catch (err: any) {
      if (err instanceof SavedDraftChangedException) return savedDraftChangedResponse(err);
      if (err instanceof TailFrameDraftValidationException) return validationResponse(err.errors);
      return jsonError(err?.message || '保存尾帧草稿失败', 500);
    }
  }

  try {
    let draft: any = null;
    let sourceHash: string | null = null;
    let savedDraftFingerprint = '';
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const promptState = reconcileFirstFramePromptStateInPatch({ project: fresh, user, groupIdx });
      sourceHash = promptState.sourceHash;
      const { draft: currentDraft } = currentFirstFrameEditDraft(fresh, groupIdx);
      const actualSavedDraftFingerprint = firstFrameDraftFingerprint(currentDraft);
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
        plan: promptState.plan,
      });
      savedDraftFingerprint = firstFrameDraftFingerprint(draft);
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx] || {};
      storyboards[groupIdx] = {
        ...prev,
        ...(promptState.slotPatch || {}),
        firstFrameEditDraft: draft,
      };
      return { storyboards };
    });
    return jsonOk({
      draft,
      sourceHash,
      savedDraftFingerprint,
      baselineFingerprint: savedDraftFingerprint,
      firstFrameBasePrompt: (updated as any)?.storyboards?.[groupIdx]?.firstFrameBasePrompt || null,
      firstFrameBackup: (updated as any)?.storyboards?.[groupIdx]?.firstFrameBackup || null,
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
  const frameType = String(body?.frameType || 'first_frame');
  const expectedSavedDraftFingerprint = String(body?.expectedSavedDraftFingerprint || '').trim();
  const force = body?.force === true;

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (frameType !== 'first_frame' && frameType !== 'tail_frame') return jsonError('当前仅支持 first_frame / tail_frame', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  if (frameType === 'tail_frame') {
    try {
      let sourceHash: string | null = null;
      let savedDraftFingerprint = '';
      const updated = patchProjectForUser(projectId, user.id, (fresh) => {
        if (!fresh) return null;
        const promptState = reconcileTailFramePromptStateInPatch({ project: fresh, user, groupIdx });
        sourceHash = promptState.sourceHash;
        const { draft: currentDraft } = currentTailFrameEditDraft(fresh, groupIdx);
        const actualSavedDraftFingerprint = tailFrameDraftFingerprint(currentDraft);
        if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint && !force) {
          throw new SavedDraftChangedException(expectedSavedDraftFingerprint, actualSavedDraftFingerprint);
        }
        if (force && expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint) {
          console.warn('[tail-frame-edit-draft] force delete after saved draft changed', {
            userId: user.id,
            projectId,
            groupIdx,
            expectedSavedDraftFingerprint,
            actualSavedDraftFingerprint,
          });
        }
        const backup = promptState.tailFrameBackup;
        if (!backup?.content) {
          const err = new Error('no_backup_to_restore');
          (err as any).status = 422;
          (err as any).code = 'no_backup_to_restore';
          throw err;
        }
        const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
        const prev = storyboards[groupIdx] || {};
        const next = {
          ...prev,
          ...(promptState.slotPatch || {}),
          tailFrameBasePrompt: {
            content: backup.content,
            sourceHash: backup.sourceHash,
            updatedAt: new Date().toISOString(),
            updatedBy: user.id,
            origin: 'backup_restore',
          },
        };
        delete next.tailFrameEditDraft;
        storyboards[groupIdx] = next;
        savedDraftFingerprint = tailFrameDraftFingerprint(null);
        return { storyboards };
      });
      return jsonOk({
        ok: true,
        sourceHash,
        savedDraftFingerprint,
        baselineFingerprint: savedDraftFingerprint,
        tailFrameBasePrompt: (updated as any)?.storyboards?.[groupIdx]?.tailFrameBasePrompt || null,
        tailFrameBackup: (updated as any)?.storyboards?.[groupIdx]?.tailFrameBackup || null,
        projectUpdatedAt: (updated as any)?.updatedAt || null,
      });
    } catch (err: any) {
      if (err instanceof SavedDraftChangedException) return savedDraftChangedResponse(err);
      if (err?.status === 422 || err?.code === 'no_backup_to_restore') {
        return Response.json(
          { error: '暂无可恢复的初始 prompt', code: 'no_backup_to_restore' },
          { status: 422 },
        );
      }
      return jsonError(err?.message || '恢复尾帧初始提示词失败', 500);
    }
  }

  try {
    let sourceHash: string | null = null;
    let savedDraftFingerprint = '';
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const promptState = reconcileFirstFramePromptStateInPatch({ project: fresh, user, groupIdx });
      sourceHash = promptState.sourceHash;
      const { draft: currentDraft } = currentFirstFrameEditDraft(fresh, groupIdx);
      const actualSavedDraftFingerprint = firstFrameDraftFingerprint(currentDraft);
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
      const backup = promptState.firstFrameBackup;
      const next = {
        ...prev,
        ...(promptState.slotPatch || {}),
        firstFrameBasePrompt: {
          content: backup.content,
          sourceHash: backup.sourceHash,
          updatedAt: new Date().toISOString(),
          updatedBy: user.id,
          origin: 'backup_restore',
        },
      };
      delete next.firstFrameEditDraft;
      storyboards[groupIdx] = next;
      savedDraftFingerprint = firstFrameDraftFingerprint(null);
      return { storyboards };
    });
    return jsonOk({
      ok: true,
      sourceHash,
      savedDraftFingerprint,
      baselineFingerprint: savedDraftFingerprint,
      firstFrameBasePrompt: (updated as any)?.storyboards?.[groupIdx]?.firstFrameBasePrompt || null,
      firstFrameBackup: (updated as any)?.storyboards?.[groupIdx]?.firstFrameBackup || null,
      projectUpdatedAt: (updated as any)?.updatedAt || null,
    });
  } catch (err: any) {
    if (err instanceof SavedDraftChangedException) return savedDraftChangedResponse(err);
    return jsonError(err?.message || '删除草稿失败', 500);
  }
}
