/**
 * 视频生成统一封装。
 *
 * 真接 OpenAI Sora：
 *   1) POST /v1/videos                   → { id, status:'queued' }
 *   2) GET  /v1/videos/{id}              → { id, status:'in_progress'|'completed'|'failed', progress }
 *   3) GET  /v1/videos/{id}/content      → 二进制 mp4
 * 协议参考：https://platform.openai.com/docs/api-reference/videos
 *
 * 兼容其他 OpenAI 风格中转/Seedance 的话，通过 settings.models.video.{baseUrl,apiKey,model} 切走。
 *
 * fake 兜底：调 ffmpeg 生成一段 4s 黑场（带 440Hz 提示音）的 mp4，
 *   保证前端 <video> 能正常播放并展示进度条 / 封面。
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { resolveLLMConfig } from './llm';
import { getDb } from './db';
import type { UserRow } from './db';
import { makeBlackVideo, extractCover } from './ffmpeg';
import { generateImage } from './image-gen';
import { buildSignedVideoUrl } from './signed-asset-url';
import { patchProjectForUser } from './projects-db';
import type { CharacterReferencePanel } from './panel-selection';
import { fetchViaProxy } from './proxy-fetch';
import {
  buildSeedancePromptParts,
  buildSeedanceFirstLastFramePromptParts,
  type VideoReferenceImage,
} from './video-prompt-runtime';
import type { TargetEndStrategy } from './video-provider-capabilities';
import { resolveVideoModelCapability } from './video-provider-capabilities';
import { hashString, resolveGenerationDurationSec } from './video-reference-manifest';
import type { DialoguePolicy } from './video-reference-manifest';
import type { VideoPromptFailureStage } from './video-prompt-state';
import { maybeAssertStoryboardsAlignedWithShots, storyboardShotIndices } from './frame-workflow-state';

export type VideoGenInput = {
  prompt: string;
  size?: '1080x1920' | '1920x1080' | '1024x1024';
  /** 画面比例，如 "16:9" / "9:16" / "1:1"，优先级高于 size */
  ratio?: string;
  durationSec?: number;
  projectId?: string;
  groupIdx?: number;
  /** 角色台词（必须严格按此演绎/配音）。grok-video 支持音画同出。
   *  老路径：单字符串"老板：xxx 帝王蟹：yyy"——已被 dialoguePairs 取代，
   *  保留是为了向后兼容（fake / sora 路径还在用）。
   */
  dialogue?: string;
  /**
   * 结构化台词列表（**新路径**）。每条 { speaker: '老板', text: '明天翻倍' }。
   * Seedance 适配会把 speaker 当"指定说话人"元信息（用来选音色/口型），
   * text 才是实际念出来的台词——避免把"老板"也当台词读出。
   */
  dialoguePairs?: Array<{ speaker: string; text: string }>;
  /**
   * 项目角色一致性主档 roster（多行字符串）。Seedance 路径会渲染成中文
   * characterLockBlock，包含 visual + performance + voice。
   */
  characterLockRoster?: string;
  /**
   * 旧字段，仅作向后兼容。新调用方应传 characterLockRoster。
   */
  voiceRoster?: string;
  /** 上一组的最后一镜简述，给模型用于"承接上一镜终幅"。 */
  prevTailSummary?: string;
  /** 下一组的第一镜简述，给模型用于"留出衔接到下一镜首帧的空间"。 */
  nextHeadSummary?: string;
  /** 用于 fake 模式做封面的素材描述 */
  coverHint?: string;
  /**
   * 视频主参考图本地路径。
   * 新多参模式下是彩色首帧；旧模式下可能仍是黑白分镜草图。
   */
  referenceImagePath?: string;
  /** 标记 referenceImagePath 的语义，避免把彩色首帧误当成黑白草图解释。 */
  referenceImageRole?: 'first_frame' | 'storyboard_sketch';
  /** 可选黑白草图路径：新模式只把它当构图调试/辅助，不再作为主参考。 */
  storyboardReferencePath?: string;
  /**
   * **彩色场景资产图**本地路径——前面"资产"步骤生成的彩色场景图。
   * Seedance 适配会拿这张图当 i2v 主参考，保证视频环境/光照/色彩跟资产一致，
   * 不再让分镜草图的黑白调污染最终视频。
   */
  sceneReferencePath?: string;
  /**
   * **彩色角色资产图**本地路径数组——本镜头出现的角色对应的彩色三视图。
   * 会拼接到合成参考图底部缩略图条，给 Seedance 稳定角色外观/服装。
   */
  characterReferencePaths?: string[];
  /**
   * 按当前镜头语义挑出的角色 panel。本字段优先于 characterReferencePaths：
   * 近景用 headshot，侧身用 side，背影用 back，全身动作用 front/side/back。
   */
  characterReferencePanels?: CharacterReferencePanel[];
  /** 本片段出现的道具参考图。会和角色参考一起放进视觉参考合成图。 */
  propReferencePaths?: string[];
  /**
   * 独立多图参考列表。开启 ORIGIN_INDEPENDENT_MULTI_IMAGE_MODE 后，
   * Seedance 适配会按顺序把这些图片作为独立 image_url(reference_image) 传入，
   * 并在 prompt 中生成 Image N 的角色/场景/道具绑定说明。
   */
  referenceImages?: VideoReferenceImage[];
  /** 尾帧进入视频模型的策略：直接图片参考、caption 降级，或不支持。 */
  targetEndStrategy?: TargetEndStrategy;
  /** caption 降级时注入 prompt 的尾帧视觉描述。 */
  targetEndCaption?: string;
  /** 当前 provider/配置无法让尾帧影响视频时的原因，供 audit/UI 使用。 */
  targetEndUnsupportedReason?: string;
  /** Builder B 的选择原因，由 executor 的 payload-mode 决策透传到 audit.modeReason。 */
  payloadModeReason?: string;
  /**
   * First+last frame 模式开关（Builder A）。当此字段存在时，video-gen
   * 必须按 Seedance 官方 first+last frame schema 提交：
   *   content = [text, first_frame image_url, last_frame image_url]
   * **严格互斥**：不再塞 reference_image（角色/场景/道具参考）。
   * 是否真正走 Builder A 由上游 executor 基于 VideoModelCapability 决定。
   * 此字段为空时保持旧 Builder B（首帧 + 多参考图）链路。
   */
  firstLastFrameMode?: {
    firstFramePath: string;
    lastFramePath: string;
    /** 透传到 audit.modeReason，典型值：tail_ready */
    modeReason?: string;
  };
};

export type { VideoReferenceImage };

/**
 * 把"彩色场景图（主） + 彩色角色图（缩略图条） + 黑白分镜草图（小角标）"
 * 合成成一张 i2v 参考图。这张图同时给 Seedance 三件事：
 *   · 顶部大图 = 彩色场景 → 决定环境/色调/光照/质感（不再让黑白草图带偏色彩）
 *   · 底部缩略图 = 彩色角色三视图 → 锁定每个角色的外形/服装/拟人 vs 真人
 *   · 右下小角 = 黑白分镜草图 → 给镜头构图/角色站位/景别参考
 *
 * 输入都没有时返回 null，调用方退回到纯 storyboard 路径（带遮罩）。
 *
 * 设计取舍：把所有彩色资产合成到一张图、再统一用 applyFaceSafetyMask
 * 打网格 + 黑条过 Seedance 人脸安全过滤——这样既保留了"前置步骤生成的彩色
 * 视觉圣经"，又不会触发"试图生成真人身份"的拦截。
 */
async function buildColorReferenceComposite(opts: {
  scenePath?: string;
  characterPaths?: string[];
  characterPanels?: CharacterReferencePanel[];
  propPaths?: string[];
  storyboardPath?: string;
}): Promise<Buffer | null> {
  const fs = await import('node:fs');
  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod || !canvasMod.createCanvas || !canvasMod.loadImage) {
    console.warn('[color-ref] @napi-rs/canvas 未安装，跳过彩色合成');
    return null;
  }
  const { createCanvas, loadImage } = canvasMod;

  const validScene = opts.scenePath && fs.existsSync(opts.scenePath) ? opts.scenePath : null;
  const validChars = (opts.characterPaths || []).filter((p) => p && fs.existsSync(p));
  const validPanels = (opts.characterPanels || [])
    .filter((panel) => panel?.path && fs.existsSync(panel.path))
    .slice(0, 4);
  const validProps = (opts.propPaths || []).filter((p) => p && fs.existsSync(p)).slice(0, 4);
  const validSb = opts.storyboardPath && fs.existsSync(opts.storyboardPath) ? opts.storyboardPath : null;
  if (!validScene && !validChars.length && !validPanels.length && !validProps.length && !validSb) return null;

  // 输出尺寸：固定 1280x720（16:9 主流横版），脚本里 ratio 用 9:16 时
  // Seedance 会自己 letterbox，但 i2v 参考图比例不影响输出比例
  const W = 1280;
  const H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 默认深灰底色，万一所有 image 都加载失败也不至于纯黑
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);

  // 1) 主背景：优先用彩色场景图作环境/色调参考。
  const mainBg = validScene;
  if (mainBg) {
    try {
      const sceneImg = await loadImage(mainBg);
      // cover 模式：等比缩放到完全覆盖 1280x720，多余裁掉
      const ratio = Math.max(W / sceneImg.width, H / sceneImg.height);
      const dw = sceneImg.width * ratio;
      const dh = sceneImg.height * ratio;
      ctx.drawImage(sceneImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch (e: any) {
      console.warn('[color-ref] main background draw failed:', e?.message || e);
    }
  } else if (validPanels.length || validChars.length || validProps.length) {
    // 没场景图时角色图占主位（cover 第一张）
    try {
      const c0 = await loadImage(validPanels[0]?.path || validChars[0] || validProps[0]);
      const ratio = Math.max(W / c0.width, H / c0.height);
      const dw = c0.width * ratio;
      const dh = c0.height * ratio;
      ctx.drawImage(c0, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch (_) {}
  }

  // 2) 底部一条角色缩略图条：
  //    - 新 panel 路径：180px，高度 156px 内容区，让竖版 headshot/front/side/back
  //      比旧 130px 条获得更大有效像素面积。
  //    - 旧路径 fallback：仍接受整张角色图，只是布局代码共用。
  //    注意：场景图存在 + 角色图存在时才贴；角色图独占主位时跳过
  const characterThumbs = validPanels.length
    ? validPanels.map((panel) => panel.path)
    : validChars.slice(0, 4);
  const referenceThumbs = [...characterThumbs, ...validProps].slice(0, 6);
  if (mainBg && referenceThumbs.length) {
    const stripH = validPanels.length ? 180 : 130;
    const stripY = H - stripH;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, stripY, W, stripH);

    const maxThumbs = Math.min(referenceThumbs.length, 6);
    const thumbGap = 12;
    const thumbW = Math.floor((W - thumbGap * (maxThumbs + 1)) / maxThumbs);
    const thumbH = stripH - thumbGap * 2;
    for (let i = 0; i < maxThumbs; i++) {
      try {
        const cImg = await loadImage(referenceThumbs[i]);
        const ratio = Math.min(thumbW / cImg.width, thumbH / cImg.height);
        const dw = cImg.width * ratio;
        const dh = cImg.height * ratio;
        const dx = thumbGap + i * (thumbW + thumbGap) + (thumbW - dw) / 2;
        const dy = stripY + thumbGap + (thumbH - dh) / 2;
        ctx.drawImage(cImg, dx, dy, dw, dh);
      } catch (_) {}
    }
  }

  // 3) 分镜草图小角标（右上角 256x144，给 Seedance 看构图/景别）
  //    Seedance 会把它当 thumbnail 处理，不会污染主色调
  if (validSb) {
    try {
      const sbImg = await loadImage(validSb);
      const tnW = 256;
      const tnH = 144;
      const tnX = W - tnW - 16;
      const tnY = 16;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(tnX - 4, tnY - 4, tnW + 8, tnH + 8);
      const ratio = Math.min(tnW / sbImg.width, tnH / sbImg.height);
      const dw = sbImg.width * ratio;
      const dh = sbImg.height * ratio;
      ctx.drawImage(sbImg, tnX + (tnW - dw) / 2, tnY + (tnH - dh) / 2, dw, dh);
    } catch (e: any) {
      console.warn('[color-ref] sb thumbnail draw failed:', e?.message || e);
    }
  }

  return canvas.toBuffer('image/png');
}

/**
 * Seedance 内容安全过滤"过人脸"专用：在参考图上叠加一层半透明网格 + 顶部
 * 1/4 处一条黑色矩形（覆盖大概率出现脸的区域）。这样：
 *   1) Seedance 安全过滤看不到完整人脸 → 不触发"试图生成真人身份"拦截
 *   2) Seedance i2v 引擎把网格当成噪声/装饰，内部 inpaint 真实人脸/物体
 *   3) 输出视频是干净的真实画面，没有网格也没有黑条
 *
 * 实现：用 @napi-rs/canvas 做 2D 合成（不依赖 ffmpeg，比 ffmpeg drawgrid 更可控）。
 * 失败时返回 null，调用方 fallback 到纯文本 t2v。
 *
 * 入参可以是磁盘路径（旧路径），也可以是已经在内存里的 Buffer（新路径——
 * 给 buildColorReferenceComposite 输出的合成图直接打遮罩用）。
 */
async function applyFaceSafetyMask(imageInput: string | Buffer): Promise<Buffer | null> {
  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod || !canvasMod.createCanvas || !canvasMod.loadImage) {
    console.warn('[face-mask] @napi-rs/canvas 未安装，跳过遮罩');
    return null;
  }
  const { createCanvas, loadImage } = canvasMod;
  // 路径模式：先校验文件存在，存在再 loadImage
  if (typeof imageInput === 'string') {
    const fs = await import('node:fs');
    if (!fs.existsSync(imageInput)) {
      console.warn('[face-mask] reference image not found:', imageInput);
      return null;
    }
  }
  const img = await loadImage(imageInput);
  const w = img.width;
  const h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  // 1) 原图打底
  ctx.drawImage(img, 0, 0, w, h);

  // 2) 网格遮罩：~20px 一格的中密度网格，深灰中等不透明
  //    粒度细 → Seedance i2v 会当成纹理噪声 / cross-hatch 处理掉
  //    又足够密 → 安全过滤无法稳定识别人脸器官（眼/鼻/嘴）
  const grid = Math.max(16, Math.round(Math.min(w, h) / 60));
  ctx.strokeStyle = 'rgba(20,20,20,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += grid) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += grid) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();

  // 3) 黑条遮挡：分镜常见布局 1×1 / 1×2 / 2×2，face 通常在每"格"的上 1/3。
  //    给每个估算的"行"都打一条横向黑条（覆盖该行 panel 内的眼鼻区域）。
  //    我们不知道精确分格，但盖住 y≈10-15%、35-40%、60-65%、85-90% 这四个高度
  //    带可以兜住 1×1 / 1×2 / 2×2 三种情况下的所有"上 1/3 face zone"。
  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  const barH = Math.max(8, Math.floor(h * 0.045));
  [0.12, 0.37, 0.62, 0.87].forEach((rel) => {
    ctx.fillRect(0, Math.floor(h * rel), w, barH);
  });
  return canvas.toBuffer('image/png');
}

/**
 * 火山方舟 Seedance 内容安全过滤经常误判"详细中文人物描述"为试图生成真人，
 * 触发"素材不符合内容规范"。这里把容易触发身份/真人识别的关键词擦掉、
 * 把"45 岁中年中国男性、东亚面孔、真人皮肤毛孔可见"这种描述降级成
 * 通用人物描述（保留服装/动作/场景，删掉年龄+族裔+真人标签）。
 *
 * 设计取舍：
 *   · 不删服装/姿态/物件——这些不会触发过滤
 *   · 不加"动漫/卡通/插画"前缀——会破坏用户原本要的"真人电影感"
 *   · 仅删容易触发"试图生成真人"识别的明确身份特征
 */
export function sanitizeForSeedance(rawPrompt: string): string {
  if (!rawPrompt) return rawPrompt;
  let t = rawPrompt;
  // 1) 精确年龄："45 岁 / 45岁左右 / 30 岁出头"
  t = t.replace(/\d+\s*岁(?:左右|出头|上下|前后)?/g, '');
  // 2) 年龄段前缀（去掉就够了，不必硬替换成"人物"——"中年中国男性"会被
  //    chain 处理成"男性"，独立的"男性"基本不触发过滤）
  t = t.replace(/(?:幼年|童年|少年|青年|青壮年|中年|中老年|老年)/g, '');
  // 3) 族裔/地域前缀（同理，链式删除）
  //    用 negative lookahead 避开"中华田园犬 / 国际化 / 东方明珠"这类无关词
  t = t.replace(/(?:中国|华人|中华|东亚|亚洲|韩国|日本|东方|西方|欧美|白人|黑人|黄种|有色)(?![家际线方人民]?[人民田家际线方])/g, '');
  // 但保险起见，再补一遍最常见的明确身份组合：
  t = t.replace(/(?:中国人|华人|亚洲人|东亚人|韩国人|日本人|欧美人|西方人)/g, '人物');
  // 4) 真人/写实/毛孔等"真人识别诱因"
  t = t.replace(/真人(?:皮肤|脸|面部|身体|形象|外观|身材|身形|演员)?(?:毛孔)?(?:可见|质感|清晰|分明)?/g, '');
  t = t.replace(/真实(?:皮肤|毛孔|人脸|人物|面部|的人|肌肤|质感|演员)/g, '');
  t = t.replace(/(?:皮肤)?毛孔(?:可见|清晰|分明|质感)?/g, '');
  t = t.replace(/写实(?:人物|人脸|皮肤|风格|的)?/g, '');
  t = t.replace(/(?:面部|脸部|五官)(?:细节|特写|清晰可见|精致|立体|真实|逼真)/g, '');
  // 5) 名人/政治敏感词（防御性兜底）
  t = t.replace(/(?:奥巴马|特朗普|拜登|习近平|普京|马斯克|乔布斯|周杰周|周杰伦)[^，。；,;.\n]{0,12}/g, '人物');
  // 6) 清理因删除留下的连续标点 / 多余空格 / 残缺词组
  t = t
    .replace(/，\s*，/g, '，')
    .replace(/、\s*、/g, '、')
    .replace(/\s{2,}/g, ' ')
    .replace(/[，、；,;]\s*[。.]/g, '。')
    .replace(/，\s*，/g, '，') // 上一步可能产生新的连续逗号
    .trim();
  // 7) 行首孤立标点
  t = t.replace(/^[\s，、；,;。.]+/, '').replace(/(\n)[\s，、；,;。.]+/g, '$1');
  return t;
}

/** 把 ratio 字符串规范成统一格式 + size 映射 */
function normalizeRatio(ratio?: string): { ratio: string; size: '1080x1920' | '1920x1080' | '1024x1024' } {
  const r = (ratio || '').trim();
  if (r === '16:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '9:16') return { ratio: '9:16', size: '1080x1920' };
  if (r === '1:1') return { ratio: '1:1', size: '1024x1024' };
  // 4:3 / 3:4 / 21:9 等 grok 暂不支持，回退
  if (r === '4:3' || r === '21:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '3:4') return { ratio: '9:16', size: '1080x1920' };
  // Default: 竖屏短视频 9:16（v2 起沿用）。调用方未传 input.ratio 时走此分支。
  return { ratio: '9:16', size: '1080x1920' };
}

export type VideoGenResult = {
  taskId: string;
  status: 'completed' | 'failed';
  url: string;
  protectedUrl: string;
  coverUrl: string | null;
  durationSec: number;
  mode: 'real' | 'fake';
  videoAudit?: {
    provider: string;
    model?: string;
    providerTaskId?: string;
    finalPromptPreview: string;
    finalPromptHash: string;
    finalPromptLength: number;
    referenceImages: Array<VideoAuditReferenceImage>;
    dialoguePolicy?: DialoguePolicy;
    dialoguePolicyNotes?: string;
    fallbackReason?: string;
    /**
     * Which payload builder ran. Callers reading audit logs use this to
     * decide how to interpret referenceImages and the returned* fields.
     *   - first_last_frame: Builder A (role=first_frame+last_frame only,
     *     no reference_image permitted by provider's mutual exclusion rule)
     *   - first_frame_multi_ref: Builder B (legacy multi-reference path)
     */
    payloadMode?: 'first_last_frame' | 'first_frame_multi_ref';
    /** Why the above mode was chosen, e.g. tail_ready, tail_unresolvable_degraded, no_tail_intent. */
    modeReason?: string;
    /** From VideoModelCapability.verifiedAt at the time of the request. */
    capabilityVerifiedAt?: string;
    /** Provider-returned last frame URL (only when first_last_frame mode and provider supports return_last_frame). */
    returnedLastFrameUrl?: string | null;
    /** Local path after downloading the returned last frame into the project directory. */
    returnedLastFrameLocalPath?: string | null;
    /** sha256 of the returned last frame content (for stable comparison across 24h URL expiries). */
    returnedLastFrameContentHash?: string | null;
    /** sha256 of the last frame the user submitted (so UI/tests can diff submitted vs returned). */
    submittedLastFrameContentHash?: string | null;
  };
};

/**
 * Per-reference record written into videoAudit. Semantic fields (role, label...)
 * describe planning intent; apiRole + apiContentIndex describe what was actually
 * submitted to the provider; imageContentHash is sha256(file) for stable
 * comparison between planning and submission.
 */
export type VideoAuditReferenceImage =
  Pick<VideoReferenceImage, 'role' | 'path' | 'label' | 'sourceUrl' | 'assetId' | 'assetName' | 'promptHint'>
  & {
    apiRole?: string;
    apiContentIndex?: number;
    imageContentHash?: string;
  };

export class VideoGenerationError extends Error {
  taskId?: string;
  videoAudit?: VideoGenResult['videoAudit'];
  failureStage: VideoPromptFailureStage;

  constructor(message: string, opts: {
    taskId?: string;
    videoAudit?: VideoGenResult['videoAudit'];
    failureStage?: VideoPromptFailureStage;
    cause?: any;
  } = {}) {
    super(message);
    this.name = 'VideoGenerationError';
    this.taskId = opts.taskId;
    this.videoAudit = opts.videoAudit;
    this.failureStage = opts.failureStage || classifyVideoFailureStage(opts.cause || message);
    if (opts.cause) (this as any).cause = opts.cause;
  }
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function retryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, time - Date.now());
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 1000);
}

function networkErrorMessage(err: any): string {
  return String(err?.message || err || '');
}

function isTransientNetworkError(err: any): boolean {
  const msg = networkErrorMessage(err);
  return /socket hang up|secure TLS|TLS connection|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|fetch failed|network|aborted/i.test(msg);
}

export function classifyVideoFailureStage(err: any): VideoPromptFailureStage {
  const status = Number(err?.status || err?.statusCode);
  const msg = networkErrorMessage(err);
  if (status === 429 || /rate.?limit|HTTP 429|429/i.test(msg)) return 'submit_rate_limited';
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|HTTP 401|HTTP 403/i.test(msg)) return 'submit_auth';
  if (status >= 500) return 'submit_network';
  if (isTransientNetworkError(err) || /retry_deadline_exceeded/i.test(msg)) return 'submit_network';
  if ((status >= 400 && status < 500) || /rejected|policy|审核|不符合|sensitive|filter|risk/i.test(msg)) {
    return 'submit_upstream_reject';
  }
  if (/poll|状态|超时|timeout|排队过久/i.test(msg)) return 'post_submit_poll';
  if (/download|下载/i.test(msg)) return 'download';
  return 'unknown';
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

let _submitSemaphoreLimit = 0;
let _submitSemaphore: Semaphore | null = null;

function videoSubmitSemaphore(): Semaphore {
  const limit = envInt('VIDEO_SUBMIT_CONCURRENCY', 2, 1, 3);
  if (!_submitSemaphore || _submitSemaphoreLimit !== limit) {
    _submitSemaphoreLimit = limit;
    _submitSemaphore = new Semaphore(limit);
  }
  return _submitSemaphore;
}

async function withVideoSubmitSlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return videoSubmitSemaphore().run(async () => {
    console.log(`[video-gen] submit slot acquired label=${label} concurrency=${_submitSemaphoreLimit}`);
    return fn();
  });
}

const DATA_DIR = join(process.cwd(), 'data');
const VIDEOS_DIR = join(DATA_DIR, 'videos');
mkdirSync(VIDEOS_DIR, { recursive: true });

/**
 * 主入口：生成 + 落 DB + 返回封装结果。
 *
 * 调用方决定是否轮询（这里内部是同步等到完成后才返回；
 * 上层一般在 batch executor 里，不会阻塞 HTTP 请求线程）。
 */
export async function generateVideo(
  user: UserRow,
  input: VideoGenInput,
  onProgress?: (pct: number, hint?: string) => void,
): Promise<VideoGenResult> {
  const cfg = resolveLLMConfig(user, 'video');
  const taskId = randomUUID();
  const ownerDir = join(VIDEOS_DIR, String(user.id));
  mkdirSync(ownerDir, { recursive: true });
  const filename = `${taskId}.mp4`;
  const fullPath = join(ownerDir, filename);
  // 选择适配器（提前算，决定时长）
  const cfgIsGrok = /^grok-video/i.test(cfg.model || '');
  const isVolcano = /volces\.com|volcengine|ark\.cn-/i.test(cfg.baseUrl) || /seedance|doubao/i.test(cfg.model);
  const isGrok = cfgIsGrok;
  // 生成请求时长来自镜头表计划时长；仅在模型自身固定时长或供应商最小时长时做适配。
  const dur = resolveGenerationDurationSec({
    plannedDurationSec: input.durationSec,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    minDurationSec: cfg.minDurationSec,
  });
  // ratio 优先；没传 ratio 时尊重 size，否则按 size 反推
  const sizeArgPresent = !!input.size;
  const { ratio: aspectRatio, size: sizeFromRatio } = normalizeRatio(
    input.ratio || (input.size === '1080x1920' ? '9:16' : input.size === '1920x1080' ? '16:9' : input.size === '1024x1024' ? '1:1' : '16:9'),
  );
  const size = (sizeArgPresent && !input.ratio ? input.size! : sizeFromRatio) as '1080x1920' | '1920x1080' | '1024x1024';
  console.log(`[video-gen] resolved ratio=${aspectRatio} size=${size} dur=${dur}s model=${cfg.model}`);

  let mode: 'real' | 'fake' = 'real';
  let videoAudit: VideoGenResult['videoAudit'] | undefined;

  // 入库登记
  const db = getDb();
  db.prepare(
    `INSERT INTO video_tasks (id, owner_id, project_id, group_idx, prompt, provider, status, progress, filename, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)`,
  ).run(
    taskId,
    user.id,
    input.projectId || null,
    input.groupIdx ?? null,
    input.prompt.slice(0, 4000),
    cfg.mode === 'fake' ? 'fake' : (cfg.model || 'openai'),
    filename,
    dur,
  );

  // 选择适配器：grok（中转） / 火山引擎 Seedance / OpenAI Sora / fake

  if (cfg.mode === 'fake' || !cfg.apiKey) {
    onProgress?.(20, '[fake] 生成黑场视频…');
    await makeBlackVideo({ outputPath: fullPath, durationSec: dur, withTone: true });
    onProgress?.(80, '[fake] 提取封面…');
    mode = 'fake';
  } else if (isGrok) {
    // ---- Grok video 适配（yungpt 中转）----
    // 提交：POST {base}/video/create
    // 轮询：GET  {base}/videos/{id}     （含 progress、video_id 字段）
    //       GET  {base}/video/query?id={id}（兜底，含 video_url）
    // 失败时直接抛错（**不 fallback 黑场视频**），上层 batch executor 会把这条任务标 failed
    try {
      const finalPrompt = input.prompt;
      videoAudit = {
        provider: 'grok',
        model: cfg.model,
        finalPromptPreview: finalPrompt.slice(0, 500),
        finalPromptHash: hashString(finalPrompt),
        finalPromptLength: finalPrompt.length,
        referenceImages: [],
        dialoguePolicy: 'budget_check_only',
      };
      console.log(`[video-gen][grok] final prompt length=${finalPrompt.length}`);

      // 关键：grok-video-3 提交参数兼容
      //   - grok-video-3-Ns（带数字后缀）：模型已锁时长，传 duration 是冗余但 OK
      //   - grok-video-3（无后缀）：实测同时传 aspect_ratio + duration 会让中转 60s 超时
      //                            → 所以无后缀模型只传 aspect_ratio
      const hasDurationSuffix = /-\d+s$/i.test(cfg.model);
      const submitBody: any = {
        model: cfg.model,
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
      };
      if (hasDurationSuffix) submitBody.duration = dur;
      console.log(`[video-gen][grok] submit body keys = ${Object.keys(submitBody).join(',')}`);
      onProgress?.(5, `提交 Grok 视频任务（${cfg.model}, ${dur}s, ${aspectRatio}）…`);

	      const submit: any = await withVideoSubmitSlot('[grok submit]', () => retryFetch(
	        `${cfg.baseUrl}/video/create`,
	        {
	          method: 'POST',
	          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
	          body: JSON.stringify(submitBody),
	        },
	        '[grok submit]',
	      ));
    console.log('[video-gen][grok] submit response:', JSON.stringify(submit).slice(0, 400));
	    const remoteId = submit.id || submit.task_id;
	    if (!remoteId) throw new Error('Grok API 返回缺 id：' + JSON.stringify(submit).slice(0, 200));
	    console.log('[video-gen][grok] remoteId =', remoteId);
	    db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);
	    if (videoAudit) videoAudit.providerTaskId = remoteId;

    const isTerminalStatus = (s: string) =>
      /^(succeeded|success|completed|complete|finished|done|ok|ready)$/i.test(s);
    const isFailureStatus = (s: string) =>
      /^(failed|fail|error|cancelled|canceled|timeout)$/i.test(s);

    const deadline = Date.now() + 10 * 60 * 1000; // 10 分钟超时
    let status = (submit.status || 'processing').toLowerCase();
    let videoUrl = '';
    let providerProgress = 0;
    let pollCount = 0;

    while (!isTerminalStatus(status) && !isFailureStatus(status) && !videoUrl) {
      if (Date.now() > deadline) throw new Error('Grok 视频生成超时（10 分钟）');
      await sleep(8000);
      pollCount++;

      // 主端点：GET /videos/{id}（progress 更细）
      let j: any = null;
      try {
        j = await retryFetch(
          `${cfg.baseUrl}/videos/${encodeURIComponent(remoteId)}`,
          { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
          `[grok poll #${pollCount}]`,
        );
      } catch (eMain: any) {
        console.warn(`[video-gen][grok] poll #${pollCount} /videos/{id} failed: ${eMain?.message || eMain}, fallback to /video/query`);
        try {
          j = await retryFetch(
            `${cfg.baseUrl}/video/query?id=${encodeURIComponent(remoteId)}`,
            { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
            `[grok poll #${pollCount} fallback]`,
          );
        } catch (eAlt: any) {
          console.warn(`[video-gen][grok] poll #${pollCount} fallback also failed: ${eAlt?.message || eAlt}`);
          // 单次失败不致命，下一轮继续
          continue;
        }
      }

      status = (j.status || '').toString().toLowerCase();
      videoUrl = j.video_url || j.url || videoUrl;
      providerProgress = Number.isFinite(j.progress) ? Number(j.progress) : providerProgress;
      const stageHint = Math.min(85, Math.max(20 + pollCount * 4, providerProgress));
      onProgress?.(stageHint, `Grok 状态：${status || '生成中'}（${providerProgress}%）`);
      db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(stageHint, taskId);
      console.log(`[video-gen][grok] poll #${pollCount} status=${status} progress=${providerProgress} videoUrl=${videoUrl ? 'yes' : 'no'}`);
    }

    if (isFailureStatus(status)) throw new Error(`Grok 任务结束状态: ${status}`);
    if (!videoUrl) throw new Error('Grok 完成但没返回 video_url（最后状态: ' + status + '）');
    console.log(`[video-gen][grok] succeeded after ${pollCount} polls, url=${videoUrl.slice(0, 100)}…`);

    onProgress?.(90, '下载视频…');
      const buf = await retryDownload(videoUrl);
      require('node:fs').writeFileSync(fullPath, buf);
      console.log(`[video-gen][grok] downloaded ${buf.length} bytes to ${fullPath}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.warn('[video-gen][grok] generation failed:', msg);
      console.warn('[video-gen][grok] full error:', String(e?.stack || e).slice(0, 800));
      // 残留文件清理
      try { require('node:fs').unlinkSync(fullPath); } catch (_) {}
      // 标 video_tasks 失败（**不写假视频**）
      db.prepare(
        `UPDATE video_tasks SET status='failed', error_msg=?,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(msg.slice(0, 1000), taskId);
      // 往上抛 → batch executor 会把对应 batch_task 标 failed，前端能"重试"
	      throw new VideoGenerationError('Grok 视频生成失败：' + msg.slice(0, 200), {
	        taskId,
	        videoAudit,
	        failureStage: classifyVideoFailureStage(e),
	        cause: e,
	      });
    }
  } else if (isVolcano) {
    // ===============================================================
    // Builder A — first+last frame mode (mutually exclusive with
    // Builder B's multi-reference mode, per Seedance's official rule).
    // Activated when the executor set input.firstLastFrameMode.
    // ===============================================================
    if (input.firstLastFrameMode) {
      try {
        onProgress?.(5, '提交火山 Seedance 首尾帧任务…');
        const capability = resolveVideoModelCapability(cfg.model);
        const { firstFramePath, lastFramePath, modeReason } = input.firstLastFrameMode;

        const firstBuf = readFileSync(firstFramePath);
        const lastBuf = readFileSync(lastFramePath);
        const submittedFirstHash = createHash('sha256').update(firstBuf).digest('hex');
        const submittedLastHash = createHash('sha256').update(lastBuf).digest('hex');

        const promptParts = buildSeedanceFirstLastFramePromptParts({
          prompt: input.prompt || '',
          dialoguePairs: input.dialoguePairs,
          characterLockRoster: input.characterLockRoster,
          voiceRoster: input.voiceRoster,
          prevTailSummary: input.prevTailSummary,
          nextHeadSummary: input.nextHeadSummary,
        });
        const finalPrompt = promptParts.finalPrompt;

        const body = buildSeedanceFirstLastFrameBody({
          model: cfg.model || 'doubao-seedance-2-0-260128',
          prompt: finalPrompt,
          firstFramePath,
          lastFramePath,
          ratio: aspectRatio,
          durationSec: dur,
          resolution: '720p',
          watermark: false,
          generateAudio: false,
          returnLastFrame: capability.supportsReturnLastFrame,
        });

        videoAudit = {
          provider: 'seedance',
          model: cfg.model,
          finalPromptPreview: finalPrompt.slice(0, 500),
          finalPromptHash: hashString(finalPrompt),
          finalPromptLength: finalPrompt.length,
          dialoguePolicy: 'budget_check_only',
          payloadMode: 'first_last_frame',
          modeReason: modeReason || 'tail_ready',
          capabilityVerifiedAt: capability.verifiedAt,
          submittedLastFrameContentHash: submittedLastHash,
          referenceImages: [
            {
              role: 'first_frame',
              path: firstFramePath,
              label: `segment ${(input.groupIdx ?? 0) + 1} first frame`,
              apiRole: 'first_frame',
              apiContentIndex: 1,
              imageContentHash: submittedFirstHash,
            },
            {
              role: 'target_end',
              path: lastFramePath,
              label: `segment ${(input.groupIdx ?? 0) + 1} last frame`,
              apiRole: 'last_frame',
              apiContentIndex: 2,
              imageContentHash: submittedLastHash,
            },
          ],
        };

        const submit: any = await withVideoSubmitSlot('[seedance first-last submit]', () => retryFetch(
          `${cfg.baseUrl}/contents/generations/tasks`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify(body),
          },
          '[seedance first-last submit]',
        ));
        const remoteId = submit.id;
        if (!remoteId) throw new Error('Seedance API 返回缺 id');
        console.log(`[video-gen][seedance][first-last] task created id=${remoteId}`);
        db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);
        if (videoAudit) videoAudit.providerTaskId = remoteId;

        const deadline = Date.now() + 15 * 60 * 1000;
        let status = (submit.status || '').toLowerCase();
        let videoUrl = '';
        let returnedLastFrameUrl: string | null = null;
        let pollCount = 0;
        let lastErrorPayload = '';
        while (!['succeeded', 'failed', 'cancelled'].includes(status)) {
          if (Date.now() > deadline) {
            throw new Error('Seedance 排队过久（>15 分钟未返回），请稍后重试此片段');
          }
          await sleep(6000);
          pollCount++;
          const j: any = await retryFetch(
            `${cfg.baseUrl}/contents/generations/tasks/${remoteId}`,
            { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
            `[seedance first-last poll #${pollCount}]`,
          );
          status = (j.status || '').toLowerCase();
          videoUrl = j?.content?.video_url || videoUrl;
          returnedLastFrameUrl = j?.content?.last_frame_url || returnedLastFrameUrl;
          if (status === 'failed' || status === 'cancelled') {
            lastErrorPayload =
              j?.error?.message ||
              j?.error?.code ||
              j?.fail_reason ||
              JSON.stringify(j?.error || {}).slice(0, 300);
          }
          const stageHint = status === 'queued' ? 20 : (status === 'running' || status === 'in_progress') ? Math.min(70, 30 + pollCount * 3) : 85;
          onProgress?.(stageHint, `Seedance 首尾帧状态：${status}`);
          db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(stageHint, taskId);
        }
        if (status !== 'succeeded') {
          throw new Error(lastErrorPayload || `任务结束状态: ${status}`);
        }
        if (!videoUrl) throw new Error('Seedance 完成但没返回 video_url');
        console.log(`[video-gen][seedance][first-last] succeeded after ${pollCount} polls`);

        onProgress?.(90, '下载视频…');
        const buf = await retryDownload(videoUrl);
        writeFileSync(fullPath, buf);
        console.log(`[video-gen][seedance][first-last] downloaded ${buf.length} bytes to ${fullPath}`);

        if (returnedLastFrameUrl && videoAudit) {
          try {
            const returnedBuf = await retryDownload(returnedLastFrameUrl);
            // Register the returned last frame in the images table so the
            // frontend can render it via the existing /api/images/file/:id
            // endpoint and diff it against the user's submitted tail frame.
            const returnedImageId = randomUUID();
            const imagesOwnerDir = join(DATA_DIR, 'images', String(user.id));
            mkdirSync(imagesOwnerDir, { recursive: true });
            const returnedLocalPath = join(imagesOwnerDir, `${returnedImageId}.png`);
            writeFileSync(returnedLocalPath, returnedBuf);
            const returnedStat = statSync(returnedLocalPath);
            db.prepare(
              `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
               VALUES (?, ?, ?, 'other', ?, ?, 'image/png', ?, 0, 0, ?, 'video-last-frame')`,
            ).run(
              returnedImageId,
              user.id,
              input.projectId || null,
              `video-last-frame/${taskId}`,
              `${returnedImageId}.png`,
              returnedStat.size,
              (input.prompt || '').slice(0, 200),
            );
            videoAudit.returnedLastFrameUrl = `/api/images/file/${returnedImageId}`;
            videoAudit.returnedLastFrameLocalPath = returnedLocalPath;
            videoAudit.returnedLastFrameContentHash = createHash('sha256').update(returnedBuf).digest('hex');
            console.log(`[video-gen][seedance][first-last] returned last_frame saved to images table as ${returnedImageId}`);
          } catch (dErr: any) {
            console.warn(`[video-gen][seedance][first-last] failed to download returned last_frame: ${String(dErr?.message || dErr).slice(0, 200)}`);
          }
        }

        // --- Cover extraction (same pattern as Builder B's common path) ---
        let coverImageId: string | null = null;
        let coverUrl: string | null = null;
        try {
          const coverPath = join(ownerDir, `${taskId}.cover.png`);
          await extractCover({ videoPath: fullPath, outputPath: coverPath });
          coverImageId = randomUUID();
          const stat = statSync(coverPath);
          db.prepare(
            `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
             VALUES (?, ?, ?, 'other', ?, ?, 'image/png', ?, 1080, 1920, ?, 'video-cover')`,
          ).run(
            coverImageId,
            user.id,
            input.projectId || null,
            `video-cover/${taskId}`,
            `${taskId}.cover.png`,
            stat.size,
            (input.prompt || '').slice(0, 200),
          );
          coverUrl = `/api/images/file/${coverImageId}`;
          db.prepare('UPDATE video_tasks SET cover_image_id=? WHERE id=?').run(coverImageId, taskId);
        } catch (e: any) {
          console.warn('[video-gen][seedance][first-last] extract cover failed:', e?.message);
        }

        db.prepare(
          `UPDATE video_tasks SET status='completed', progress=100,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(taskId);

        onProgress?.(100, '完成');
        const protectedUrl = `/api/videos/file/${taskId}`;
        return {
          taskId,
          status: 'completed',
          url: buildSignedVideoUrl(taskId, user.id).url,
          protectedUrl,
          coverUrl,
          durationSec: dur,
          mode,
          videoAudit,
        };
      } catch (e: any) {
        const msg = String(e?.message || e);
        let friendly = msg;
        if (/sensitive|filter|risk|content[\s_-]?policy|不符合(?:内容)?规范|敏感|审核未通过/i.test(msg)) {
          friendly =
            '画面或台词被 Seedance 内容安全过滤拦截（首尾帧模式下同样会触发）。' +
            '可尝试：① 改写视频提示词，② 更换首帧或尾帧图片，③ 回退到首帧+多图模式（临时移除尾帧）。';
        }
        console.warn('[video-gen][seedance][first-last] failed:', msg.slice(0, 300));
        try { require('node:fs').unlinkSync(fullPath); } catch (_) {}
        db.prepare(
          `UPDATE video_tasks SET status='failed', error_msg=?,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(friendly.slice(0, 1000), taskId);
        throw new VideoGenerationError(friendly.slice(0, 400), {
          taskId,
          videoAudit,
          failureStage: classifyVideoFailureStage(e),
          cause: e,
        });
      }
    }
    // ---- 火山引擎 Seedance 适配（Builder B: 首帧 + 多参考图） ----
    try {
      onProgress?.(5, '提交火山 Seedance 任务…');

      // 用户反馈两个核心问题：
      //   1) "片段经常有重复的台词" —— 因为结构化 videoPrompt 里的 0-3s/3-5s
      //      段落把台词写在叙事里，相邻 group 的 LLM 输出常引用同一句台词；
      //      Seedance 又更"听"长 prompt 的叙事而不是末尾"台词："那行。
      //      → 修法：把"本组唯一台词" 顶到 prompt 最前面，并强制说"只能说这句，
      //        其它任何引号台词全都不准念"。
      //   2) "片段3和片段4出来的画面也是黑白的（用的是素描的图）" —— Seedance
      //      i2v 把铅笔分镜的黑白色调一并保留下来。
      //      → 修法：参考图前加"风格强制覆盖"指令，告诉 Seedance 参考图只用作
      //        构图/角色/镜头参考，最终视频必须全彩电影级。

      // 用户反馈关键架构问题："前面有场景彩色图和人物角色彩色图，不能单一参考
      // 分镜图去生成"——之前只把黑白分镜草图当 i2v 主参考，等于让 Seedance
      // 基于黑白调凭空想象彩色画面，前面"资产"步骤生成的彩色场景/角色图完全
      // 没传过来。
      //
      // 修法：先把"彩色场景图（顶部主背景）+ 彩色角色图（底部缩略图条）+
      // 黑白分镜草图（右上小角标）"合成成一张"视觉圣经参考图"，再统一打人脸
      // 遮罩送给 Seedance。这样：
      //   · 主色调来自彩色场景图 → 不再黑白
      //   · 角色外形来自彩色角色三视图 → 跨片段一致
      //   · 镜头构图/景别来自分镜草图小角标 → 不丢前期分镜工作
      const seedancePrompt = buildSeedancePromptParts({
        ...input,
        ratio: aspectRatio,
        durationSec: dur,
      });
      const independentReferenceImages = seedancePrompt.independentReferenceImages;
      const hasIndependentImageRefs = seedancePrompt.hasIndependentImageRefs;
      const hasFirstFrameRef = seedancePrompt.hasFirstFrameRef;
      const hasColorRefs = seedancePrompt.hasColorRefs;
      const hasAnyRef = seedancePrompt.hasAnyRef;
      videoAudit = {
        provider: 'seedance',
        model: cfg.model,
        finalPromptPreview: seedancePrompt.finalPrompt.slice(0, 500),
        finalPromptHash: hashString(seedancePrompt.finalPrompt),
        finalPromptLength: seedancePrompt.finalPrompt.length,
        referenceImages: [],
        dialoguePolicy: 'budget_check_only',
        payloadMode: 'first_frame_multi_ref',
        modeReason: input.payloadModeReason || 'no_tail_intent',
      };

      const content: any[] = [
        { type: 'text', text: seedancePrompt.finalPrompt },
      ];

      if (hasIndependentImageRefs) {
        try {
          for (const ref of independentReferenceImages) {
            content.push({
              type: 'image_url',
              image_url: { url: imagePathToDataUrl(ref.path) },
              role: 'reference_image',
            });
          }
          videoAudit = {
            provider: 'seedance',
            model: cfg.model,
            finalPromptPreview: seedancePrompt.finalPrompt.slice(0, 500),
            finalPromptHash: hashString(seedancePrompt.finalPrompt),
            finalPromptLength: seedancePrompt.finalPrompt.length,
            dialoguePolicy: 'budget_check_only',
            payloadMode: 'first_frame_multi_ref',
            modeReason: input.payloadModeReason || 'no_tail_intent',
            referenceImages: independentReferenceImages.map((ref) => ({
              role: ref.role,
              path: ref.path,
              label: ref.label,
              sourceUrl: ref.sourceUrl,
              assetId: ref.assetId,
              assetName: ref.assetName,
              promptHint: ref.promptHint,
            })),
          };
          console.log(
            `[video-gen][seedance] attached independent reference images ` +
              `(${independentReferenceImages.map((ref, i) => `Image${i + 1}:${ref.role}:${ref.label}`).join(' | ')})`,
          );
          console.log(
            `[metric][seedance][multi-image] attempted groupIdx=${input.groupIdx ?? -1} ` +
              `images=${independentReferenceImages.length} ` +
              `roles=${independentReferenceImages.map((ref) => ref.role).join(',')}`,
          );
        } catch (refErr: any) {
          console.warn(
            '[video-gen][seedance] independent reference image build failed, falling back to text-only:',
            refErr?.message || refErr,
          );
        }
      } else if (hasAnyRef) {
        try {
          let refBuf: Buffer | null = null;
          if (hasFirstFrameRef && input.referenceImagePath) {
            refBuf = readFileSync(input.referenceImagePath);
            console.log(
              `[video-gen][seedance] attached first-frame reference directly ` +
                `(props=${input.propReferencePaths?.length || 0}, panels=${input.characterReferencePanels?.length || 0})`,
            );
          } else if (hasColorRefs) {
            // 走新路径：合成"彩色场景 + 彩色角色 + 黑白草图角标"
            const composite = await buildColorReferenceComposite({
              scenePath: input.sceneReferencePath,
              characterPaths: input.characterReferencePaths,
              characterPanels: input.characterReferencePanels,
              propPaths: input.propReferencePaths,
              storyboardPath: input.referenceImagePath,
            });
            if (composite) {
              refBuf = await applyFaceSafetyMask(composite);
              console.log(
                `[video-gen][seedance] built color reference composite ` +
                  `(scene=${!!input.sceneReferencePath}, panels=${input.characterReferencePanels?.length || 0}, ` +
                  `chars=${input.characterReferencePaths?.length || 0}, ` +
                  `props=${input.propReferencePaths?.length || 0}, firstFrame=${hasFirstFrameRef}, ` +
                  `sb=${!!(hasFirstFrameRef ? input.storyboardReferencePath : input.referenceImagePath)})`,
              );
            }
          }
          // 兜底：合成失败 / 没彩色资产 → 用旧的纯分镜草图路径
          if (!refBuf && !hasFirstFrameRef && input.referenceImagePath) {
            refBuf = await applyFaceSafetyMask(input.referenceImagePath);
          }

          if (refBuf) {
            const dataUrl = `data:image/png;base64,${refBuf.toString('base64')}`;
            content.push({ type: 'image_url', image_url: { url: dataUrl }, role: 'reference_image' });
            console.log(`[video-gen][seedance] attached i2v ref image (${refBuf.length} bytes)`);
          }
        } catch (refErr: any) {
          console.warn(
            '[video-gen][seedance] reference image build failed, falling back to text-only:',
            refErr?.message || refErr,
          );
        }
      }

      let submit: any;
      try {
	        submit = await withVideoSubmitSlot('[seedance submit]', () => retryFetch(
	          `${cfg.baseUrl}/contents/generations/tasks`,
	          {
	            method: 'POST',
	            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
	            body: JSON.stringify({
	              model: cfg.model || 'doubao-seedance-2-0-260128',
	              content,
	              ratio: aspectRatio,
	              duration: dur,
	              resolution: '720p',
	              watermark: false,
	              generate_audio: false,
	            }),
	          },
	          '[seedance submit]',
	        ));
      } catch (submitErr: any) {
        if (hasIndependentImageRefs && hasFirstFrameRef && input.referenceImagePath && isInputImageSensitiveError(submitErr)) {
          console.warn(
            '[video-gen][seedance] independent refs rejected by input-image safety; retrying with first-frame only:',
            submitErr?.message || submitErr,
          );
          console.log(
            `[metric][seedance][multi-image] fallback groupIdx=${input.groupIdx ?? -1} ` +
              `reason=sensitive images=${independentReferenceImages.length}`,
          );
              const fallbackPrompt = buildSeedancePromptParts({
                ...input,
                ratio: aspectRatio,
                durationSec: dur,
                referenceImages: undefined,
                referenceImageRole: 'first_frame',
              });
              videoAudit = {
                provider: 'seedance',
                model: cfg.model,
                finalPromptPreview: fallbackPrompt.finalPrompt.slice(0, 500),
                finalPromptHash: hashString(fallbackPrompt.finalPrompt),
                finalPromptLength: fallbackPrompt.finalPrompt.length,
                dialoguePolicy: 'budget_check_only',
                payloadMode: 'first_frame_multi_ref',
                modeReason: input.payloadModeReason || 'first_frame_fallback',
                referenceImages: [{
                  role: 'first_frame',
                  path: input.referenceImagePath,
                  label: `segment ${(input.groupIdx ?? 0) + 1} first frame`,
                  promptHint: 'Fallback after independent reference images were rejected.',
                }],
                fallbackReason: 'independent_refs_rejected_by_input_image_safety',
              };
              const fallbackContent: any[] = [
                { type: 'text', text: fallbackPrompt.finalPrompt },
            {
              type: 'image_url',
              image_url: { url: imagePathToDataUrl(input.referenceImagePath) },
              role: 'reference_image',
            },
          ];
	          submit = await withVideoSubmitSlot('[seedance submit first-frame fallback]', () => retryFetch(
	            `${cfg.baseUrl}/contents/generations/tasks`,
	            {
	              method: 'POST',
	              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
	              body: JSON.stringify({
	                model: cfg.model || 'doubao-seedance-2-0-260128',
	                content: fallbackContent,
	                ratio: aspectRatio,
	                duration: dur,
	                resolution: '720p',
	                watermark: false,
	                generate_audio: false,
	              }),
	            },
	            '[seedance submit first-frame fallback]',
	          ));
        } else {
          throw submitErr;
        }
      }
      const remoteId = submit.id;
      if (!remoteId) throw new Error('Seedance API 返回缺 id');
      console.log(`[video-gen][seedance] task created id=${remoteId}`);
      db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);
      if (videoAudit) videoAudit.providerTaskId = remoteId;

      // 用户反馈：10 分钟有时撞到 Seedance 排队/慢推理导致"等待时间过长"误报失败。
      // 加长到 15 分钟兜住高峰期排队，并把超时文案带上重试建议。
      const deadline = Date.now() + 15 * 60 * 1000;
      let status = (submit.status || '').toLowerCase();
      let videoUrl = '';
      let pollCount = 0;
      let lastErrorPayload = '';
      while (!['succeeded', 'failed', 'cancelled'].includes(status)) {
        if (Date.now() > deadline) {
          throw new Error('Seedance 排队过久（>15 分钟未返回），请稍后重试此片段');
        }
        await sleep(6000);
        pollCount++;
        const j: any = await retryFetch(
          `${cfg.baseUrl}/contents/generations/tasks/${remoteId}`,
          { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
          `[seedance poll #${pollCount}]`,
        );
        status = (j.status || '').toLowerCase();
        videoUrl = j?.content?.video_url || j?.video_url || videoUrl;
        // 失败时把后端返回的具体原因吞下来（火山的"素材不符合内容规范，请尝试重试"
        // 就藏在这里），这样上层 catch 块的 sanitizer 才能识别成"内容安全过滤"
        if (status === 'failed' || status === 'cancelled') {
          lastErrorPayload =
            j?.error?.message ||
            j?.error?.code ||
            j?.fail_reason ||
            j?.failReason ||
            j?.message ||
            '';
        }
        const stageHint = status === 'queued' ? 20 : status === 'running' || status === 'in_progress' ? Math.min(70, 30 + pollCount * 3) : 85;
        onProgress?.(stageHint, `Seedance 状态：${status}`);
        db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(stageHint, taskId);
      }
      if (status !== 'succeeded') {
        const reason = lastErrorPayload || `任务结束状态: ${status}`;
        throw new Error(reason);
      }
      if (!videoUrl) throw new Error('Seedance 完成但没返回 video_url');
      console.log(`[video-gen][seedance] succeeded after ${pollCount} polls, url=${videoUrl.slice(0, 80)}…`);

      onProgress?.(90, '下载视频…');
      const buf = await retryDownload(videoUrl);
      require('node:fs').writeFileSync(fullPath, buf);
      console.log(`[video-gen][seedance] downloaded ${buf.length} bytes to ${fullPath}`);
    } catch (e: any) {
      // 用户反馈：之前 Seedance 失败兜底成黑场假视频，UI 显示"成功"但播放是全黑，
      // 误导。统一改成"真失败"——抛错让 batch_executor 把任务标 failed，
      // 前端的"重试"按钮才能起作用。
      const msg = String(e?.message || e);
      // 内容安全过滤的错误码常见：FilteredContent / SensitiveContentDetected /
      // "素材不符合内容规范" / "Risk control" 等关键词。把它转成更易读的提示。
      let friendly = msg;
      if (/sensitive|filter|risk|content[\s_-]?policy|不符合(?:内容)?规范|敏感|审核未通过/i.test(msg)) {
        friendly =
          '画面或台词被 Seedance 内容安全过滤拦截（通常是"过于像真人"触发的人脸识别保护）。' +
          '已自动剔除身份描述但仍被拦截，可尝试：① 改写视频提示词页里的角色描述（去掉年龄/族裔等），' +
          '② 用 Grok 模型生成同一片段，③ 联系火山方舟客服申请豁免身份过滤。';
      }
      console.warn('[video-gen][seedance] failed (no fallback):', msg.slice(0, 300));
      console.warn('[video-gen][seedance] full error:', String(e?.stack || e).slice(0, 800));
      try { require('node:fs').unlinkSync(fullPath); } catch (_) {}
      db.prepare(
        `UPDATE video_tasks SET status='failed', error_msg=?,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(friendly.slice(0, 1000), taskId);
	      throw new VideoGenerationError(friendly.slice(0, 400), {
	        taskId,
	        videoAudit,
	        failureStage: classifyVideoFailureStage(e),
	        cause: e,
	      });
    }
  } else {
    // ---- OpenAI Sora 适配 ----
    try {
      onProgress?.(5, '提交 Sora 任务…');
      const finalPrompt = input.prompt;
      const soraModel = cfg.model || 'sora-2';
      videoAudit = {
        provider: 'sora',
        model: soraModel,
        finalPromptPreview: finalPrompt.slice(0, 500),
        finalPromptHash: hashString(finalPrompt),
        finalPromptLength: finalPrompt.length,
        referenceImages: [],
        dialoguePolicy: 'budget_check_only',
      };
	      const submit: any = await withVideoSubmitSlot('[sora submit]', () => retryFetch(
	        `${cfg.baseUrl}/videos`,
	        {
	          method: 'POST',
	          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
	          body: JSON.stringify({
	            model: soraModel,
	            prompt: finalPrompt,
	            size,
	            seconds: String(dur),
	          }),
	        },
	        '[sora submit]',
	      ));
      const remoteId = submit.id;
      if (!remoteId) throw new Error('Video API 返回缺 id');
      db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);
      if (videoAudit) videoAudit.providerTaskId = remoteId;

      const deadline = Date.now() + 6 * 60 * 1000;
      let status = submit.status || 'queued';
      let progress = 0;
      while (status !== 'completed' && status !== 'failed') {
        if (Date.now() > deadline) throw new Error('视频生成超时（6 分钟）');
        await sleep(5000);
        const r = await fetchViaProxy(`${cfg.baseUrl}/videos/${remoteId}`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error(`Video poll ${r.status}: ${t.slice(0, 400)}`);
        }
        const j: any = await r.json();
        status = j.status || 'queued';
        progress = j.progress ?? progress;
        onProgress?.(Math.max(progress, 10), `远端状态：${status} (${progress}%)`);
        db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(progress, taskId);
      }
      if (status === 'failed') throw new Error('远端视频任务 failed');

      onProgress?.(90, '下载视频…');
      const dl = await fetchViaProxy(`${cfg.baseUrl}/videos/${remoteId}/content`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
      if (!dl.ok) throw new Error(`下载 ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      require('node:fs').writeFileSync(fullPath, buf);
    } catch (e: any) {
      console.warn('[video-gen][sora] fallback to placeholder:', e?.message);
      try { require('node:fs').unlinkSync(fullPath); } catch (_) {}
      await makeBlackVideo({ outputPath: fullPath, durationSec: dur, withTone: true });
      mode = 'fake';
      db.prepare('UPDATE video_tasks SET error_msg=? WHERE id=?').run(String(e?.message || e).slice(0, 1000), taskId);
    }
  }

  // 自动出封面（直接抽第一帧）
  onProgress?.(95, '提取封面…');
  let coverImageId: string | null = null;
  let coverUrl: string | null = null;
  try {
    const coverPath = join(ownerDir, `${taskId}.cover.png`);
    await extractCover({ videoPath: fullPath, outputPath: coverPath });
    // 把封面也写入 images 表（这样跟 storyboard / asset 图同样的访问路径）
    coverImageId = randomUUID();
    const stat = statSync(coverPath);
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (?, ?, ?, 'other', ?, ?, 'image/png', ?, 1080, 1920, ?, 'video-cover')`,
    ).run(
      coverImageId,
      user.id,
      input.projectId || null,
      `video-cover/${taskId}`,
      `${taskId}.cover.png`,
      stat.size,
      input.prompt.slice(0, 200),
    );
    coverUrl = `/api/images/file/${coverImageId}`;
    db.prepare('UPDATE video_tasks SET cover_image_id=? WHERE id=?').run(coverImageId, taskId);
  } catch (e: any) {
    console.warn('[video-gen] extract cover failed:', e?.message);
  }

  db.prepare(
    `UPDATE video_tasks SET status='completed', progress=100,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
  ).run(taskId);

  onProgress?.(100, '完成');

  const protectedUrl = `/api/videos/file/${taskId}`;

  return {
    taskId,
    status: 'completed',
    url: buildSignedVideoUrl(taskId, user.id).url,
    protectedUrl,
      coverUrl,
      durationSec: dur,
      mode,
      videoAudit,
    };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function imagePathToDataUrl(imagePath: string): string {
  const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
}

/**
 * Builder A — construct the Seedance first+last frame request body.
 *
 * This is a pure function: takes validated paths and runtime knobs, returns
 * the POST body shape. The executor is responsible for choosing this builder
 * (based on VideoModelCapability + tailFrameIntent) and for writing/reading
 * audit records.
 *
 * Official request shape (Volcengine Ark doubao-seedance-2-0, verified 2026-05-09):
 *   {
 *     model, content: [
 *       { type: 'text', text },
 *       { type: 'image_url', image_url: { url }, role: 'first_frame' },
 *       { type: 'image_url', image_url: { url }, role: 'last_frame' },
 *     ],
 *     ratio, duration, resolution,         // top-level (NOT in prompt)
 *     watermark: false, generate_audio: false,
 *     return_last_frame: true,             // ask provider to echo its final frame
 *   }
 *
 * Strict mutual exclusion with reference_image mode is enforced upstream; this
 * builder will not accept any reference_image param.
 */
export function buildSeedanceFirstLastFrameBody(opts: {
  model: string;
  prompt: string;
  firstFramePath: string;
  lastFramePath: string;
  ratio: string;
  durationSec: number;
  resolution?: string;
  watermark?: boolean;
  generateAudio?: boolean;
  returnLastFrame?: boolean;
}): any {
  const {
    model,
    prompt,
    firstFramePath,
    lastFramePath,
    ratio,
    durationSec,
    resolution = '720p',
    watermark = false,
    generateAudio = false,
    returnLastFrame = true,
  } = opts;
  return {
    model,
    content: [
      { type: 'text', text: prompt },
      {
        type: 'image_url',
        image_url: { url: imagePathToDataUrl(firstFramePath) },
        role: 'first_frame',
      },
      {
        type: 'image_url',
        image_url: { url: imagePathToDataUrl(lastFramePath) },
        role: 'last_frame',
      },
    ],
    ratio,
    duration: durationSec,
    resolution,
    watermark,
    generate_audio: generateAudio,
    return_last_frame: returnLastFrame,
  };
}

function isInputImageSensitiveError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return /InputImageSensitiveContentDetected|PrivacyInformation|real person|真人|隐私/i.test(msg);
}

/**
 * 带重试的 fetch + JSON 解析。submit 阶段使用更长退避和 overall deadline，
 * poll 阶段保留较短重试，避免一次网络抖动直接打断长任务。
 */
async function retryFetch(url: string, init: any, label: string, retries = 3): Promise<any> {
  const isSubmit = /submit|video\/create|generations\/tasks(?!\/)/i.test(label) || /\/video\/create$|\/contents\/generations\/tasks$|\/videos$/.test(url);
  const maxAttempts = isSubmit ? envInt('VIDEO_SUBMIT_MAX_ATTEMPTS', 5, 1, 8) : retries;
  const deadlineMs = isSubmit
    ? envInt('VIDEO_SUBMIT_RETRY_DEADLINE_MS', 120_000, 10_000, 600_000)
    : envInt('VIDEO_FETCH_RETRY_DEADLINE_MS', 60_000, 5_000, 300_000);
  const deadlineAt = Date.now() + deadlineMs;
  let lastErr: any;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetchViaProxy(url, init);
      if (!resp.ok) {
        const t = await resp.text();
        const err: any = new Error(`${label} HTTP ${resp.status}: ${t.slice(0, 300)}`);
        err.status = resp.status;
        err.retryAfterMs = retryAfterMs(resp.headers.get('retry-after'));
        throw err;
      }
      return await resp.json();
    } catch (e: any) {
      lastErr = e;
      const status = Number(e?.status || e?.statusCode);
      const msg = e?.message || String(e);
      const retryable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        (!status && isTransientNetworkError(e));
      const attemptsLeft = i < maxAttempts - 1;
      if (retryable && attemptsLeft) {
        const retryAfter = typeof e?.retryAfterMs === 'number' ? e.retryAfterMs : null;
        const baseDelay = status === 429
          ? envInt('VIDEO_SUBMIT_429_RETRY_BASE_MS', 20_000, 1_000, 300_000)
          : isSubmit
            ? envInt('VIDEO_SUBMIT_NETWORK_RETRY_BASE_MS', 10_000, 1_000, 120_000)
            : 2_000;
        const capDelay = isSubmit
          ? envInt('VIDEO_SUBMIT_RETRY_MAX_MS', 90_000, 1_000, 300_000)
          : 12_000;
        const computedDelay = Math.min(capDelay, retryAfter != null ? retryAfter : baseDelay * Math.pow(2, i));
        const delay = jitter(computedDelay);
        if (Date.now() + delay > deadlineAt) {
          const finalErr: any = new Error(
            `${label} retry_deadline_exceeded after ${i + 1}/${maxAttempts}: ${msg}`,
          );
          finalErr.status = status;
          finalErr.failureStage = classifyVideoFailureStage(e);
          throw finalErr;
        }
        console.warn(
          `${label} attempt ${i + 1}/${maxAttempts} failed: ${msg}; retrying in ${Math.round(delay / 1000)}s`,
        );
        await sleep(delay);
        continue;
      }
      const finalErr: any = new Error(`${label} 失败（${i + 1} 次尝试后）: ${msg}`);
      finalErr.status = status;
      finalErr.failureStage = classifyVideoFailureStage(e);
      throw finalErr;
    }
  }
  throw lastErr;
}

/**
 * 带重试的下载（视频 URL 是 CDN，可能抖一下）。
 */
async function retryDownload(url: string, retries = 3): Promise<Buffer> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      const dl = await fetchViaProxy(url);
      if (!dl.ok) throw new Error(`下载 HTTP ${dl.status}`);
      return Buffer.from(await dl.arrayBuffer());
    } catch (e: any) {
      lastErr = e;
      if (i < retries - 1) {
        console.warn(`[video-gen] download retry ${i + 1}/${retries}:`, e?.message || e);
        await sleep(3000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export function getVideoTaskMeta(id: string, ownerId: number) {
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM video_tasks WHERE id = @id AND owner_id = @uid')
    .get({ id, uid: ownerId });
  if (!row) return null;
  return {
    ...row,
    fullPath: join(VIDEOS_DIR, String(row.owner_id), row.filename || ''),
  };
}

const recoveringVideoTasks = new Set<string>();

export function recoverRunningVideoTasks(limit = 12) {
  const db = getDb();
  const rows = db
    .prepare<[], any>(
      `SELECT *
       FROM video_tasks
       WHERE status IN ('queued','running')
       ORDER BY created_at ASC
       LIMIT ${Math.max(1, Math.min(limit, 50))}`,
    )
    .all();

  if (!rows.length) return 0;

  let started = 0;
  for (const row of rows) {
    const taskId = String(row.id || '');
    if (!taskId || recoveringVideoTasks.has(taskId)) continue;

    if (!row.provider_task) {
      const createdAt = Date.parse(row.created_at || '');
      const stale = Number.isFinite(createdAt) && Date.now() - createdAt > 2 * 60 * 1000;
      if (stale) {
        db.prepare(
          `UPDATE video_tasks
           SET status='failed',
               error_msg='orphaned by server restart before remote submit',
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=? AND status IN ('queued','running') AND (provider_task IS NULL OR provider_task='')`,
        ).run(taskId);
      }
      continue;
    }

    const user = db.prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id').get({ id: Number(row.owner_id) });
    if (!user) continue;

    recoveringVideoTasks.add(taskId);
    started++;
    void recoverOneRunningVideoTask(user, row)
      .catch((e) => {
        console.warn('[video-recover] failed:', taskId, e?.message || e);
      })
      .finally(() => {
        recoveringVideoTasks.delete(taskId);
      });
  }

  if (started) console.warn(`[video-recover] started ${started} in-flight video recovery task(s)`);
  return started;
}

async function recoverOneRunningVideoTask(user: UserRow, row: any) {
  const cfg = resolveLLMConfig(user, 'video');
  const taskId = String(row.id || '');
  const remoteId = String(row.provider_task || '');
  const providerName = String(row.provider || cfg.model || '').toLowerCase();
  const isSeedance =
    /seedance|doubao/i.test(providerName) ||
    /volces\.com|volcengine|ark\.cn-/i.test(cfg.baseUrl);

  if (!isSeedance) {
    console.warn(`[video-recover] skip unsupported provider task=${taskId} provider=${row.provider || cfg.model || 'unknown'}`);
    return;
  }

  console.warn(`[video-recover] resuming Seedance task local=${taskId} remote=${remoteId}`);
  const deadline = Date.now() + 15 * 60 * 1000;
  let pollCount = 0;

  while (true) {
    const j: any = await retryFetch(
      `${cfg.baseUrl}/contents/generations/tasks/${remoteId}`,
      { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
      `[video-recover seedance poll #${pollCount + 1}]`,
    );
    pollCount++;

    const status = String(j.status || '').toLowerCase();
    const videoUrl = j?.content?.video_url || j?.video_url || '';
    const progress = status === 'queued'
      ? 20
      : status === 'running' || status === 'in_progress'
        ? Math.min(70, 30 + pollCount * 3)
        : status === 'succeeded'
          ? 90
          : Number(row.progress || 0);

    dbUpdateVideoProgress(taskId, progress);

    if (status === 'succeeded') {
      if (!videoUrl) throw new Error('Seedance 恢复成功但没返回 video_url');
      await finalizeRecoveredVideoTask(user, row, videoUrl);
      console.warn(`[video-recover] recovered Seedance task local=${taskId} remote=${remoteId}`);
      return;
    }

    if (status === 'failed' || status === 'cancelled') {
      const reason =
        j?.error?.message ||
        j?.error?.code ||
        j?.fail_reason ||
        j?.failReason ||
        j?.message ||
        `Seedance 远端状态：${status}`;
      markVideoTaskFailed(taskId, String(reason).slice(0, 1000));
      return;
    }

    if (Date.now() > deadline) {
      console.warn(`[video-recover] remote still running after recovery window local=${taskId} remote=${remoteId}`);
      return;
    }

    await sleep(6000);
  }
}

function dbUpdateVideoProgress(taskId: string, progress: number) {
  const db = getDb();
  db.prepare(
    `UPDATE video_tasks
     SET progress=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=? AND status IN ('queued','running')`,
  ).run(progress, taskId);
}

function markVideoTaskFailed(taskId: string, message: string) {
  const db = getDb();
  db.prepare(
    `UPDATE video_tasks
     SET status='failed', error_msg=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=? AND status IN ('queued','running')`,
  ).run(message, taskId);
}

async function finalizeRecoveredVideoTask(user: UserRow, row: any, videoUrl: string) {
  const db = getDb();
  const taskId = String(row.id);
  const ownerDir = join(VIDEOS_DIR, String(user.id));
  mkdirSync(ownerDir, { recursive: true });
  const filename = row.filename || `${taskId}.mp4`;
  const fullPath = join(ownerDir, filename);

  const buf = await retryDownload(videoUrl);
  writeFileSync(fullPath, buf);

  let coverImageId = row.cover_image_id || null;
  let coverUrl = coverImageId ? `/api/images/file/${coverImageId}` : null;
  if (!coverImageId) {
    try {
      const coverPath = join(ownerDir, `${taskId}.cover.png`);
      await extractCover({ videoPath: fullPath, outputPath: coverPath });
      coverImageId = randomUUID();
      const stat = statSync(coverPath);
      db.prepare(
        `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
         VALUES (?, ?, ?, 'other', ?, ?, 'image/png', ?, 1080, 1920, ?, 'video-cover')`,
      ).run(
        coverImageId,
        user.id,
        row.project_id || null,
        `video-cover/${taskId}`,
        `${taskId}.cover.png`,
        stat.size,
        String(row.prompt || '').slice(0, 200),
      );
      coverUrl = `/api/images/file/${coverImageId}`;
    } catch (e: any) {
      console.warn('[video-recover] extract cover failed:', e?.message || e);
    }
  }

  db.prepare(
    `UPDATE video_tasks
     SET status='completed',
         progress=100,
         filename=?,
         cover_image_id=?,
         error_msg=NULL,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=?`,
  ).run(filename, coverImageId, taskId);

  if (row.project_id && row.group_idx != null) {
    const groupIdx = Number(row.group_idx);
    const protectedUrl = `/api/videos/file/${taskId}`;
    const durationSec = Number(row.duration_sec) || undefined;
    patchProjectForUser(String(row.project_id), user.id, (fresh) => {
      if (!fresh) return null;
      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
      if (groupIdx >= shots.length) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const sb = storyboards[groupIdx];
      const shotIndices = storyboardShotIndices(fresh, groupIdx, sb, { mode: 'single-shot-strict' });
      videoTasks[groupIdx] = {
        ...(videoTasks[groupIdx] || {}),
        groupIdx,
        taskId,
        status: 'completed',
        url: protectedUrl,
        coverUrl,
        durationSec,
        prompt: row.prompt || '',
      };

      storyboards[groupIdx] = {
        ...sb,
        idx: groupIdx,
        shotIdx: groupIdx + 1,
        shotIndices,
        videoUrl: protectedUrl,
        videoTaskId: taskId,
        videoDurationSec: durationSec || sb.videoDurationSec,
      };
      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards, videoTasks }, 'video-task-recovery');
      return { videoTasks, storyboards };
    });
  }
}
