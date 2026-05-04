import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete, parseJsonLoose } from '@/lib/llm';
import { buildRetagMessages } from '@/lib/prompts';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const scriptText: string = (body.script || '').toString();
  const durationSec: number | undefined = body.durationSec;

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const finalScript = scriptText || (proj as any)?.scriptDraft || (proj as any)?.script || '';
  if (!finalScript) return jsonError('当前没有剧本可分析', 400);

  let emotions: any[] = [];
  try {
    const raw = await chatComplete(
      user,
      buildRetagMessages(finalScript, durationSec || (proj as any)?.scriptTargetDurationSec),
      { temperature: 0.4, responseFormat: 'json_object', maxTokens: 800, modelRole: 'structured' },
    );
    const json = parseJsonLoose<{ emotions: any[] }>(raw);
    emotions = Array.isArray(json?.emotions) ? json.emotions : [];
  } catch (e: any) {
    return jsonError('情绪标签生成失败：' + (e?.message || String(e)), 502);
  }

  if (projectId && proj) {
    updateProjectForUser(projectId, user.id, { emotions });
  }
  return jsonOk({ emotions });
}
