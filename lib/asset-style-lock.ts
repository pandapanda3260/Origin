import { createHash } from 'node:crypto';
import { normalizeCastingProfile } from './casting-profile';

export type AssetStyleType = 'char' | 'scene' | 'prop';

export const STYLE_LOCK_VERSION = 3;

export const ASSET_STYLE_FIELDS: Record<AssetStyleType, string[]> = {
  char: [
    'visualStyle',
    'visualStyleDesc',
    'mood',
    'colorPalette',
    'lighting',
    'texture',
    'additionalPrompt',
    'negativePrompt',
    'castingProfile',
  ],
  scene: [
    'visualStyle',
    'visualStyleDesc',
    'mood',
    'colorPalette',
    'lighting',
    'texture',
    'cameraStyle',
    'era',
    'worldRules',
    'additionalPrompt',
    'negativePrompt',
  ],
  prop: ['visualStyle', 'colorPalette', 'texture', 'negativePrompt'],
};

export type AssetStyleLockContext = {
  prompt: string;
  signature: string;
  signatureType: AssetStyleType;
  styleLockVersion: number;
  hasMeaningfulStyle: boolean;
  resolvedBackdropColor?: string;
};

const COLD_BACKDROP = '#F4F6F8';
const WARM_BACKDROP = '#FAF8F4';
const DEFAULT_BACKDROP = '#FFFFFF';

const COLD_KEYWORDS = [
  '冷',
  '冷峻',
  '霓虹',
  '雨夜',
  '黑色电影',
  '雪夜',
  '夜戏',
  '冷调',
  '赛博',
  '金属',
  '医院',
];

const WARM_KEYWORDS = [
  '暖',
  '婚礼',
  '香槟',
  '黄昏',
  '夕阳',
  '篝火',
  '烛光',
  '金色',
  '胶片暖调',
  '温暖室内',
];

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

function styleValue(styleBible: any, key: string): any {
  if (!isRecord(styleBible)) return undefined;
  if (key === 'visualStyle') return styleBible.visualStyle || styleBible.vision;
  if (key === 'mood') return styleBible.mood || styleBible.tone;
  if (key === 'negativePrompt') return styleBible.negativePrompt || styleBible.videoNegativePrompt;
  return styleBible[key];
}

function paletteItems(value: any): Array<{ hex?: string; name?: string }> {
  const out: Array<{ hex?: string; name?: string }> = [];
  const add = (raw: any) => {
    if (!raw) return;
    if (typeof raw === 'string') {
      out.push({ name: raw.trim() });
      return;
    }
    if (isRecord(raw)) {
      const hex = cleanHex(raw.hex || raw.value || raw.color);
      const name = cleanText(raw.name || raw.label || raw.color || raw.value || raw.hex);
      if (hex || name) out.push({ ...(hex ? { hex } : {}), ...(name ? { name } : {}) });
    }
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (typeof value === 'string') value.split(/[、,，/|;]/).map((item) => item.trim()).filter(Boolean).forEach(add);
  else if (isRecord(value)) {
    const maybePalette = value.colorPalette || value.color_palette || value.palette || value.colors;
    if (maybePalette !== undefined) return paletteItems(maybePalette);
    Object.entries(value).forEach(([name, hex]) => add({ name, hex }));
  }
  return out;
}

function cleanHex(value: any): string | undefined {
  const raw = cleanText(value).replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return undefined;
  return `#${raw.toUpperCase()}`;
}

function hexRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = cleanHex(hex);
  if (!clean) return null;
  return {
    r: parseInt(clean.slice(1, 3), 16),
    g: parseInt(clean.slice(3, 5), 16),
    b: parseInt(clean.slice(5, 7), 16),
  };
}

export function isWhiteSafeBackdrop(hex: any): boolean {
  const rgb = hexRgb(cleanText(hex));
  return !!rgb && rgb.r >= 244 && rgb.g >= 244 && rgb.b >= 244;
}

// Currently unused for char path in STYLE_LOCK_VERSION 3; character
// backgrounds force #FFFFFF. Retained for future non-character or
// reintroduced near-white backdrop strategies.
function resolveBackdropColor(styleBible: any): string {
  for (const item of paletteItems(styleValue(styleBible, 'colorPalette'))) {
    if (item.hex && isWhiteSafeBackdrop(item.hex)) return item.hex;
  }
  const source = [
    styleValue(styleBible, 'visualStyle'),
    styleValue(styleBible, 'visualStyleDesc'),
    styleValue(styleBible, 'mood'),
    styleValue(styleBible, 'lighting'),
  ].map(cleanText).join(',').toLowerCase();
  const cold = COLD_KEYWORDS.some((keyword) => source.includes(keyword.toLowerCase()));
  if (cold) return COLD_BACKDROP;
  const warm = WARM_KEYWORDS.some((keyword) => source.includes(keyword.toLowerCase()));
  return warm ? WARM_BACKDROP : DEFAULT_BACKDROP;
}

function normalizeNegativePrompt(value: any): string[] {
  const raw = cleanText(value);
  if (!raw) return [];
  const seen = new Set<string>();
  return raw
    .toLowerCase()
    .replace(/[，。！？、；;,.!?()[\]{}"'`~:：]/g, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .sort()
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function normalizeSignatureValue(key: string, value: any): any {
  if (key === 'colorPalette') {
    return paletteItems(value)
      .map((item) => ({ hex: cleanHex(item.hex) || '', name: cleanText(item.name) }))
      .filter((item) => item.hex || item.name)
      .sort((a, b) => `${a.hex}|${a.name}`.localeCompare(`${b.hex}|${b.name}`));
  }
  if (key === 'negativePrompt') return normalizeNegativePrompt(value);
  if (key === 'castingProfile') return normalizeCastingProfile(value)?.ethnicityType || '';
  return cleanText(value);
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function signaturePayload(styleBible: any, type: AssetStyleType) {
  const fields = ASSET_STYLE_FIELDS[type] || [];
  const payload: Record<string, any> = { styleLockVersion: STYLE_LOCK_VERSION };
  for (const field of fields) {
    payload[field] = normalizeSignatureValue(field, styleValue(styleBible, field));
  }
  return payload;
}

export function assetStyleSignature(styleBible: any, type: AssetStyleType): string {
  return createHash('sha256').update(stableStringify(signaturePayload(styleBible, type))).digest('hex');
}

function hasMeaningfulStyle(styleBible: any, type: AssetStyleType): boolean {
  return (ASSET_STYLE_FIELDS[type] || []).some((field) => {
    const value = normalizeSignatureValue(field, styleValue(styleBible, field));
    return Array.isArray(value) ? value.length > 0 : cleanText(value).length > 0;
  });
}

function palettePrompt(styleBible: any): string {
  const palette = paletteItems(styleValue(styleBible, 'colorPalette'))
    .map((item) => `${item.hex || ''}${item.name ? ` (${item.name})` : ''}`.trim())
    .filter(Boolean)
    .join(', ');
  return palette;
}

export function buildAssetStyleLock(styleBible: any, type: AssetStyleType): AssetStyleLockContext {
  const signature = assetStyleSignature(styleBible, type);
  const meaningful = hasMeaningfulStyle(styleBible, type);
  const parts: string[] = [];
  const vs = cleanText(styleValue(styleBible, 'visualStyle'));
  const visualStyleDesc = cleanText(styleValue(styleBible, 'visualStyleDesc'));
  const mood = cleanText(styleValue(styleBible, 'mood'));
  const lighting = cleanText(styleValue(styleBible, 'lighting'));
  const texture = cleanText(styleValue(styleBible, 'texture'));
  const additionalPrompt = cleanText(styleValue(styleBible, 'additionalPrompt'));
  const negativePrompt = cleanText(styleValue(styleBible, 'negativePrompt'));
  const palette = palettePrompt(styleBible);
  const resolvedBackdropColor = type === 'char' ? DEFAULT_BACKDROP : undefined;

  if (vs) parts.push(`Project visual style: ${vs}.`);
  if (visualStyleDesc) parts.push(`Style detail: ${visualStyleDesc}`);
  if (palette && type !== 'char') parts.push(`Project color palette: ${palette}.`);
  if (mood) parts.push(`Overall mood: ${mood}`);
  if (lighting) {
    parts.push(type === 'char'
      ? `Lighting hint — apply ONLY to the character body: skin, hair, fabric, wetness response, edge light, contrast, and facial modeling. Background MUST stay pure white regardless of this hint: ${lighting}`
      : `Lighting direction to express on the subject: ${lighting}`);
  }
  if (texture) parts.push(`Texture and material direction: ${texture}`);

  if (type === 'char') {
    parts.push('Apply project style ONLY to the character subject. Do not render project locations, streets, rooms, rain environments, neon signs, color cards, palette swatches, or readable text.');
    parts.push('Apply the project style to the character body only: skin light response, wardrobe material, hair detail, color temperature, contrast, and grain. Do not turn the backdrop into a scene.');
  } else if (type === 'scene') {
    const era = cleanText(styleValue(styleBible, 'era'));
    const cameraStyle = cleanText(styleValue(styleBible, 'cameraStyle'));
    const worldRules = cleanText(styleValue(styleBible, 'worldRules')).slice(0, 240);
    if (era) parts.push(`Era & setting: ${era}`);
    if (cameraStyle) parts.push(`Camera language: ${cameraStyle}`);
    if (worldRules) parts.push(`World rules: ${worldRules}`);
    parts.push('All scene images in this project must look like they came from the same DP and the same color grading session.');
  } else {
    parts.push('Apply the project style to material, finish, wear, and surface texture without adding scene context.');
  }

  if (additionalPrompt) {
    parts.push(type === 'char'
      ? `Additional character-only style hint — apply ONLY to character rendering, wardrobe/material finish, natural skin texture, film grain, and performance mood. NEVER render it as background, location, signage, weather, props, swatches, or text: ${additionalPrompt}`
      : `Additional positive style prompt: ${additionalPrompt}`);
  }
  if (negativePrompt) parts.push(`Negative style constraints: ${negativePrompt}`);

  return {
    prompt: meaningful
      ? [
        type === 'char'
          ? '=== PROJECT CHARACTER STYLE LOCK (must match current project style bible) ==='
          : type === 'scene'
            ? '=== PROJECT STYLE BIBLE LOCK (every scene image in this project MUST share this exact look) ==='
            : '=== PROJECT PROP STYLE LOCK (must match current project style bible) ===',
        ...parts,
      ].join('\n')
      : '',
    signature,
    signatureType: type,
    styleLockVersion: STYLE_LOCK_VERSION,
    hasMeaningfulStyle: meaningful,
    resolvedBackdropColor,
  };
}

function assetHasImage(asset: any): boolean {
  if (!asset || typeof asset !== 'object') return false;
  const reference = asset.reference || {};
  return !!(
    reference.currentUrl ||
    reference.lastKnownGoodUrl ||
    asset.imageUrl ||
    asset.rawUrl ||
    asset.realPhotoUrl ||
    asset.pencilUrl
  );
}

export function computeAssetStyleStaleFlags(project: any): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  const assets = project?.assets || {};
  const groups: Array<{ type: AssetStyleType; key: string; items: any[] }> = [
    { type: 'char', key: 'characters', items: Array.isArray(assets.characters) ? assets.characters : [] },
    { type: 'scene', key: 'scenes', items: Array.isArray(assets.scenes) ? assets.scenes : [] },
    { type: 'prop', key: 'props', items: Array.isArray(assets.props) ? assets.props : [] },
  ];
  for (const group of groups) {
    const current = assetStyleSignature(project?.styleBible || {}, group.type);
    group.items.forEach((item, idx) => {
      if (!assetHasImage(item)) return;
      const stored = cleanText(item?.reference?.styleBibleSignature);
      if (stored !== current) flags[`asset_img_${group.type}_${idx}`] = true;
    });
  }
  return flags;
}
