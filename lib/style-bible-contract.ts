import {
  cleanStyleHex,
  mergeStyleBibleWithConstraints,
  normalizeLLMStyleBibleOutput,
  normalizePalette,
  type StyleConstraints,
} from './style-template-constraints';
import type { StyleBibleStageName } from './prompts';
import { normalizeCastingProfile } from './casting-profile';

export type StyleBibleValidationResult = {
  ok: boolean;
  missing: string[];
  invalid: string[];
};

export const STYLE_BIBLE_STAGE_FIELDS: Record<StyleBibleStageName, string[]> = {
  core: ['visualStyle', 'visualStyleDesc', 'era', 'mood', 'worldRules', 'castingProfile'],
  characters: ['characters'],
  visual: [
    'colorPalette',
    'cameraStyle',
    'compositionGuidance',
    'lighting',
    'texture',
    'negativePrompt',
    'additionalPrompt',
  ], // Legacy 5-stage field set; keep only for rollback/debug comparisons.
  visual_palette: ['colorPalette'],
  visual_prompts: ['negativePrompt', 'additionalPrompt'],
  visual_lens: ['cameraStyle', 'compositionGuidance', 'lighting', 'texture'],
  production: ['editingRhythm', 'audio', 'subtitleStyle', 'dialogueStyle'],
};

export const STYLE_BIBLE_REQUIRED_FINAL_FIELDS = [
  ...STYLE_BIBLE_STAGE_FIELDS.core,
  ...STYLE_BIBLE_STAGE_FIELDS.characters,
  ...STYLE_BIBLE_STAGE_FIELDS.visual_palette,
  ...STYLE_BIBLE_STAGE_FIELDS.visual_prompts,
  ...STYLE_BIBLE_STAGE_FIELDS.visual_lens,
  ...STYLE_BIBLE_STAGE_FIELDS.production,
  'aspectRatio',
];

export function mergeStyleBibleStageDraft(
  draft: any,
  stageOutput: any,
  opts: { aspectRatio?: string; stage?: StyleBibleStageName } = {},
) {
  const normalized = normalizeLLMStyleBibleOutput(stageOutput);
  const filtered = opts.stage
    ? pickAllowedStageFields(opts.stage, normalized)
    : normalized;
  const merged = {
    ...(isRecord(draft) ? draft : {}),
    ...filtered,
  };
  const aspectRatio = opts.stage
    ? normalizeAspectRatio((isRecord(draft) ? draft.aspectRatio : null) ?? opts.aspectRatio)
    : normalizeAspectRatio(merged.aspectRatio || opts.aspectRatio);
  if (aspectRatio) merged.aspectRatio = aspectRatio;
  return merged;
}

export function finalizeStyleBibleDraft(
  draft: any,
  constraints: StyleConstraints,
  opts: { aspectRatio?: string; userControls?: any } = {},
) {
  const merged = mergeStyleBibleWithConstraints(draft, constraints, opts.userControls || {});
  const aspectRatio = normalizeAspectRatio(merged.aspectRatio || opts.aspectRatio) || '9:16';
  return {
    ...merged,
    aspectRatio,
  };
}

export function validateStyleBibleStage(stage: StyleBibleStageName, value: any): StyleBibleValidationResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const data = isRecord(value) ? value : {};

  for (const field of STYLE_BIBLE_STAGE_FIELDS[stage] || []) {
    if (field === 'characters') {
      validateCharacters(data.characters, missing, invalid);
      continue;
    }
    if (field === 'castingProfile') {
      validateCastingProfile(data.castingProfile, missing, invalid);
      continue;
    }
    if (field === 'colorPalette') {
      validateColorPalette(data.colorPalette, missing, invalid);
      continue;
    }
    if (!nonEmptyText(data[field])) missing.push(field);
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

export function validateFinalStyleBible(value: any): StyleBibleValidationResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const data = isRecord(value) ? value : {};
  const seen = new Set<string>();

  for (const field of STYLE_BIBLE_REQUIRED_FINAL_FIELDS) {
    if (seen.has(field)) continue;
    seen.add(field);
    if (field === 'characters') {
      validateCharacters(data.characters, missing, invalid);
      continue;
    }
    if (field === 'castingProfile') {
      validateCastingProfile(data.castingProfile, missing, invalid);
      continue;
    }
    if (field === 'colorPalette') {
      validateColorPalette(data.colorPalette, missing, invalid);
      continue;
    }
    if (field === 'aspectRatio') {
      if (!normalizeAspectRatio(data.aspectRatio)) invalid.push('aspectRatio');
      continue;
    }
    if (!nonEmptyText(data[field])) missing.push(field);
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

function validateCastingProfile(value: any, missing: string[], invalid: string[]) {
  if (!value) {
    missing.push('castingProfile');
    return;
  }
  const profile = normalizeCastingProfile(value);
  if (!profile) {
    invalid.push('castingProfile');
    return;
  }
  if (!profile.ethnicityType) invalid.push('castingProfile.ethnicityType');
}

export function normalizeAspectRatio(value: any): '16:9' | '9:16' | '1:1' | null {
  const text = String(value || '').trim();
  if (text === '16:9' || text === '9:16' || text === '1:1') return text;
  return null;
}

function validateCharacters(value: any, missing: string[], invalid: string[]) {
  if (!Array.isArray(value) || value.length < 1) {
    missing.push('characters');
    return;
  }
  if (value.length > 6) invalid.push('characters.length');
  value.slice(0, 6).forEach((ch, index) => {
    const prefix = `characters[${index}]`;
    if (!isRecord(ch)) {
      invalid.push(prefix);
      return;
    }
    for (const field of ['name', 'appearance', 'clothing']) {
      if (!nonEmptyText(ch[field])) missing.push(`${prefix}.${field}`);
    }
  });
}

function validateColorPalette(value: any, missing: string[], invalid: string[]) {
  const palette = normalizePalette(value);
  if (palette.length < 5) {
    missing.push('colorPalette');
    return;
  }
  if (palette.length > 6) invalid.push('colorPalette.length');
  palette.slice(0, 6).forEach((item, index) => {
    if (!nonEmptyText(item.name)) missing.push(`colorPalette[${index}].name`);
    if (!cleanStyleHex(item.hex)) invalid.push(`colorPalette[${index}].hex`);
  });
}

function nonEmptyText(value: any): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickAllowedStageFields(stage: StyleBibleStageName, value: any) {
  const allowed = STYLE_BIBLE_STAGE_FIELDS[stage] || [];
  const source = isRecord(value) ? value : {};
  const picked: Record<string, any> = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      picked[field] = source[field];
    }
  }
  return picked;
}
