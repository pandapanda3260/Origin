import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';
import { validateCharacterConsistencyForGroup } from '@/lib/character-consistency-gate';
import {
  applyVideoPromptWrite,
  computeVideoPromptSourceHash,
  normalizeVideoPromptContent,
  videoPromptDraftFingerprint,
} from '@/lib/video-prompt-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function gateBlockResponse(gate: any) {
  return Response.json(
    {
      error: '视频提示词角色一致性检查未通过。',
      code: 'VIDEO_PROMPT_CONSISTENCY_BLOCKED',
      blockers: gate.blockers || [],
      warnings: gate.warnings || [],
    },
    { status: 422 },
  );
}

function savedDraftChangedResponse(expected: string, actual: string) {
  return Response.json(
    {
      error: '草稿已在其他位置更新，请刷新后重试，或确认覆盖。',
      code: 'saved_draft_changed',
      expectedSavedDraftFingerprint: expected,
      actualSavedDraftFingerprint: actual,
    },
    { status: 409 },
  );
}

export async function POST(req: NextRequest) {
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

  const storyboards = Array.isArray((project as any).storyboards) ? [...(project as any).storyboards] : [];
  const sb = storyboards[groupIdx];
  if (!sb) return jsonError(`片段 ${groupIdx + 1} 不存在`, 404);

  const draft = sb.videoPromptEditDraft || null;
  if (!draft) return jsonError('没有可提交的视频提示词草稿', 400);
  const content = normalizeVideoPromptContent(draft.content);
  if (!content) {
    return Response.json(
      { error: '视频提示词不能为空。', code: 'empty_video_prompt' },
      { status: 422 },
    );
  }

  const actualSavedDraftFingerprint = draft.savedDraftFingerprint || videoPromptDraftFingerprint(draft.sourceHash || null, draft);
  if (expectedSavedDraftFingerprint && expectedSavedDraftFingerprint !== actualSavedDraftFingerprint && !force) {
    return savedDraftChangedResponse(expectedSavedDraftFingerprint, actualSavedDraftFingerprint);
  }

  const currentSourceHash = computeVideoPromptSourceHash({ project, groupIdx, ownerId: user.id });
  const shotIndices = storyboardShotIndices(project as any, groupIdx, sb, { mode: 'single-shot-strict' });
  const gateStoryboards = [...storyboards];
  gateStoryboards[groupIdx] = { ...sb, videoPrompt: content };
  const gate = validateCharacterConsistencyForGroup(
    { ...(project as any), storyboards: gateStoryboards },
    { groupIdx, shotIndices, target: 'videoPrompt' },
  );
  if (gate.blockers?.length) return gateBlockResponse(gate);

  const result = applyVideoPromptWrite({
    projectId,
    userId: user.id,
    groupIdx,
    prompt: content,
    sourceHash: currentSourceHash,
    ownership: 'takeover',
    writeKind: 'commit_draft',
    shotIndices,
    consistency: {
      characterUsages: gate.characterUsages,
      score: gate.score,
      level: gate.level,
      warnings: gate.warnings,
    },
  });

  if (!result.applied) {
    return Response.json(
      { error: '视频提示词草稿提交失败。', code: 'VIDEO_PROMPT_DRAFT_COMMIT_FAILED', reason: result.skippedReason },
      { status: 409 },
    );
  }

  return jsonOk({
    ok: true,
    videoPrompt: content,
    videoPromptSourceHash: currentSourceHash,
    videoPromptRunId: result.runId,
    projectUpdatedAt: (result.project as any)?.updatedAt || null,
    gate,
  });
}
