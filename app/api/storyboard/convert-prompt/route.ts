import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatStream } from '@/lib/llm';
import { sseResponse } from '@/lib/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单条镜头 → 图像生成提示词
 *
 * 前端 storyboard.js 调 apiPostStream("/api/storyboard/convert-prompt", { shot, styleBible, assets, assetRefs, idx, imageUrls, creatorProfile })
 * 期待：SSE 流式 chunk + 最终 done.imagePrompt
 */

const SP_SHOT_TO_IMG_PROMPT = `你是分镜手稿（pre-production storyboard）提示词工程师。把"短视频镜头"翻译成英文提示词，最终会被画成**黑白铅笔分镜稿**（不是成片！不是照片！）。

【硬性要求】
- 全英文输出，不要中文，不要 markdown，不要 ["..."] 围栏
- 50-150 词
- 描述对象就是一张分镜稿，所以只描写：①主体（人物名 + 服装外观 + 表情/姿态）②动作（只描述这一帧定格的动作）③ 构图与景别（wide shot / medium / close-up / over-shoulder）④ 机位（low angle / high angle / eye-level / POV）⑤ 光照方向（key light from left / backlit / overhead / silhouette）⑥ 关键道具与场景元素（counter, fish trays, apron, clipboard 等）
- 如果 assets/assetRefs 里给了角色描述，必须保留外观/服装一致性（同一角色多个镜头里穿同样的衣服）

【禁止】
- 不要写 "photorealistic / cinematic film / 35mm / film grain / hyper-real / 4K / vivid color / teal-orange / saturated"——这些会破坏手稿风
- 不要写 "color palette / warm color tone"，分镜稿是黑白
- 不要写"运镜动词"作为单独陈述（如 "the camera slowly pushes in"），改用"frame composition implies a slow push-in"或直接给静止构图
- 不要写台词或字幕
- 不要写 "three-view" 或 "white background"（那是资产图，不是分镜图）
- 不要解释，不要复述中文，不要写"Description:"前缀，直接输出 prompt 段落`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response(
      `data: ${JSON.stringify({ type: 'error', error: 'unauthorized' })}\n\n`,
      { status: 401, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const shot = body.shot || null;
  const styleBible = body.styleBible || null;
  const assets = body.assets || null;
  const assetRefs: any[] = Array.isArray(body.assetRefs) ? body.assetRefs : [];
  const idx: number = typeof body.idx === 'number' ? body.idx : 0;
  // creatorProfile 暂未用到，预留参数

  return sseResponse(async (writer) => {
    if (!shot) {
      writer.error('缺 shot 数据');
      return;
    }

    // 兼容老字段（万一某些镜头还是老 schema）
    const shotType = shot.shotType || shot.framing || '';
    const camera = shot.camera || shot.movement || '';
    const visual = shot.visual || shot.description || shot.desc || '';
    const dialogue = shot.dialogue || shot.dialog || '';
    const characters: string[] = Array.isArray(shot.characters) ? shot.characters : [];
    const keyInfo = shot.keyInfo || '';

    const styleHint = styleBible
      ? [
          styleBible.vision || styleBible.visualStyle,
          styleBible.colorPalette,
          styleBible.cameraStyle,
          styleBible.mood || styleBible.tone,
          styleBible.lighting,
        ].filter(Boolean).join('; ')
      : '';

    // 角色/场景上下文：优先 assetRefs（已经匹配到的），fallback 到 assets 全集筛选
    let charContext = '';
    if (assetRefs.length) {
      charContext = assetRefs
        .map((r: any) => {
          const desc = r.appearance || r.description || r.detail || '';
          const cloth = r.clothing ? `, clothing: ${r.clothing}` : '';
          return `${r.name || r.role}: ${desc}${cloth}`.trim();
        })
        .filter(Boolean)
        .join(' | ');
    } else if (assets && characters.length) {
      const allChars = (assets.characters || []) as any[];
      charContext = characters
        .map((nm) => allChars.find((c) => c.name === nm || c.role === nm))
        .filter(Boolean)
        .map((c: any) => {
          const desc = c.appearance || c.description || c.detail || '';
          const cloth = c.clothing ? `, clothing: ${c.clothing}` : '';
          return `${c.name || c.role}: ${desc}${cloth}`.trim();
        })
        .join(' | ');
    }

    const userMsg = [
      `镜头序号：${shot.idx ?? idx + 1}`,
      shotType && `景别：${shotType}`,
      camera && `运镜：${camera}`,
      visual && `画面描述：${visual}`,
      dialogue && dialogue !== '——' && `台词/旁白：${dialogue}`,
      keyInfo && `主题词：${keyInfo}`,
      charContext && `本镜头出现的角色（必须保留外观/服装一致性）：${charContext}`,
      styleHint && `整体视觉风格：${styleHint}`,
    ].filter(Boolean).join('\n');

    let promptText = '';
    try {
      writer.step('正在分析镜头…');
      await chatStream(
        user,
        [
          { role: 'system', content: SP_SHOT_TO_IMG_PROMPT },
          { role: 'user', content: userMsg },
        ],
        { temperature: 0.5, maxTokens: 600, modelRole: 'structured' },
        (delta) => {
          promptText += delta;
          writer.chunk(delta);
        },
      );
    } catch (e: any) {
      writer.error('提示词生成失败：' + (e?.message || String(e)));
      return;
    }

    const cleaned = promptText.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!cleaned) {
      writer.error('AI 没有返回提示词，请稍后重试');
      return;
    }

    writer.done({ imagePrompt: cleaned, idx });
  });
}
