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

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  /**
   * 可选：参考图 PNG 在磁盘上的绝对路径。一旦提供，调用方式从
   * `/v1/images/generations` 切到 `/v1/images/edits`（multipart），把这张
   * 图作为视觉锚点喂给 gpt-image-1 / gpt-image-2，让生成图保留参考图的
   * 材质 / 色调 / 建筑结构 / 物件风格。当前主要用途：
   *   - 副场景以主场景为参考，做"同一地点不同角度"
   *   - 镜头分镜以场景图为参考，保证场景一致
   * 如果文件不存在或读取失败，会自动 fallback 到 generations 路径。
   */
  referenceImagePath?: string;
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
      // 手稿风格锁定：参考原站效果——干净线稿 + 中灰阴影 + 工业制图般的
      // 严谨度（不是糙笔速写）。关键词侧重：
      //   · "ink + pencil hybrid" → 主线条干净像针管笔，阴影才用铅笔渐变
      //   · "tonal washes + cross-hatching" → 既有大面积灰调也有交叉影线
      //   · "industrial production storyboard" → 行业级专业感而非草稿
      //   · "characters fully rendered, faces detailed" → 人物面部不能模糊
      //   · "consistent line weight" → 多格之间风格统一
      const PENCIL_PREFIX = [
        'Professional film pre-production storyboard frame, drawn in the style of a senior storyboard artist working for a feature animation studio.',
        'Medium: ink-and-pencil hybrid on smooth bristol paper — clean confident ink-pen outlines for figures and architecture, soft graphite tonal shading for volumes, cross-hatching for shadows, light tonal wash for atmosphere.',
        'Strictly monochrome (true black + warm-grey graphite tones + paper white). Absolutely NO color, NO digital painting look.',
        'High level of finish: faces and hands are fully rendered with anatomy, not vague smudges; clothing folds visible; perspective lines accurate; environment rendered with depth via hatching not blank space.',
        'Composition: cinematic framing, clear silhouette / staging, characters readable at small sizes.',
        '',
      ].join('\n');
      const PENCIL_SUFFIX = [
        '',
        '=== STYLE LOCK (do not deviate) ===',
        'Style: black-and-white pencil + ink storyboard sheet, professional pre-production grade, hand-drawn on white paper, visible graphite tone and crosshatch shading. Like classic Pixar / Studio Ghibli / Spielberg-era industrial storyboards.',
        'Line work: confident ink outlines for figures + architectural lines, no scratchy nervous lines, no doodle look.',
        'Shading: soft graphite gradients + crosshatching for shadows, leave paper white for highlights.',
        'STRICTLY NOT allowed: photorealistic photo, 3D render, watercolor, anime / manga style, cartoon / chibi, comic book ink (heavy black fills), vector illustration, painted, colored, flat color, gradient color, blueprint, schematic.',
        'STRICTLY NOT allowed: any visible text / captions / panel labels / signatures / watermarks / page borders.',
        'STRICTLY NOT allowed: rough scratchy "napkin doodle" look — this MUST look like a finished pre-production deliverable.',
      ].join('\n');
      return `${PENCIL_PREFIX}\n${input.prompt}\n${PENCIL_SUFFIX}`;
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
    // 是否走 image-edit（参考图 → 同地点不同角度 / 同角色不同动作）
    // 兼容性：gpt-image-1 / gpt-image-2 / dall-e-2 都支持 /v1/images/edits，
    // dall-e-3 不支持（只有 generations）。如果调方给了参考图但模型不支持，
    // 会 fallback 到普通 generations + 文本 prompt（色调/构图至少有 styleBible
    // lock 兜底）。
    const editSupported = (() => {
      const m = (modelName || '').toLowerCase();
      return m.includes('gpt-image') || m.includes('dall-e-2');
    })();
    const useEdit = !!(input.referenceImagePath && existsSync(input.referenceImagePath) && editSupported);
    if (input.referenceImagePath && !editSupported) {
      console.warn(`[image-gen] reference image provided but model ${modelName} does not support edits — falling back to text-only generation`);
    }
    const q = pickQuality(modelName, cfg.imageQuality || input.quality);
    const requestTimeoutMs = cfg.timeoutMs || 240_000;

    // 失败重试，专门针对中转站常见的 timeout / 502 / 503 / 504 / 429。
    // 4xx（除 429）与 401/403 视为永久错误，立刻抛出，避免无意义浪费积分。
    // 429 限流：3 次机会，退避 8-15s（限流需要等更久才放行）
    // 5xx/超时：3 次机会，退避 2-4s（多数是抖动，快重试就能过）
    const MAX_ATTEMPTS = 3;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 单次调用超时由平台 env 控制；未配置时保留原来的 240s。
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
      const tA = Date.now();
      try {
        let resp: Response;
        if (useEdit) {
          console.log(`[image-gen] start attempt=${attempt} model=${modelName} size=${input.size || '1024x1024'} quality=${q || '-'} kind=${input.kind} mode=edit ref=${input.referenceImagePath}`);
          const fd = new FormData();
          fd.append('model', modelName);
          fd.append('prompt', finalPrompt);
          fd.append('size', input.size || '1024x1024');
          fd.append('n', '1');
          if (q) fd.append('quality', q);
          const refBuf = readFileSync(input.referenceImagePath!);
          fd.append('image', new Blob([refBuf], { type: 'image/png' }), 'reference.png');
          resp = await fetch(`${cfg.baseUrl}${cfg.imageEditEndpoint || '/images/edits'}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
            body: fd as any,
            signal: controller.signal,
          });
        } else {
          const body: any = {
            model: modelName,
            prompt: finalPrompt,
            size: input.size || '1024x1024',
            n: 1,
          };
          if (q) body.quality = q;
          console.log(`[image-gen] start attempt=${attempt} model=${modelName} size=${body.size} quality=${q || '-'} kind=${input.kind} mode=generate`);
          resp = await fetch(`${cfg.baseUrl}${cfg.imageGenerationEndpoint || '/images/generations'}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const err: any = new Error(`Image API ${resp.status}: ${text.slice(0, 400)}`);
          err.status = resp.status;
          throw err;
        }
        const json: any = await resp.json();
        const item = json?.data?.[0];
        if (!item) throw new Error('图像 API 返回结构异常');

        let buf: Buffer;
        if (item.b64_json) {
          buf = Buffer.from(item.b64_json, 'base64');
        } else if (item.url) {
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
        console.log(`[image-gen] ok attempt=${attempt} model=${modelName} bytes=${buf.length} elapsed=${elapsed}ms`);
        lastErr = null;
        break; // 成功
      } catch (e: any) {
        const elapsed = Date.now() - tA;
        const aborted = e?.name === 'AbortError';
        const status = e?.status as number | undefined;
        const transient = aborted || status === 429 || (status !== undefined && status >= 500 && status < 600);
        const reason = aborted ? `请求超时（>${Math.round(requestTimeoutMs / 1000)}s 未返回）` : (e?.message || String(e));
        console.warn(`[image-gen] fail attempt=${attempt} model=${modelName} elapsed=${elapsed}ms transient=${transient} reason=${reason}`);
        lastErr = e;
        if (attempt < MAX_ATTEMPTS && transient) {
          // 429 限流要等更久（中转站每分钟有总配额，太快重试还会被拒）
          // 5xx/超时多数是抖动/排队，2-4s 退避通常就能过
          const isRateLimit = status === 429;
          const baseDelay = isRateLimit ? 8000 + attempt * 3000 : 2000;
          const delay = baseDelay + Math.floor(Math.random() * 3000);
          console.log(`[image-gen] retry attempt=${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms (status=${status || 'timeout'})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // 永久错误 / 用尽重试次数 → 抛出最终错误（针对常见 status 给人话提示）
        let friendly: string;
        if (status === 429) {
          friendly = `中转站当前限流（API 429），${MAX_ATTEMPTS} 次重试均被拒。请等几分钟再试，或更换图像 API Key`;
        } else if (status === 401 || status === 403) {
          friendly = `图像 API Key 无效或无权限（${status}），请到设置里检查/更换 Key`;
        } else if (status === 402) {
          friendly = `图像 API 余额不足（402），请到中转站充值后再试`;
        } else if (aborted) {
          friendly = `图像生成超时（>${Math.round(requestTimeoutMs / 1000)}s 未返回），中转站可能在排队，请稍后重试`;
        } else if (status && status >= 500 && status < 600) {
          friendly = `中转站服务异常（${status}），${MAX_ATTEMPTS} 次重试均失败，请稍后再试`;
        } else {
          friendly = '图像生成失败：' + reason;
        }
        throw new Error(friendly);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    // 理论上不会走到这里，break 或 throw 二选一
    if (lastErr) throw new Error('图像生成失败：' + (lastErr?.message || lastErr));
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
      // 不能强行画成真人；白底+写实摄影+三视图（前/严格 90° 侧/背），不要头部特写。
      // 用户反馈：拟人海鲜画头部特写没有意义（壳/钳子比脸更像它的"id"），
      // 三视图正侧背已经够用。布局回到 1×3 三栏。
      return [
        '=== MANDATORY STYLE OVERRIDE (must follow) ===',
        'Style: photorealistic creature/object photography, sharp focus, high detail, magazine-grade quality.',
        'Background: PURE WHITE (#FFFFFF) seamless studio backdrop, NO shadows on backdrop, NO gradient, NO other objects.',
        'Layout: ONE canvas split into THREE panels in a single row, evenly sized (each panel ~33% of canvas width), NO gaps between panels:',
        '  · Panel 1 (left): FRONT VIEW — full subject, facing camera, neutral pose.',
        '  · Panel 2 (middle): SIDE VIEW — STRICT pure 90° profile, body axis exactly perpendicular to the camera. Same pose as front view. NEVER 3/4, NEVER angled.',
        '  · Panel 3 (right): BACK VIEW — full subject from behind, same pose.',
        'CRITICAL: the SAME subject must appear in all three panels — same colors, same anatomy, same proportions, only the camera angle changes.',
        'IMPORTANT: keep the subject\'s actual non-human anatomy (e.g. crab, shrimp, mech, animal) — do NOT redraw it as a human, do NOT add a human body or human face.',
        'Lighting: even soft studio lighting, no harsh shadows.',
        'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch, stylized art.',
        'STRICTLY NOT allowed: turning the subject into a human person if it is not one.',
        'STRICTLY NOT allowed: any text, watermark, logo, frame, border, panel labels.',
        'STRICTLY NOT allowed: 3/4 view in the side panel — if Panel 2 is not a strict 90° profile, the image is REJECTED.',
        'STRICTLY NOT allowed: a head close-up panel — only the three full-body angle views.',
      ].join('\n');
    }
    // 人类角色：白底 + 真人摄影 + 四宫格 character model sheet
    // 布局：左 ~40% 大头部特写 + 右 ~60% 三视图（正面 / 严格 90° 侧面 / 背面）
    // ※ 用户反馈中"侧面是斜的"= 之前允许 3/4 视角 → 这里强制纯正侧 90°，并用
    //   "if humanoid, only ONE eye and ONE ear visible" 这种可验证规则收紧描述。
    return [
      '=== MANDATORY STYLE OVERRIDE (must follow) ===',
      'Style: photorealistic photography, professional studio headshot quality, sharp focus, magazine-grade photography, high detail of skin texture / hair / clothing fabric.',
      'Background: PURE WHITE (#FFFFFF) seamless studio backdrop, NO shadows on backdrop, NO gradient, NO other objects.',
      'Layout: ONE canvas split into FOUR panels in a single row, evenly spaced, NO gaps between panels:',
      '  · Panel 1 (LARGEST, left ~40% of canvas): LARGE HEAD CLOSE-UP — head and shoulders only, face fills the panel from top to bottom, sharp portrait crop, eyes at upper third, looking straight at camera, neutral expression. Background still pure white.',
      '  · Panel 2 (right ~20% of canvas, 1st of three views): FRONT FULL-BODY VIEW — head to feet visible, facing camera squarely, arms relaxed at sides, neutral standing pose.',
      '  · Panel 3 (right ~20% of canvas, 2nd of three views): SIDE FULL-BODY VIEW — STRICT pure 90° profile, body axis exactly perpendicular to the camera, ONLY ONE EYE AND ONE EAR VISIBLE, nose silhouette pointing left or right, shoulders perfectly aligned to one side. Same pose as front. NEVER 3/4, NEVER angled, NEVER turned partially.',
      '  · Panel 4 (right ~20% of canvas, 3rd of three views): BACK FULL-BODY VIEW — full body from behind, head to feet visible, same pose as front.',
      'CRITICAL: the SAME PERSON must appear in all four panels — same face, same hair, same clothing, same body type, same skin tone — only the camera angle changes.',
      'Lighting: even soft studio lighting from the front, no harsh shadows.',
      'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch, stylized art.',
      'STRICTLY NOT allowed: any text, watermark, logo, frame, border, panel labels, names.',
      'STRICTLY NOT allowed: 3/4 view, three-quarter view, angled view in the side panel — if Panel 3 is not a strict 90° profile, the image is REJECTED.',
    ].join('\n');
  }
  if (kind === 'scene') {
    // 场景：六宫格多角度参考图（2 行 × 3 列），每格一个不同角度。
    // 用户反馈："原网站是六宫格图 各个角度的场景图"——把单张 establishing shot
    // 升级成 6-panel reference sheet，便于后续分镜覆盖更多视角。
    return [
      '=== MANDATORY STYLE OVERRIDE (must follow) ===',
      'Style: photorealistic photography, cinematic establishing shots, sharp focus, high detail, professional location photography.',
      'Layout: ONE canvas split into SIX panels arranged in a 2-row × 3-column grid (top row 3 panels, bottom row 3 panels), evenly sized cells, thin black gaps (~4px) between panels, white outer border.',
      'Each of the SIX panels shows the SAME ONE LOCATION from a DIFFERENT camera angle / focal length, so they read as a complete location reference sheet:',
      '  · Top-Left: WIDE establishing shot, eye-level, full overview of the space.',
      '  · Top-Middle: HIGH-ANGLE / overhead-ish wide shot revealing the floor plan / layout.',
      '  · Top-Right: LOW-ANGLE wide shot looking up, emphasizing height / ceiling / vertical features.',
      '  · Bottom-Left: MEDIUM shot of one signature corner / area, eye-level (e.g. counter, workstation, entry).',
      '  · Bottom-Middle: MEDIUM shot of a different corner / area from the opposite direction.',
      '  · Bottom-Right: CLOSE-UP / detail shot of a key prop / texture / surface that defines the location\'s mood (e.g. wood grain, neon sign, equipment, food display).',
      'CRITICAL: ALL SIX panels must show the SAME LOCATION — same architecture, same lighting mood, same color palette, same era/style. They are reference photos of one place from different angles, NOT six different rooms.',
      'No people / no human figures in any panel.',
      'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch, concept art.',
      'STRICTLY NOT allowed: any text, watermark, logo, panel labels, captions.',
      'STRICTLY NOT allowed: rendering this as a single image instead of a 6-panel grid — if there are not 6 visible panels, the image is REJECTED.',
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

/**
 * 把项目里存的 imageUrl（形如 `/api/images/file/<uuid>`）反查回磁盘绝对路径。
 * 用于副场景拿主场景的 PNG 当参考图。如果 url 不是这种内部格式 / 找不到对应
 * 行 / 文件不存在，返回 null，调用方应自动 fallback 到无参考图的纯文本 prompt。
 */
export function resolveLocalImagePath(
  imageUrl: string | undefined | null,
  ownerId: number,
): string | null {
  if (!imageUrl) return null;
  const m = /\/api\/images\/file\/([0-9a-fA-F-]{36})/.exec(imageUrl);
  if (!m) return null;
  const meta = getImageMeta(m[1], ownerId);
  if (!meta) return null;
  if (!existsSync(meta.fullPath)) return null;
  return meta.fullPath;
}
