import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk, noStoreHeaders } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { buildVideoPromptAudit } from '@/lib/video-prompt-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseBoolean(value: string | null): boolean | undefined {
  if (value == null || value === '') return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

function parseShotIndices(value: string | null): number[] | undefined {
  if (!value) return undefined;
  const indices = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return indices.length ? indices : undefined;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') || '';
  if (!projectId) return jsonError('缺 projectId', 400);

  const groupIdx = Number(url.searchParams.get('groupIdx') || '0');
  if (!Number.isInteger(groupIdx) || groupIdx < 0) return jsonError('groupIdx 无效', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  try {
    const audit = buildVideoPromptAudit(user, project, groupIdx, {
      ratio: url.searchParams.get('ratio') || undefined,
      quality: url.searchParams.get('quality') || undefined,
      videoModel: url.searchParams.get('videoModel') || undefined,
      genAudio: parseBoolean(url.searchParams.get('genAudio')),
      watermark: parseBoolean(url.searchParams.get('watermark')),
      shotIndices: parseShotIndices(url.searchParams.get('shotIndices')),
    });
    return jsonOk({ audit }, { headers: noStoreHeaders });
  } catch (e: any) {
    return jsonError(e?.message || '提示词审计信息生成失败', 400);
  }
}
