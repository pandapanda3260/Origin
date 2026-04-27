import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildAgentMessages } from '@/lib/prompts';
import { getProjectByIdForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const userMsg: string = (body.message || body.text || '').toString();
  const refs: any[] = Array.isArray(body.refs) ? body.refs : [];
  if (!userMsg.trim()) {
    return new Response(JSON.stringify({ detail: '消息不能为空' }), { status: 400 });
  }
  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;

  return sseResponse(async (writer) => {
    writer.step('Creative Agent 思考中…');
    let buf = '';
    await chatStream(
      user,
      buildAgentMessages({ project: proj, refs, userMsg }),
      { temperature: 0.5, maxTokens: 1000 },
      (delta) => {
        buf += delta;
        writer.chunk(delta);
      },
    );

    // 解析 [PATCH] 行（可选）
    const patches: any[] = [];
    const patchLine = buf.match(/^\[PATCH\][^\n]*$/m);
    if (patchLine) {
      patches.push({ raw: patchLine[0] });
    }

    writer.done({ reply: buf.trim(), patches });
  });
}
