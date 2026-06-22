import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import type { UserRow } from './db';
import { resolveLocalImagePath } from './image-gen';
import { getDataDir } from './runtime-paths';
import { isBlockingReferenceStatus, resolveAssetReferenceState } from './visual-reference-state';

export type PropDimensionality = 'volumetric' | 'flat';
export type PropViewRole = 'front' | 'side' | 'back' | 'top' | 'hero';
export type PropViewSlot = PropViewRole | 'side_left' | 'side_right';
export type PropImageUrlStrategy = 'selection' | 'framePlan' | 'videoManifest';
export type PropViewQualityStatus = 'accepted' | 'degraded' | 'rejected';

export type PropViewQuality = {
  nonWhiteRatio: number;
  bboxCoverage: number;
  bboxCenterX: number;
  bboxCenterY: number;
  edgeTouch: boolean;
  status: PropViewQualityStatus;
  usable: boolean;
  reason?: string;
  warnings?: string[];
};

export type PropView = {
  role: PropViewRole;
  slot?: PropViewSlot;
  imageUrl?: string;
  rawUrl?: string;
  imagePrompt?: string;
  reference?: any;
  generatedAt?: string;
  quality?: PropViewQuality;
};

export type PropViewsMeta = {
  schema: 'prop-six-view-sheet-v1';
  sourceImageId: string | null;
  sourceImageUrl: string;
  sheetUrl: string;
  version: number;
  generatedAt: string;
  slots: Partial<Record<PropViewSlot, PropView>>;
  quality: {
    slots: Partial<Record<PropViewSlot, PropViewQuality>>;
    roles: Partial<Record<PropViewRole, PropViewQuality>>;
  };
  front?: PropView;
  side?: PropView;
  back?: PropView;
  top?: PropView;
  hero?: PropView;
};

export type SplitPropViewsResult =
  | { ok: true; views: PropViewsMeta; viewImageIds: string[] }
  | { ok: false; error: string; views?: PropViewsMeta };

type CanvasApi = {
  createCanvas: (width: number, height: number) => any;
  loadImage: (src: string | Buffer) => Promise<any>;
};

type Bounds = { left: number; right: number; top: number; bottom: number };

type PreparedPropView = {
  slot: PropViewSlot;
  role: PropViewRole;
  width: number;
  height: number;
  buffer: Buffer;
  quality: PropViewQuality;
};

const DATA_DIR = getDataDir();
const IMAGES_DIR = join(DATA_DIR, 'images');
const MAX_PROP_VIEW_HISTORY = 5;
const PROP_VIEW_TOO_WHITE_RATIO = 0.01;
const PROP_VIEW_TOO_SMALL_COVERAGE = 0.025;
const PROP_VIEW_TOO_INK_RATIO = 0.78;
const PROP_VIEW_TOO_LARGE_COVERAGE = 0.88;
const PROP_VIEW_NEAR_SOLID_RATIO = 0.92;
const PROP_VIEW_THIN_RATIO = 0.16;
const PROP_VIEW_OFF_CENTER_DELTA = 0.33;

export const PROP_VIEW_SCHEMA = 'prop-six-view-sheet-v1' as const;
export const PROP_VIEW_ROLES: PropViewRole[] = ['front', 'side', 'back', 'top', 'hero'];
export const RAW_PROP_VIEW_SLOTS: Array<{ slot: PropViewSlot; role: PropViewRole; col: number; row: number }> = [
  { slot: 'hero', role: 'hero', col: 0, row: 0 },
  { slot: 'front', role: 'front', col: 1, row: 0 },
  { slot: 'back', role: 'back', col: 2, row: 0 },
  { slot: 'side_left', role: 'side', col: 0, row: 1 },
  { slot: 'side_right', role: 'side', col: 1, row: 1 },
  { slot: 'top', role: 'top', col: 2, row: 1 },
];

function compactText(value: unknown): string {
  return String(value || '').trim();
}

function firstUrl(...values: unknown[]): string {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return '';
}

function imageIdFromUrl(url: string | undefined | null): string | null {
  const m = /\/api\/images\/file\/([0-9a-fA-F-]{36})/.exec(url || '');
  return m ? m[1] : null;
}

function publicUrlForImageId(id: string) {
  return `/api/images/file/${id}`;
}

export function normalizePropDimensionality(value: unknown, prop?: any): PropDimensionality {
  const raw = compactText(value).toLowerCase();
  if (raw === 'flat' || raw === '2d' || raw === 'planar' || raw === 'plane') return 'flat';
  if (raw === 'volumetric' || raw === '3d' || raw === 'object' || raw === 'solid') return 'volumetric';

  const text = [
    prop?.name,
    prop?.propType,
    prop?.category,
    prop?.features,
    prop?.material,
    prop?.description,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/(画作|绘画|海报|照片|相框|文件|纸张|书页|票据|卡片|证件|地图|卷轴|屏幕内容|屏幕画面|招牌|标识牌|路牌|poster|painting|photo|frame|document|paper|page|ticket|card|map|scroll|sign|placard|screen content)/i.test(text)) {
    return 'flat';
  }
  return 'volumetric';
}

export function normalizePropViewRole(value: unknown): PropViewRole | null {
  const role = compactText(value).toLowerCase();
  return PROP_VIEW_ROLES.includes(role as PropViewRole) ? (role as PropViewRole) : null;
}

export function propViewStaleKey(idx: number): string {
  return `asset_img_prop_${idx}`;
}

function isWhiteLike(r: number, g: number, b: number, a: number): boolean {
  if (a < 16) return true;
  return r >= 238 && g >= 238 && b >= 238;
}

function detectContentBounds(data: Uint8ClampedArray, width: number, height: number): Bounds | null {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      if (!isWhiteLike(data[off], data[off + 1], data[off + 2], data[off + 3])) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }

  if (right < left || bottom < top) return null;
  return { left, right, top, bottom };
}

function propViewQuality(data: Uint8ClampedArray, width: number, height: number): { quality: PropViewQuality; bounds: Bounds | null } {
  const bounds = detectContentBounds(data, width, height);
  const total = Math.max(1, width * height);
  if (!bounds) {
    return {
      bounds,
      quality: {
        nonWhiteRatio: 0,
        bboxCoverage: 0,
        bboxCenterX: 0.5,
        bboxCenterY: 0.5,
        edgeTouch: false,
        status: 'rejected',
        usable: false,
        reason: 'empty-view',
      },
    };
  }

  const bboxW = bounds.right - bounds.left + 1;
  const bboxH = bounds.bottom - bounds.top + 1;
  const nonWhiteRatio = (() => {
    let nonWhite = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = (y * width + x) * 4;
        if (!isWhiteLike(data[off], data[off + 1], data[off + 2], data[off + 3])) nonWhite++;
      }
    }
    return nonWhite / total;
  })();
  const bboxCoverage = (bboxW * bboxH) / total;
  const bboxCenterX = (bounds.left + bboxW / 2) / width;
  const bboxCenterY = (bounds.top + bboxH / 2) / height;
  const edgeMargin = Math.max(2, Math.round(Math.min(width, height) * 0.025));
  const edgeTouch = bounds.left <= edgeMargin ||
    bounds.top <= edgeMargin ||
    bounds.right >= width - 1 - edgeMargin ||
    bounds.bottom >= height - 1 - edgeMargin;

  let rejectedReason = '';
  if (nonWhiteRatio < PROP_VIEW_TOO_WHITE_RATIO) rejectedReason = 'too-much-white';
  else if (bboxCoverage < PROP_VIEW_TOO_SMALL_COVERAGE) rejectedReason = 'subject-too-small';
  else if (nonWhiteRatio >= PROP_VIEW_NEAR_SOLID_RATIO && bboxCoverage >= PROP_VIEW_NEAR_SOLID_RATIO) {
    rejectedReason = 'near-solid-no-structure';
  }

  if (rejectedReason) {
    return {
      bounds,
      quality: {
        nonWhiteRatio,
        bboxCoverage,
        bboxCenterX,
        bboxCenterY,
        edgeTouch,
        status: 'rejected',
        usable: false,
        reason: rejectedReason,
      },
    };
  }

  const warnings: string[] = [];
  if (nonWhiteRatio > PROP_VIEW_TOO_INK_RATIO) warnings.push('too-much-ink');
  if (bboxCoverage > PROP_VIEW_TOO_LARGE_COVERAGE) warnings.push('subject-too-large');
  if (bboxW / width < PROP_VIEW_THIN_RATIO || bboxH / height < PROP_VIEW_THIN_RATIO) warnings.push('subject-too-thin');
  if (edgeTouch) warnings.push('subject-touches-cell-edge');
  if (Math.abs(bboxCenterX - 0.5) > PROP_VIEW_OFF_CENTER_DELTA || Math.abs(bboxCenterY - 0.5) > PROP_VIEW_OFF_CENTER_DELTA) {
    warnings.push('subject-off-center');
  }
  const status: PropViewQualityStatus = warnings.length ? 'degraded' : 'accepted';

  return {
    bounds,
    quality: {
      nonWhiteRatio,
      bboxCoverage,
      bboxCenterX,
      bboxCenterY,
      edgeTouch,
      status,
      usable: true,
      warnings: warnings.length ? warnings : undefined,
    },
  };
}

function qualityStatus(quality: PropViewQuality | undefined): PropViewQualityStatus {
  if (!quality) return 'rejected';
  if (quality.status) return quality.status;
  return quality.usable === false ? 'rejected' : 'accepted';
}

function qualityScore(quality: PropViewQuality | undefined): number {
  if (!quality) return -Infinity;
  const status = qualityStatus(quality);
  if (status === 'rejected') return -Infinity;
  const centerPenalty = Math.abs(quality.bboxCenterX - 0.5) + Math.abs(quality.bboxCenterY - 0.5);
  const statusBase = status === 'accepted' ? 200 : 100;
  return statusBase + quality.bboxCoverage * 20 + quality.nonWhiteRatio * 10 - centerPenalty * 8 - (quality.edgeTouch ? 30 : 0);
}

function roleFromSlot(slot: PropViewSlot): PropViewRole {
  const spec = RAW_PROP_VIEW_SLOTS.find((item) => item.slot === slot);
  return spec?.role || (slot as PropViewRole);
}

function selectSideView(slots: Partial<Record<PropViewSlot, PropView>>): PropView | undefined {
  const left = slots.side_left;
  const right = slots.side_right;
  if (!left) return right ? { ...right, role: 'side' } : undefined;
  if (!right) return { ...left, role: 'side' };
  const leftStatus = qualityStatus(left.quality);
  const rightStatus = qualityStatus(right.quality);
  if (leftStatus === 'accepted' && rightStatus !== 'accepted') return { ...left, role: 'side' };
  if (rightStatus === 'accepted' && leftStatus !== 'accepted') return { ...right, role: 'side' };
  return qualityScore(right.quality) > qualityScore(left.quality)
    ? { ...right, role: 'side' }
    : { ...left, role: 'side' };
}

async function loadCanvas(): Promise<CanvasApi> {
  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod || !canvasMod.createCanvas || !canvasMod.loadImage) {
    throw new Error('@napi-rs/canvas 不可用，无法切分道具设定板');
  }
  return canvasMod as CanvasApi;
}

function makeSquareCrop(canvasApi: CanvasApi, cellCanvas: any, bounds: Bounds): { buffer: Buffer; width: number; height: number } {
  const bboxW = bounds.right - bounds.left + 1;
  const bboxH = bounds.bottom - bounds.top + 1;
  const contentSide = Math.max(bboxW, bboxH);
  const margin = Math.max(24, Math.round(contentSide * 0.12));
  const side = contentSide + margin * 2;
  const out = canvasApi.createCanvas(side, side);
  const outCtx = out.getContext('2d');
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, side, side);
  outCtx.drawImage(
    cellCanvas,
    bounds.left,
    bounds.top,
    bboxW,
    bboxH,
    margin + Math.round((contentSide - bboxW) / 2),
    margin + Math.round((contentSide - bboxH) / 2),
    bboxW,
    bboxH,
  );
  return {
    buffer: out.toBuffer('image/png') as Buffer,
    width: side,
    height: side,
  };
}

function attachRoleViews(views: PropViewsMeta) {
  views.hero = views.slots.hero ? { ...views.slots.hero, role: 'hero' } : undefined;
  views.front = views.slots.front ? { ...views.slots.front, role: 'front' } : undefined;
  views.back = views.slots.back ? { ...views.slots.back, role: 'back' } : undefined;
  views.top = views.slots.top ? { ...views.slots.top, role: 'top' } : undefined;
  views.side = selectSideView(views.slots);
  for (const role of PROP_VIEW_ROLES) {
    if (views[role]) views.quality.roles[role] = views[role]?.quality;
  }
}

export async function splitPropViews(opts: {
  user: UserRow;
  projectId?: string | null;
  assetRef: string;
  sourceImageUrl: string;
  prompt?: string;
  version?: number;
}): Promise<SplitPropViewsResult> {
  try {
    const sourcePath = resolveLocalImagePath(opts.sourceImageUrl, opts.user.id);
    if (!sourcePath || !existsSync(sourcePath)) {
      return { ok: false, error: 'source image not found' };
    }

    const canvasApi = await loadCanvas();
    const sourceImg = await canvasApi.loadImage(sourcePath);
    const width = sourceImg.width;
    const height = sourceImg.height;
    if (!width || !height) return { ok: false, error: 'invalid source image dimensions' };

    const sourceCanvas = canvasApi.createCanvas(width, height);
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.drawImage(sourceImg, 0, 0, width, height);
    const sourceImageId = imageIdFromUrl(opts.sourceImageUrl);
    const generatedAt = new Date().toISOString();
    const views: PropViewsMeta = {
      schema: PROP_VIEW_SCHEMA,
      sourceImageId,
      sourceImageUrl: opts.sourceImageUrl,
      sheetUrl: opts.sourceImageUrl,
      version: opts.version || 1,
      generatedAt,
      slots: {},
      quality: { slots: {}, roles: {} },
    };

    const prepared: PreparedPropView[] = [];
    for (const spec of RAW_PROP_VIEW_SLOTS) {
      const left = Math.round((width * spec.col) / 3);
      const top = Math.round((height * spec.row) / 2);
      const right = Math.round((width * (spec.col + 1)) / 3);
      const bottom = Math.round((height * (spec.row + 1)) / 2);
      const cellW = Math.max(1, right - left);
      const cellH = Math.max(1, bottom - top);
      const cellCanvas = canvasApi.createCanvas(cellW, cellH);
      const cellCtx = cellCanvas.getContext('2d');
      cellCtx.fillStyle = '#ffffff';
      cellCtx.fillRect(0, 0, cellW, cellH);
      cellCtx.drawImage(sourceImg, left, top, cellW, cellH, 0, 0, cellW, cellH);
      const cellData = cellCtx.getImageData(0, 0, cellW, cellH).data as Uint8ClampedArray;
      const { quality, bounds } = propViewQuality(cellData, cellW, cellH);
      views.quality.slots[spec.slot] = quality;
      if (quality.status === 'rejected' || !bounds) continue;

      const crop = makeSquareCrop(canvasApi, cellCanvas, bounds);
      prepared.push({
        slot: spec.slot,
        role: spec.role,
        width: crop.width,
        height: crop.height,
        buffer: crop.buffer,
        quality,
      });
    }

    if (!prepared.length) {
      return { ok: false, error: 'not enough usable prop views (0/6)', views };
    }

    const db = getDb();
    const ownerDir = join(IMAGES_DIR, String(opts.user.id));
    mkdirSync(ownerDir, { recursive: true });
    const viewImageIds: string[] = [];
    for (const view of prepared) {
      const id = randomUUID();
      const filename = `${id}.png`;
      const fullPath = join(ownerDir, filename);
      writeFileSync(fullPath, view.buffer);
      db.prepare(
        `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
         VALUES (?, ?, ?, 'prop', ?, ?, 'image/png', ?, ?, ?, ?, 'prop-view')`,
      ).run(
        id,
        opts.user.id,
        opts.projectId || null,
        `${opts.assetRef}.views.slots.${view.slot}`,
        filename,
        view.buffer.length,
        view.width,
        view.height,
        (opts.prompt || `prop view ${view.slot}`).slice(0, 4000),
      );
      viewImageIds.push(id);
      views.slots[view.slot] = {
        role: roleFromSlot(view.slot),
        slot: view.slot,
        imageUrl: publicUrlForImageId(id),
        rawUrl: publicUrlForImageId(id),
        imagePrompt: opts.prompt,
        generatedAt,
        quality: view.quality,
      };
    }

    attachRoleViews(views);
    const canonical = firstUrl(views.front?.imageUrl, views.hero?.imageUrl, views.side?.imageUrl, views.back?.imageUrl, views.top?.imageUrl);
    if (!canonical) return { ok: false, error: 'not enough usable prop views (no canonical view)', views };
    return { ok: true, views, viewImageIds };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function appendPropViewHistory(existing: any): any[] {
  const priorHistory = Array.isArray(existing?.viewHistory) ? existing.viewHistory : [];
  const priorViews = existing?.views && typeof existing.views === 'object' ? existing.views : null;
  if (!priorViews) return priorHistory.slice(0, MAX_PROP_VIEW_HISTORY);
  const urls = [
    priorViews.front?.imageUrl,
    priorViews.side?.imageUrl,
    priorViews.back?.imageUrl,
    priorViews.top?.imageUrl,
    priorViews.hero?.imageUrl,
    ...Object.values(priorViews.slots || {}).map((view: any) => view?.imageUrl || view?.rawUrl),
  ].filter(Boolean);
  if (!urls.length) return priorHistory.slice(0, MAX_PROP_VIEW_HISTORY);
  return [
    {
      version: Number(existing?.viewsVersion || priorViews.version || 0),
      sourceImageId: priorViews.sourceImageId || imageIdFromUrl(priorViews.sourceImageUrl || priorViews.sheetUrl),
      viewImageIds: Array.from(new Set(urls.map((url: any) => imageIdFromUrl(url)).filter(Boolean))),
      deprecatedAt: new Date().toISOString(),
    },
    ...priorHistory,
  ].slice(0, MAX_PROP_VIEW_HISTORY);
}

function canonicalPropViewUrl(views: PropViewsMeta | undefined | null, existing?: any): string {
  return firstUrl(
    views?.front?.imageUrl,
    views?.hero?.imageUrl,
    views?.side?.imageUrl,
    views?.back?.imageUrl,
    views?.top?.imageUrl,
    existing?.imageUrl,
    existing?.rawUrl,
  );
}

export function applyPropViewWrite(existing: any, args: {
  splitResult: SplitPropViewsResult;
  sourceImageUrl: string;
  imagePrompt?: string;
  submittedImagePrompt?: string;
  referenceStatus?: string;
  generatedAt?: string;
  imageSafetyAudit?: any;
  effectiveVisualDescription?: any;
  styleBibleSignature?: string;
  styleLockVersion?: number;
  resolvedBackdropColor?: string;
}): any {
  const now = args.generatedAt || new Date().toISOString();
  if (!args.splitResult.ok) {
    return {
      ...(existing || {}),
      imagePrompt: args.imagePrompt === undefined ? existing?.imagePrompt : args.imagePrompt,
      views: args.splitResult.views || existing?.views,
      viewsError: args.splitResult.error,
      viewsErrorAt: now,
      imageLastError: args.splitResult.error,
      imageFailedAt: now,
    };
  }

  const views = {
    ...args.splitResult.views,
    sourceImageUrl: args.sourceImageUrl,
    sheetUrl: args.sourceImageUrl,
  };
  const canonicalUrl = canonicalPropViewUrl(views, existing);
  const reference = canonicalUrl
    ? {
        ...((existing && existing.reference) || {}),
        currentUrl: canonicalUrl,
        lastKnownGoodUrl: canonicalUrl,
        status: args.referenceStatus || 'ready',
        updatedAt: now,
        styleBibleSignature: args.styleBibleSignature,
        styleLockVersion: args.styleLockVersion,
        resolvedBackdropColor: args.resolvedBackdropColor,
      }
    : existing?.reference;
  const next: any = {
    ...(existing || {}),
    dimensionality: normalizePropDimensionality(existing?.dimensionality, existing),
    imagePrompt: args.imagePrompt === undefined ? existing?.imagePrompt : args.imagePrompt,
    imageSafetyAudit: args.imageSafetyAudit === undefined ? existing?.imageSafetyAudit : args.imageSafetyAudit,
    effectiveVisualDescription: args.effectiveVisualDescription === undefined ? existing?.effectiveVisualDescription : args.effectiveVisualDescription,
    views,
    viewsVersion: views.version,
    viewHistory: appendPropViewHistory(existing),
    reference,
  };
  if (args.submittedImagePrompt !== undefined) next.submittedImagePrompt = args.submittedImagePrompt;
  if (canonicalUrl) {
    next.imageUrl = canonicalUrl;
    next.rawUrl = canonicalUrl;
    next.assetId = imageIdFromUrl(canonicalUrl) || existing?.assetId;
    next.imageGeneratedAt = now;
  }
  delete next.viewsError;
  delete next.viewsErrorAt;
  delete next.imageLastError;
  delete next.imageFailedAt;
  if (next.reference) {
    delete next.reference.lastError;
    delete next.reference.lastAttemptUrl;
    delete next.reference.lastFailedAt;
  }
  return next;
}

export function normalizePropViews(prop: any): PropView[] {
  const views = prop?.views && typeof prop.views === 'object' ? prop.views : null;
  const out: PropView[] = [];
  if (views) {
    for (const role of PROP_VIEW_ROLES) {
      const view = views[role];
      if (view && typeof view === 'object') {
        const imageUrl = firstUrl(view?.reference?.currentUrl, view?.reference?.lastKnownGoodUrl, view?.imageUrl, view?.rawUrl);
        if (imageUrl) out.push({ ...view, role, imageUrl, rawUrl: compactText(view?.rawUrl) });
      }
    }
  }
  if (!out.some((view) => view.role === 'front')) {
    const legacyUrl = firstUrl(prop?.reference?.currentUrl, prop?.reference?.lastKnownGoodUrl, prop?.imageUrl, prop?.rawUrl);
    if (legacyUrl) {
      out.push({
        role: 'front',
        imageUrl: legacyUrl,
        rawUrl: compactText(prop?.rawUrl),
        reference: prop?.reference,
        generatedAt: prop?.imageGeneratedAt,
      });
    }
  }
  return out;
}

function resolvePropViewUrl(prop: any, viewRole: PropViewRole, gate: boolean): string {
  const view = normalizePropViews(prop).find((item) => item.role === viewRole);
  if (!view) return '';
  const reference = resolveAssetReferenceState(view);
  if (gate && isBlockingReferenceStatus(reference.status)) return '';
  return firstUrl(reference.currentUrl, reference.lastKnownGoodUrl, view.imageUrl, view.rawUrl);
}

export function resolvePropImageUrl(
  prop: any,
  opts: {
    strategy?: PropImageUrlStrategy;
    gate?: boolean;
    viewRole?: PropViewRole | string | null;
  } = {},
): string {
  if (!prop) return '';
  const gate = opts.gate !== false;
  const requestedRole = normalizePropViewRole(opts.viewRole);
  if (requestedRole) {
    const roleUrl = resolvePropViewUrl(prop, requestedRole, gate);
    if (roleUrl) return roleUrl;
  }

  const strategy = opts.strategy || 'videoManifest';
  const roles: PropViewRole[] = ['front', 'hero', 'side', 'back', 'top'];
  for (const role of roles) {
    const url = resolvePropViewUrl(prop, role, gate);
    if (url) return url;
  }
  if (strategy !== 'selection') {
    const reference = resolveAssetReferenceState(prop);
    if (gate && isBlockingReferenceStatus(reference.status)) return '';
    const refUrl = firstUrl(reference.currentUrl, reference.lastKnownGoodUrl);
    if (refUrl) return refUrl;
  }
  return firstUrl(prop?.imageUrl, prop?.rawUrl);
}

function shotText(shot: any): string {
  return [
    shot?.angle,
    shot?.shotType,
    shot?.camera,
    shot?.composition,
    shot?.visual,
    shot?.description,
    shot?.desc,
    shot?.prompt,
    shot?.videoPrompt,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function pickPropView(prop: any, primaryShot?: any): { role: PropViewRole; url: string; view?: PropView } {
  const text = shotText(primaryShot);
  const name = compactText(prop?.name).toLowerCase();
  const propMentioned = !!name && name.length >= 2 && text.includes(name);
  const preferred: PropViewRole =
    /俯拍|鸟瞰|顶视|top[-\s]?down|overhead|from above/.test(text)
      ? 'top'
      : propMentioned && /背面|背部|背后|后侧|back view|from behind|rear/.test(text)
        ? 'back'
        : propMentioned && /侧面|侧边|侧视|side view|profile/.test(text)
          ? 'side'
          : 'front';
  const roles: PropViewRole[] = preferred === 'front'
    ? ['front', 'hero', 'side', 'back', 'top']
    : [preferred, 'front', 'hero', 'side', 'back', 'top'];
  const views = normalizePropViews(prop);
  for (const role of roles) {
    const url = resolvePropImageUrl(prop, { strategy: 'videoManifest', gate: true, viewRole: role });
    if (url) return { role, url, view: views.find((view) => view.role === role) };
  }
  return { role: 'front', url: resolvePropImageUrl(prop, { strategy: 'videoManifest', gate: true }) };
}
