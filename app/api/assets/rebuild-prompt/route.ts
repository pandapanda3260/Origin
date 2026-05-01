import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete } from '@/lib/llm';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单卡"重新生成参考图"前会先调这里重写 imagePrompt——风格 / 白底 / 三视图 /
 * 六宫格这些约束统一由 lib/image-gen.ts 的 forceStyleSuffix 兜底，所以这里只
 * 写"主体本身"，**不要**再写 style/lighting/background 关键词，否则会和
 * forceStyleSuffix 打架（"warm lighting" vs "neutral studio lighting"），
 * 导致出图风格漂移。
 */
const SP_REBUILD = `你是 AI 图像生成提示词工程师，专为"白底+写实摄影"参考图（角色四宫格 / 场景六宫格 / 道具白底产品图）写英文 prompt。

【任务】根据用户给的资产数据，重写一段 60-150 词的英文 imagePrompt。

【硬性要求】
- 全英文，纯文本，**不要** markdown 围栏 / 不要"prompt:"前缀 / 不要解释。
- 只描述"主体本身"——长什么样、穿什么、什么形态、什么动作、什么材质、什么陈设。
- **绝不要写**：cinematic / illustration / anime / cartoon / warm lighting / studio backdrop / white background / three-view / model sheet / six-panel grid——这些都由后台统一加。
- **绝不要写**画面构图 / 镜头机位 / 光线方向（场景级元数据 timeSetting/atmosphere 由后台拼到 prompt 末尾，不在你这里写）。

【场景特别注意】
- 如果资产是 scene（环境），用户的 item.timeSetting / item.atmosphere / item.weather / item.lighting 已经会被后台拼到末尾去强制图像反映，**你不要在自己这段 prompt 里复写**这些（避免冲突）。
- 你只描述"这个空间长什么样"——建筑/家具/陈设/材质/物品布局。

【角色特别注意】
- 描述外貌（年龄/性别/体型/面孔/发型/肤色）+ 服装（颜色/材质/版型）+ 手持物。
- 不要写"facing camera / standing pose / neutral expression"——这些由后台四宫格 layout 统一指定。

直接输出 prompt 段落。`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const target: string = (body.targetType || body.kind || body.type || 'character').toString();
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

  const cleaned = prompt.trim().replace(/^["'`]|["'`]$/g, '');
  // 同时返回 prompt 和 imagePrompt 两个字段，前端两种调用方式都能拿到
  return jsonOk({ prompt: cleaned, imagePrompt: cleaned });
}
