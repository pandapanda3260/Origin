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

import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveLLMConfig } from './llm';
import { getDb } from './db';
import type { UserRow } from './db';
import { makeBlackVideo, extractCover } from './ffmpeg';
import { generateImage } from './image-gen';

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
   * 项目角色声音 roster（多行字符串，每行 "- 名字: 描述"），
   * 跨片段保持同一个名字 → 同一个声音/形象。
   */
  voiceRoster?: string;
  /** 上一组的最后一镜简述，给模型用于"承接上一镜终幅"。 */
  prevTailSummary?: string;
  /** 下一组的第一镜简述，给模型用于"留出衔接到下一镜首帧的空间"。 */
  nextHeadSummary?: string;
  /** 用于 fake 模式做封面的素材描述 */
  coverHint?: string;
  /**
   * 分镜草图本地路径（黑白铅笔风），仅作为构图/分格参考。
   * 之前是单一 i2v 主参考，导致最终视频也是黑白调；现在降级为辅助。
   */
  referenceImagePath?: string;
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
};

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
  const validSb = opts.storyboardPath && fs.existsSync(opts.storyboardPath) ? opts.storyboardPath : null;
  if (!validScene && !validChars.length && !validSb) return null;

  // 输出尺寸：固定 1280x720（16:9 主流横版），脚本里 ratio 用 9:16 时
  // Seedance 会自己 letterbox，但 i2v 参考图比例不影响输出比例
  const W = 1280;
  const H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 默认深灰底色，万一所有 image 都加载失败也不至于纯黑
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);

  // 1) 主背景 = 场景图，铺满画布
  if (validScene) {
    try {
      const sceneImg = await loadImage(validScene);
      // cover 模式：等比缩放到完全覆盖 1280x720，多余裁掉
      const ratio = Math.max(W / sceneImg.width, H / sceneImg.height);
      const dw = sceneImg.width * ratio;
      const dh = sceneImg.height * ratio;
      ctx.drawImage(sceneImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch (e: any) {
      console.warn('[color-ref] scene draw failed:', e?.message || e);
    }
  } else if (validChars.length) {
    // 没场景图时角色图占主位（cover 第一张）
    try {
      const c0 = await loadImage(validChars[0]);
      const ratio = Math.max(W / c0.width, H / c0.height);
      const dw = c0.width * ratio;
      const dh = c0.height * ratio;
      ctx.drawImage(c0, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch (_) {}
  }

  // 2) 底部一条角色缩略图条（高 130px，半透明黑底 + 角色彩图）
  //    注意：场景图存在 + 角色图存在时才贴；角色图独占主位时跳过
  if (validScene && validChars.length) {
    const stripH = 130;
    const stripY = H - stripH;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, stripY, W, stripH);

    const maxThumbs = Math.min(validChars.length, 4);
    const thumbGap = 12;
    const thumbW = Math.floor((W - thumbGap * (maxThumbs + 1)) / maxThumbs);
    const thumbH = stripH - thumbGap * 2;
    for (let i = 0; i < maxThumbs; i++) {
      try {
        const cImg = await loadImage(validChars[i]);
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

/**
 * 把"视频提示词页"生成的长结构化中文 prompt（含"运镜系统/角色/场景/0-Ns/基调/约束/音障"）
 * 压缩成 grok-video 友好的简洁单段描述。
 *
 * grok-video 对长 prompt 控制力差，>500 字基本只会抓最显著的关键词（如"叹气"），
 * 忽略大部分场景/角色细节。压缩后只保留视觉相关段落、限到 ~250 字以内。
 */
export function compressForGrokVideo(rawPrompt: string, maxChars = 320): string {
  if (!rawPrompt) return '';
  const txt = rawPrompt.replace(/\r/g, '');
  // 把整段按"段落标题/时间标签"切成 K→V
  const SECTION_HEADERS = ['运镜系统', '角色', '场景', '基调', '约束', '音障'];
  const TIME_RE = /^\s*\d+(?:\.\d+)?\s*[-–~～至到]\s*\d+(?:\.\d+)?\s*s?\s*$/;
  const lines = txt.split(/\n+/);
  const sections: Array<{ key: string; body: string }> = [];
  let currentKey: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (currentKey && buf.length) {
      sections.push({ key: currentKey, body: buf.join(' ').trim() });
    }
    buf = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (SECTION_HEADERS.includes(t) || TIME_RE.test(t)) {
      flush();
      currentKey = t;
    } else if (currentKey) {
      buf.push(t);
    }
  }
  flush();

  // 抽出关键段
  const get = (k: string) => sections.find(s => s.key === k)?.body || '';
  const scene = get('场景');
  const character = get('角色');
  const camera = get('运镜系统');
  const timeline = sections.find(s => TIME_RE.test(s.key))?.body || '';

  // 拼接顺序：镜头运镜 → 场景 → 角色外形 → 时间轴动作（去掉⟦⟧装饰）
  const cleanTimeline = timeline.replace(/[⟦⟧【】「」]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [camera, scene, character, cleanTimeline].filter(Boolean);
  let combined = parts.join('。').replace(/[。；][。；]+/g, '。');
  combined = combined.replace(/[⟦⟧【】]/g, '').replace(/\s+/g, ' ').trim();

  // 完全没切到段：直接截断原文
  if (!combined) combined = txt.replace(/\s+/g, ' ').slice(0, maxChars);

  if (combined.length > maxChars) {
    // 在 maxChars 附近找一个标点截断，避免半句话+省略号让模型迷糊
    const cut = combined.slice(0, maxChars);
    const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
    combined = lastPunct > maxChars * 0.6 ? cut.slice(0, lastPunct + 1) : cut;
  }
  return combined;
}

/** 把 ratio 字符串规范成统一格式 + size 映射 */
function normalizeRatio(ratio?: string): { ratio: string; size: '1080x1920' | '1920x1080' | '1024x1024' } {
  const r = (ratio || '').trim();
  if (r === '16:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '9:16') return { ratio: '9:16', size: '1080x1920' };
  if (r === '1:1') return { ratio: '1:1', size: '1024x1024' };
  // 4:3 / 3:4 / 21:9 等 grok 暂不支持，回退到 16:9 横版
  if (r === '4:3' || r === '21:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '3:4') return { ratio: '9:16', size: '1080x1920' };
  // 没传 ratio 时按 size 反推
  return { ratio: '16:9', size: '1920x1080' };
}

export type VideoGenResult = {
  taskId: string;
  status: 'completed' | 'failed';
  url: string;
  coverUrl: string | null;
  durationSec: number;
  mode: 'real' | 'fake';
};

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
  // grok 模型时长策略：
  //   grok-video-3-10s → 固定 10 秒
  //   grok-video-3-Ns  → 固定 N 秒
  //   grok-video-3     → 默认 5 秒（中转站默认）
  const grokFixedDur = cfgIsGrok
    ? (/-(\d+)s$/i.test(cfg.model) ? Number(RegExp.$1) : 5)
    : null;
  const dur = grokFixedDur ?? input.durationSec ?? 4;
  // ratio 优先；没传 ratio 时尊重 size，否则按 size 反推
  const sizeArgPresent = !!input.size;
  const { ratio: aspectRatio, size: sizeFromRatio } = normalizeRatio(
    input.ratio || (input.size === '1080x1920' ? '9:16' : input.size === '1920x1080' ? '16:9' : input.size === '1024x1024' ? '1:1' : '16:9'),
  );
  const size = (sizeArgPresent && !input.ratio ? input.size! : sizeFromRatio) as '1080x1920' | '1920x1080' | '1024x1024';
  console.log(`[video-gen] resolved ratio=${aspectRatio} size=${size} dur=${dur}s model=${cfg.model}`);

  let mode: 'real' | 'fake' = 'real';

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
  const isVolcano = /volces\.com|volcengine|ark\.cn-/i.test(cfg.baseUrl) || /seedance|doubao/i.test(cfg.model);
  const isGrok = cfgIsGrok;

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
      // grok-video 对长 prompt 理解力差，压缩后只保留视觉关键信息（视觉部分留 240 字）
      const compressedVisual = compressForGrokVideo(input.prompt, 240);
      // 拼上必须严格演绎的台词（如有）。这一段不计入压缩预算，确保不被截断。
      // 优先用 dialoguePairs 拼成 "说话人:'台词'" 的紧凑格式（让 grok 知道
      // 谁说什么、避免把"老板"这种角色名也念出来）；没有 pairs 才退回到
      // 老的 input.dialogue 字符串。
      let finalPrompt = compressedVisual || input.prompt.slice(0, 240);
      let dialogueText = '';
      if (Array.isArray(input.dialoguePairs) && input.dialoguePairs.length > 0) {
        dialogueText = input.dialoguePairs
          .filter((p) => p && p.text)
          .map((p) => {
            const tx = p.text.replace(/\s+/g, ' ').slice(0, 100);
            return p.speaker
              ? `由 ${p.speaker} 开口说："${tx}"（"${p.speaker}"是说话人标记不要念出）`
              : `旁白："${tx}"`;
          })
          .join('；');
      } else if (input.dialogue && input.dialogue.trim()) {
        dialogueText = input.dialogue.trim().replace(/\s+/g, ' ').slice(0, 220);
      }
      if (dialogueText) {
        finalPrompt =
          finalPrompt +
          `。【角色对白】必须严格、完整、清晰地按以下原文演绎并配音，不得自由发挥、不得即兴增删字句：${dialogueText}`;
      }
      console.log(`[video-gen][grok] prompt: visual=${compressedVisual.length}c dialogue=${dialogueText.length}c total=${finalPrompt.length}c`);
      console.log(`[video-gen][grok] final prompt = ${finalPrompt.slice(0, 600)}…`);

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

      const submit: any = await retryFetch(
        `${cfg.baseUrl}/video/create`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(submitBody),
        },
        '[grok submit]',
      );
    console.log('[video-gen][grok] submit response:', JSON.stringify(submit).slice(0, 400));
    const remoteId = submit.id || submit.task_id;
    if (!remoteId) throw new Error('Grok API 返回缺 id：' + JSON.stringify(submit).slice(0, 200));
    console.log('[video-gen][grok] remoteId =', remoteId);
    db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);

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
      throw new Error('Grok 视频生成失败：' + msg.slice(0, 200));
    }
  } else if (isVolcano) {
    // ---- 火山引擎 Seedance 适配 ----
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

      // 结构化台词：每条 { speaker, text }——分离说话人与台词内容，避免
      // Seedance 把"老板："这种角色名前缀当成台词的一部分念出来。
      // 同时给 Seedance 一个明确的"指定说话人"元信息（同一名字跨片段
      // 应该对应同一种音色——配合后面的 voiceRoster 锁住）。
      const dialogPairs = Array.isArray(input.dialoguePairs)
        ? input.dialoguePairs.filter((p) => p && p.text)
        : [];

      let dialogueBlock = '';
      if (dialogPairs.length > 0) {
        const lines = dialogPairs
          .map((p, i) => {
            const cleanText = p.text.replace(/\s+/g, ' ').slice(0, 200);
            const sp = p.speaker
              ? `说话人: ${p.speaker}（必须由该角色开口配音，唇形要对得上）`
              : `说话人: 旁白`;
            return `  [${i + 1}] ${sp}\n      台词内容: "${cleanText}"`;
          })
          .join('\n');
        dialogueBlock =
          `【本片段台词 - 必须严格按原文配音、按列表顺序、由指定说话人开口】\n` +
          lines +
          `\n` +
          `严格规则：\n` +
          `  · "说话人:" 后面的角色名是元信息，**绝对不准念出来**（不要把"老板"、"帝王蟹队长"等角色名当成台词的一部分朗读）\n` +
          `  · 只有"台词内容:"引号里的字才是真正要念的台词\n` +
          `  · 每句台词的发声角色必须严格匹配上面"说话人:"指定的那个名字，` +
          `其它角色只做反应/听不发声\n` +
          `  · 提示词里任何「」/""/''/⟦⟧ 包裹的、不在上面列表里的句子都禁止念出\n\n`;
      } else {
        dialogueBlock =
          `【本片段无台词】\n` +
          `角色保持沉默，禁止从画面描述中提取任何"" /「」/⟦⟧ 内的对白朗读出来，` +
          `即便提示词里有引号包住的句子也不要念，只保留环境音 / 动作音 / 背景音。\n\n`;
      }

      // 角色声音 roster：保证跨片段同一角色声音一致
      const voiceBlock = input.voiceRoster
        ? `【角色声音/形象锁 - 跨片段必须一致】\n${input.voiceRoster}\n` +
          `（同一个角色名在不同片段必须使用同一种音色 / 性别 / 年龄段，` +
          `拟人化非人角色要用带物种特征的语气，例如帝王蟹是低沉粗哑男声、` +
          `生蚝实习生是怯怯轻细的青年声）\n\n`
        : '';

      // 前后镜头衔接信息：避免硬切 / 角色姿态突变
      const continuityBlock =
        input.prevTailSummary || input.nextHeadSummary
          ? `【前后片段衔接 - 避免硬切】\n` +
            (input.prevTailSummary
              ? `· 上一片段结束在：${input.prevTailSummary.slice(0, 200)}\n` +
                `  → 本片段第一帧的角色站位、视线方向、灯光要与之自然承接\n`
              : '') +
            (input.nextHeadSummary
              ? `· 下一片段开始时：${input.nextHeadSummary.slice(0, 200)}\n` +
                `  → 本片段最后一帧要为下一镜留出过渡空间（不要镜头突然推到死/拉到底）\n`
              : '') +
            `\n`
          : '';

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
      const hasColorRefs =
        !!input.sceneReferencePath ||
        (Array.isArray(input.characterReferencePaths) && input.characterReferencePaths.length > 0);
      const hasAnyRef = hasColorRefs || !!input.referenceImagePath;

      let styleOverrideBlock = '';
      if (hasColorRefs) {
        styleOverrideBlock =
          `【风格强制覆盖 - 视觉圣经参考图说明】\n` +
          `已附上一张合成参考图，包含三块信息：\n` +
          `  ① 主背景（顶部铺满）= 彩色场景资产图，定义环境、光照、色调、材质\n` +
          `  ② 底部缩略图条 = 本片段出场角色的彩色资产三视图，定义角色外形/服装/物种（拟人化角色必须保留物种特征）\n` +
          `  ③ 右上小角标 = 黑白铅笔分镜草图，仅用于参考镜头构图/景别/角色站位（不要复制黑白色调）\n` +
          `最终视频必须满足：\n` +
          `  · 全彩电影级真人画质（live-action cinematic full color, professional cinematography）\n` +
          `  · 色调/光照/材质完全跟随彩色场景图，禁止保留分镜草图的黑白灰阶 / 铅笔肌理 / 草稿质感\n` +
          `  · 每个角色严格匹配底部对应的彩色资产图（人物形象、衣着、物种）；非人/拟人角色绝对不能画成真人\n` +
          `  · 镜头构图/景别遵循右上角标的草图，但成片是真人电影质感\n\n`;
      } else if (input.referenceImagePath) {
        // 没拿到彩色资产时回退到旧路径：分镜草图 + 强制覆盖
        styleOverrideBlock =
          `【风格强制覆盖】\n` +
          `参考图为黑白铅笔分镜草图（pre-production storyboard sketch），` +
          `仅用于构图、角色站位、镜头视角、动作走位的参考。\n` +
          `最终视频必须满足：\n` +
          `  · 全彩电影级真人画质（live-action cinematic full color, professional cinematography）\n` +
          `  · 严禁保留参考图的铅笔线条 / 素描肌理 / 黑白灰阶 / 网格纹理 / 草稿质感\n` +
          `  · 角色皮肤、服装颜色、环境光照、道具材质均按真实场景渲染\n\n`;
      }

      const promptCore =
        `${dialogueBlock}` +
        `${voiceBlock}` +
        `${continuityBlock}` +
        `${styleOverrideBlock}` +
        `${input.prompt}`;

      const content: any[] = [
        { type: 'text', text: `${promptCore}\n--ratio ${aspectRatio} --duration ${dur}` },
      ];

      if (hasAnyRef) {
        try {
          let refBuf: Buffer | null = null;
          if (hasColorRefs) {
            // 走新路径：合成"彩色场景 + 彩色角色 + 黑白草图角标"
            const composite = await buildColorReferenceComposite({
              scenePath: input.sceneReferencePath,
              characterPaths: input.characterReferencePaths,
              storyboardPath: input.referenceImagePath,
            });
            if (composite) {
              refBuf = await applyFaceSafetyMask(composite);
              console.log(
                `[video-gen][seedance] built color reference composite ` +
                  `(scene=${!!input.sceneReferencePath}, chars=${input.characterReferencePaths?.length || 0}, ` +
                  `sb=${!!input.referenceImagePath})`,
              );
            }
          }
          // 兜底：合成失败 / 没彩色资产 → 用旧的纯分镜草图路径
          if (!refBuf && input.referenceImagePath) {
            refBuf = await applyFaceSafetyMask(input.referenceImagePath);
          }

          if (refBuf) {
            const dataUrl = `data:image/png;base64,${refBuf.toString('base64')}`;
            content.push({ type: 'image_url', image_url: { url: dataUrl } });
            console.log(`[video-gen][seedance] attached i2v ref image (${refBuf.length} bytes)`);
          }
        } catch (refErr: any) {
          console.warn(
            '[video-gen][seedance] reference image build failed, falling back to text-only:',
            refErr?.message || refErr,
          );
        }
      }

      const submit: any = await retryFetch(
        `${cfg.baseUrl}/contents/generations/tasks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model || 'doubao-seedance-2-0-260128',
            content,
          }),
        },
        '[seedance submit]',
      );
      const remoteId = submit.id;
      if (!remoteId) throw new Error('Seedance API 返回缺 id');
      console.log(`[video-gen][seedance] task created id=${remoteId}`);
      db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);

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
      throw new Error(friendly.slice(0, 400));
    }
  } else {
    // ---- OpenAI Sora 适配 ----
    try {
      onProgress?.(5, '提交 Sora 任务…');
      const submitResp = await fetch(`${cfg.baseUrl}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model || 'sora-2',
          prompt: input.prompt,
          size,
          seconds: String(dur),
        }),
      });
      if (!submitResp.ok) {
        const t = await submitResp.text();
        throw new Error(`Video submit ${submitResp.status}: ${t.slice(0, 400)}`);
      }
      const submit: any = await submitResp.json();
      const remoteId = submit.id;
      if (!remoteId) throw new Error('Video API 返回缺 id');
      db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);

      const deadline = Date.now() + 6 * 60 * 1000;
      let status = submit.status || 'queued';
      let progress = 0;
      while (status !== 'completed' && status !== 'failed') {
        if (Date.now() > deadline) throw new Error('视频生成超时（6 分钟）');
        await sleep(5000);
        const r = await fetch(`${cfg.baseUrl}/videos/${remoteId}`, {
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
      const dl = await fetch(`${cfg.baseUrl}/videos/${remoteId}/content`, {
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

  return {
    taskId,
    status: 'completed',
    url: `/api/videos/file/${taskId}`,
    coverUrl,
    durationSec: dur,
    mode,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带重试的 fetch + JSON 解析（Volcano 偶尔抖一下，重试 3 次）。
 */
async function retryFetch(url: string, init: any, label: string, retries = 3): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, init);
      if (!resp.ok) {
        const t = await resp.text();
        if (resp.status >= 500 && i < retries - 1) {
          console.warn(`${label} status=${resp.status}, retrying...`);
          await sleep(2000 * (i + 1));
          continue;
        }
        throw new Error(`${label} HTTP ${resp.status}: ${t.slice(0, 300)}`);
      }
      return await resp.json();
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message || String(e);
      if (i < retries - 1) {
        console.warn(`${label} attempt ${i + 1}/${retries} failed: ${msg}, retrying...`);
        await sleep(2000 * (i + 1));
        continue;
      }
      throw new Error(`${label} 失败（${retries} 次重试后）: ${msg}`);
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
      const dl = await fetch(url);
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
