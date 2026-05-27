import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';
import {
  applyVideoPromptWrite,
  normalizeVideoPromptContent,
} from '@/lib/video-prompt-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  const storyboards = Array.isArray((project as any).storyboards) ? (project as any).storyboards : [];
  const sb = storyboards[groupIdx];
  if (!sb) return jsonError(`片段 ${groupIdx + 1} 不存在`, 404);

  const backup = sb.videoPromptBackup || null;
  const content = normalizeVideoPromptContent(backup?.content);
  if (!content) {
    return Response.json(
      { error: '没有可恢复的视频提示词备份。', code: 'missing_video_prompt_backup' },
      { status: 404 },
    );
  }

  const shotIndices = storyboardShotIndices(project as any, groupIdx, sb, { mode: 'single-shot-strict' });
  const result = applyVideoPromptWrite({
    projectId,
    userId: user.id,
    groupIdx,
    prompt: content,
    sourceHash: typeof backup.sourceHash === 'string' ? backup.sourceHash : null,
    ownership: 'takeover',
    writeKind: 'restore_backup',
    shotIndices,
  });

  if (!result.applied) {
    return Response.json(
      { error: '恢复视频提示词失败。', code: 'VIDEO_PROMPT_RESTORE_FAILED', reason: result.skippedReason },
      { status: 409 },
    );
  }

  return jsonOk({
    ok: true,
    videoPrompt: content,
    videoPromptSourceHash: result.sourceHash,
    videoPromptRunId: result.runId,
    projectUpdatedAt: (result.project as any)?.updatedAt || null,
  });
}
