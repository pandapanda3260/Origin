import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  computeVideoPromptSourceHash,
  normalizeVideoPromptEditDraftInput,
  videoPromptDraftFingerprint,
} from '@/lib/video-prompt-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
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

function actualDraftFingerprint(existingDraft: any, sourceHash: string | null) {
  if (existingDraft?.savedDraftFingerprint) return String(existingDraft.savedDraftFingerprint);
  return videoPromptDraftFingerprint(sourceHash, existingDraft || '');
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const input = body?.draft ?? body?.content ?? body?.videoPrompt ?? body?.prompt ?? '';
  const expectedSavedDraftFingerprint = String(body?.expectedSavedDraftFingerprint || '').trim();
  const force = body?.force === true;

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  try {
    let draft: any = null;
    let sourceHash: string | null = null;
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx];
      if (!prev) throw new Error(`片段 ${groupIdx + 1} 不存在`);

      const existingDraft = prev.videoPromptEditDraft || null;
      sourceHash = typeof existingDraft?.sourceHash === 'string'
        ? existingDraft.sourceHash
        : computeVideoPromptSourceHash({ project: fresh, groupIdx, ownerId: user.id });
      const actualSavedDraftFingerprint = actualDraftFingerprint(existingDraft, sourceHash);
      if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint && !force) {
        throw new SavedDraftChangedException(expectedSavedDraftFingerprint, actualSavedDraftFingerprint);
      }

      draft = normalizeVideoPromptEditDraftInput(input, sourceHash);
      storyboards[groupIdx] = {
        ...prev,
        videoPromptEditDraft: draft,
      };
      return { storyboards };
    });

    return jsonOk({
      draft,
      sourceHash,
      savedDraftFingerprint: draft?.savedDraftFingerprint || '',
      baselineFingerprint: draft?.savedDraftFingerprint || '',
      projectUpdatedAt: (updated as any)?.updatedAt || null,
    });
  } catch (err: any) {
    if (err instanceof SavedDraftChangedException) return savedDraftChangedResponse(err);
    return jsonError(err?.message || '保存视频提示词草稿失败', 500);
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
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx];
      if (!prev) throw new Error(`片段 ${groupIdx + 1} 不存在`);

      const existingDraft = prev.videoPromptEditDraft || null;
      sourceHash = typeof existingDraft?.sourceHash === 'string'
        ? existingDraft.sourceHash
        : computeVideoPromptSourceHash({ project: fresh, groupIdx, ownerId: user.id });
      const actualSavedDraftFingerprint = actualDraftFingerprint(existingDraft, sourceHash);
      if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint && !force) {
        throw new SavedDraftChangedException(expectedSavedDraftFingerprint, actualSavedDraftFingerprint);
      }

      if (!existingDraft) {
        savedDraftFingerprint = videoPromptDraftFingerprint(sourceHash, '');
        return {};
      }
      const next = { ...prev };
      delete next.videoPromptEditDraft;
      storyboards[groupIdx] = next;
      savedDraftFingerprint = videoPromptDraftFingerprint(sourceHash, '');
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
    return jsonError(err?.message || '删除视频提示词草稿失败', 500);
  }
}
