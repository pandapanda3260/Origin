/**
 * 批量任务的 3 个执行器（与原站 batchType 对齐）：
 *   1. asset_images       —— 给角色/场景/道具生成参考图
 *   2. storyboard_prompts —— 把镜头描述转成图像生成提示词（纯文本 LLM）
 *   3. storyboard_images  —— 给每个分镜组生成手稿风格分镜图
 *
 * 注册时机：lib/init-executors.ts 在 app 启动时调用一次。
 */

import { registerExecutor, type BatchExecCtx } from './batches';
import { generateImage } from './image-gen';
import { chatComplete } from './llm';
import { getProjectByIdForUser, updateProjectForUser } from './projects-db';

/* ============================================================
   helper：根据 target.{type, idx} 找到对应资产 + 构造提示词
   ============================================================ */
function resolveAssetTarget(project: any, target: any) {
  const type: 'char' | 'scene' | 'prop' = target.type;
  const idx: number = target.idx;
  const cat = type === 'char' ? 'characters' : type === 'scene' ? 'scenes' : 'props';
  const item =
    project?.assets?.[cat]?.[idx] ??
    (cat === 'characters' ? project?.characters?.[idx] :
     cat === 'scenes' ? project?.environments?.[idx] :
     project?.props?.[idx]);
  return { item, type, idx, cat };
}

function buildAssetPrompt(asset: any, type: string, styleBible: any): string {
  const sb = styleBible || {};
  const styleHint = [sb.vision, sb.colorPalette, sb.cameraStyle, sb.mood]
    .filter(Boolean)
    .join('; ');
  const base = (() => {
    if (type === 'char') {
      const tags = [asset.temperament, asset.actionTraits, ...(asset.tags || [])].filter(Boolean).join(', ');
      return `Character reference portrait: ${asset.name || 'unnamed'}.\n${asset.detail || asset.intro || ''}\nTags: ${tags}.\nFull-body or 3/4 view, neutral background, clean reference sheet style.`;
    }
    if (type === 'scene') {
      return `Environment / scene reference: ${asset.name || 'unnamed'}.\n${asset.description || ''}\nWide establishing shot, no people, atmospheric lighting.`;
    }
    return `Prop / object reference: ${asset.name || 'unnamed'}.\n${asset.features || ''}; type: ${asset.propType || ''}.\nIsolated on neutral background, studio product-shot style.`;
  })();
  return [base, styleHint && `Style: ${styleHint}`].filter(Boolean).join('\n');
}

/* ============================================================
   1. asset_images executor
   ============================================================ */
registerExecutor('asset_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const { item, type, idx, cat } = resolveAssetTarget(proj, ctx.target);
  if (!item) throw new Error(`找不到 ${cat}[${idx}]`);

  ctx.progress({ stage: 'building_prompt' });
  const prompt = item.imagePrompt || buildAssetPrompt(item, type, (proj as any).styleBible);

  ctx.progress({ stage: 'calling_image_api' });
  const result = await generateImage(ctx.user, {
    prompt,
    size: type === 'char' ? '1024x1536' : type === 'scene' ? '1536x1024' : '1024x1024',
    style: 'natural',
    kind: type === 'char' ? 'character' : type === 'scene' ? 'scene' : 'prop',
    projectId: ctx.projectId,
    assetRef: `${cat}[${idx}]`,
  });

  // 写回项目：把 imageUrl + imagePrompt 落到资产对象
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    const assets = (fresh as any).assets || { characters: [], scenes: [], props: [] };
    if (!assets[cat]) assets[cat] = [];
    if (!assets[cat][idx]) assets[cat][idx] = {};
    assets[cat][idx] = {
      ...assets[cat][idx],
      imageUrl: result.url,
      imagePrompt: prompt,
      imageGeneratedAt: new Date().toISOString(),
    };
    // 顶层 characters/environments/props 也同步（前端两种结构都读）
    const topKey = cat === 'characters' ? 'characters' : cat === 'scenes' ? 'environments' : 'props';
    const top = (fresh as any)[topKey] || [];
    if (!top[idx]) top[idx] = {};
    top[idx] = { ...top[idx], imageUrl: result.url, imagePrompt: prompt };
    updateProjectForUser(ctx.projectId, ctx.user.id, { assets, [topKey]: top });
  }

  return {
    resultUrl: result.url,
    patch: { type: 'asset_image', cat, idx, imageUrl: result.url, imagePrompt: prompt },
    extra: { mode: result.mode, width: result.width, height: result.height },
  };
});

/* ============================================================
   2. storyboard_prompts executor —— 把单个镜头描述转成图像生成提示词
   ============================================================ */
const SP_SHOT_TO_IMG_PROMPT = `你是 AI 图像生成提示词工程师。请把"短视频镜头描述"翻译成一段直接喂给图像模型的英文提示词。
要求：
- 全英文
- 包含主体、动作、构图、镜头视角、光线、色调、风格关键词
- 50-150 词为宜
- 不要解释、不要 markdown 围栏，直接输出提示词`;

registerExecutor('storyboard_prompts', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');
  const idx: number = ctx.target.idx ?? ctx.seq;
  const shot = (proj as any).shots?.[idx];
  if (!shot) throw new Error(`找不到 shots[${idx}]`);

  ctx.progress({ stage: 'building_prompt' });
  const styleBible = (proj as any).styleBible || {};
  const styleHint = [styleBible.vision, styleBible.colorPalette, styleBible.cameraStyle, styleBible.mood]
    .filter(Boolean).join('; ');

  const userMsg = [
    `镜头序号：${shot.idx ?? idx + 1}`,
    `景别：${shot.framing || ''}`,
    `运镜：${shot.movement || ''}`,
    `画面描述：${shot.description || ''}`,
    `台词/音效：${shot.dialog || ''}`,
    styleHint && `整体风格：${styleHint}`,
  ].filter(Boolean).join('\n');

  ctx.progress({ stage: 'calling_llm' });
  const prompt = await chatComplete(
    ctx.user,
    [
      { role: 'system', content: SP_SHOT_TO_IMG_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.4, maxTokens: 500 },
  );
  const cleaned = prompt.trim().replace(/^["'`]|["'`]$/g, '');

  // 写回 project.shots[idx]
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    const shots = (fresh as any).shots || [];
    if (shots[idx]) {
      shots[idx] = { ...shots[idx], imagePrompt: cleaned, imagePromptGenerated: true };
      updateProjectForUser(ctx.projectId, ctx.user.id, { shots });
    }
  }

  return {
    patch: { type: 'shot_prompt', idx, imagePrompt: cleaned },
    extra: { tokens: Math.ceil(cleaned.length / 2) },
  };
});

/* ============================================================
   3. storyboard_images executor —— 给一个分镜 group 生成手稿风分镜图
   ============================================================ */
registerExecutor('storyboard_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  // 一个 group 里通常包含 1-3 个连贯镜头；如果前端没传 group 划分，就把同 idx 的镜头当作单独 group
  const shots = (proj as any).shots || [];
  const groupShot = shots[groupIdx];
  if (!groupShot) throw new Error(`找不到 shots[${groupIdx}]`);

  ctx.progress({ stage: 'building_prompt' });
  const basePrompt =
    groupShot.imagePrompt ||
    `Storyboard frame for shot ${groupShot.idx ?? groupIdx + 1}.\n${groupShot.description || ''}\nFraming: ${groupShot.framing || 'medium'}; movement: ${groupShot.movement || 'static'}.`;

  ctx.progress({ stage: 'calling_image_api' });
  const result = await generateImage(ctx.user, {
    prompt: basePrompt,
    size: '1536x1024', // 16:9 风格分镜
    style: 'pencil', // 手稿风格
    kind: 'storyboard',
    projectId: ctx.projectId,
    assetRef: `storyboards[${groupIdx}]`,
  });

  // 写回 project.storyboards[groupIdx]
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    const storyboards = Array.isArray((fresh as any).storyboards) ? (fresh as any).storyboards : [];
    while (storyboards.length <= groupIdx) storyboards.push({});
    storyboards[groupIdx] = {
      ...storyboards[groupIdx],
      url: result.url,
      pencilUrl: result.url,
      imagePrompt: basePrompt,
      idx: groupIdx,
      shotIdx: groupShot.idx ?? groupIdx + 1,
    };
    updateProjectForUser(ctx.projectId, ctx.user.id, { storyboards });
  }

  return {
    resultUrl: result.url,
    patch: { type: 'storyboard_image', idx: groupIdx, url: result.url, pencilUrl: result.url },
    extra: { mode: result.mode },
  };
});
