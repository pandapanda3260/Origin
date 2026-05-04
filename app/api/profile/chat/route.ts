import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, chatComplete, parseJsonLoose } from '@/lib/llm';
import { getJson, setJson } from '@/lib/kv-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_PERSONA = `你是创作偏好研究员。通过简短对话弄清用户的创作风格倾向（视觉/叙事/镜头/情绪/提示词习惯），
每轮回复保持 ≤120 字，多用反问与示例帮用户自己说清楚。
只输出给用户看的自然语言正文，不要输出 <step>、XML 标签、JSON 或 markdown。`;

const SP_PERSONA_DERIVE = `根据下面对话历史，提炼出用户的创作偏好画像，输出严格 JSON：
{
  "visualStyle": "视觉风格倾向（30-60 字）",
  "narrativeStyle": "叙事风格倾向（30-60 字）",
  "cameraStyle": "镜头偏好（30-60 字）",
  "moodStyle": "情绪基调倾向（30-60 字）",
  "promptHabits": "提示词写作习惯（30-60 字）"
}
没有充分证据的字段填空字符串。`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const userMsg: string = (body.message || body.text || '').toString();
  const cur: any = getJson('user_profiles', user.id, {
    visualStyle: '', narrativeStyle: '', cameraStyle: '', moodStyle: '', promptHabits: '',
    rawDialog: [], updatedAt: null,
  });
  const dialog = Array.isArray(cur.rawDialog) ? cur.rawDialog : [];

  return sseResponse(async (writer) => {
    let buf = '';
    await chatStream(
      user,
      [
        { role: 'system', content: SP_PERSONA },
        ...dialog.map((m: any) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMsg },
      ],
      { temperature: 0.7, maxTokens: 600, modelRole: 'brain' },
      (d) => {
        buf += d;
        writer.chunk(d);
      },
    );
    buf = stripStepTags(buf).trim();

    const newDialog = [...dialog, { role: 'user', content: userMsg }, { role: 'assistant', content: buf.trim() }];
    let persona = { ...cur };

    // 每 4 轮自动提炼一次画像
    if (newDialog.length >= 4 && newDialog.length % 4 === 0) {
      try {
        const raw = await chatComplete(
          user,
          [
            { role: 'system', content: SP_PERSONA_DERIVE },
            { role: 'user', content: JSON.stringify(newDialog.slice(-12)) },
          ],
          {
            temperature: 0.3,
            responseFormat: 'json_object',
            maxTokens: 700,
            modelRole: 'structured',
            reasoningEffort: 'medium',
            requestTimeoutMs: 12_000,
          },
        );
        const j = parseJsonLoose(raw);
        persona = { ...persona, ...j };
      } catch (_) {}
    }

    persona.rawDialog = newDialog;
    persona.updatedAt = new Date().toISOString();
    setJson('user_profiles', user.id, persona);

    writer.done({ reply: buf.trim(), profile: persona, persona });
  });
}

function stripStepTags(text: string): string {
  return String(text || '').replace(/<step>[^<]*<\/step>\s*/gi, '').trim();
}
