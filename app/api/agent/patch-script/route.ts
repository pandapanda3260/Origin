import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete } from '@/lib/llm';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_PATCH = `你是剧本编辑助手。给你"原剧本"和"修改意图"，请返回修改后的【完整剧本】，
保持五段式结构（铺垫/升温/高潮/回落/余韵）和总时长不变。
直接输出新剧本，不要解释、不要 markdown 围栏。`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const intent: string = (body.intent || body.instruction || '').toString();
  const targetField: string = (body.targetField || 'script').toString();

  if (!projectId) return jsonError('缺 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  if (!intent) return jsonError('缺修改意图', 400);

  const baseScript = (proj as any).scriptDraft || (proj as any).script || '';
  if (!baseScript) return jsonError('当前没有剧本', 400);

  let next = '';
  try {
    next = await chatComplete(
      user,
      [
        { role: 'system', content: SP_PATCH },
        { role: 'user', content: `原剧本：\n${baseScript}\n\n修改意图：${intent}` },
      ],
      { temperature: 0.6, maxTokens: 3500, modelRole: 'brain' },
    );
  } catch (e: any) {
    return jsonError('修改失败：' + (e?.message || String(e)), 502);
  }

  const updated: any = {};
  updated[targetField === 'scriptDraft' ? 'scriptDraft' : 'script'] = next;
  updated.scriptDraft = next; // 保险起见两边都写
  updated.script = next;
  updateProjectForUser(projectId, user.id, updated);

  return jsonOk({ ok: true, script: next });
}
