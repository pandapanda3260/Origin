import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import { buildStyleBibleMessages } from '@/lib/prompts';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const scriptText: string = (body.script || body.scriptText || '').toString();

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const finalScript = scriptText || (proj as any)?.scriptDraft || (proj as any)?.script || '';
  if (!finalScript) return jsonError('当前没有剧本可分析', 400);

  let styleBible: any = null;
  try {
    styleBible = await chatCompleteJsonWithRetry(
      user,
      buildStyleBibleMessages(finalScript),
      { temperature: 0.4, maxTokens: 2500 },
      (raw) => parseJsonLoose(raw),
      'styleBible',
    );
  } catch (e: any) {
    return jsonError('风格圣经生成失败：' + (e?.message || String(e)), 502);
  }

  if (projectId && proj) {
    updateProjectForUser(projectId, user.id, { styleBible });
  }
  return jsonOk({ styleBible });
}
