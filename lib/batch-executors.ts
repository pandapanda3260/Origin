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
import { generateVideo } from './video-gen';
import { chatComplete, chatCompleteJsonWithRetry, parseJsonLoose } from './llm';
import { buildShotsMessages, buildVideoPromptMessages } from './prompts';
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

/**
 * 当 LLM 没写 imagePrompt 时的兜底 prompt。
 * 注意：风格统一（白底 + 写实摄影 + 三视图）已经在 image-gen.ts 的
 * forceStyleSuffix() 里强制兜底了，这里只描述"主体"，不再写风格。
 */
function buildAssetPrompt(asset: any, type: string, _styleBible: any): string {
  if (type === 'char') {
    const traits = [asset.temperament, asset.actionTraits, ...(asset.tags || [])]
      .filter(Boolean)
      .join(', ');
    return [
      `Subject: ${asset.name || 'unnamed character'}.`,
      asset.detail || asset.intro || '',
      traits && `Traits: ${traits}.`,
      asset.appearance && `Appearance: ${asset.appearance}.`,
      asset.clothing && `Clothing: ${asset.clothing}.`,
    ].filter(Boolean).join('\n');
  }
  if (type === 'scene') {
    return [
      `Subject: ${asset.name || 'unnamed scene'}.`,
      asset.description || '',
    ].filter(Boolean).join('\n');
  }
  return [
    `Subject: ${asset.name || 'unnamed prop'}.`,
    asset.features && `Appearance: ${asset.features}.`,
    asset.propType && `Type: ${asset.propType}.`,
  ].filter(Boolean).join('\n');
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
  // 尺寸策略：
  //   - 真人角色：1536×1024（宽图），三视图横向排开
  //   - 非人角色（拟人海鲜/机甲/动物）：1536×1024 也用三视图（前/侧/背）
  //   - 场景：1536×1024 establishing shot
  //   - 道具：1024×1024 白底 product shot
  const entityType: 'human' | 'non-human' =
    type === 'char' && (item.entityType === 'non-human') ? 'non-human' : 'human';

  const result = await generateImage(ctx.user, {
    prompt,
    size: type === 'char' ? '1536x1024' : type === 'scene' ? '1536x1024' : '1024x1024',
    style: 'natural',
    kind: type === 'char' ? 'character' : type === 'scene' ? 'scene' : 'prop',
    entityType: type === 'char' ? entityType : undefined,
    projectId: ctx.projectId,
    assetRef: `${cat}[${idx}]`,
  });

  // 写回项目：把 imageUrl + rawUrl + imagePrompt 落到资产对象
  // 注意：写入 imageUrl + rawUrl 两个字段，因为前端不同卡片读不同字段（兼容历史）
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    const assets = (fresh as any).assets || { characters: [], scenes: [], props: [] };
    if (!assets[cat]) assets[cat] = [];
    if (!assets[cat][idx]) assets[cat][idx] = {};
    const charExtra = type === 'char'
      ? { realPhotoUrl: result.url, pencilUrl: result.url, skippedStylize: true }
      : {};
    assets[cat][idx] = {
      ...assets[cat][idx],
      imageUrl: result.url,
      rawUrl: result.url,
      imagePrompt: prompt,
      imageGeneratedAt: new Date().toISOString(),
      ...charExtra,
    };
    // 顶层 characters/environments/props 也同步（前端两种结构都读）
    const topKey = cat === 'characters' ? 'characters' : cat === 'scenes' ? 'environments' : 'props';
    const top = (fresh as any)[topKey] || [];
    if (!top[idx]) top[idx] = {};
    top[idx] = {
      ...top[idx],
      imageUrl: result.url,
      rawUrl: result.url,
      imagePrompt: prompt,
      ...charExtra,
    };
    updateProjectForUser(ctx.projectId, ctx.user.id, { assets, [topKey]: top });
  }

  // task_completed 事件 payload：前端 onTaskCompleted 读 extra.rawUrl / extra.pencilUrl
  // 来实时更新卡片 UI（不刷新就能看到图）。之前我们漏发这两个字段，所以图必须
  // 刷新页面才显示——这里补上。
  return {
    resultUrl: result.url,
    patch: { type: 'asset_image', cat, idx, value: result.url, imageUrl: result.url, imagePrompt: prompt },
    extra: {
      type,
      idx,
      rawUrl: result.url,
      pencilUrl: type === 'char' ? result.url : undefined,
      skippedStylize: type === 'char' ? true : undefined,
      mode: result.mode,
      width: result.width,
      height: result.height,
    },
  };
});

/* ============================================================
   2. storyboard_prompts executor —— 把单个镜头描述转成图像生成提示词
   ============================================================ */
const SP_SHOT_TO_IMG_PROMPT = `你是分镜手稿（pre-production storyboard）提示词工程师。把"短视频镜头"翻译成英文提示词，最终会被画成**黑白铅笔分镜稿**（不是成片！不是照片！）。

【硬性要求】
- 全英文输出，不要中文，不要 markdown，不要 ["..."] 围栏
- 50-150 词
- 描述对象就是一张分镜稿，所以只描写：①主体（人物名 + 服装外观 + 表情/姿态）②动作（只描述这一帧定格的动作）③ 构图与景别（wide shot / medium / close-up / over-shoulder）④ 机位（low angle / high angle / eye-level / POV）⑤ 光照方向（key light from left / backlit / overhead / silhouette）⑥ 关键道具与场景元素（counter, fish trays, apron, clipboard 等）
- 如果给了角色描述，必须保留外观/服装一致性（同一角色多个镜头里穿同样的衣服）

【禁止】
- 不要写 "photorealistic / cinematic film / 35mm / film grain / hyper-real / 4K / vivid color / teal-orange / saturated"——这些会破坏手稿风
- 不要写 "color palette / warm color tone"，分镜稿是黑白
- 不要写"运镜动词"作为单独陈述（如 "the camera slowly pushes in"），改用"frame composition implies a slow push-in"或直接给静止构图
- 不要写台词或字幕
- 不要写 "three-view" 或 "white background"（那是资产图，不是分镜图）
- 不要解释，不要复述中文，不要写"Description:"前缀，直接输出 prompt 段落`;

registerExecutor('storyboard_prompts', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');
  const idx: number = ctx.target.idx ?? ctx.seq;
  const shot = (proj as any).shots?.[idx];
  if (!shot) throw new Error(`找不到 shots[${idx}]`);

  ctx.progress({ stage: 'building_prompt' });
  const styleBible = (proj as any).styleBible || {};
  const styleHint = [
    styleBible.vision || styleBible.visualStyle,
    styleBible.colorPalette,
    styleBible.cameraStyle,
    styleBible.mood || styleBible.tone,
    styleBible.lighting,
  ].filter(Boolean).join('; ');

  // 兼容新老字段
  const shotType = shot.shotType || shot.framing || '';
  const camera = shot.camera || shot.movement || '';
  const visual = shot.visual || shot.description || shot.desc || '';
  const dialogue = shot.dialogue || shot.dialog || '';
  const characters: string[] = Array.isArray(shot.characters) ? shot.characters : [];
  const keyInfo = shot.keyInfo || '';

  // 拼角色上下文（保持跨镜头服装/外观一致性）
  let charContext = '';
  if (characters.length) {
    const allChars = ((proj as any).assets?.characters || []) as any[];
    charContext = characters
      .map((nm) => allChars.find((c: any) => c.name === nm || c.role === nm))
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
    charContext && `本镜头角色（必须保留外观/服装一致性）：${charContext}`,
    styleHint && `整体视觉风格：${styleHint}`,
  ].filter(Boolean).join('\n');

  ctx.progress({ stage: 'calling_llm' });
  const prompt = await chatComplete(
    ctx.user,
    [
      { role: 'system', content: SP_SHOT_TO_IMG_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.5, maxTokens: 600 },
  );
  const cleaned = prompt.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!cleaned) throw new Error('AI 没有返回提示词');

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
    extra: { tokens: Math.ceil(cleaned.length / 2), shotIdx: idx, imagePrompt: cleaned },
  };
});

/* ============================================================
   3. storyboard_images executor —— 给一个分镜 group 生成手稿风分镜图
   ============================================================ */
registerExecutor('storyboard_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const shots = (proj as any).shots || [];

  // 优先使用前端传过来的 shotIndices（按情绪段切分组后的真实镜头索引数组）
  // 退化场景：老的目标只传 groupIdx，就把它当成镜头索引（兼容旧调用）
  let shotIndices: number[] = Array.isArray(ctx.target.shotIndices) && ctx.target.shotIndices.length
    ? ctx.target.shotIndices.filter((i: any) => typeof i === 'number')
    : [groupIdx];
  // 越界保护
  shotIndices = shotIndices.filter((i) => i >= 0 && i < shots.length);
  if (!shotIndices.length) {
    throw new Error(`分组 #${groupIdx} 没有对应的镜头数据`);
  }

  const groupShots = shotIndices.map((i) => shots[i]);
  const firstShot = groupShots[0];

  ctx.progress({ stage: 'building_prompt' });

  // 单组 prompt 长度上限（中转站对超长 prompt 不稳定，1200 字符是安全线）
  const MAX_PROMPT_CHARS = 1200;
  // 把组内所有镜头压成精简描述：每段最多 350 字符
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  const promptSections: string[] = groupShots.map((sh: any, i: number) => {
    const idx = shotIndices[i] + 1;
    const _shotType = sh.shotType || sh.framing || '';
    const _camera = sh.camera || sh.movement || '';
    const englishPrompt = (sh.imagePrompt || '').trim();
    const _visual = sh.visual || sh.description || sh.desc || '';
    const body = englishPrompt || _visual;
    const head = `Frame ${idx}` + (_shotType ? ` (${_shotType}${_camera ? ', ' + _camera : ''})` : '');
    return `${head}: ${truncate(body, 350)}`;
  });

  // 多镜头：让模型把它们画成一张多格分镜稿（panel grid）
  const isMulti = groupShots.length > 1;
  const sheetIntro = isMulti
    ? `Storyboard sheet with ${groupShots.length} sequential panels showing different beats of the same scene. `
    : '';
  let basePrompt = sheetIntro + promptSections.join(' | ');
  if (basePrompt.length > MAX_PROMPT_CHARS) {
    basePrompt = basePrompt.slice(0, MAX_PROMPT_CHARS) + '…';
  }

  ctx.progress({
    stage: 'calling_image_api',
    shotCount: groupShots.length,
    hint: `调用图像 API 中（gpt-image-1 单张约 30-60 秒）…`,
  });
  const result = await generateImage(ctx.user, {
    prompt: basePrompt,
    size: '1536x1024', // 16:9 多格分镜
    style: 'pencil', // 手稿风格
    kind: 'storyboard',
    projectId: ctx.projectId,
    assetRef: `storyboards[${groupIdx}]`,
  });

  // 写回 project.storyboards[groupIdx]：注意 imageUrl + url 都写，前端两边都会读
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    const storyboards = Array.isArray((fresh as any).storyboards) ? (fresh as any).storyboards : [];
    while (storyboards.length <= groupIdx) storyboards.push({});
    storyboards[groupIdx] = {
      ...storyboards[groupIdx],
      url: result.url,
      imageUrl: result.url,
      rawUrl: result.url,
      pencilUrl: result.url,
      imagePrompt: basePrompt,
      idx: groupIdx,
      shotIdx: firstShot?.idx ?? shotIndices[0] + 1,
      shotIndices,
    };
    updateProjectForUser(ctx.projectId, ctx.user.id, { storyboards });
  }

  return {
    resultUrl: result.url,
    patch: { type: 'storyboard_image', idx: groupIdx, url: result.url, pencilUrl: result.url, imageUrl: result.url, rawUrl: result.url },
    extra: { mode: result.mode, groupIdx, url: result.url, rawUrl: result.url, imageUrl: result.url },
  };
});

/* ============================================================
   4. video_segments executor —— 给每个分镜组生成视频片段
   ============================================================ */
registerExecutor('video_segments', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? ctx.seq;
  const storyboards = (proj as any).storyboards || [];
  const sb = storyboards[groupIdx];
  if (!sb) throw new Error(`找不到 storyboards[${groupIdx}]`);

  // 提示词来源优先：sb.videoPrompt（视频提示词页生成的）→ shot.imagePrompt → shot.visual / shot.description
  const shots = (proj as any).shots || [];
  const shot = shots[groupIdx] || {};
  const _shotVisual = shot.visual || shot.description || shot.desc || '';
  const prompt =
    sb.videoPrompt || shot.imagePrompt || _shotVisual || `Video segment for shot ${groupIdx + 1}`;
  const durationSec = Math.max(2, Math.min(12, Number(shot.duration || shot.durationSec || 4)));

  ctx.progress({ stage: 'submitting', durationSec });

  const result = await generateVideo(
    ctx.user,
    {
      prompt,
      size: '1080x1920',
      durationSec,
      projectId: ctx.projectId,
      groupIdx,
    },
    (pct, hint) => ctx.progress({ stage: 'gen', pct, hint }),
  );

  // 写回 project.videoTasks 数组（前端 batch 页读这里）
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? (fresh as any).videoTasks : [];
    while (videoTasks.length <= groupIdx) videoTasks.push({});
    videoTasks[groupIdx] = {
      groupIdx,
      taskId: result.taskId,
      status: 'completed',
      url: result.url,
      coverUrl: result.coverUrl,
      durationSec: result.durationSec,
      prompt,
    };
    // 同时挂到 storyboards[groupIdx].videoUrl，方便编辑页直接读
    const sbs = Array.isArray((fresh as any).storyboards) ? (fresh as any).storyboards : [];
    if (sbs[groupIdx]) {
      sbs[groupIdx] = { ...sbs[groupIdx], videoUrl: result.url, videoTaskId: result.taskId };
    }
    updateProjectForUser(ctx.projectId, ctx.user.id, {
      videoTasks,
      storyboards: sbs,
    });
  }

  return {
    resultUrl: result.url,
    patch: {
      type: 'video_segment',
      groupIdx,
      url: result.url,
      coverUrl: result.coverUrl,
      durationSec: result.durationSec,
      taskId: result.taskId,
    },
    extra: { mode: result.mode, durationSec: result.durationSec },
  };
});

/* ============================================================
   5. shots executor —— 把剧本拆成 6-15 个镜头（一次 LLM 调用）
   ============================================================
   前端 generateShots() 的 stage hint 命名约定：
     prepare → planning → reasoning → writing → parsing → assembling
   这里我们没法精细拆 LLM 内部阶段，但能在调用前后发几个粗粒度
   stage 让进度条至少动起来。
   返回 patch.value = shots 数组，前端 onTaskCompleted 直接读。
   ============================================================ */
registerExecutor('shots', async (ctx: BatchExecCtx) => {
  const { script, styleBible, assets, durationSec } = (ctx.options || {}) as {
    script?: string;
    styleBible?: any;
    assets?: any;
    durationSec?: number | null;
  };
  if (!script || !script.trim()) {
    throw new Error('当前没有剧本，请先生成剧本再做镜头设计');
  }

  ctx.progress({ stage: 'prepare', percent: 8, hint: '正在准备剧本与资产上下文…' });

  // 把资产瘦身：只发名字 + 简短描述给 LLM，避免上下文炸掉
  const slimAssets = (() => {
    if (!assets) return null;
    const trim = (a: any) => a && {
      id: a.id,
      name: a.name,
      role: a.role,
      identity: a.identity,
      description: a.description || a.appearance || '',
    };
    return {
      characters: (assets.characters || []).map(trim),
      scenes: (assets.scenes || assets.environments || []).map(trim),
      props: (assets.props || []).map(trim),
    };
  })();

  ctx.progress({ stage: 'planning', percent: 18, hint: 'AI 正在分析剧本结构…' });
  const messages = buildShotsMessages({
    script,
    styleBible,
    assets: slimAssets,
    totalDurationSec: durationSec || undefined,
  });

  ctx.progress({ stage: 'writing', percent: 45, hint: 'AI 正在生成镜头表（这一步比较慢，请耐心等）…' });

  // 用带重试的 JSON 调用：镜头表是大段 JSON，模型偶尔会截断或多嘴
  let parsed: any;
  try {
    parsed = await chatCompleteJsonWithRetry(
      ctx.user,
      messages,
      // 镜头表可能很长（10+ 镜头），给足 token
      { temperature: 0.6, maxTokens: 4000 },
      (raw) => parseJsonLoose(raw),
      'shots-generate',
    );
  } catch (e: any) {
    throw new Error('镜头设计失败：' + (e?.message || String(e)));
  }

  ctx.progress({ stage: 'parsing', percent: 88, hint: '正在整理镜头表…' });

  let shotsArr: any[] = Array.isArray(parsed?.shots) ? parsed.shots : [];
  if (!shotsArr.length && Array.isArray(parsed)) shotsArr = parsed;
  if (!shotsArr.length) {
    throw new Error('AI 未返回有效镜头列表（shots 字段为空）');
  }

  /* ---------- 字段映射 / 兜底 ----------
     前端读：duration / shotType / camera / visual / dialogue / keyInfo / audio / emotion / intensity / scriptRef / characters
     LLM 偶尔回退到老 schema (durationSec/framing/movement/description/dialog/stylePillar)，
     这里统一标准化。
     注意：camera 必须保留 LLM 的细致词（如"缓慢推进"、"轻微推近"），
     不能再强行吸附到下拉菜单里——前端 _buildSelectOptions 已经会把任意值
     作为 option 加入，因此细致词可以原样显示。
  ------------------------------------- */
  const EMOTIONS = ['setup','rising','climax','falling','resolution','transition'];

  // 只对"明显是老 schema 的粗词"做最小升级，其他值原样保留
  const upgradeCamera = (raw: string): string => {
    const map: Record<string, string> = {
      '推': '推近',
      '拉': '拉远',
      '推镜头': '推近',
      '拉镜头': '拉远',
      '航拍': '升降',
      '轨道': '跟随',
      '固定机位': '固定镜头',
      '手持': '手持轻晃',
    };
    return map[raw] || raw;
  };
  const upgradeShotType = (raw: string): string => {
    const map: Record<string, string> = {
      '广角全景': '大全景',
      '广角': '大全景',
    };
    return map[raw] || raw;
  };

  const cleanStr = (...candidates: any[]): string => {
    for (const c of candidates) {
      if (c == null) continue;
      const s = String(c).trim();
      if (s) return s;
    }
    return '';
  };

  shotsArr = shotsArr.map((sh, i) => {
    const dur = Number(sh.duration ?? sh.durationSec ?? 4);
    const visual = cleanStr(sh.visual, sh.description, sh.desc);
    const dialogue = cleanStr(sh.dialogue, sh.dialog);
    let keyInfo = cleanStr(sh.keyInfo, sh.key, sh.stylePillar);
    // keyInfo 兜底：太长就只保留前 8 个字符（前端期望主题词）
    if (keyInfo.length > 12) keyInfo = keyInfo.slice(0, 8);
    const audio = cleanStr(sh.audio, sh.sfx);
    const characters = Array.isArray(sh.characters)
      ? sh.characters.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim())
      : [];
    const intensityRaw = Number(sh.intensity);
    const intensity = Number.isFinite(intensityRaw)
      ? Math.max(1, Math.min(5, Math.round(intensityRaw)))
      : 3;

    const rawShotType = cleanStr(sh.shotType, sh.framing) || '中景';
    const rawCamera = cleanStr(sh.camera, sh.movement) || '固定镜头';
    const rawEmotion = cleanStr(sh.emotion);

    return {
      idx: typeof sh.idx === 'number' && sh.idx > 0 ? sh.idx : i + 1,
      duration: Math.max(2, Math.min(12, Number.isFinite(dur) ? dur : 4)),
      shotType: upgradeShotType(rawShotType),
      camera: upgradeCamera(rawCamera),
      visual,
      dialogue: dialogue || '——',
      keyInfo,
      audio,
      emotion: EMOTIONS.includes(rawEmotion) ? rawEmotion : 'rising',
      intensity,
      scriptRef: cleanStr(sh.scriptRef),
      characters,
    };
  });

  // 过滤掉完全空白的镜头（visual + dialogue 都没有）
  shotsArr = shotsArr.filter(sh => sh.visual || (sh.dialogue && sh.dialogue !== '——'));
  // 重新排 idx，避免过滤后跳号
  shotsArr = shotsArr.map((sh, i) => ({ ...sh, idx: i + 1 }));

  if (!shotsArr.length) {
    throw new Error('AI 返回的镜头都没有内容，请稍后重试或换个剧本');
  }

  ctx.progress({ stage: 'assembling', percent: 95, hint: '正在保存镜头表…' });

  // 写回项目：shots + 重置下游审批/分镜
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    updateProjectForUser(ctx.projectId, ctx.user.id, {
      shots: shotsArr,
      shotsApproved: false,
      storyboards: [],
      currentStep: 3,
    });
  }

  return {
    patch: { type: 'shots', value: shotsArr },
    extra: { count: shotsArr.length },
  };
});

/* ============================================================
   6. video_prompts executor —— 给一个分镜组生成视频生成模型用的英文 prompt
   ============================================================
   前端 generateAllVideoPrompts 启动 batchType: 'video_prompts'，
   targets 里每条带 { groupIdx, shotIndices, totalGroups }。
   返回到前端的 extra：{ groupIdx, videoPrompt, narrationsUsed }
   ============================================================ */
registerExecutor('video_prompts', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const totalGroups: number = ctx.target.totalGroups || 1;
  const shots = (proj as any).shots || [];

  // 优先用 target.shotIndices（前端按情绪段切组后传过来）
  let shotIndices: number[] = Array.isArray(ctx.target.shotIndices) && ctx.target.shotIndices.length
    ? ctx.target.shotIndices.filter((i: any) => typeof i === 'number')
    : [];
  shotIndices = shotIndices.filter((i) => i >= 0 && i < shots.length);
  if (!shotIndices.length) {
    // fallback：把 groupIdx 当镜头索引（兼容老调用）
    if (groupIdx < shots.length) shotIndices = [groupIdx];
    else throw new Error(`分组 #${groupIdx} 没有对应的镜头`);
  }

  const groupShots = shotIndices.map((i) => shots[i]);
  const styleBible = (proj as any).styleBible || {};
  const assets = (proj as any).assets || {};
  const narrations: any[] = Array.isArray((proj as any).narrations) ? (proj as any).narrations : [];

  ctx.progress({ stage: 'preparing', percent: 10, hint: '准备镜头与资产上下文…' });

  const messages = buildVideoPromptMessages({
    shots: groupShots,
    styleBible,
    assets,
    narrations,
    groupIdx,
    totalGroups,
  });

  ctx.progress({ stage: 'calling_llm', percent: 35, hint: 'AI 正在写视频提示词…' });

  // 检测 LLM 是否偷懒输出了老格式 / 含禁止词
  const looksLikeOldFormat = (text: string): boolean => {
    const t = text || '';
    if (/\[(CAMERA|STYLE|CONSTRAINTS|AUDIO)\]/i.test(t)) return true;
    if (/\bshot\s*\d+\s*:/i.test(t)) return true;
    // "参考图X" 引用是用户明确不要的
    if (/参考图\s*\d+/.test(t)) return true;
    // 看起来 80% 以上是英文
    const cnChars = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enChars = (t.match(/[a-zA-Z]/g) || []).length;
    if (cnChars + enChars > 100 && cnChars / (cnChars + enChars) < 0.4) return true;
    return false;
  };

  // 兜底清洗：把 "（参考图N）" / "(参考图N)" / "参考图N" 直接擦掉
  const stripRefMarkers = (text: string): string =>
    text
      .replace(/[（(]\s*参考图\s*\d+\s*[)）]/g, '')
      .replace(/参考图\s*\d+/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*([，。；：])[ \t]*/g, '$1');

  let prompt = '';
  let attempt = 0;
  const MAX_ATTEMPTS = 2;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      // 第二次重试时压低 temperature 并在 user message 末尾追加强提示
      const retryMessages = attempt === 1
        ? messages
        : [
            ...messages.slice(0, -1),
            {
              ...messages[messages.length - 1],
              content:
                messages[messages.length - 1].content +
                '\n\n⚠️ 上一次输出错了，必须严格按"运镜系统/角色/场景/0-Xs/.../基调/约束/音障"中文段落输出，**绝对不要写 shot 1: / [CAMERA] / camera: / characters: 这种英文键值对**。重写一遍。',
            },
          ];
      const temp = attempt === 1 ? 0.55 : 0.3;
      prompt = await chatComplete(
        ctx.user,
        retryMessages,
        { temperature: temp, maxTokens: 2200 },
      );
      if (!looksLikeOldFormat(prompt)) break;
      console.warn(`[video_prompts] attempt ${attempt} produced old format, retrying…`);
    } catch (e: any) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error('视频提示词生成失败：' + (e?.message || String(e)));
      }
    }
  }

  let cleaned = prompt.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!cleaned) throw new Error('AI 没有返回提示词');
  // 即使 LLM 漏写了"参考图X"，最后再做一次纯文本清洗（不破坏其他内容）
  cleaned = stripRefMarkers(cleaned);
  if (looksLikeOldFormat(cleaned)) {
    // 两次都失败：抛错让前端显示"重试"按钮，比保存一份乱码好
    throw new Error('AI 输出格式不符（旧英文格式或仍含参考图编号），请点击重新生成（已自动重试 2 次仍失败）');
  }

  ctx.progress({ stage: 'saving', percent: 92, hint: '正在保存…' });

  // 写回 storyboards[groupIdx].videoPrompt
  const fresh = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (fresh) {
    const storyboards = Array.isArray((fresh as any).storyboards) ? (fresh as any).storyboards : [];
    while (storyboards.length <= groupIdx) storyboards.push({});
    storyboards[groupIdx] = {
      ...storyboards[groupIdx],
      videoPrompt: cleaned,
      narrationsUsed: narrations,
      shotIndices,
    };
    updateProjectForUser(ctx.projectId, ctx.user.id, { storyboards });
  }

  return {
    patch: { type: 'video_prompt', idx: groupIdx, value: cleaned },
    extra: {
      groupIdx,
      videoPrompt: cleaned,
      narrationsUsed: narrations,
      shotIndices,
    },
  };
});
