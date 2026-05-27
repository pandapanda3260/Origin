import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';
import { validateCharacterConsistencyForGroup } from '@/lib/character-consistency-gate';
import {
  applyVideoPromptWrite,
  computeVideoPromptSourceHash,
  normalizeVideoPromptContent,
} from '@/lib/video-prompt-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseSnapshot(value: unknown) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function gateBlockResponse(gate: any) {
  return Response.json(
    {
      error: '历史视频提示词角色一致性检查未通过。',
      code: 'VIDEO_PROMPT_CONSISTENCY_BLOCKED',
      blockers: gate.blockers || [],
      warnings: gate.warnings || [],
    },
    { status: 422 },
  );
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx ?? body?.targetGroupIdx);
  const taskId = String(body?.taskId || body?.videoTaskId || '').trim();
  const confirmLegacy = body?.confirmLegacy === true;

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (!taskId) return jsonError('缺 taskId', 400);

  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>(
      `SELECT id, project_id, group_idx, prompt, status, video_prompt_snapshot_json
       FROM video_tasks
       WHERE id = @id AND owner_id = @uid
       LIMIT 1`,
    )
    .get({ id: taskId, uid: user.id });
  if (!row) return jsonError('历史视频不存在', 404);
  if (row.status !== 'completed') {
    return Response.json(
      { error: '只能从已完成的视频历史中替换提示词。', code: 'video_history_not_completed' },
      { status: 422 },
    );
  }
  if (String(row.project_id || '') !== projectId) {
    return Response.json(
      { error: '历史视频不属于当前项目，不能直接替换当前片段提示词。', code: 'history_project_mismatch' },
      { status: 422 },
    );
  }

  const parsedSnapshot = parseSnapshot(row.video_prompt_snapshot_json);
  const snapshot = normalizeVideoPromptContent(parsedSnapshot?.content)
    ? parsedSnapshot
    : {
        content: row.prompt || '',
        sourceHash: null,
        legacy: true,
      };
  const content = normalizeVideoPromptContent(snapshot.content);
  if (!content) {
    return Response.json(
      { error: '历史视频没有可用的视频提示词快照。', code: 'missing_video_prompt_snapshot' },
      { status: 404 },
    );
  }
  if (snapshot.legacy && !confirmLegacy) {
    return Response.json(
      {
        error: '该历史视频来自旧版本，提示词可能被截断，请确认后再替换。',
        code: 'legacy_snapshot_confirmation_required',
      },
      { status: 409 },
    );
  }

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);
  const storyboards = Array.isArray((project as any).storyboards) ? [...(project as any).storyboards] : [];
  const sb = storyboards[groupIdx];
  if (!sb) return jsonError(`片段 ${groupIdx + 1} 不存在`, 404);

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
    writeKind: 'apply_history',
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
      { error: '替换历史视频提示词失败。', code: 'VIDEO_PROMPT_APPLY_HISTORY_FAILED', reason: result.skippedReason },
      { status: 409 },
    );
  }

  return jsonOk({
    ok: true,
    videoPrompt: content,
    videoPromptSourceHash: currentSourceHash,
    videoPromptRunId: result.runId,
    sourceTaskId: taskId,
    sourceSnapshotLegacy: !!snapshot.legacy,
    projectUpdatedAt: (result.project as any)?.updatedAt || null,
    gate,
  });
}
