import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildConsultMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const userMsg: string = (body.message || body.userMsg || body.text || '').toString();
  const projectId: string | undefined = body.projectId;

  if (!userMsg.trim()) {
    return new Response(JSON.stringify({ detail: '消息不能为空' }), { status: 400 });
  }

  // 取项目里已有的咨询历史（如果有）
  let history: { role: 'user' | 'assistant'; content: string }[] = [];
  if (projectId) {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (proj) {
      const consult = (proj as any).scriptConsult || {};
      history = Array.isArray(consult.messages) ? consult.messages : [];
    }
  }

  return sseResponse(async (writer) => {
    writer.step('正在分析意图…');
    let buf = '';
    const messages = buildConsultMessages(history, userMsg);
    await chatStream(user, messages, { temperature: 0.6, maxTokens: 800 }, (delta) => {
      buf += delta;
      writer.chunk(delta);
    });

    // 检查 [READY] 标志，前端据此判断"够不够生成完整剧本"
    const readyIdx = buf.indexOf('[READY]');
    const ready = readyIdx >= 0;
    const outline = ready ? buf.slice(readyIdx + '[READY]'.length).trim() : '';
    const replyMain = ready ? buf.slice(0, readyIdx).trim() : buf.trim();

    // 把这一轮对话写回项目
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (proj) {
        const existing = (proj as any).scriptConsult || { messages: [] };
        const newMessages = [
          ...(existing.messages || []),
          { role: 'user' as const, content: userMsg },
          { role: 'assistant' as const, content: buf.trim() },
        ];
        updateProjectForUser(projectId, user.id, {
          scriptConsult: {
            messages: newMessages,
            outline: ready ? outline : (existing.outline || ''),
            ready,
          },
        });
      }
    }

    writer.done({
      reply: replyMain,
      outline,
      ready,
      // 用户本轮消息直接含"确认/可以/直接生成"等意图时，前端会自动触发 confirm
      shouldAutoTrigger: ready && /(确认|可以|直接.{0,3}生成|开始|就这样|没问题)/.test(userMsg),
    });
  });
}
