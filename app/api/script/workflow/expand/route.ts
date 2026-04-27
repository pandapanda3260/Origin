import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_EXPAND = `你是短视频编剧助理。请把现有剧本扩充得更丰满（多加细节描写、对白和镜头建议），但保持原有五段式结构（铺垫/升温/高潮/回落/余韵）和总时长不变。
回答必须用中文，不要 markdown 围栏，直接输出新的完整剧本。每段开头插入 <step>步骤名</step>。`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const currentScript: string = (body.script || '').toString();

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const baseScript = currentScript || (proj as any)?.scriptDraft || (proj as any)?.script || '';
  if (!baseScript) {
    return new Response(JSON.stringify({ detail: '当前没有剧本可扩充' }), { status: 400 });
  }

  return sseResponse(async (writer) => {
    writer.step('正在扩充剧本…');
    let buf = '';
    await chatStream(
      user,
      [
        { role: 'system', content: SP_EXPAND },
        { role: 'user', content: `当前剧本：\n${baseScript}` },
      ],
      { temperature: 0.7, maxTokens: 3500 },
      (delta) => {
        buf += delta;
        writer.chunk(delta);
      },
    );

    if (projectId && proj) {
      updateProjectForUser(projectId, user.id, {
        scriptDraft: buf,
        script: buf,
      });
    }

    writer.done({ script: buf, deltaTokens: Math.ceil(buf.length / 2) });
  });
}
