import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete } from '@/lib/llm';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_REBUILD = `你是 AI 视频/图像生成提示词工程师。请把用户给的"草稿"提示词重写得更精准、更结构化，
保持同样语种，控制长度（视频提示词不超过 800 词，图像不超过 200 词），不要解释。`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const text: string = (body.text || body.prompt || '').toString();
  const projectId = String(body.projectId || '').trim();
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  if (!text) return jsonError('缺 text', 400);

  let rebuilt = '';
  try {
    rebuilt = await chatComplete(
      user,
      [
        { role: 'system', content: SP_REBUILD },
        { role: 'user', content: text },
      ],
      {
        temperature: 0.4,
        maxTokens: 1500,
        modelRole: 'structured',
        traceName: 'prompt.rebuild',
        tokenContext: {
          projectId: project ? projectId : null,
          projectTitleSnapshot: (project as any)?.title || null,
          requestPath: req.nextUrl.pathname,
          routeName: 'prompt.rebuild',
          moduleKey: 'prompt',
          moduleLabel: '提示词',
          featureKey: 'prompt_rebuild',
          featureLabel: '提示词重写',
          callItemType: 'project',
          callItemId: project ? projectId : null,
          callItemLabel: (project as any)?.title || null,
        },
      },
    );
  } catch (e: any) {
    return jsonError('重建失败：' + (e?.message || String(e)), 502);
  }
  return jsonOk({ prompt: rebuilt.trim().replace(/^["'`]|["'`]$/g, '') });
}
