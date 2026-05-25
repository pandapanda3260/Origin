import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, extname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { verifySignedImageUrl } from '@/lib/signed-asset-url';
import { dataPath } from '@/lib/runtime-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const THUMBNAIL_VERSION = 'v1';
const THUMBNAIL_QUALITY = 82;
const THUMBNAIL_WIDTHS = [256, 384, 512, 1024, 1600] as const;
const HEADER_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 4096 * 4096;
const RESIZE_QUEUE_TIMEOUT_MS = 10_000;
const RESIZE_TASK_TIMEOUT_MS = 30_000;
const DEFAULT_RESIZE_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism()));

type ThumbnailFormat = 'webp' | 'jpeg';
type ImageInfo = { width?: number; height?: number; orientation?: number };

let webpSupported: boolean | null = null;
let resizeActive = 0;
const resizeQueue: Array<{
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}> = [];

function thumbnailsEnabled() {
  const raw = String(process.env.IMAGE_THUMB_ENABLED ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function resizeConcurrency() {
  const raw = Number(process.env.IMAGE_THUMB_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RESIZE_CONCURRENCY;
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

function parseThumbWidth(req: NextRequest): number {
  if (!thumbnailsEnabled()) return 0;
  const raw = new URL(req.url).searchParams.get('w');
  if (!raw) return 0;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'orig' || normalized === 'original') return 0;
  const n = Number.parseInt(normalized, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return THUMBNAIL_WIDTHS.reduce((best, candidate) => {
    const bestDelta = Math.abs(best - n);
    const candidateDelta = Math.abs(candidate - n);
    if (candidateDelta < bestDelta) return candidate;
    if (candidateDelta === bestDelta && candidate > best) return candidate;
    return best;
  }, THUMBNAIL_WIDTHS[0]);
}

function mimeFromFormat(format: ThumbnailFormat) {
  return format === 'webp' ? 'image/webp' : 'image/jpeg';
}

function extFromFormat(format: ThumbnailFormat) {
  return format === 'webp' ? 'webp' : 'jpg';
}

function getThumbnailCachePath(row: any, width: number, format: ThumbnailFormat) {
  return dataPath(
    'image-thumbs',
    String(row.owner_id),
    `${row.id}_${THUMBNAIL_VERSION}_w${width}_q${THUMBNAIL_QUALITY}.${extFromFormat(format)}`
  );
}

async function statSafe(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readHeader(path: string, size: number) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function parsePngInfo(buf: Buffer): ImageInfo {
  if (buf.length < 24) return {};
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return {};
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), orientation: 1 };
}

function parseExifOrientation(segment: Buffer): number | undefined {
  if (segment.length < 14 || segment.toString('ascii', 0, 6) !== 'Exif\0\0') return undefined;
  const tiff = 6;
  const order = segment.toString('ascii', tiff, tiff + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return undefined;
  const read16 = (offset: number) => (le ? segment.readUInt16LE(offset) : segment.readUInt16BE(offset));
  const read32 = (offset: number) => (le ? segment.readUInt32LE(offset) : segment.readUInt32BE(offset));
  const ifdOffset = tiff + read32(tiff + 4);
  if (ifdOffset < 0 || ifdOffset + 2 > segment.length) return undefined;
  const entries = read16(ifdOffset);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > segment.length) break;
    const tag = read16(entry);
    if (tag !== 0x0112) continue;
    const type = read16(entry + 2);
    const count = read32(entry + 4);
    if (type !== 3 || count < 1) return undefined;
    const value = read16(entry + 8);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

function parseJpegInfo(buf: Buffer): ImageInfo {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return {};
  const info: ImageInfo = { orientation: 1 };
  let offset = 2;
  while (offset + 4 <= buf.length) {
    while (offset < buf.length && buf[offset] === 0xff) offset += 1;
    if (offset >= buf.length) break;
    const marker = buf[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buf.length) break;
    const len = buf.readUInt16BE(offset);
    if (len < 2 || offset + len > buf.length) break;
    const start = offset + 2;
    const end = offset + len;
    if (marker === 0xe1) {
      const orientation = parseExifOrientation(buf.subarray(start, end));
      if (orientation) info.orientation = orientation;
    }
    const isSof = (
      marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 ||
      marker === 0xc5 || marker === 0xc6 || marker === 0xc7 ||
      marker === 0xc9 || marker === 0xca || marker === 0xcb ||
      marker === 0xcd || marker === 0xce || marker === 0xcf
    );
    if (isSof && start + 5 <= end) {
      info.height = buf.readUInt16BE(start + 1);
      info.width = buf.readUInt16BE(start + 3);
    }
    if (info.width && info.height && info.orientation) break;
    offset = end;
  }
  return info;
}

function parseImageInfo(buf: Buffer, mime: string): ImageInfo {
  const normalized = mime.toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return parseJpegInfo(buf);
  if (normalized.includes('png')) return parsePngInfo(buf);
  return {};
}

function shouldPassthroughSource(row: any) {
  const mime = String(row.mime || '').toLowerCase();
  const ext = extname(String(row.filename || '')).toLowerCase();
  return (
    mime.includes('svg') ||
    mime.includes('gif') ||
    mime.includes('apng') ||
    mime.includes('avif') ||
    mime.includes('heic') ||
    mime.includes('heif') ||
    ['.svg', '.gif', '.apng', '.avif', '.heic', '.heif'].includes(ext)
  );
}

async function getThumbnailFormat(): Promise<ThumbnailFormat> {
  if (webpSupported !== null) return webpSupported ? 'webp' : 'jpeg';
  try {
    const canvasMod: any = await import('@napi-rs/canvas');
    const canvas = canvasMod.createCanvas(8, 8);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 8, 8);
    const buf = canvas.toBuffer('image/webp', THUMBNAIL_QUALITY);
    webpSupported = Buffer.isBuffer(buf) && buf.length > 0;
  } catch (error) {
    webpSupported = false;
    console.warn('[images/file] webp probe failed, falling back to jpeg:', error);
  }
  return webpSupported ? 'webp' : 'jpeg';
}

function acquireResizeSlot(): Promise<() => void> {
  if (resizeActive < resizeConcurrency()) {
    resizeActive += 1;
    return Promise.resolve(releaseResizeSlot);
  }
  return new Promise((resolve, reject) => {
    const item = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const idx = resizeQueue.indexOf(item);
        if (idx >= 0) resizeQueue.splice(idx, 1);
        reject(new Error('resize_queue_timeout'));
      }, RESIZE_QUEUE_TIMEOUT_MS),
    };
    resizeQueue.push(item);
  });
}

function releaseResizeSlot() {
  resizeActive = Math.max(0, resizeActive - 1);
  const next = resizeQueue.shift();
  if (!next) return;
  clearTimeout(next.timer);
  resizeActive += 1;
  next.resolve(releaseResizeSlot);
}

async function withResizeSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireResizeSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

const THUMBNAIL_WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const canvasMod = require('@napi-rs/canvas');

function applyOrientation(ctx, image, width, height, orientation) {
  switch (orientation) {
    case 2:
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(image, 0, 0, width, height);
      break;
    case 3:
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      ctx.drawImage(image, 0, 0, width, height);
      break;
    case 4:
      ctx.translate(0, height);
      ctx.scale(1, -1);
      ctx.drawImage(image, 0, 0, width, height);
      break;
    case 5:
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      ctx.drawImage(image, 0, 0, height, width);
      break;
    case 6:
      ctx.translate(width, 0);
      ctx.rotate(0.5 * Math.PI);
      ctx.drawImage(image, 0, 0, height, width);
      break;
    case 7:
      ctx.translate(width, height);
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(-1, 1);
      ctx.drawImage(image, 0, 0, height, width);
      break;
    case 8:
      ctx.translate(0, height);
      ctx.rotate(-0.5 * Math.PI);
      ctx.drawImage(image, 0, 0, height, width);
      break;
    default:
      ctx.drawImage(image, 0, 0, width, height);
  }
}

(async () => {
  try {
    const source = await fs.readFile(workerData.fullPath);
    const image = await canvasMod.loadImage(source);
    const orientation = Number(workerData.orientation || 1);
    const rotated = orientation >= 5 && orientation <= 8;
    const orientedWidth = rotated ? image.height : image.width;
    const orientedHeight = rotated ? image.width : image.height;
    const width = Math.min(Number(workerData.width), orientedWidth);
    const height = Math.max(1, Math.round(orientedHeight * (width / orientedWidth)));
    const canvas = canvasMod.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (workerData.format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    applyOrientation(ctx, image, width, height, orientation);
    const mime = workerData.format === 'webp' ? 'image/webp' : 'image/jpeg';
    const buffer = typeof canvas.toBufferAsync === 'function'
      ? await canvas.toBufferAsync(mime, workerData.quality)
      : canvas.toBuffer(mime, workerData.quality);
    parentPort.postMessage({ ok: true, buffer });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error && (error.stack || error.message) || String(error) });
  }
})();
`;

function runThumbnailWorker(opts: {
  fullPath: string;
  width: number;
  format: ThumbnailFormat;
  quality: number;
  orientation: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(THUMBNAIL_WORKER_CODE, { eval: true, workerData: opts });
    let settled = false;
    const finish = (error?: Error, buffer?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(buffer || Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(new Error('resize_task_timeout'));
    }, RESIZE_TASK_TIMEOUT_MS);
    worker.once('message', (message: any) => {
      if (!message?.ok) {
        finish(new Error(message?.error || 'thumbnail_worker_failed'));
        return;
      }
      finish(undefined, Buffer.from(message.buffer));
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(new Error(`thumbnail_worker_exit_${code}`));
    });
  });
}

async function writeCacheAtomic(path: string, buf: Buffer) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, buf);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

function logTiming(args: {
  id: string;
  width: number;
  hit: string;
  mode: string;
  bytes: number;
  ms: number;
}) {
  console.info(
    '[image-timing] id=%s w=%d hit=%s mode=%s bytes=%d ms=%d',
    args.id,
    args.width,
    args.hit,
    args.mode,
    args.bytes,
    args.ms
  );
}

function imageResponse(buf: Buffer, contentType: string, cacheControl: string) {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
      'Cache-Control': cacheControl,
    },
  });
}

async function originalResponse(row: any, fullPath: string, width: number, started: number, mode: string) {
  const buf = await readFile(fullPath);
  logTiming({
    id: row.id,
    width,
    hit: width ? 'passthrough' : 'original',
    mode,
    bytes: buf.length,
    ms: Date.now() - started,
  });
  return imageResponse(buf, row.mime || 'image/png', 'private, max-age=31536000, immutable');
}

/**
 * 提供生成图文件的下载/预览。
 *
 * 鉴权：任何原图/缩略图路径都必须先校验登录用户或 signed URL；w 暂不进入签名 payload。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const started = Date.now();
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT * FROM images WHERE id = @id').get({ id });
  if (!row) return new Response('not found', { status: 404 });

  const url = new URL(req.url);
  const signedOk = verifySignedImageUrl({
    imageId: id,
    ownerId: Number(row.owner_id),
    exp: url.searchParams.get('exp'),
    sig: url.searchParams.get('sig'),
  });
  const user = await getCurrentUser(req);
  if (user) {
    if (Number(row.owner_id) !== Number(user.id)) return new Response('forbidden', { status: 403 });
  } else {
    if (!signedOk) return new Response('unauthorized', { status: 401 });
  }
  const thumbnailCacheControl = signedOk
    ? 'public, max-age=31536000, immutable'
    : 'private, max-age=31536000, immutable';

  let fullPath = dataPath('images', String(row.owner_id), row.filename);
  let fileStat = await statSafe(fullPath);
  if (!fileStat && (row.style === 'video-cover' || String(row.asset_ref || '').startsWith('video-cover/'))) {
    const videoCoverPath = dataPath('videos', String(row.owner_id), row.filename);
    const videoCoverStat = await statSafe(videoCoverPath);
    if (videoCoverStat) {
      fullPath = videoCoverPath;
      fileStat = videoCoverStat;
    }
  }
  if (!fileStat) return new Response('file missing', { status: 404 });

  const width = parseThumbWidth(req);
  if (!width) return originalResponse(row, fullPath, 0, started, thumbnailsEnabled() ? 'original' : 'disabled');
  if (shouldPassthroughSource(row)) return originalResponse(row, fullPath, width, started, 'unsupported_source');
  if (fileStat.size > MAX_SOURCE_BYTES) return originalResponse(row, fullPath, width, started, 'source_too_large');

  const header = await readHeader(fullPath, Math.min(HEADER_BYTES, fileStat.size));
  const headerInfo = parseImageInfo(header, row.mime || '');
  const sourceWidth = Number(row.width) || headerInfo.width || 0;
  const sourceHeight = Number(row.height) || headerInfo.height || 0;
  const orientation = headerInfo.orientation || 1;
  const rotated = orientation >= 5 && orientation <= 8;
  const orientedWidth = rotated ? sourceHeight : sourceWidth;
  const orientedHeight = rotated ? sourceWidth : sourceHeight;

  if (orientedWidth && orientedHeight && orientedWidth * orientedHeight > MAX_SOURCE_PIXELS) {
    return originalResponse(row, fullPath, width, started, 'source_pixels_too_large');
  }
  if (orientedWidth && orientedWidth <= width) {
    return originalResponse(row, fullPath, width, started, 'source_smaller_than_variant');
  }

  const format = await getThumbnailFormat();
  const contentType = mimeFromFormat(format);
  const cachePath = getThumbnailCachePath(row, width, format);
  const cached = await readFile(cachePath).catch(() => null);
  if (cached) {
    logTiming({ id, width, hit: 'cache', mode: format, bytes: cached.length, ms: Date.now() - started });
    return imageResponse(cached, contentType, thumbnailCacheControl);
  }

  let resized: Buffer;
  try {
    resized = await withResizeSlot(() =>
      runThumbnailWorker({
        fullPath,
        width,
        format,
        quality: THUMBNAIL_QUALITY,
        orientation,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[images/file] thumbnail resize failed:', error);
    if (message.includes('timeout')) return originalResponse(row, fullPath, width, started, message);
    return new Response('thumbnail failed', { status: 422 });
  }

  try {
    await writeCacheAtomic(cachePath, resized);
  } catch (error) {
    console.warn('[images/file] thumbnail cache write failed:', error);
  }
  logTiming({ id, width, hit: 'generated', mode: format, bytes: resized.length, ms: Date.now() - started });
  return imageResponse(resized, contentType, thumbnailCacheControl);
}
