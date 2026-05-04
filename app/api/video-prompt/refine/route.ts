import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildRefineMessages } from '@/lib/prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const currentPrompt: string = (body.currentPrompt || body.prompt || '').toString();
  const instruction: string = (body.instruction || body.intent || '').toString();
  if (!currentPrompt || !instruction) {
    return new Response(JSON.stringify({ detail: '缺 currentPrompt 或 instruction' }), { status: 400 });
  }

  return sseResponse(async (writer) => {
    writer.step('正在微调提示词…');
    let buf = '';
    try {
      await chatStream(
        user,
        buildRefineMessages(currentPrompt, instruction),
        { temperature: 0.5, maxTokens: 1500, modelRole: 'brain' },
        (delta) => {
          buf += delta;
          writer.chunk(delta);
        },
      );
    } catch (e: any) {
      writer.error('微调失败：' + (e?.message || String(e)));
      return;
    }
    writer.done({ videoPrompt: buf.trim() });
  });
}
