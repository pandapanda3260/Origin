import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db';
import { getDataDir } from './runtime-paths';
import {
  materialRoleToImageKind,
  normalizeStoryboardMaterialRole,
  storyboardMaterialAssetRef,
  STORYBOARD_MATERIAL_IMAGE_STYLE,
  STORYBOARD_MATERIAL_UPLOAD_PROMPT,
  type StoryboardMaterialRole,
} from './reference-roles';

const DATA_DIR = getDataDir();
const IMAGES_DIR = join(DATA_DIR, 'images');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_LONG_EDGE = 2048;
const MIN_SHORT_EDGE = 256;
const LOW_RES_LONG_EDGE = 768;
const EXTREME_ASPECT_RATIO = 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNKS_TO_STRIP = new Set(['caBX']);

export type StoryboardMaterialImageWarning = {
  code: 'low_resolution' | 'extreme_aspect_ratio' | 'metadata_cleaned';
  message: string;
};

export type ProcessedStoryboardMaterialImage = {
  buffer: Buffer;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
  warnings: StoryboardMaterialImageWarning[];
  mode: 'copied' | 'reencoded';
};

export type StoredStoryboardMaterialImage = {
  imageId: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  mime: string;
  warnings: StoryboardMaterialImageWarning[];
  assetRef: string;
  mode: 'copied' | 'reencoded' | 'existing';
};

export class StoryboardMaterialImageError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'StoryboardMaterialImageError';
    this.status = status;
    this.code = code;
  }
}

function imageOwnerDir(ownerId: number): string {
  return join(IMAGES_DIR, String(ownerId));
}

function imageFullPath(ownerId: number, filename: string): string {
  return join(imageOwnerDir(ownerId), filename);
}

function safeUnlink(path: string): void {
  try {
    if (path && existsSync(path)) unlinkSync(path);
  } catch (_) {}
}

function detectImageKind(buffer: Buffer): 'jpeg' | 'png' | 'webp' | 'gif' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return null;
}

function stripProblematicPngMetadata(buffer: Buffer): Buffer | null {
  if (detectImageKind(buffer) !== 'png') return null;

  const chunks: Buffer[] = [buffer.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;
  let stripped = false;
  let sawIend = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const chunkEnd = dataStart + length + 4;
    if (chunkEnd > buffer.length) return null;

    const type = buffer.subarray(typeStart, typeStart + 4).toString('latin1');
    const chunk = buffer.subarray(offset, chunkEnd);
    if (PNG_METADATA_CHUNKS_TO_STRIP.has(type)) {
      stripped = true;
    } else {
      chunks.push(chunk);
    }

    offset = chunkEnd;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }

  if (!stripped || !sawIend) return null;
  return Buffer.concat(chunks);
}

function hasPngAlpha(buffer: Buffer): boolean {
  if (buffer.length < 33 || detectImageKind(buffer) !== 'png') return false;
  const colorType = buffer[25];
  if (colorType === 4 || colorType === 6) return true;
  return buffer.includes(Buffer.from('tRNS', 'ascii'));
}

function hasWebpAlpha(buffer: Buffer): boolean {
  if (detectImageKind(buffer) !== 'webp') return false;
  const vp8x = buffer.indexOf(Buffer.from('VP8X', 'ascii'));
  if (vp8x >= 0 && buffer.length > vp8x + 8) {
    const flags = buffer[vp8x + 8];
    if ((flags & 0x10) !== 0) return true;
  }
  return buffer.includes(Buffer.from('ALPH', 'ascii'));
}

function hasTransparentPixels(canvasMod: any, image: any, width: number, height: number): boolean {
  const canvas = canvasMod.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) return true;
  }
  return false;
}

function isAnimatedWebp(buffer: Buffer): boolean {
  if (detectImageKind(buffer) !== 'webp') return false;
  const vp8x = buffer.indexOf(Buffer.from('VP8X', 'ascii'));
  if (vp8x >= 0 && buffer.length > vp8x + 8) {
    const flags = buffer[vp8x + 8];
    if ((flags & 0x02) !== 0) return true;
  }
  return buffer.includes(Buffer.from('ANIM', 'ascii')) || buffer.includes(Buffer.from('ANMF', 'ascii'));
}

function mimeForKind(kind: 'jpeg' | 'png' | 'webp'): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (kind === 'jpeg') return 'image/jpeg';
  if (kind === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionForKind(kind: 'jpeg' | 'png' | 'webp'): 'jpg' | 'png' | 'webp' {
  if (kind === 'jpeg') return 'jpg';
  if (kind === 'webp') return 'webp';
  return 'png';
}

export async function processStoryboardMaterialImageBuffer(
  input: Buffer,
): Promise<ProcessedStoryboardMaterialImage> {
  if (!input.length) {
    throw new StoryboardMaterialImageError('empty_file', '图片文件为空');
  }
  if (input.length > MAX_IMAGE_BYTES) {
    throw new StoryboardMaterialImageError('file_too_large', '图片不能超过 20MB', 413);
  }

  const kind = detectImageKind(input);
  if (kind === 'gif') {
    throw new StoryboardMaterialImageError('unsupported_animated_image', '不支持 GIF 动图，请上传静态图片');
  }
  if (!kind) {
    throw new StoryboardMaterialImageError('unsupported_image_type', '不支持的图片格式');
  }
  if (kind === 'webp' && isAnimatedWebp(input)) {
    throw new StoryboardMaterialImageError('unsupported_animated_image', '不支持动画 WebP，请上传静态图片');
  }

  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod?.createCanvas || !canvasMod?.loadImage) {
    throw new StoryboardMaterialImageError('image_processor_unavailable', '图片处理组件不可用');
  }

  let sourceBuffer = input;
  let metadataCleaned = false;
  let image: any = null;
  try {
    image = await canvasMod.loadImage(sourceBuffer);
  } catch {
    if (kind === 'png') {
      const cleaned = stripProblematicPngMetadata(input);
      if (cleaned) {
        try {
          image = await canvasMod.loadImage(cleaned);
          sourceBuffer = cleaned;
          metadataCleaned = true;
        } catch (_) {}
      }
    }
    if (!image) {
      throw new StoryboardMaterialImageError('unprocessable_image', '图片无法解析，请重新导出后再上传');
    }
  }
  const sourceWidth = Number(image?.width || 0);
  const sourceHeight = Number(image?.height || 0);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new StoryboardMaterialImageError('unprocessable_image', '图片尺寸无法识别');
  }

  const shortEdge = Math.min(sourceWidth, sourceHeight);
  const longEdge = Math.max(sourceWidth, sourceHeight);
  if (shortEdge < MIN_SHORT_EDGE) {
    throw new StoryboardMaterialImageError('image_too_small', '图片短边不能小于 256px');
  }

  const warnings: StoryboardMaterialImageWarning[] = [];
  if (metadataCleaned) {
    warnings.push({ code: 'metadata_cleaned', message: '已自动清理图片元数据并上传' });
  }
  if (longEdge < LOW_RES_LONG_EDGE) {
    warnings.push({ code: 'low_resolution', message: '图片分辨率偏低，可能影响生成效果' });
  }
  if (longEdge / shortEdge > EXTREME_ASPECT_RATIO) {
    warnings.push({ code: 'extreme_aspect_ratio', message: '图片比例过于极端，可能影响生成效果' });
  }

  const needsResize = longEdge > MAX_LONG_EDGE;
  const mayHaveAlpha = kind === 'png' ? hasPngAlpha(sourceBuffer) : kind === 'webp' ? hasWebpAlpha(sourceBuffer) : false;
  const hasAlpha = mayHaveAlpha && !needsResize
    ? hasTransparentPixels(canvasMod, image, sourceWidth, sourceHeight)
    : mayHaveAlpha;
  if (!hasAlpha && !needsResize) {
    return {
      buffer: sourceBuffer,
      mime: mimeForKind(kind),
      extension: extensionForKind(kind),
      width: sourceWidth,
      height: sourceHeight,
      warnings,
      mode: 'copied',
    };
  }

  const scale = needsResize ? MAX_LONG_EDGE / longEdge : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  let buffer: Buffer;
  try {
    const canvas = canvasMod.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    buffer = canvas.toBuffer('image/jpeg');
  } catch {
    throw new StoryboardMaterialImageError('unprocessable_image', '图片无法处理，请重新导出后再上传');
  }
  return {
    buffer,
    mime: 'image/jpeg',
    extension: 'jpg',
    width,
    height,
    warnings,
    mode: 'reencoded',
  };
}

function existingMaterialImage(
  ownerId: number,
  projectId: string,
  assetRef: string,
  db = getDb(),
): any | null {
  return db
    .prepare(
      `SELECT *
         FROM images
        WHERE owner_id = ?
          AND project_id = ?
          AND asset_ref = ?
          AND style = ?
        LIMIT 1`,
    )
    .get(ownerId, projectId, assetRef, STORYBOARD_MATERIAL_IMAGE_STYLE) || null;
}

function existingImageResponse(row: any, assetRef: string): StoredStoryboardMaterialImage {
  return {
    imageId: row.id,
    url: `/api/images/file/${row.id}`,
    thumbUrl: `/api/images/file/${row.id}?w=256`,
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    sizeBytes: Number(row.size_bytes || 0),
    mime: row.mime || 'image/png',
    warnings: [],
    assetRef,
    mode: 'existing',
  };
}

export async function storeStoryboardMaterialImage(opts: {
  ownerId: number;
  projectId: string;
  groupIdx: number;
  role: StoryboardMaterialRole;
  materialId: string;
  buffer: Buffer;
}): Promise<StoredStoryboardMaterialImage> {
  const role = normalizeStoryboardMaterialRole(opts.role);
  const kind = materialRoleToImageKind(role);
  const materialId = String(opts.materialId || '').trim();
  if (!kind || !materialId || !/^[a-zA-Z0-9_.:-]+$/.test(materialId)) {
    throw new StoryboardMaterialImageError('invalid_material_id', '素材 ID 无效');
  }
  if (!opts.projectId || !Number.isInteger(opts.groupIdx) || opts.groupIdx < 0) {
    throw new StoryboardMaterialImageError('invalid_material_scope', '素材归属无效');
  }
  const assetRef = storyboardMaterialAssetRef(opts.groupIdx, role, materialId);
  if (!assetRef) throw new StoryboardMaterialImageError('invalid_material_scope', '素材归属无效');

  const processed = await processStoryboardMaterialImageBuffer(opts.buffer);
  const imageId = randomUUID();
  const filename = `${imageId}.${processed.extension}`;
  const ownerDir = imageOwnerDir(opts.ownerId);
  mkdirSync(ownerDir, { recursive: true });
  const fullPath = imageFullPath(opts.ownerId, filename);
  writeFileSync(fullPath, processed.buffer);

  const db = getDb();
  const result = (() => {
    try {
      return db.transaction(() => {
        const existing = existingMaterialImage(opts.ownerId, opts.projectId, assetRef, db);
        if (existing) {
          const existingPath = imageFullPath(Number(existing.owner_id), String(existing.filename || ''));
          if (existsSync(existingPath)) return { type: 'existing' as const, row: existing };
          db.prepare(
            `DELETE FROM images
              WHERE id = ?
                AND owner_id = ?
                AND project_id = ?
                AND asset_ref = ?
                AND style = ?`,
          ).run(existing.id, opts.ownerId, opts.projectId, assetRef, STORYBOARD_MATERIAL_IMAGE_STYLE);
        }

        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO images
              (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style, correlation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            imageId,
            opts.ownerId,
            opts.projectId,
            kind,
            assetRef,
            filename,
            processed.mime,
            processed.buffer.length,
            processed.width,
            processed.height,
            STORYBOARD_MATERIAL_UPLOAD_PROMPT,
            STORYBOARD_MATERIAL_IMAGE_STYLE,
          );

        if (inserted.changes === 0) {
          const afterConflict = existingMaterialImage(opts.ownerId, opts.projectId, assetRef, db);
          if (afterConflict) {
            const conflictPath = imageFullPath(Number(afterConflict.owner_id), String(afterConflict.filename || ''));
            if (existsSync(conflictPath)) return { type: 'existing' as const, row: afterConflict };
            db.prepare(
              `DELETE FROM images
                WHERE id = ?
                  AND owner_id = ?
                  AND project_id = ?
                  AND asset_ref = ?
                  AND style = ?`,
            ).run(afterConflict.id, opts.ownerId, opts.projectId, assetRef, STORYBOARD_MATERIAL_IMAGE_STYLE);
          }
          throw new StoryboardMaterialImageError('material_upload_conflict', '素材上传冲突，请重试', 409);
        }

        return { type: 'inserted' as const };
      })();
    } catch (error) {
      safeUnlink(fullPath);
      throw error;
    }
  })();

  if (result.type === 'existing') {
    safeUnlink(fullPath);
    return existingImageResponse(result.row, assetRef);
  }

  return {
    imageId,
    url: `/api/images/file/${imageId}`,
    thumbUrl: `/api/images/file/${imageId}?w=256`,
    width: processed.width,
    height: processed.height,
    sizeBytes: processed.buffer.length,
    mime: processed.mime,
    warnings: processed.warnings,
    assetRef,
    mode: processed.mode,
  };
}
