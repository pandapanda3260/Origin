import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete } from '@/lib/llm';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_REBUILD = `你是 AI 图像生成提示词工程师。根据用户给的角色/场景/道具描述，写一段不超过 150 词的英文图像生成提示词，包含主体、构图、光线、风格关键词。
直接输出提示词，不要任何解释、不要 markdown 围栏。`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const target: string = (body.targetType || body.kind || 'character').toString();
  const item: any = body.item || body;
  const styleBible: any = body.styleBible || null;

  if (!item) return jsonError('缺 item 字段', 400);

  const ctx = [
    `资产类型：${target}`,
    `资产数据：${JSON.stringify(item)}`,
  ];
  if (styleBible) ctx.push(`风格圣经：${JSON.stringify(styleBible)}`);

  let prompt = '';
  try {
    prompt = await chatComplete(
      user,
      [
        { role: 'system', content: SP_REBUILD },
        { role: 'user', content: ctx.join('\n\n') },
      ],
      { temperature: 0.5, maxTokens: 400 },
    );
  } catch (e: any) {
    return jsonError('提示词生成失败：' + (e?.message || String(e)), 502);
  }

  return jsonOk({ prompt: prompt.trim().replace(/^["'`]|["'`]$/g, '') });
}
