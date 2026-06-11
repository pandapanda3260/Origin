import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatStream } from '@/lib/llm';
import { sseResponse } from '@/lib/sse';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { styleBibleForShotPrompt } from '@/lib/casting-profile';
import { resolveShotFieldsForPrompt } from '@/lib/shot-plan-normalize';
import { formatWorldContextForPrompt, projectWorldContextForStage } from '@/lib/world-template-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单条镜头 → 图像生成提示词
 *
 * 前端 storyboard.js 调 apiPostStream("/api/storyboard/convert-prompt", { shot, styleBible, assets, assetRefs, idx, imageUrls, creatorProfile })
 * 期待：SSE 流式 chunk + 最终 done.imagePrompt
 */

const SP_SHOT_TO_IMG_PROMPT = `你是分镜手稿（pre-production storyboard）提示词工程师。把"短视频镜头"整理成中文画面提示词，最终会被画成**黑白铅笔分镜稿**（不是成片！不是照片！）。

【硬性要求】
- 中文为主输出，不要 markdown，不要 ["..."] 围栏
- 80-220 字
- 描述对象就是一张分镜稿，所以只描写：①主体（人物名 + 服装外观 + 表情/姿态）②动作（只描述这一帧定格的动作）③ 构图与景别（可保留 wide shot / medium / close-up / over-shoulder 等少量术语）④ 机位（可保留 low angle / high angle / eye-level / POV 等少量术语）⑤ 光照方向 ⑥ 关键道具与场景元素
- 如果 assets/assetRefs 里给了角色描述，必须保留外观/服装一致性（同一角色多个镜头里穿同样的衣服）

【禁止】
- 不要写 "photorealistic / cinematic film / 35mm / film grain / hyper-real / 4K / vivid color / teal-orange / saturated"——这些会破坏手稿风
- 不要写 "color palette / warm color tone"，分镜稿是黑白
- 不要写"运镜动词"作为单独陈述（如"镜头缓慢推进"），改成静止构图描述，例如"构图暗示纵深推进感"
- 不要写台词或字幕
- 不要写 "three-view" 或 "white background"（那是资产图，不是分镜图）
- 不要解释，不要复述输入，不要写"提示词："前缀，直接输出中文 prompt 段落`;

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
  const styleBible = styleBibleForShotPrompt(body.styleBible || null);
  const assets = body.assets || null;
  const assetRefs: any[] = Array.isArray(body.assetRefs) ? body.assetRefs : [];
  const idx: number = typeof body.idx === 'number' ? body.idx : 0;
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  // creatorProfile 暂未用到，预留参数

  return sseResponse(async (writer) => {
    if (!shot) {
      writer.error('缺 shot 数据');
      return;
    }

    // 兼容新老字段。旧 shotType=俯拍/主观/过肩 会在这里读成 angle，shotType 回落到景别。
    const shotFields = resolveShotFieldsForPrompt(shot, styleBible);
    const shotType = shotFields.shotType;
    const angle = shotFields.angle;
    const lens = shotFields.lens;
    const focus = shotFields.focus;
    const light = shotFields.light;
    const composition = shotFields.composition;
    const camera = shotFields.camera;
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

    const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
    const worldContext = projectWorldContextForStage('storyboard_sketch_prompt', (project as any)?.worldTemplateSnapshot, {
      project,
      target: { shot, idx },
    });
    const worldText = formatWorldContextForPrompt(worldContext);

    const userMsg = [
      `镜头序号：${shot.idx ?? idx + 1}`,
      shotType && `景别：${shotType}`,
      angle && `角度/视点：${angle}`,
      lens && `焦距：${lens}`,
      focus && `景深/焦点：${focus}`,
      light && `光线组合：${light}`,
      composition && `构图组合：${composition}`,
      camera && `运镜：${camera}`,
      visual && `画面描述：${visual}`,
      dialogue && dialogue !== '——' && `台词/旁白：${dialogue}`,
      keyInfo && `主题词：${keyInfo}`,
      charContext && `本镜头出现的角色（必须保留外观/服装一致性）：${charContext}`,
      styleHint && `整体视觉风格：${styleHint}`,
      worldText && `分镜稿参考的世界观事实与软默认：\n${worldText}`,
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
        {
          temperature: 0.5,
          maxTokens: 600,
          modelRole: 'structured',
          traceName: 'storyboard.convert-prompt',
          tokenContext: {
            projectId: project ? projectId || null : null,
            projectTitleSnapshot: (project as any)?.title || null,
            requestPath: req.nextUrl.pathname,
            routeName: 'storyboard.convert-prompt',
            moduleKey: 'storyboard',
            moduleLabel: '分镜图',
            featureKey: 'storyboard_image_prompt_convert',
            featureLabel: '分镜图提示词生成',
            callItemType: 'shot',
            callItemId: String(shot?.id || shot?.uid || idx),
            callItemLabel: `镜头 ${shot.idx ?? idx + 1}`,
          },
        },
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

    if (projectId) {
      try {
        if (project) {
          const context = buildKnowledgeContextForStage({
            ownerId: user.id,
            project: {
              ...(project as any),
              id: projectId,
            },
            stage: 'storyboard_sketch_prompt',
            stageTarget: {
              idx,
              shotIdx: shot.idx ?? idx + 1,
              shotType,
              camera,
              assetRefCount: assetRefs.length,
              hasStyleBible: !!styleBible,
            },
          });
          recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context });
        }
      } catch (error) {
        console.warn('[storyboard/convert-prompt] knowledge context audit skipped:', error);
      }
    }

    writer.done({ imagePrompt: cleaned, idx });
  });
}
