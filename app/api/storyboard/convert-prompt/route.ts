import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete } from '@/lib/llm';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_SB_CONVERT = `你是 AI 图像生成提示词工程师。请把用户给的"分镜画面描述"转成可直接喂给图像模型的提示词。
要求：
- 全英文
- 包含主体、动作、构图、镜头视角、光线、色调、风格关键词
- 风格基调结合用户给的 styleBible
- 不超过 200 词，不要解释、不要 markdown 围栏，直接输出提示词`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const description: string = (body.description || body.text || '').toString();
  const styleBible: any = body.styleBible || null;
  if (!description) return jsonError('缺 description', 400);

  const ctx = [`画面描述：${description}`];
  if (styleBible) ctx.push(`风格圣经：${JSON.stringify(styleBible)}`);

  try {
    const prompt = await chatComplete(
      user,
      [
        { role: 'system', content: SP_SB_CONVERT },
        { role: 'user', content: ctx.join('\n\n') },
      ],
      { temperature: 0.4, maxTokens: 500 },
    );
    return jsonOk({ prompt: prompt.trim().replace(/^["'`]|["'`]$/g, '') });
  } catch (e: any) {
    return jsonError('提示词转换失败：' + (e?.message || String(e)), 502);
  }
}
