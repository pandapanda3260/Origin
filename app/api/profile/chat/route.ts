import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, chatComplete, parseJsonLoose } from '@/lib/llm';
import { getJson, setJson } from '@/lib/kv-db';
import { DEFAULT_CREATOR_PROFILE, normalizeCreatorProfile } from '@/lib/creator-profile';

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
  const cur = normalizeCreatorProfile(getJson('user_profiles', user.id, DEFAULT_CREATOR_PROFILE));
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
    let persona = normalizeCreatorProfile(cur);

    // 画像为空时立即补提炼；之后降低频率，避免 gpt-5.4-pro 结构化调用频繁阻塞聊天。
    if (newDialog.length >= 4 && (!hasProfileFields(persona) || newDialog.length % 12 === 0)) {
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
            modelRole: 'profileDerive',
            requestTimeoutMs: 45_000,
          },
        );
        const j = parseJsonLoose(raw);
        persona = normalizeCreatorProfile({ ...persona, ...j });
      } catch (e: any) {
        console.warn('[profile/chat] persona derive failed:', e?.message || String(e));
      }
    }

    const now = new Date().toISOString();
    persona = normalizeCreatorProfile({ ...persona, rawDialog: newDialog, updatedAt: now, lastUpdated: now });
    setJson('user_profiles', user.id, persona);

    writer.done({ reply: buf.trim(), profile: persona, persona });
  });
}

function stripStepTags(text: string): string {
  return String(text || '').replace(/<step>[^<]*<\/step>\s*/gi, '').trim();
}

function hasProfileFields(profile: any): boolean {
  const p = normalizeCreatorProfile(profile);
  return Boolean(
    p.visualStyle || p.narrativeStyle || p.cameraStyle || p.moodStyle || p.promptHabits || p.duration || p.freeText,
  );
}
