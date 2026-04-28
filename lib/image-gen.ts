/**
 * 统一 图像生成调用层（OpenAI 兼容协议）
 *
 * 支持的模型/服务：
 *   - OpenAI 官方：gpt-image-1, dall-e-3
 *   - 任何 OpenAI 兼容中转：使用 settings.models.image.{baseUrl,apiKey,model}
 *
 * 与文本 LLM 用相同的"settings → env → fake"三级回落。
 * 输出：把生成图保存到 data/images/<userId>/<imageId>.png，并把元数据写进 images 表。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveLLMConfig } from './llm';
import { getDb } from './db';
import type { UserRow } from './db';

export type ImageGenInput = {
  prompt: string;
  size?: '1024x1024' | '1024x1536' | '1536x1024' | '512x512' | '512x768' | '768x512';
  style?: 'natural' | 'vivid' | 'pencil' | 'photographic';
  quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd';
  // 用于持久化分类
  kind: 'character' | 'scene' | 'prop' | 'storyboard' | 'other';
  // 角色生成时区分人 / 非人（如海鲜拟人、机甲、动物）。
  // 默认 'human'：走"白底+真人摄影+三视图"风格；
  // 'non-human' 时换成"白底+实物写实+保留生物形态"风格，避免把蟹盾画成真人。
  entityType?: 'human' | 'non-human';
  projectId?: string;
  assetRef?: string; // e.g. 'characters[0]' / 'storyboards[2]'
};

export type ImageGenResult = {
  id: string;
  url: string; // /api/images/file/<id>
  width: number;
  height: number;
  bytes: number;
  mode: 'real' | 'fake';
};

const DATA_DIR = join(process.cwd(), 'data');
const IMAGES_DIR = join(DATA_DIR, 'images');
mkdirSync(IMAGES_DIR, { recursive: true });

/**
 * 主入口：生成 + 保存 + 落 DB
 */
export async function generateImage(user: UserRow, input: ImageGenInput): Promise<ImageGenResult> {
  const cfg = resolveLLMConfig(user, 'image'); // 读 settings.models.image
  const id = randomUUID();
  const ownerDir = join(IMAGES_DIR, String(user.id));
  mkdirSync(ownerDir, { recursive: true });
  const filename = `${id}.png`;
  const fullPath = join(ownerDir, filename);

  let bytes = 0;
  let width = 1024;
  let height = 1024;
  let mode: 'real' | 'fake' = 'real';

  // 拼接风格关键词
  //   - storyboard 用 pencil 手稿
  //   - character/scene/prop 强制锁定为"白底 + 写实摄影"
  //     LLM 写出来的 imagePrompt 五花八门，这里兜底加一段 hard rule，
  //     保证最终风格统一（参考原网站效果）
  const finalPrompt = (() => {
    if (input.style === 'pencil') {
      return `${input.prompt}\n\nstyle: pencil sketch, hand-drawn line art, monochrome graphite, paper texture, storyboard illustration`;
    }
    return `${input.prompt}\n\n${forceStyleSuffix(input.kind, input.entityType)}`;
  })();

  // 解析尺寸
  const [w, h] = parseSize(input.size || '1024x1024');
  width = w;
  height = h;

  if (cfg.mode === 'fake' || !cfg.apiKey) {
    // 兜底：写一张 1×1 灰色 PNG 占位
    const placeholder = makePlaceholderPng(w, h);
    writeFileSync(fullPath, placeholder);
    bytes = placeholder.length;
    mode = 'fake';
  } else {
    const t0 = Date.now();
    const modelName = cfg.model || 'gpt-image-1';
    // 超时保护：单次图像调用最长 180s（gpt-image-1 一般 30-60s，留足余量但不让它无限挂）
    // 注意：base64 下载通常是同一连接内传输，这里 timeout 包含了下载时间
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    try {
      // OpenAI 兼容 image generation 接口
      // 不同后端字段命名略有差异：gpt-image-1 / dall-e-3 都是 /v1/images/generations
      const body: any = {
        model: modelName,
        prompt: finalPrompt,
        size: input.size || '1024x1024',
        n: 1,
      };
      // gpt-image-1 / dall-e-3 / dall-e-2 的 quality 字段取值不同，自动按模型挑：
      //   - gpt-image-1: low | medium | high | auto（默认 low —— 参考图够用且明显更快）
      //   - dall-e-3:    standard | hd                （默认 standard）
      //   - 其它：       不传
      const q = pickQuality(modelName, input.quality);
      if (q) body.quality = q;

      console.log(`[image-gen] start model=${modelName} size=${body.size} quality=${q || '-'} kind=${input.kind}`);
      const resp = await fetch(`${cfg.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Image API ${resp.status}: ${text.slice(0, 400)}`);
      }
      const json: any = await resp.json();
      // 兼容两种返回：{data:[{b64_json}]} 或 {data:[{url}]}
      const item = json?.data?.[0];
      if (!item) throw new Error('图像 API 返回结构异常');

      let buf: Buffer;
      if (item.b64_json) {
        buf = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        // 下载阶段也加超时（30s 通常够 5MB 图片，慢的中转站可能更久 → 用 60s）
        const dlController = new AbortController();
        const dlTimer = setTimeout(() => dlController.abort(), 60_000);
        try {
          const r = await fetch(item.url, { signal: dlController.signal });
          if (!r.ok) throw new Error(`下载图片失败 ${r.status}`);
          buf = Buffer.from(await r.arrayBuffer());
        } finally {
          clearTimeout(dlTimer);
        }
      } else {
        throw new Error('图像 API 没返回 b64_json 也没返回 url');
      }
      writeFileSync(fullPath, buf);
      bytes = buf.length;
      const elapsed = Date.now() - t0;
      console.log(`[image-gen] ok model=${modelName} bytes=${buf.length} elapsed=${elapsed}ms`);
    } catch (e: any) {
      const elapsed = Date.now() - t0;
      const aborted = e?.name === 'AbortError';
      const reason = aborted ? `请求超时（>180s 未返回）` : (e?.message || String(e));
      console.warn(`[image-gen] fail model=${modelName} elapsed=${elapsed}ms reason=${reason}`);
      // 真调失败 → 抛错让 batch 走 task_failed，UI 上显示"失败"而不是一直转
      throw new Error('图像生成失败：' + reason);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 落 DB
  const db = getDb();
  db.prepare(
    `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
     VALUES (?, ?, ?, ?, ?, ?, 'image/png', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    user.id,
    input.projectId || null,
    input.kind,
    input.assetRef || null,
    filename,
    bytes,
    width,
    height,
    finalPrompt.slice(0, 4000),
    input.style || null,
  );

  return {
    id,
    url: `/api/images/file/${id}`,
    width,
    height,
    bytes,
    mode,
  };
}

function parseSize(s: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2])];
  return [1024, 1024];
}

/**
 * 资产参考图统一风格后缀（白底 + 写实摄影；角色额外要求三视图布局）。
 *
 * 设计动机：
 *   - 原网站效果是"白底 + 真人写实摄影 + 角色三视图（正/侧/背）"
 *   - LLM 抽资产时写出来的 imagePrompt 风格千差万别（半写实插画、动漫、CG…）
 *   - 这里在最终调图像 API 前强行追加一段 hard rule，覆盖掉风格漂移
 */
function forceStyleSuffix(
  kind: ImageGenInput['kind'],
  entityType: ImageGenInput['entityType'] = 'human',
): string {
  if (kind === 'character') {
    if (entityType === 'non-human') {
      // 非人实体（拟人化海鲜、机甲、动物、异形）：保留生物本来的形态，
      // 不能强行画成真人；但白底+写实摄影+三视图布局保持一致。
      return [
        '=== MANDATORY STYLE OVERRIDE (must follow) ===',
        'Style: photorealistic creature/object photography, sharp focus, high detail, magazine-grade quality.',
        'Background: PURE WHITE (#FFFFFF) seamless studio backdrop, NO shadows on backdrop, NO gradient, NO other objects.',
        'Layout: reference sheet showing the SAME subject in THREE views side-by-side, evenly spaced:',
        '  · Left:   front view',
        '  · Middle: 3/4 or side view',
        '  · Right:  back view',
        'IMPORTANT: keep the subject\'s actual non-human anatomy (e.g. crab, shrimp, mech, animal) — do NOT redraw it as a human.',
        'Lighting: even soft studio lighting, no harsh shadows.',
        'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch, stylized art.',
        'STRICTLY NOT allowed: turning the subject into a human person if it is not one.',
        'STRICTLY NOT allowed: any text, watermark, logo, frame, border.',
      ].join('\n');
    }
    // 人类角色：白底 + 真人摄影 + 三视图（正/侧/背全身）
    return [
      '=== MANDATORY STYLE OVERRIDE (must follow) ===',
      'Style: photorealistic photography, professional studio headshot quality, sharp focus, magazine-grade photography, high detail.',
      'Background: PURE WHITE (#FFFFFF) seamless studio backdrop, NO shadows, NO gradient, NO objects.',
      'Layout: character model sheet showing the SAME person in THREE full-body views side-by-side, evenly spaced:',
      '  · Left:   front view, facing camera, arms relaxed at sides, neutral standing pose',
      '  · Middle: 3/4 or side profile view, same pose',
      '  · Right:  back view, same pose',
      'Lighting: even soft studio lighting from the front, no harsh shadows.',
      'Camera: full body in frame, head to feet visible in all three views.',
      'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch, stylized art.',
      'STRICTLY NOT allowed: any text, watermark, logo, frame, border.',
    ].join('\n');
  }
  if (kind === 'scene') {
    return [
      '=== MANDATORY STYLE OVERRIDE (must follow) ===',
      'Style: photorealistic photography, cinematic establishing shot, sharp focus, high detail, professional photography.',
      'No people / no human figures in the frame.',
      'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch.',
      'STRICTLY NOT allowed: any text, watermark, logo.',
    ].join('\n');
  }
  if (kind === 'prop') {
    return [
      '=== MANDATORY STYLE OVERRIDE (must follow) ===',
      'Style: photorealistic product photography, studio shot, sharp focus, high detail.',
      'Background: PURE WHITE (#FFFFFF) seamless studio backdrop, soft drop shadow only under the object.',
      'Camera: object centered in frame, fills 70% of canvas.',
      'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch.',
      'STRICTLY NOT allowed: any text, watermark, logo.',
    ].join('\n');
  }
  // storyboard / other: 不加额外约束
  return '';
}

/**
 * 根据模型挑 quality 字段。
 *   - gpt-image-1: low | medium | high | auto（默认 low —— 参考图够用且明显更快，
 *     auto 会跑到 high 模式，单张能 60-90s，用户体验上看起来"卡住"）
 *   - dall-e-3:    standard | hd                （默认 standard）
 *   - dall-e-2 / 其它: 不传（接口不接受 quality 字段）
 *
 * 如果 caller 传了 requested 且对当前模型合法，就用 requested。
 */
function pickQuality(model: string, requested?: string): string | undefined {
  const m = (model || '').toLowerCase();
  const req = (requested || '').toLowerCase();
  if (m.includes('gpt-image')) {
    if (['low', 'medium', 'high', 'auto'].includes(req)) return req;
    return 'low';
  }
  if (m.includes('dall-e-3')) {
    if (['standard', 'hd'].includes(req)) return req;
    return 'standard';
  }
  return undefined;
}

/**
 * 制作一张极小的 PNG 占位图（避免依赖 sharp/canvas）。
 * 这里用一个写死的灰色渐变 PNG 模板（base64），实际尺寸由 width/height 元数据决定，
 * 浏览器仍会按字节里的真实分辨率显示，所以这里宽高参数仅用于落库元数据。
 */
function makePlaceholderPng(_w: number, _h: number): Buffer {
  // 1×1 灰色 PNG（base64）
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEUlEQVR4AWPgZGD4z0AswK4SAAvyAQXeYNvCAAAAAElFTkSuQmCC';
  return Buffer.from(b64, 'base64');
}

/**
 * 通过 image id 拿元数据 + 文件路径
 */
export function getImageMeta(id: string, ownerId: number) {
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>(
      'SELECT * FROM images WHERE id = @id AND owner_id = @uid',
    )
    .get({ id, uid: ownerId });
  if (!row) return null;
  return {
    ...row,
    fullPath: join(IMAGES_DIR, String(row.owner_id), row.filename),
    publicUrl: `/api/images/file/${row.id}`,
  };
}
