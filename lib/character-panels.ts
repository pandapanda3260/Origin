import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import type { UserRow } from './db';
import { resolveLocalImagePath } from './image-gen';

export type CharacterEntityType = 'human' | 'non-human';
export type PanelName = 'headshot' | 'front' | 'side' | 'back';
export type CropMethod = 'pixel-detect' | 'percent-fallback';

export type PanelQuality = {
  nonWhiteRatio: number;
  bboxCoverage: number;
  bboxCenterX: number;
  bboxCenterY: number;
  usable: boolean;
  reason?: string;
};

export type CharacterPanelsMeta = {
  schema: 'human-character-sheet-v1' | 'non-human-character-sheet-v1';
  sourceImageId: string | null;
  sourceImageUrl: string;
  sheetUrl: string;
  headshotUrl?: string;
  frontUrl?: string;
  sideUrl?: string;
  backUrl?: string;
  cropMethod: CropMethod;
  confidence: number;
  version: number;
  generatedAt: string;
  quality: Partial<Record<PanelName, PanelQuality>>;
};

export type SplitCharacterPanelsResult =
  | { ok: true; panels: CharacterPanelsMeta; panelImageIds: string[] }
  | { ok: false; error: string };

type Boundary = { left: number; right: number };
type PreparedPanel = {
  panelName: PanelName;
  width: number;
  height: number;
  buffer: Buffer;
  quality: PanelQuality;
};

const DATA_DIR = join(process.cwd(), 'data');
const IMAGES_DIR = join(DATA_DIR, 'images');

function imageIdFromUrl(url: string | undefined | null): string | null {
  const m = /\/api\/images\/file\/([0-9a-fA-F-]{36})/.exec(url || '');
  return m ? m[1] : null;
}

function expectedPanelNames(entityType: CharacterEntityType): PanelName[] {
  return entityType === 'non-human'
    ? ['front', 'side', 'back']
    : ['headshot', 'front', 'side', 'back'];
}

function isWhiteLike(r: number, g: number, b: number, a: number): boolean {
  if (a < 16) return true;
  return r >= 238 && g >= 238 && b >= 238;
}

function detectContentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { left: number; right: number; top: number; bottom: number } | null {
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

function columnInkDensity(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  top: number,
  bottom: number,
): number {
  let ink = 0;
  let total = 0;
  for (let y = top; y <= bottom; y++) {
    const off = (y * width + x) * 4;
    if (!isWhiteLike(data[off], data[off + 1], data[off + 2], data[off + 3])) ink++;
    total++;
  }
  return total > 0 ? ink / total : 0;
}

function mergeRuns(runs: Array<{ start: number; end: number }>, maxGap: number) {
  if (!runs.length) return runs;
  const merged: Array<{ start: number; end: number }> = [];
  let cur = { ...runs[0] };
  for (let i = 1; i < runs.length; i++) {
    const next = runs[i];
    if (next.start - cur.end <= maxGap) cur.end = next.end;
    else {
      merged.push(cur);
      cur = { ...next };
    }
  }
  merged.push(cur);
  return merged;
}

function detectPanelBoundaries(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  entityType: CharacterEntityType,
): { boundaries: Boundary[]; confidence: number } | null {
  const names = expectedPanelNames(entityType);
  const expected = names.length;
  const bounds = detectContentBounds(data, width, height);
  if (!bounds) return null;

  const scanLeft = Math.max(0, bounds.left - Math.round(width * 0.015));
  const scanRight = Math.min(width - 1, bounds.right + Math.round(width * 0.015));
  const scanTop = Math.max(0, bounds.top);
  const scanBottom = Math.min(height - 1, bounds.bottom);
  const threshold = 0.012;
  const runs: Array<{ start: number; end: number }> = [];
  let inRun = false;
  let start = scanLeft;

  for (let x = scanLeft; x <= scanRight; x++) {
    const density = columnInkDensity(data, width, height, x, scanTop, scanBottom);
    if (density <= threshold) {
      if (!inRun) {
        start = x;
        inRun = true;
      }
    } else if (inRun) {
      runs.push({ start, end: x - 1 });
      inRun = false;
    }
  }
  if (inRun) runs.push({ start, end: scanRight });

  const minGapWidth = Math.max(2, Math.round(width * 0.006));
  const internalRuns = mergeRuns(runs, Math.max(2, Math.round(width * 0.004)))
    .filter((r) => r.end - r.start + 1 >= minGapWidth)
    .filter((r) => r.start > scanLeft + width * 0.03 && r.end < scanRight - width * 0.03);

  if (internalRuns.length !== expected - 1) return null;

  const edges = [
    scanLeft,
    ...internalRuns.map((r) => Math.round((r.start + r.end) / 2)),
    scanRight + 1,
  ];
  const boundaries: Boundary[] = [];
  for (let i = 0; i < expected; i++) {
    boundaries.push({ left: edges[i], right: edges[i + 1] });
  }

  const widths = boundaries.map((b) => b.right - b.left);
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);
  const expectedRatios = entityType === 'non-human'
    ? Array(expected).fill(1 / expected)
    : [0.4, 0.2, 0.2, 0.2];
  const maxDev = Math.max(
    ...widths.map((w, i) => Math.abs(w / totalWidth - expectedRatios[i]) / expectedRatios[i]),
  );
  if (maxDev > 0.15) return null;

  return { boundaries, confidence: 0.9 };
}

function percentFallbackBoundaries(width: number, entityType: CharacterEntityType): Boundary[] {
  if (entityType === 'non-human') {
    return [
      { left: 0, right: Math.round(width / 3) },
      { left: Math.round(width / 3), right: Math.round((width * 2) / 3) },
      { left: Math.round((width * 2) / 3), right: width },
    ];
  }
  return [
    { left: 0, right: Math.round(width * 0.4) },
    { left: Math.round(width * 0.4), right: Math.round(width * 0.6) },
    { left: Math.round(width * 0.6), right: Math.round(width * 0.8) },
    { left: Math.round(width * 0.8), right: width },
  ];
}

function panelQuality(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  panel: PanelName,
): PanelQuality {
  let nonWhite = 0;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  const total = width * height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      if (!isWhiteLike(data[off], data[off + 1], data[off + 2], data[off + 3])) {
        nonWhite++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }

  const nonWhiteRatio = total > 0 ? nonWhite / total : 0;
  if (right < left || bottom < top) {
    return {
      nonWhiteRatio,
      bboxCoverage: 0,
      bboxCenterX: 0.5,
      bboxCenterY: 0.5,
      usable: false,
      reason: 'empty-panel',
    };
  }

  const bboxW = right - left + 1;
  const bboxH = bottom - top + 1;
  const bboxCoverage = (bboxW * bboxH) / total;
  const bboxCenterX = (left + bboxW / 2) / width;
  const bboxCenterY = (top + bboxH / 2) / height;

  const minInk = panel === 'headshot' ? 0.08 : 0.03;
  const minHeight = panel === 'headshot' ? 0.35 : 0.45;
  let reason = '';
  if (nonWhiteRatio < minInk) reason = 'too-much-white';
  else if (nonWhiteRatio > 0.85) reason = 'too-much-ink';
  else if (bboxH / height < minHeight) reason = 'subject-too-short';
  else if (Math.abs(bboxCenterX - 0.5) > 0.34) reason = 'subject-off-center';

  return {
    nonWhiteRatio,
    bboxCoverage,
    bboxCenterX,
    bboxCenterY,
    usable: !reason,
    reason: reason || undefined,
  };
}

function computeHeadshotVerticalCrop(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { top: number; height: number } {
  const targetH = Math.min(height, Math.max(1, Math.round(width * 0.85)));
  if (targetH >= height) return { top: 0, height };

  const bounds = detectContentBounds(data, width, height);
  if (!bounds) {
    return {
      top: Math.max(0, Math.round((height - targetH) / 2)),
      height: targetH,
    };
  }

  // Headshot panels are meant to stabilize face identity, so bias upward:
  // keep a small margin above the subject and crop away lower blank/body area.
  const marginTop = Math.round(targetH * 0.08);
  const preferredTop = bounds.top - marginTop;
  const maxTop = height - targetH;
  return {
    top: Math.max(0, Math.min(maxTop, preferredTop)),
    height: targetH,
  };
}

function publicUrlForImageId(id: string) {
  return `/api/images/file/${id}`;
}

function setPanelUrl(panels: CharacterPanelsMeta, panelName: PanelName, url: string) {
  switch (panelName) {
    case 'headshot':
      panels.headshotUrl = url;
      break;
    case 'front':
      panels.frontUrl = url;
      break;
    case 'side':
      panels.sideUrl = url;
      break;
    case 'back':
      panels.backUrl = url;
      break;
  }
}

async function loadCanvas() {
  const canvasMod: any = await import('@napi-rs/canvas').catch(() => null);
  if (!canvasMod || !canvasMod.createCanvas || !canvasMod.loadImage) {
    throw new Error('@napi-rs/canvas 不可用，无法切分角色设定板');
  }
  return canvasMod as {
    createCanvas: (width: number, height: number) => any;
    loadImage: (src: string | Buffer) => Promise<any>;
  };
}

export async function splitCharacterPanels(opts: {
  user: UserRow;
  projectId?: string | null;
  assetRef: string;
  sourceImageUrl: string;
  entityType: CharacterEntityType;
  prompt?: string;
  version?: number;
}): Promise<SplitCharacterPanelsResult> {
  try {
    const sourcePath = resolveLocalImagePath(opts.sourceImageUrl, opts.user.id);
    if (!sourcePath || !existsSync(sourcePath)) {
      return { ok: false, error: 'source image not found' };
    }

    const { createCanvas, loadImage } = await loadCanvas();
    const sourceImg = await loadImage(sourcePath);
    const width = sourceImg.width;
    const height = sourceImg.height;
    if (!width || !height) return { ok: false, error: 'invalid source image dimensions' };

    const sourceCanvas = createCanvas(width, height);
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.drawImage(sourceImg, 0, 0, width, height);
    const sourceData = sourceCtx.getImageData(0, 0, width, height).data as Uint8ClampedArray;

    const detected = detectPanelBoundaries(sourceData, width, height, opts.entityType);
    const cropMethod: CropMethod = detected ? 'pixel-detect' : 'percent-fallback';
    const confidence = detected ? detected.confidence : 0.5;
    const boundaries = detected?.boundaries || percentFallbackBoundaries(width, opts.entityType);
    const names = expectedPanelNames(opts.entityType);
    const sourceImageId = imageIdFromUrl(opts.sourceImageUrl);
    const ownerDir = join(IMAGES_DIR, String(opts.user.id));
    mkdirSync(ownerDir, { recursive: true });

    const panels: CharacterPanelsMeta = {
      schema: opts.entityType === 'non-human' ? 'non-human-character-sheet-v1' : 'human-character-sheet-v1',
      sourceImageId,
      sourceImageUrl: opts.sourceImageUrl,
      sheetUrl: opts.sourceImageUrl,
      cropMethod,
      confidence,
      version: opts.version || 1,
      generatedAt: new Date().toISOString(),
      quality: {},
    };
    const preparedPanels: PreparedPanel[] = [];

    for (let i = 0; i < names.length; i++) {
      const panelName = names[i];
      const b = boundaries[i];
      const cropLeft = Math.max(0, Math.min(width - 1, b.left));
      const cropRight = Math.max(cropLeft + 1, Math.min(width, b.right));
      const cropW = cropRight - cropLeft;
      const cropH = height;
      const cropCanvas = createCanvas(cropW, cropH);
      const cropCtx = cropCanvas.getContext('2d');
      cropCtx.fillStyle = '#ffffff';
      cropCtx.fillRect(0, 0, cropW, cropH);
      cropCtx.drawImage(sourceImg, cropLeft, 0, cropW, cropH, 0, 0, cropW, cropH);
      const initialData = cropCtx.getImageData(0, 0, cropW, cropH).data as Uint8ClampedArray;

      let finalCanvas = cropCanvas;
      let finalH = cropH;
      if (panelName === 'headshot') {
        const headCrop = computeHeadshotVerticalCrop(initialData, cropW, cropH);
        if (headCrop.top > 0 || headCrop.height < cropH) {
          const headCanvas = createCanvas(cropW, headCrop.height);
          const headCtx = headCanvas.getContext('2d');
          headCtx.fillStyle = '#ffffff';
          headCtx.fillRect(0, 0, cropW, headCrop.height);
          headCtx.drawImage(
            cropCanvas,
            0,
            headCrop.top,
            cropW,
            headCrop.height,
            0,
            0,
            cropW,
            headCrop.height,
          );
          finalCanvas = headCanvas;
          finalH = headCrop.height;
        }
      }

      const cropData = finalCanvas.getContext('2d').getImageData(0, 0, cropW, finalH).data as Uint8ClampedArray;
      const quality = panelQuality(cropData, cropW, finalH, panelName);
      panels.quality[panelName] = quality;
      if (!quality.usable) continue;

      preparedPanels.push({
        panelName,
        width: cropW,
        height: finalH,
        buffer: finalCanvas.toBuffer('image/png') as Buffer,
        quality,
      });
    }

    const usableCount = preparedPanels.length;
    const requiredCount = opts.entityType === 'non-human' ? 2 : 3;
    if (usableCount < requiredCount) {
      return {
        ok: false,
        error: `not enough usable panels (${usableCount}/${names.length})`,
      };
    }

    const db = getDb();
    const panelImageIds: string[] = [];
    for (const panel of preparedPanels) {
      const id = randomUUID();
      const filename = `${id}.png`;
      const fullPath = join(ownerDir, filename);
      writeFileSync(fullPath, panel.buffer);
      db.prepare(
        `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
         VALUES (?, ?, ?, 'character', ?, ?, 'image/png', ?, ?, ?, ?, 'character-panel')`,
      ).run(
        id,
        opts.user.id,
        opts.projectId || null,
        `${opts.assetRef}.panels.${panel.panelName}`,
        filename,
        panel.buffer.length,
        panel.width,
        panel.height,
        (opts.prompt || `character panel ${panel.panelName}`).slice(0, 4000),
      );
      panelImageIds.push(id);
      setPanelUrl(panels, panel.panelName, publicUrlForImageId(id));
    }

    return { ok: true, panels, panelImageIds };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function resolveCharacterPanelPaths(
  panels: CharacterPanelsMeta | undefined | null,
  ownerId: number,
): Partial<Record<PanelName | 'sheet', string>> {
  if (!panels) return {};
  const out: Partial<Record<PanelName | 'sheet', string>> = {};
  const urls: Array<[PanelName | 'sheet', string | undefined]> = [
    ['sheet', panels.sheetUrl],
    ['headshot', panels.headshotUrl],
    ['front', panels.frontUrl],
    ['side', panels.sideUrl],
    ['back', panels.backUrl],
  ];
  for (const [name, url] of urls) {
    const path = resolveLocalImagePath(url, ownerId);
    if (path) out[name] = path;
  }
  return out;
}

export function inferEntityTypeFromCharacter(ch: any): CharacterEntityType {
  if (ch?.entityType === 'non-human') return 'non-human';
  if (ch?.isNonHuman === true) return 'non-human';
  const typeText = [ch?.type, ch?.roleType, ch?.species, ch?.category].filter(Boolean).join(' ');
  if (/non[-\s]?human|anthropomorphic|creature|animal|mech|robot|非人|拟人|动物|机甲|机器人/i.test(typeText)) {
    return 'non-human';
  }
  return 'human';
}

export function existingPanelVersion(ch: any): number {
  const v = Number(ch?.panels?.version);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function buildDeprecatedPanelHistory(ch: any, nextVersion: number) {
  const prev = ch?.panels;
  const history = Array.isArray(ch?.panelHistory) ? [...ch.panelHistory] : [];
  if (prev && typeof prev === 'object') {
    const panelImageIds = ['headshotUrl', 'frontUrl', 'sideUrl', 'backUrl']
      .map((key) => imageIdFromUrl(prev[key]))
      .filter((id): id is string => Boolean(id));
    history.unshift({
      version: prev.version || Math.max(1, nextVersion - 1),
      sourceImageId: prev.sourceImageId || imageIdFromUrl(prev.sourceImageUrl || prev.sheetUrl),
      panelImageIds,
      deprecatedAt: new Date().toISOString(),
    });
  }
  return history.slice(0, 5);
}

export function applyCharacterPanelResult(
  character: any,
  result: SplitCharacterPanelsResult,
  failedAt = new Date().toISOString(),
) {
  if (result.ok) {
    return {
      ...(character || {}),
      panels: result.panels,
      panelHistory: buildDeprecatedPanelHistory(character, result.panels.version),
      panelsError: '',
      panelsErrorAt: '',
    };
  }
  return {
    ...(character || {}),
    panelsError: result.error,
    panelsErrorAt: failedAt,
  };
}
