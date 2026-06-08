/**
 * 统一图像生成调用层
 *
 * 支持的模型/服务：
 *   - OpenAI 官方：gpt-image-1, dall-e-3
 *   - 任何 OpenAI 兼容中转：使用 settings.models.image.{baseUrl,apiKey,model}
 *   - 火山方舟 Seedream：使用 IMAGE_PROVIDER=volcengine_seedream
 *
 * 与文本 LLM 用相同的"settings → env → fake"三级回落。
 * 输出：把生成图保存到 data/images/<userId>/<imageId>.png，并把元数据写进 images 表。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveLLMConfig } from './llm';
import { recordModelCallEvent } from './model-routing';
import { getDb } from './db';
import type { UserRow } from './db';
import { fetchViaProxy } from './proxy-fetch';
import { getDataDir } from './runtime-paths';
import { DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT, getGlobalImageConcurrencyLimit } from './system-config';
import { createAssetRecord, hashFile, localAssetUri } from './asset-library';
import { getExternalEnvValue } from './env';
import type { CharacterAssetMode } from './crowd-character';

export type ImageGenInput = {
  prompt: string;
  size?: '1024x1024' | '1024x1536' | '1536x1024' | '512x512' | '512x768' | '768x512';
  style?: 'natural' | 'vivid' | 'pencil' | 'photographic';
  quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd';
  styleLockApplied?: boolean;
  styleBackdropColor?: string;
  imageAuditMetadata?: Record<string, any>;
  // 用于持久化分类
  kind: 'character' | 'scene' | 'prop' | 'storyboard' | 'other';
  // 角色生成时区分人 / 非人（如海鲜拟人、机甲、动物）。
  // 默认 'human'：走"白底+真人摄影+三视图"风格；
  // 'non-human' 时换成"白底+实物写实+保留生物形态"风格，避免把蟹盾画成真人。
  entityType?: 'human' | 'non-human';
  characterAssetMode?: CharacterAssetMode;
  projectId?: string;
  assetRef?: string; // e.g. 'characters[0]' / 'storyboards[2]'
  correlationId?: string;
  /**
   * 可选：参考图 PNG 在磁盘上的绝对路径。一旦提供，调用方式从
	 * `/v1/images/generations` 切到 `/v1/images/edits`（multipart），把这张
	 * 图作为视觉锚点喂给 gpt-image-1 / gpt-image-2，让生成图保留参考图的
	 * 材质 / 色调 / 建筑结构 / 物件风格。当前主要用途：
   *   - 镜头分镜以场景图为参考，保证场景一致
   * 如果文件不存在或读取失败，会自动 fallback 到 generations 路径。
   *
   * P3a 兼容字段: 当调用方传 referenceImagePaths (数组) 时, 这个单字段被忽略;
   * 未传时内部自动包装成 [referenceImagePath] 走多图归并入口, 保证单图/多图走
   * 同一套 provider 分支代码。
   */
  referenceImagePath?: string;
  /**
   * P3a 新增：多张参考图的本地绝对路径数组。顺序严格对齐 prompt 里的
   * "Image 1 / Image 2 / Image 3 …" 编号和提交给 provider 的 image[] 数组顺序。
   * 实际能传几张由 resolveLLMConfig 的 capabilities.image.multiRefImage 决定;
   * 业务层若超出能力上限, 请在传进来之前自行截断 (或依靠 plan 的 imageNo 分配)。
   */
  referenceImagePaths?: string[];
  assetLibrary?: {
    batchId?: string;
    stage?: string;
    source?: 'generated' | 'uploaded' | 'toolbox' | 'edit_export' | 'imported';
    shotUid?: string | null;
    legacyShotId?: string | number | null;
    versionGroupId?: string | null;
    makeCurrent?: boolean;
    predecessorVersionAssetId?: string | null;
  };
};

export type ImageGenResult = {
  id: string;
  url: string; // /api/images/file/<id>
  width: number;
  height: number;
  bytes: number;
  mode: 'real' | 'fake';
};

const DATA_DIR = getDataDir();
const IMAGES_DIR = join(DATA_DIR, 'images');
mkdirSync(IMAGES_DIR, { recursive: true });

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = getExternalEnvValue(name) ?? getExternalEnvValue(`ORIGIN_${name}`) ?? process.env[name] ?? process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = getExternalEnvValue(name) ?? getExternalEnvValue(`ORIGIN_${name}`) ?? process.env[name] ?? process.env[`ORIGIN_${name}`];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

/**
 * 归并 referenceImagePaths (新) 和 referenceImagePath (旧) 为统一的数组。
 * 数组非空优先, 否则降级成 [referenceImagePath], 再降级空数组。
 * provider 分支代码统一从这个 helper 拿路径, 不再直接读 input.referenceImagePath。
 */
export function collectImagePaths(input: ImageGenInput): string[] {
  if (Array.isArray(input.referenceImagePaths) && input.referenceImagePaths.length) {
    return input.referenceImagePaths.filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
  if (input.referenceImagePath) return [input.referenceImagePath];
  return [];
}

function imageCallTraceMeta(input: ImageGenInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: input.kind,
    assetRef: input.assetRef || null,
    projectId: input.projectId || null,
    correlationId: input.correlationId || null,
    assetLibraryStage: input.assetLibrary?.stage || null,
    ...extra,
  };
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
  return ms + Math.floor(Math.random() * 5000);
}

function isTransientNetworkError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return /socket hang up|secure TLS|TLS connection|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|fetch failed|network|aborted|ByteString|greater than 255|Invalid statusText/i.test(msg);
}

let imageSubmitActive = 0;
const imageSubmitQueue: Array<() => void> = [];

function imageSubmitConcurrency(): number {
  const fallback = envInt(
    'IMAGE_SUBMIT_CONCURRENCY',
    envInt('IMAGE_GEN_SUBMIT_CONCURRENCY', DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT, 1, 8),
    1,
    8,
  );
  return getGlobalImageConcurrencyLimit(fallback);
}

async function acquireImageSubmitPermit(label: string): Promise<() => void> {
  const limit = imageSubmitConcurrency();
  if (imageSubmitActive >= limit) {
    console.log(
      `[image-gen][submit-semaphore] waiting label=${label} active=${imageSubmitActive} limit=${limit} queued=${imageSubmitQueue.length + 1}`,
    );
  }

  await new Promise<void>((resolve) => {
    const tryAcquire = () => {
      if (imageSubmitActive < imageSubmitConcurrency()) {
        imageSubmitActive += 1;
        resolve();
        return;
      }
      imageSubmitQueue.push(tryAcquire);
    };
    tryAcquire();
  });

  let released = false;
  console.log(`[image-gen][submit-semaphore] acquired label=${label} active=${imageSubmitActive} limit=${imageSubmitConcurrency()}`);
  return () => {
    if (released) return;
    released = true;
    imageSubmitActive = Math.max(0, imageSubmitActive - 1);
    const next = imageSubmitQueue.shift();
    if (next) setImmediate(next);
  };
}

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
  const finalPrompt = composeFinalImagePrompt(input);

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
    recordModelCallEvent({
      cfg,
      slot: 'image',
      status: 'ok',
      latencyMs: 0,
      fallbackUsed: true,
      traceName: input.kind,
      message: 'image fake fallback',
      meta: imageCallTraceMeta(input, { fallbackUsed: true }),
    });
  } else {
    const generated = await generateRealImageBuffer(cfg, input, finalPrompt, w, h);
    writeFileSync(fullPath, generated.buffer);
    bytes = generated.buffer.length;
    width = generated.width;
    height = generated.height;
  }

  // 落 DB
  const db = getDb();
  db.prepare(
    `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, 'image/png', ?, ?, ?, ?, ?, ?)`,
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
    finalPrompt.slice(0, 5000),
    input.style || null,
    input.correlationId || null,
  );

  try {
    createAssetRecord({
      assetId: id,
      ownerId: user.id,
      projectId: input.projectId || null,
      shotUid: input.assetLibrary?.shotUid || null,
      legacyShotId: input.assetLibrary?.legacyShotId ?? legacyShotIdFromAssetRef(input.assetRef),
      versionGroupId: input.assetLibrary?.versionGroupId || null,
      batchId: input.assetLibrary?.batchId || null,
      assetKind: 'image',
      source: input.assetLibrary?.source || (String(input.assetRef || '').startsWith('toolbox/') ? 'toolbox' : 'generated'),
      stage: input.assetLibrary?.stage || imageAssetStage(input.kind, input.assetRef),
      fileUri: localAssetUri('images', user.id, filename),
      thumbUri: `/api/images/file/${id}`,
      fileHash: hashFile(fullPath),
      byteSize: bytes,
      width,
      height,
      predecessorVersionAssetId: input.assetLibrary?.predecessorVersionAssetId || null,
      makeCurrent: input.assetLibrary?.makeCurrent ?? !!input.projectId,
    });
  } catch (error) {
    console.warn('[image-gen] asset library indexing skipped:', id, error);
  }

  return {
    id,
    url: `/api/images/file/${id}`,
    width,
    height,
    bytes,
    mode,
  };
}

function legacyShotIdFromAssetRef(assetRef: string | undefined) {
  const match = /storyboards\[(\d+)\]/.exec(String(assetRef || ''));
  return match ? `shot_${match[1]}` : null;
}

function imageAssetStage(kind: ImageGenInput['kind'], assetRef: string | undefined) {
  if (kind === 'character') return 'asset_character';
  if (kind === 'scene') return 'asset_scene';
  if (kind === 'prop') return 'asset_prop';
  if (kind === 'storyboard') return 'storyboard';
  const ref = String(assetRef || '');
  if (/firstFrame/i.test(ref)) return 'first_frame';
  if (/tailFrame/i.test(ref)) return 'tail_frame';
  if (ref.startsWith('toolbox/')) return 'toolbox_image';
  return 'image';
}

export function isCharacterImageInput(input: Pick<ImageGenInput, 'kind' | 'assetRef' | 'assetLibrary'>): boolean {
  return input.kind === 'character'
    || input.assetLibrary?.stage === 'asset_character'
    || /(^|[.\s/])characters\[\d+\]/.test(String(input.assetRef || ''));
}

export function shouldAllowImageProviderFallback(input: Pick<ImageGenInput, 'kind' | 'assetRef' | 'assetLibrary'>): boolean {
  if (!isCharacterImageInput(input)) return true;
  return envBool('IMAGE_CHARACTER_FALLBACK_ENABLED', false);
}

function parseSize(s: string): [number, number] {
  const m = /^(\d+)x(\d+)$/i.exec(String(s || '').replace(/[×X]/g, 'x'));
  if (m) return [Number(m[1]), Number(m[2])];
  return [1024, 1024];
}

type ImageRuntimeConfig = ReturnType<typeof resolveLLMConfig>;

type RealImageBufferResult = {
  buffer: Buffer;
  width: number;
  height: number;
};

async function generateRealImageBuffer(
  primaryCfg: ImageRuntimeConfig,
  input: ImageGenInput,
  finalPrompt: string,
  initialWidth: number,
  initialHeight: number,
): Promise<RealImageBufferResult> {
  const rawFallbackConfigs = (primaryCfg.fallbackConfigs || []).filter((cfg) => cfg.mode === 'real' && !!cfg.apiKey);
  const fallbackConfigs = shouldAllowImageProviderFallback(input) ? rawFallbackConfigs : [];
  const fallbackAfter = envInt('IMAGE_FALLBACK_AFTER_FAILURES', 2, 1, 10);
  const characterPrimaryRetryAttempts = isCharacterImageInput(input)
    ? envInt('IMAGE_CHARACTER_PRIMARY_RETRY_ATTEMPTS', 3, 1, 6)
    : 1;
  const configs = [primaryCfg, ...fallbackConfigs];
  const allRefPaths = collectImagePaths(input).filter((p) => existsSync(p));
  let primaryFailures = 0;
  let lastErr: any = null;

  for (let cfgIndex = 0; cfgIndex < configs.length; cfgIndex += 1) {
    const cfg = configs[cfgIndex];
    const isFallback = cfgIndex > 0;
    const t0 = Date.now();
    const modelName = cfg.model || 'gpt-image-1';
    let width = initialWidth;
    let height = initialHeight;

    // 是否走 image-edit（参考图 → 同地点不同角度 / 同角色不同动作）
    // 兼容性：gpt-image-1 / gpt-image-2 / dall-e-2 都支持 /v1/images/edits，
    // dall-e-3 不支持（只有 generations）。如果调方给了参考图但模型不支持，
    // 会 fallback 到普通 generations + 文本 prompt（色调/构图至少有 styleBible lock 兜底）。
    const editSupported = (() => {
      const m = (modelName || '').toLowerCase();
      return m.includes('gpt-image') || m.includes('dall-e-2');
    })();
    const useEdit = !!(allRefPaths.length && editSupported);
    if (allRefPaths.length && !editSupported) {
      console.warn(`[image-gen] reference image(s) provided but model ${modelName} does not support edits — falling back to text-only generation`);
    }

    // 实际提交给 provider 的 ref 张数, 受 capability 上限裁剪。
    const capImage = cfg.capabilities?.image;
    const multiRefCap = capImage ? Math.max(0, Math.floor(capImage.multiRefImage || 0)) : 1;
    const effectiveRefPaths = allRefPaths.slice(0, multiRefCap);
    const imageTransport = (capImage && capImage.transport) || 'single_image';
    if (allRefPaths.length > effectiveRefPaths.length) {
      console.warn(
        `[image-gen] capability caps multiRefImage=${multiRefCap}, dropped ${allRefPaths.length - effectiveRefPaths.length} ref image(s)`,
      );
    }

    const q = pickQuality(modelName, cfg.imageQuality || input.quality);
    const requestTimeoutMs = cfg.timeoutMs || 240_000;

    // 失败重试，专门针对中转站常见的 timeout / 502 / 503 / 504 / 429。
    // 如果配置了 fallback，则主通道累计失败到 IMAGE_FALLBACK_AFTER_FAILURES 次后，
    // 立即切到备用 provider（默认 Seedream），避免把用户卡在 GPT-image-2 长重试里。
    const TRANSIENT_MAX_ATTEMPTS = envInt('IMAGE_GEN_TRANSIENT_MAX_ATTEMPTS', 3, 1, 6);
    const NETWORK_MAX_ATTEMPTS = envInt('IMAGE_GEN_NETWORK_MAX_ATTEMPTS', 5, 1, 8);
    const RATE_LIMIT_MAX_ATTEMPTS = envInt('IMAGE_GEN_429_MAX_ATTEMPTS', 5, 1, 8);
    const RATE_LIMIT_BASE_DELAY_MS = envInt('IMAGE_GEN_429_RETRY_BASE_MS', 20_000, 1_000, 300_000);
    const RATE_LIMIT_MAX_DELAY_MS = envInt('IMAGE_GEN_429_RETRY_MAX_MS', 120_000, 1_000, 600_000);
    const NETWORK_BASE_DELAY_MS = envInt('IMAGE_GEN_NETWORK_RETRY_BASE_MS', 10_000, 1_000, 120_000);
    const NETWORK_MAX_DELAY_MS = envInt('IMAGE_GEN_NETWORK_RETRY_MAX_MS', 90_000, 1_000, 300_000);
    const RETRY_DEADLINE_MS = envInt('IMAGE_GEN_RETRY_DEADLINE_MS', 120_000, 10_000, 600_000);
    let retryDeadlineAt = 0;
    const fallbackAttemptFloor = !isFallback && fallbackConfigs.length ? fallbackAfter : 1;
    const MAX_ATTEMPTS = Math.max(
      fallbackAttemptFloor,
      characterPrimaryRetryAttempts,
      TRANSIENT_MAX_ATTEMPTS,
      RATE_LIMIT_MAX_ATTEMPTS,
      NETWORK_MAX_ATTEMPTS,
    );
    let switchedToFallback = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // 单次调用超时由平台 env 控制；未配置时保留原来的 240s。
      if (retryDeadlineAt > 0 && retryDeadlineAt - Date.now() <= 0) {
        throw new Error('图像生成失败：retry_deadline_exceeded，网络/限流重试超过总预算');
      }
      let attemptTimeoutMs = 0;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let tA = Date.now();
      let releaseSubmitPermit: null | (() => void) = null;
      try {
        releaseSubmitPermit = await acquireImageSubmitPermit(
          `${input.kind}:${input.assetRef || 'unscoped'}:${cfg.provider}:attempt${attempt}`,
        );
        if (!retryDeadlineAt) retryDeadlineAt = Date.now() + RETRY_DEADLINE_MS;
        const submitRemainingBudget = retryDeadlineAt - Date.now();
        if (submitRemainingBudget <= 0) {
          throw new Error('图像生成失败：retry_deadline_exceeded，网络/限流重试超过总预算');
        }
        attemptTimeoutMs = Math.max(1000, Math.min(requestTimeoutMs, submitRemainingBudget));
        tA = Date.now();
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), attemptTimeoutMs);
        let resp: Response;
        if (cfg.provider === 'volcengine_seedream') {
          const body = buildSeedreamImageBody(cfg, modelName, finalPrompt, input);
          if (effectiveRefPaths.length === 1) {
            // 单图路径: 旧行为, body.image = string (与文档 / 现网一致, 稳定)。
            body.image = await buildSeedreamReferenceDataUrl(effectiveRefPaths[0]);
          } else if (effectiveRefPaths.length > 1) {
            if (
              imageTransport === 'unverified_seedream_array' ||
              imageTransport === 'verified_seedream_array'
            ) {
              // Seedream 4.x/5.x 文档声称 image 字段接受数组。unverified_* 前提是
              // scripts/probe-multi-ref-seedream.js 未跑过实测, 默认保守装配;
              // probe 跑通后手动改成 'verified_seedream_array' 消除警告。
              body.image = await Promise.all(effectiveRefPaths.map((p) => buildSeedreamReferenceDataUrl(p)));
            } else {
              console.warn(
                `[image-gen][seedream] transport='${imageTransport}' not yet wired for multi-image, falling back to single ref (first image only)`,
              );
              body.image = await buildSeedreamReferenceDataUrl(effectiveRefPaths[0]);
            }
          }
          const imagePayloadBytes = Array.isArray(body.image)
            ? body.image.reduce((sum: number, value: string) => sum + Buffer.byteLength(value, 'utf8'), 0)
            : (typeof body.image === 'string' ? Buffer.byteLength(body.image, 'utf8') : 0);
          console.log(
            `[image-gen][seedream] start attempt=${attempt} model=${modelName} ` +
              `size=${body.size || '-'} kind=${input.kind} refCount=${effectiveRefPaths.length} ` +
              `transport=${imageTransport} refPayloadMB=${(imagePayloadBytes / 1024 / 1024).toFixed(2)}` +
              `${isFallback ? ' fallback=true' : ''}`,
          );
          resp = await fetchViaProxy(`${cfg.baseUrl}${cfg.imageGenerationEndpoint || '/images/generations'}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } else if (useEdit) {
          // P3a: multipart 按 transport 决定字段名。probe 验证前先用 'image' 重复 (最常见),
          // verified_openai_multipart_bracket → 'image[]', verified_openai_multipart_image_files → 'image_files[]'.
          let fieldName = 'image';
          if (imageTransport === 'verified_openai_multipart_bracket') fieldName = 'image[]';
          else if (imageTransport === 'verified_openai_multipart_image_files') fieldName = 'image_files[]';
          // 其它情况 (unverified / verified_repeat / single_image) 都用 'image', 重复 append 多次。
          console.log(
            `[image-gen] start attempt=${attempt} model=${modelName} size=${input.size || '1024x1024'} quality=${q || '-'} kind=${input.kind} mode=edit refCount=${effectiveRefPaths.length} transport=${imageTransport} field=${fieldName}${isFallback ? ' fallback=true' : ''}`,
          );
          const fd = new FormData();
          fd.append('model', modelName);
          fd.append('prompt', finalPrompt);
          fd.append('size', input.size || '1024x1024');
          fd.append('n', '1');
          if (q) fd.append('quality', q);
          for (let i = 0; i < effectiveRefPaths.length; i += 1) {
            const refBuf = readFileSync(effectiveRefPaths[i]);
            fd.append(fieldName, new Blob([refBuf], { type: 'image/png' }), `reference-${i + 1}.png`);
          }
          resp = await fetchViaProxy(`${cfg.baseUrl}${cfg.imageEditEndpoint || '/images/edits'}`, {
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
          console.log(
            `[image-gen] start attempt=${attempt} model=${modelName} size=${body.size} quality=${q || '-'} kind=${input.kind} mode=generate${isFallback ? ' fallback=true' : ''}`,
          );
          resp = await fetchViaProxy(`${cfg.baseUrl}${cfg.imageGenerationEndpoint || '/images/generations'}`, {
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
          const err: any = new Error(`Image API ${resp.status}: ${text.slice(0, 1000)}`);
          err.status = resp.status;
          err.retryAfterMs = retryAfterMs(resp.headers.get('retry-after'));
          throw err;
        }
        const json: any = await resp.json();
        const item = json?.data?.[0];
        if (!item) throw new Error('图像 API 返回结构异常');
        if (item.error) {
          const code = item.error.code ? `${item.error.code}: ` : '';
          throw new Error(`图像 API 单图失败：${code}${item.error.message || JSON.stringify(item.error).slice(0, 200)}`);
        }
        if (typeof item.size === 'string') {
          const [actualW, actualH] = parseSize(item.size);
          width = actualW;
          height = actualH;
        }
        releaseSubmitPermit();
        releaseSubmitPermit = null;

        let buf: Buffer;
        if (item.b64_json) {
          buf = Buffer.from(item.b64_json, 'base64');
        } else if (item.url) {
          const dlController = new AbortController();
          const dlTimer = setTimeout(() => dlController.abort(), 60_000);
          try {
            const r = await fetchViaProxy(item.url, { signal: dlController.signal });
            if (!r.ok) throw new Error(`下载图片失败 ${r.status}`);
            buf = Buffer.from(await r.arrayBuffer());
          } finally {
            clearTimeout(dlTimer);
          }
        } else {
          throw new Error('图像 API 没返回 b64_json 也没返回 url');
        }
        const normalized = await normalizeGeneratedImageBuffer(buf, cfg);
        buf = normalized.buffer;
        if (normalized.width && normalized.height) {
          width = normalized.width;
          height = normalized.height;
        }
        const elapsed = Date.now() - t0;
        console.log(`[image-gen] ok attempt=${attempt} model=${modelName} bytes=${buf.length} elapsed=${elapsed}ms${isFallback ? ' fallback=true' : ''}`);
        recordModelCallEvent({
          cfg,
          slot: 'image',
          status: 'ok',
          latencyMs: elapsed,
          fallbackUsed: isFallback,
          traceName: input.kind,
          meta: imageCallTraceMeta(input, { attempt, refCount: effectiveRefPaths.length, transport: imageTransport, fallbackUsed: isFallback }),
        });
        return { buffer: buf, width, height };
      } catch (e: any) {
        const elapsed = Date.now() - tA;
        const aborted = e?.name === 'AbortError';
        const status = e?.status as number | undefined;
        const networkTransient = !status && isTransientNetworkError(e);
        const transient = aborted || networkTransient || status === 429 || (status !== undefined && status >= 500 && status < 600);
        const reason = aborted ? `请求超时（>${Math.round(attemptTimeoutMs / 1000)}s 未返回）` : (e?.message || String(e));
        console.warn(`[image-gen] fail attempt=${attempt} model=${modelName} elapsed=${elapsed}ms transient=${transient} reason=${reason}${isFallback ? ' fallback=true' : ''}`);
        recordModelCallEvent({
          cfg,
          slot: 'image',
          status: status === 429 ? 'rate_limited' : 'failed',
          statusCode: status || null,
          errorCode: aborted ? 'timeout' : status ? `http_${status}` : 'network_or_exception',
          latencyMs: elapsed,
          fallbackUsed: isFallback,
          traceName: input.kind,
          message: reason,
          meta: imageCallTraceMeta(input, { attempt, transient, fallbackUsed: isFallback }),
        });
        lastErr = e;

        if (!isFallback && fallbackConfigs.length) {
          primaryFailures += 1;
          const shouldSwitchToFallback = primaryFailures >= fallbackAfter || aborted;
          if (shouldSwitchToFallback) {
            const next = fallbackConfigs[0];
            console.warn(
              `[image-gen] switching to fallback provider after ${primaryFailures} primary failure(s)` +
                `${aborted ? ' due to primary timeout' : ''}: ${next.provider}/${next.model}`,
            );
            switchedToFallback = true;
            break;
          }
          if (!transient) {
            console.log(`[image-gen] retrying primary before fallback failure=${primaryFailures}/${fallbackAfter}`);
            continue;
          }
        }

        if (transient) {
          const isRateLimit = status === 429;
          const isNetwork = networkTransient || aborted;
          const maxAttemptsForThisError = isRateLimit ? RATE_LIMIT_MAX_ATTEMPTS : isNetwork ? NETWORK_MAX_ATTEMPTS : TRANSIENT_MAX_ATTEMPTS;
          if (attempt >= maxAttemptsForThisError) {
            // 用尽该类错误的重试额度，走下面的人话错误。
          } else {
            const retryAfter = typeof e?.retryAfterMs === 'number' ? e.retryAfterMs : null;
            const rateLimitDelay = Math.min(
              RATE_LIMIT_MAX_DELAY_MS,
              retryAfter != null ? retryAfter : RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
            );
            const networkDelay = Math.min(NETWORK_MAX_DELAY_MS, NETWORK_BASE_DELAY_MS * Math.pow(2, attempt - 1));
            const delay = isRateLimit ? jitter(rateLimitDelay) : isNetwork ? jitter(networkDelay) : jitter(2000 + (attempt - 1) * 1000);
            if (Date.now() + delay > retryDeadlineAt) {
              throw new Error('图像生成失败：retry_deadline_exceeded，网络/限流重试超过总预算；最后错误：' + reason);
            }
            console.log(
              `[image-gen] retry attempt=${attempt + 1}/${maxAttemptsForThisError} ` +
                `after ${delay}ms (status=${status || (isNetwork ? 'network' : 'timeout')})`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }

        // 永久错误 / 用尽重试次数 → 抛出最终错误（针对常见 status 给人话提示）
        let friendly: string;
        if (status === 429) {
          friendly = `中转站当前限流（API 429），${RATE_LIMIT_MAX_ATTEMPTS} 次重试均被拒。请等几分钟再试，或更换图像 API Key`;
        } else if (status === 401 || status === 403) {
          friendly = `图像 API Key 无效或无权限（${status}），请到设置里检查/更换 Key`;
        } else if (status === 402) {
          friendly = `图像 API 余额不足（402），请到中转站充值后再试`;
        } else if (aborted) {
          friendly = '网络不稳定，请重新提交';
        } else if (!status && isTransientNetworkError(e)) {
          friendly = '网络不稳定，请重新提交';
        } else if (status && status >= 500 && status < 600) {
          friendly = '网络不稳定，请重新提交';
        } else {
          friendly = '图像生成失败：' + reason;
        }
        throw new Error(friendly);
      } finally {
        if (releaseSubmitPermit) releaseSubmitPermit();
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    if (switchedToFallback) continue;
  }

  throw new Error('图像生成失败：' + (lastErr?.message || lastErr || 'primary_and_fallback_failed'));
}

function buildSeedreamImageBody(
  cfg: ImageRuntimeConfig,
  modelName: string,
  prompt: string,
  input: ImageGenInput,
): Record<string, any> {
  const body: Record<string, any> = {
    model: modelName || 'doubao-seedream-4-5-251128',
    prompt,
    size: resolveSeedreamSize(cfg.imageSize, input.size),
    response_format: normalizeSeedreamResponseFormat(cfg.imageResponseFormat),
    watermark: cfg.imageWatermark ?? false,
    sequential_image_generation: normalizeSeedreamSequentialMode(cfg.seedreamSequentialImageGeneration),
  };

  const optimizeMode = normalizeSeedreamOptimizeMode(cfg.seedreamOptimizePromptMode);
  if (optimizeMode) {
    body.optimize_prompt_options = { mode: optimizeMode };
  }

  return body;
}

function resolveSeedreamSize(configured: string | undefined, requested: ImageGenInput['size']): string {
  const cfg = (configured || '4K').trim();
  if (/^\d+x\d+$/i.test(cfg)) return cfg;

  const tier = cfg.toUpperCase() === '2K' ? '2K' : '4K';
  const requestedSize = String(requested || '1024x1024').toLowerCase();
  const table: Record<'2K' | '4K', Record<string, string>> = {
    '2K': {
      '1024x1024': '2048x2048',
      '512x512': '2048x2048',
      '1536x1024': '2496x1664',
      '768x512': '2496x1664',
      '1024x1536': '1664x2496',
      '512x768': '1664x2496',
    },
    '4K': {
      '1024x1024': '4096x4096',
      '512x512': '4096x4096',
      '1536x1024': '4992x3328',
      '768x512': '4992x3328',
      '1024x1536': '3328x4992',
      '512x768': '3328x4992',
    },
  };
  return table[tier][requestedSize] || tier;
}

function normalizeSeedreamResponseFormat(value: string | undefined): 'url' | 'b64_json' {
  return value === 'url' ? 'url' : 'b64_json';
}

function normalizeSeedreamSequentialMode(value: string | undefined): 'auto' | 'disabled' {
  return value === 'auto' ? 'auto' : 'disabled';
}

function normalizeSeedreamOptimizeMode(value: string | undefined): 'standard' | undefined {
  return value === 'standard' || !value ? 'standard' : undefined;
}

function imagePathToDataUrl(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase().replace(/^\./, '');
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'bmp'
          ? 'image/bmp'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'tif' || ext === 'tiff'
              ? 'image/tiff'
              : 'image/png';
  return `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
}

async function buildSeedreamReferenceDataUrl(imagePath: string): Promise<string> {
  const source = readFileSync(imagePath);
  const originalBytes = source.length;
  const maxEdge = envInt('IMAGE_REFERENCE_MAX_EDGE', 1536, 512, 4096);
  const quality = envInt('IMAGE_REFERENCE_JPEG_QUALITY', 86, 50, 95);
  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod?.createCanvas || !canvasMod?.loadImage) {
    console.warn('[image-gen][seedream] @napi-rs/canvas unavailable; submitting original reference image');
    return imagePathToDataUrl(imagePath);
  }

  try {
    const image = await canvasMod.loadImage(source);
    const originalWidth = Math.max(1, Number(image.width || 1));
    const originalHeight = Math.max(1, Number(image.height || 1));
    const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = canvasMod.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const buf: Buffer = canvas.toBuffer('image/jpeg', quality);
    console.log(
      `[image-gen][seedream] reference compressed ${originalWidth}x${originalHeight}->${width}x${height} ` +
        `${(originalBytes / 1024 / 1024).toFixed(2)}MB->${(buf.length / 1024 / 1024).toFixed(2)}MB`,
    );
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (e: any) {
    console.warn('[image-gen][seedream] reference compression failed; submitting original reference image:', e?.message || e);
    return imagePathToDataUrl(imagePath);
  }
}

async function normalizeGeneratedImageBuffer(
  buffer: Buffer,
  cfg: ImageRuntimeConfig,
): Promise<{ buffer: Buffer; width?: number; height?: number }> {
  if (cfg.provider !== 'volcengine_seedream' || isPngBuffer(buffer)) return { buffer };

  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod?.createCanvas || !canvasMod?.loadImage) {
    throw new Error('Seedream 返回的图片需要转成 PNG，但 @napi-rs/canvas 不可用');
  }

  const image = await canvasMod.loadImage(buffer);
  const canvas = canvasMod.createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return {
    buffer: canvas.toBuffer('image/png') as Buffer,
    width: image.width,
    height: image.height,
  };
}

function isPngBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

/**
 * 资产参考图统一风格后缀（角色额外要求多视图布局）。
 *
 * 设计动机：
 *   - 角色参考图需要稳定布局和 splitter-safe 背景
 *   - 如果调用方已注入 PROJECT CHARACTER STYLE LOCK，这里只锁布局/纯白背景
 *   - 如果没有项目风格锁，保留旧的白底写实兜底行为
 */
function forceStyleSuffix(
  kind: ImageGenInput['kind'],
  entityType: ImageGenInput['entityType'] = 'human',
  opts: Pick<ImageGenInput, 'styleLockApplied' | 'styleBackdropColor' | 'characterAssetMode'> = {},
): string {
  if (kind === 'character') {
    const styleLocked = !!opts.styleLockApplied;
    if (opts.characterAssetMode === 'anonymous_crowd') {
      if (entityType === 'non-human') {
        return [
          styleLocked
            ? '=== MANDATORY ANONYMOUS NON-HUMAN CROWD REFERENCE RULES (must follow) ==='
            : '=== MANDATORY ANONYMOUS NON-HUMAN CROWD STYLE OVERRIDE (must follow) ===',
          styleLocked
            ? 'Style: high-detail creature/species group reference that follows the PROJECT CHARACTER STYLE LOCK above. Do not introduce a conflicting default model style.'
            : 'Style: photorealistic creature/object group reference photography, sharp focus, high detail, production reference quality.',
          'Layout: ONE single continuous image of a group. NO panels, NO split-screen, NO grid, NO collage, NO border, NO inset images.',
          'Subject: multiple individuals of the same non-human species/type, shown together as an anonymous group. Preserve the species, body plan, anatomy, material surface, scale cues, and natural posture from the prompt.',
          'Variation: individuals may vary slightly in size, markings, shell/fur/material texture, pose, and spacing; do NOT clone one identical subject repeatedly.',
          'Composition: slightly wide front-facing group reference, enough context to read group size, density, silhouette distribution, and shared visual identity.',
          'Background: simple neutral production-reference background; keep the group readable and isolated from distracting environments.',
          'CRITICAL: this is NOT a single subject model sheet. Do NOT generate front/side/back panels. Do NOT require the same subject to appear multiple times.',
          'STRICTLY NOT allowed: turning the subjects into human people, adding human faces, human bodies, clothes, shoes, or human hands unless explicitly requested.',
          'STRICTLY NOT allowed: any text, watermark, logo, frame, border, panel labels, names.',
        ].join('\n');
      }
      return [
        styleLocked
          ? '=== MANDATORY ANONYMOUS CROWD REFERENCE RULES (must follow) ==='
          : '=== MANDATORY ANONYMOUS CROWD STYLE OVERRIDE (must follow) ===',
        styleLocked
          ? 'Style: high-detail anonymous group reference that follows the PROJECT CHARACTER STYLE LOCK above. Do not introduce a conflicting default model style.'
          : 'Style: photorealistic group reference photography, sharp focus, high detail, professional production reference quality.',
        'Layout: ONE single continuous image of an anonymous group. NO panels, NO split-screen, NO grid, NO collage, NO border, NO inset images.',
        'Subject: multiple unnamed people as a crowd/group asset. Capture the collective visual identity: approximate group size, density, age range, clothing system, posture distribution, and shared temperament.',
        'Faces: faces must be varied and natural. Do NOT make everyone the same person. Do NOT clone one face across the group. No individual face is an identity target.',
        'Composition: slightly wide front-facing group reference, enough room to read scale, clothing rhythm, density, and emotional distribution.',
        'Background: simple neutral production-reference background; keep the group readable and isolated from distracting environments.',
        'CRITICAL: this is NOT a character model sheet. Do NOT generate headshot/front/side/back panels. Do NOT require the same person to appear multiple times.',
        'STRICTLY NOT allowed: any text, watermark, logo, frame, border, panel labels, names.',
      ].join('\n');
    }
    if (entityType === 'non-human') {
      // 非人实体（拟人化海鲜、机甲、动物、异形）：保留生物本来的形态，
      // 不能强行画成真人；白底+写实摄影+三视图（前/严格 90° 侧/背），不要头部特写。
      // 用户反馈：拟人海鲜画头部特写没有意义（壳/钳子比脸更像它的"id"），
      // 三视图正侧背已经够用。布局回到 1×3 三栏。
      if (styleLocked) {
        return [
          '=== MANDATORY CHARACTER REFERENCE SHEET RULES (must follow) ===',
          'Style: high-detail character/creature reference sheet that follows the PROJECT CHARACTER STYLE LOCK above. Do not introduce a conflicting default model style.',
          'Background: PURE WHITE (#FFFFFF) seamless reference-sheet backdrop. The backdrop MUST stay pure white regardless of the project style. NO color wash, NO gradient, NO texture, NO props, NO environment, NO room, NO street, NO neon signs, NO rain scene, NO color palette cards, NO swatches, NO readable text, NO readable hex codes or color names rendered as text INSIDE THE IMAGE.',
          'Layout: ONE canvas split into THREE panels in a single row, evenly sized (each panel ~33% of canvas width), NO gaps between panels:',
          '  · Panel 1 (left): FRONT VIEW — full subject, facing camera, neutral pose.',
          '  · Panel 2 (middle): SIDE VIEW — STRICT pure 90° profile, body axis exactly perpendicular to the camera. Same pose as front view. NEVER 3/4, NEVER angled.',
          '  · Panel 3 (right): BACK VIEW — full subject from behind, same pose.',
          'CRITICAL: the SAME subject must appear in all three panels — same colors, same anatomy, same proportions, only the camera angle changes.',
          'IMPORTANT: keep the subject\'s actual non-human anatomy (e.g. crab, shrimp, mech, animal) — do NOT redraw it as a human, do NOT add a human body or human face.',
          'Lighting: controlled reference-sheet lighting following the project color temperature and contrast direction, while keeping anatomy, surface detail, and silhouette readable.',
          'STRICTLY NOT allowed: style drift that contradicts the PROJECT CHARACTER STYLE LOCK.',
          'STRICTLY NOT allowed: turning the subject into a human person if it is not one.',
          'STRICTLY NOT allowed: any text, watermark, logo, frame, border, panel labels.',
          'STRICTLY NOT allowed: 3/4 view in the side panel — if Panel 2 is not a strict 90° profile, the image is REJECTED.',
          'STRICTLY NOT allowed: a head close-up panel — only the three full-body angle views.',
        ].join('\n');
      }
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
    if (styleLocked) {
      return [
        '=== MANDATORY CHARACTER REFERENCE SHEET RULES (must follow) ===',
        'Style: high-detail character reference sheet that follows the PROJECT CHARACTER STYLE LOCK above. Do not introduce a conflicting default model style.',
        'Background: PURE WHITE (#FFFFFF) seamless reference-sheet backdrop. The backdrop MUST stay pure white regardless of the project style. NO color wash, NO gradient, NO texture, NO props, NO environment, NO room, NO street, NO neon signs, NO rain scene, NO color palette cards, NO swatches, NO readable text, NO readable hex codes or color names rendered as text INSIDE THE IMAGE.',
        'Layout: ONE canvas split into FOUR panels in a single row, evenly spaced, NO gaps between panels:',
        '  · Panel 1 (LARGEST, left ~40% of canvas): LARGE HEAD CLOSE-UP — head and shoulders only, face fills the panel from top to bottom, sharp portrait crop, eyes at upper third, looking straight at camera, neutral expression. Background remains pure white.',
        '  · Panel 2 (right ~20% of canvas, 1st of three views): FRONT FULL-BODY VIEW — head to feet visible, facing camera squarely, arms relaxed at sides, neutral standing pose.',
        '  · Panel 3 (right ~20% of canvas, 2nd of three views): SIDE FULL-BODY VIEW — STRICT pure 90° profile, body axis exactly perpendicular to the camera, ONLY ONE EYE AND ONE EAR VISIBLE, nose silhouette pointing left or right, shoulders perfectly aligned to one side. Same pose as front. NEVER 3/4, NEVER angled, NEVER turned partially.',
        '  · Panel 4 (right ~20% of canvas, 3rd of three views): BACK FULL-BODY VIEW — full body from behind, head to feet visible, same pose as front.',
        'CRITICAL: the SAME PERSON must appear in all four panels — same face, same hair, same clothing, same body type, same skin tone — only the camera angle changes.',
        'Lighting: controlled reference-sheet lighting following the project color temperature and contrast direction, while keeping face, hair, clothing, anatomy and silhouette readable.',
        'STRICTLY NOT allowed: style drift that contradicts the PROJECT CHARACTER STYLE LOCK.',
        'STRICTLY NOT allowed: any text, watermark, logo, frame, border, panel labels, names.',
        'STRICTLY NOT allowed: 3/4 view, three-quarter view, angled view in the side panel — if Panel 3 is not a strict 90° profile, the image is REJECTED.',
      ].join('\n');
    }
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
    // 场景：单张主环境参考图。
    // 视频阶段已有首帧/尾帧负责镜头级构图；场景资产只负责稳定空间、
    // 色调、光照、材质，不再生成多格 sheet，避免视频模型误读分屏。
    return [
      '=== MANDATORY STYLE OVERRIDE (must follow) ===',
      'Style: photorealistic location photography, cinematic but natural establishing shot, sharp focus, high detail, professional production reference quality.',
      'Layout: ONE single continuous image of ONE location. NO panels, NO split-screen, NO grid, NO collage, NO border, NO inset images.',
      'Composition: wide establishing view at eye level or slightly high angle, clearly showing the main spatial layout, entrances/exits, floor, walls, ceiling, key furniture/equipment, and signature materials.',
      'Purpose: this image is a stable environment reference for video generation — prioritize readable space, lighting, color palette, material texture, and production design over dramatic camera tricks.',
      'CRITICAL: the image must depict one coherent physical space, not multiple rooms, not multiple angles, not a montage.',
      'No people / no human figures.',
      'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch, concept art.',
      'Text/signage policy: by default, no readable text, signage, labels, captions, logos, or UI. Only if the user prompt explicitly requests specific visible words/signage, render those exact requested words only; do not invent any extra text.',
      'STRICTLY NOT allowed: watermark, unsolicited logo, captions, panel labels, frames, UI, grid lines, or multi-panel layout.',
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

export function composeFinalImagePrompt(
  input: Pick<ImageGenInput, 'prompt' | 'style' | 'kind' | 'entityType' | 'styleLockApplied' | 'styleBackdropColor' | 'characterAssetMode'>,
): string {
  if (input.style === 'pencil') {
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
  return `${input.prompt}\n\n${forceStyleSuffix(input.kind, input.entityType, input)}`;
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
 * 用于后续生成链路把内部图片作为参考图。如果 url 不是这种内部格式 / 找不到
 * 对应行 / 文件不存在，返回 null，调用方应自动 fallback 到无参考图的纯文本 prompt。
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
