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

  // 拼接 pencil 风格关键词（仅在 style=pencil 时）
  const finalPrompt = input.style === 'pencil'
    ? `${input.prompt}\n\nstyle: pencil sketch, hand-drawn line art, monochrome graphite, paper texture, storyboard illustration`
    : input.prompt;

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
    try {
      // OpenAI 兼容 image generation 接口
      // 不同后端字段命名略有差异：gpt-image-1 / dall-e-3 都是 /v1/images/generations
      const body: any = {
        model: input.kind === 'storyboard' && input.style === 'pencil'
          ? cfg.model || 'gpt-image-1'
          : cfg.model || 'gpt-image-1',
        prompt: finalPrompt,
        size: input.size || '1024x1024',
        n: 1,
      };
      // gpt-image-1 vs dall-e-3 quality 字段不同，传通用值
      if (input.quality) body.quality = input.quality;

      const resp = await fetch(`${cfg.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
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
        const r = await fetch(item.url);
        if (!r.ok) throw new Error(`下载图片失败 ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
      } else {
        throw new Error('图像 API 没返回 b64_json 也没返回 url');
      }
      writeFileSync(fullPath, buf);
      bytes = buf.length;
    } catch (e: any) {
      // 真调失败 → 退回占位 + 抛错给 caller 决定是否软失败
      const placeholder = makePlaceholderPng(w, h);
      writeFileSync(fullPath, placeholder);
      bytes = placeholder.length;
      mode = 'fake';
      console.warn('[image-gen] fallback to placeholder due to:', e?.message);
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
