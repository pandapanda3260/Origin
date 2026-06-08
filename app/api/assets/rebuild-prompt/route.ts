import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete } from '@/lib/llm';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { sanitizePromptObject } from '@/lib/content-sanitize';
import { appendCharacterCastingPrompt, omitCastingProfileFromStyleBible } from '@/lib/casting-profile';
import { isAnonymousCrowdAsset } from '@/lib/crowd-character';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单卡"重新生成参考图"前会先调这里重写 imagePrompt——风格 / 白底 / 三视图 /
 * 场景单图这些约束统一由 lib/image-gen.ts 的 forceStyleSuffix 兜底，所以这里只
 * 写"主体本身"，**不要**再写 style/lighting/background 关键词，否则会和
 * forceStyleSuffix 打架（"warm lighting" vs "neutral studio lighting"），
 * 导致出图风格漂移。
 */
const SP_REBUILD = `你是 AI 图像生成提示词工程师，专为"白底+写实摄影"参考图（角色四宫格 / 场景单图 / 道具白底产品图）写中文 prompt。

【任务】根据用户给的资产数据，重写一段 80-220 字的中文 imagePrompt。

【硬性要求】
- 中文为主，纯文本，**不要** markdown 围栏 / 不要"prompt:"前缀 / 不要解释。
- 允许保留少量必要专有术语、模型名、比例或焦段，但不要整段英文。
- 只描述"主体本身"——长什么样、穿什么、什么形态、什么动作、什么材质、什么陈设。
- **绝不要写**：cinematic / illustration / anime / cartoon / warm lighting / studio backdrop / white background / three-view / model sheet / multi-panel layout / split-screen / grid——这些都由后台统一加。
- **绝不要写**画面构图 / 镜头机位 / 光线方向（场景级元数据 timeSetting/atmosphere 由后台拼到 prompt 末尾，不在你这里写）。

【场景特别注意】
- 如果资产是 scene（环境），用户的 item.timeSetting / item.atmosphere / item.weather / item.lighting 已经会被后台拼到末尾去强制图像反映，**你不要在自己这段 prompt 里复写**这些（避免冲突）。
- 你只描述"这个空间长什么样"——建筑/家具/陈设/材质/物品布局。
- 默认不要写可读文字、招牌字、标签或 logo；除非用户资产数据里明确要求出现某几个字。若明确要求，必须保留那些 exact words，不要添加任何额外文字。

【角色特别注意】
- 描述外貌（年龄/性别/体型/发型/神态/姿态）+ 服装（颜色/材质/版型）+ 手持物。
- 不写中国人/欧美人/白人/东亚人/华人/外国人等人群身份，也不写 ethnicity、race、Chinese face、Caucasian face、skin tone；人物 casting 由系统统一注入。
- 不要写"facing camera / standing pose / neutral expression"——这些由后台四宫格 layout 统一指定。

直接输出 prompt 段落。`;

const SP_REBUILD_CROWD = `你是 AI 图像生成提示词工程师，专为"匿名群体"参考图写中文 prompt。

【任务】根据用户给的群像资产数据，重写一段 80-220 字的中文 imagePrompt。

【硬性要求】
- 中文为主，纯文本，不要 markdown 围栏 / 不要"prompt:"前缀 / 不要解释。
- 只描述群体本身：人群规模、密度、年龄段、服装系统、姿态分布、神态分布、集体气质、随身物。
- 不写单个具名成员，不写"同一个人"，不写需要锁定某张脸的描述。
- 明确表达人脸/个体应自然多样，但服装、时代、职业或阵营基调统一。
- 不写风格、光线、背景、三视图、四视图、reference sheet、split-screen、grid、model sheet。
- 不写中国人/欧美人/白人/东亚人/华人/外国人等人群身份；人物 casting 由系统统一注入。

直接输出 prompt 段落。`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const target: string = (body.targetType || body.kind || body.type || 'character').toString();
  const item: any = sanitizePromptObject(body.item || body);
  const rawStyleBible: any = sanitizePromptObject(body.styleBible || null);
  const styleBible: any = omitCastingProfileFromStyleBible(rawStyleBible);

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
        { role: 'system', content: (target === 'char' || target === 'character') && isAnonymousCrowdAsset(item) ? SP_REBUILD_CROWD : SP_REBUILD },
        { role: 'user', content: ctx.join('\n\n') },
      ],
      { temperature: 0.5, maxTokens: 400, modelRole: 'structured' },
    );
  } catch (e: any) {
    return jsonError('提示词生成失败：' + (e?.message || String(e)), 502);
  }

  let cleaned = prompt.trim().replace(/^["'`]|["'`]$/g, '');
  if (target === 'char' || target === 'character') {
    cleaned = appendCharacterCastingPrompt(cleaned, item, rawStyleBible);
  }
  // 同时返回 prompt 和 imagePrompt 两个字段，前端两种调用方式都能拿到
  return jsonOk({ prompt: cleaned, imagePrompt: cleaned });
}
