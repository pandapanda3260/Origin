export type CastingEthnicityType =
  | 'han_chinese'
  | 'east_asian'
  | 'caucasian'
  | 'mixed'
  | 'unspecified';

export type CastingProfile = {
  ethnicityType: CastingEthnicityType;
};

export type CastingPreset = {
  labelZh: string;
  positiveEn: string;
  negativeEn: string;
};

export const CASTING_ETHNICITY_TYPES: CastingEthnicityType[] = [
  'han_chinese',
  'east_asian',
  'caucasian',
  'mixed',
  'unspecified',
];

export const CASTING_PRESETS: Record<CastingEthnicityType, CastingPreset> = {
  han_chinese: {
    labelZh: '中国人 / 汉族华人外观',
    positiveEn: 'Han Chinese person, Chinese facial features, East Asian facial structure, natural warm skin tone, dark hair, dark eyes',
    negativeEn: 'Caucasian face, European facial features, blonde hair, blue eyes, deep-set eyes, western model face',
  },
  east_asian: {
    labelZh: '东亚人物外观',
    positiveEn: 'East Asian person, East Asian facial features, natural skin tone, dark hair, dark eyes',
    negativeEn: 'Caucasian face, European facial features, blonde hair, blue eyes, deep-set eyes',
  },
  caucasian: {
    labelZh: '欧美白人外观',
    positiveEn: 'Caucasian person, European facial features, fair skin, varied hair color, light or dark eyes',
    negativeEn: '',
  },
  mixed: {
    labelZh: '混血人物外观',
    positiveEn: 'mixed ethnicity person, natural realistic facial features',
    negativeEn: '',
  },
  unspecified: {
    labelZh: '不限定人物外观',
    positiveEn: '',
    negativeEn: '',
  },
};

const CASTING_ALIASES: Record<string, CastingEthnicityType> = {
  hanchinese: 'han_chinese',
  han_chinese: 'han_chinese',
  han: 'han_chinese',
  chinese: 'han_chinese',
  chinesehan: 'han_chinese',
  han族: 'han_chinese',
  汉族: 'han_chinese',
  中国: 'han_chinese',
  中国人: 'han_chinese',
  华人: 'han_chinese',
  eastasian: 'east_asian',
  east_asian: 'east_asian',
  asian: 'east_asian',
  东亚: 'east_asian',
  东亚人: 'east_asian',
  caucasian: 'caucasian',
  white: 'caucasian',
  european: 'caucasian',
  europe: 'caucasian',
  欧美: 'caucasian',
  白人: 'caucasian',
  欧美白人: 'caucasian',
  mixed: 'mixed',
  mixedethnicity: 'mixed',
  mixed_ethnicity: 'mixed',
  混血: 'mixed',
  unspecified: 'unspecified',
  unknown: 'unspecified',
  none: 'unspecified',
  不限定: 'unspecified',
  未指定: 'unspecified',
  未知: 'unspecified',
};

export function normalizeCastingEthnicityType(value: any): CastingEthnicityType {
  if (value === undefined || value === null) return 'unspecified';
  const raw = String(value).trim();
  if (!raw) return 'unspecified';
  const compact = raw
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5]/g, '');
  if (CASTING_ALIASES[compact]) return CASTING_ALIASES[compact];
  const noUnderscore = compact.replace(/_/g, '');
  if (CASTING_ALIASES[noUnderscore]) return CASTING_ALIASES[noUnderscore];
  return 'unspecified';
}

export function normalizeCastingProfile(value: any): CastingProfile | null {
  if (!value) return null;
  const source = typeof value === 'object' && !Array.isArray(value) ? value : null;
  const rawType = source
    ? source.ethnicityType
      ?? source.ethnicity_type
      ?? source.type
      ?? source.ethnicity
      ?? source.defaultEthnicity
    : value;
  if (rawType === undefined || rawType === null || String(rawType).trim() === '') return null;
  const ethnicityType = normalizeCastingEthnicityType(rawType);
  return { ethnicityType };
}

export function castingPresetFor(value: any): CastingPreset {
  return CASTING_PRESETS[normalizeCastingEthnicityType(value)];
}

export function omitCastingProfileFromStyleBible<T = any>(styleBible: T): T {
  if (!styleBible || typeof styleBible !== 'object' || Array.isArray(styleBible)) return styleBible;
  const { castingProfile: _castingProfile, ...rest } = styleBible as any;
  return rest as T;
}

export function styleBibleForCharacterAsset<T = any>(styleBible: T): T {
  return styleBible;
}

export function styleBibleForShotPrompt<T = any>(styleBible: T): T {
  return omitCastingProfileFromStyleBible(styleBible);
}

export function styleBibleForScenePrompt<T = any>(styleBible: T): T {
  return omitCastingProfileFromStyleBible(styleBible);
}

export function styleBibleForVideoPrompt<T = any>(styleBible: T): T {
  return omitCastingProfileFromStyleBible(styleBible);
}

export function isMostlyChineseText(text: any): boolean {
  const value = String(text || '');
  const chinese = (value.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (value.match(/[a-zA-Z]/g) || []).length;
  return chinese >= 12 && chinese >= latin * 2;
}

export function hasWesternSettingSignal(...values: any[]): boolean {
  const text = values.map((value) => String(value || '')).join(' ');
  return /海外|欧美|美国|英国|欧洲|伦敦|纽约|巴黎|异国|跨国|外国主角|western|europe|america|new york|london|paris/i.test(text);
}

export function inferFallbackCastingProfile(input: { script?: any }): CastingProfile {
  const script = String(input?.script || '');
  if (isMostlyChineseText(script) && !hasWesternSettingSignal(script)) return { ethnicityType: 'han_chinese' };
  return { ethnicityType: 'unspecified' };
}

export function hasObviousForeignSignal(character: any): boolean {
  if (!character || typeof character !== 'object') return false;
  const text = [
    character.role,
    character.identity,
    character.appearance,
    character.description,
    character.desc,
    character.tags,
  ].flat().filter(Boolean).join(' ');
  const name = String(character.name || '').trim();
  // Deliberately broad: P0 prefers protecting possible foreign roles from global casting over false precision.
  const hasIdentity = /外国\S*|国外\S*|欧美\S*|美国\S*|英国\S*|法国\S*|欧洲\S*|洋人|外籍|foreigner|american|european|british|french/i.test(text);
  const englishNameWithForeignIdentity = /^[A-Za-z][A-Za-z\s'.-]{1,40}$/.test(name) && /外国|外籍|欧美|foreigner|european|american/i.test(text);
  return hasIdentity || englishNameWithForeignIdentity;
}

export function fallbackForeignProtection(character: any): CastingEthnicityType | undefined {
  if (hasObviousForeignSignal(character)) return 'unspecified';
  return undefined;
}

export function isNonHumanCharacter(character: any): boolean {
  const text = String(character?.entityType || character?.identityLock?.entityType || '').trim().toLowerCase();
  return text === 'non-human' || text === 'nonhuman' || text.includes('非人');
}

export function effectiveCharacterCasting(
  character: any,
  styleBible: any,
  fallback?: CastingProfile | null,
): CastingEthnicityType {
  const override = normalizeCastingProfile(character?.castingOverride || character?.casting_override);
  if (override) return override.ethnicityType;
  const protectedType = fallbackForeignProtection(character);
  if (protectedType) return protectedType;
  const profile = normalizeCastingProfile(styleBible?.castingProfile || styleBible?.casting_profile);
  if (profile) return profile.ethnicityType;
  if (fallback) return fallback.ethnicityType;
  return 'unspecified';
}

export function formatCastingLockPrompt(type: CastingEthnicityType): string {
  const preset = CASTING_PRESETS[type];
  return preset.positiveEn ? `Casting lock: ${preset.positiveEn}.` : '';
}

export function formatCastingNegativePrompt(type: CastingEthnicityType): string {
  return CASTING_PRESETS[type].negativeEn || '';
}

export function formatCharacterCastingPromptBlock(
  character: any,
  styleBible: any,
  opts: { script?: any } = {},
): string {
  if (isNonHumanCharacter(character)) {
    return [
      '=== NON-HUMAN CHARACTER CASTING LOCK (authoritative subject baseline) ===',
      'Subject lock: non-human subject only. Preserve the species, body plan, scale, shell/fur/skin/material surface, limb count, posture, and natural movement cues from the role, identity, appearance, clothing, and equipment fields.',
      'Subject negative prompt: no human, no humanoid body, no human face portrait, no suit, no shirt, no bow tie, no dress, no shoes, no human hands, no human hairstyle, no anthropomorphic expression unless explicitly requested.',
    ].join('\n');
  }
  const fallback = normalizeCastingProfile(styleBible?.castingProfile || styleBible?.casting_profile)
    || inferFallbackCastingProfile({ script: opts.script });
  const type = effectiveCharacterCasting(character, styleBible, fallback);
  const positive = formatCastingLockPrompt(type);
  const negative = formatCastingNegativePrompt(type);
  const lines = [
    positive,
    negative ? `Casting negative prompt: ${negative}.` : '',
  ].filter(Boolean);
  if (!lines.length) return '';
  return [
    '=== CHARACTER CASTING LOCK (authoritative ethnicity/face baseline) ===',
    ...lines,
  ].join('\n');
}

export function appendCharacterCastingPrompt(
  prompt: any,
  character: any,
  styleBible: any,
  opts: { script?: any } = {},
): string {
  const base = String(prompt || '').trim();
  const block = formatCharacterCastingPromptBlock(character, styleBible, opts);
  if (!block) return base;
  if (base.includes('CHARACTER CASTING LOCK') || base.includes('Casting lock:')) return base;
  return [base, block].filter(Boolean).join('\n\n');
}
