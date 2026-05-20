export type StylePaletteItem = {
  hex?: string;
  name: string;
};

export type StyleConstraints = {
  anchor: {
    colorPalette?: StylePaletteItem[];
    cameraStyle?: string;
    mood?: string;
    negativePrompt?: string;
    additionalPrompt?: string;
  };
  reference: {
    lighting?: string;
    texture?: string;
    editingRhythm?: string;
  };
  reserved: {
    audio?: string;
    subtitleStyle?: string;
    dialogueStyle?: string;
  };
};

const STYLE_COLOR_NAME_HEX: Record<string, string> = {
  雾灰: '#B7C0C7',
  霜白: '#F4F1EA',
  松墨: '#1D2A26',
  石棕: '#6E5747',
  朱砂: '#B54434',
  冷灰: '#8A8F98',
  冷白: '#F2F6F8',
  墨黑: '#121417',
  靛蓝: '#263F78',
  血红: '#8F1D22',
  深夜蓝黑: '#07111F',
  墨夜黑: '#090D12',
  暗红: '#5C171B',
  霓血红: '#D72638',
  赭金: '#B9853B',
  香槟金: '#D8C29D',
  雾白: '#E9EDF0',
  婚纱白: '#EEEAE4',
  雨幕青: '#7A8E91',
  雨夜黑: '#111821',
  猩红: '#C52E3A',
  暖金: '#C99A46',
  檀棕: '#5B3A2E',
  墨青: '#183532',
  鎏金: '#C9A04A',
  暖玉白: '#E8DDC8',
  深檀: '#3B241E',
  电蓝: '#1E6FFF',
  品红: '#C02A83',
  深紫: '#33245F',
  冷黑: '#0E1116',
  湿银: '#A9B4BB',
  奶油白: '#F2E8D3',
  浅木: '#C7A37A',
  晴空蓝: '#6BA7D9',
  草绿: '#6FA65B',
  暖灰: '#AAA29A',
  宣纸白: '#F3EEE1',
  远山青: '#6B8986',
  淡金: '#D6BD79',
  灰蓝: '#6E8195',
  荧光绿: '#7DFF6B',
  水泥灰: '#8B8B84',
  浅棕: '#A98263',
  自然肤: '#C99778',
  深棕: '#4D3025',
  冷蓝: '#4F7EA8',
  炭黑: '#151515',
  云白: '#F0F5F7',
  冰蓝: '#A8D8F0',
  玄青: '#142E39',
  灵紫: '#7856A6',
  檀木棕: '#5A3428',
  岩灰: '#767C7F',
  沙金: '#C6A159',
  晨光橙: '#E28B3C',
  暖黄: '#F1C45A',
  粉橙: '#F3A26C',
  深靛: '#1F3266',
  云粉: '#E6A8B7',
  暮蓝: '#3B5C8A',
  金橙: '#E49A2F',
  湖青: '#4C9C9A',
  钢蓝: '#466A8F',
  爆炸橙: '#F05A28',
  黑金: '#2A2113',
};

const STRING_FIELDS = [
  'visualStyle',
  'visualStyleDesc',
  'era',
  'mood',
  'cameraStyle',
  'lighting',
  'texture',
  'editingRhythm',
  'negativePrompt',
  'additionalPrompt',
  'audio',
  'subtitleStyle',
  'dialogueStyle',
  'worldRules',
  'compositionGuidance',
  'aspectRatio',
] as const;

const PROMPT_SPLIT_RE = /[,;；、]/;

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function scalarString(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

function nonEmpty(value: any): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function cleanStyleHex(value: any): string | undefined {
  const raw = scalarString(value).replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return undefined;
  return `#${raw.toUpperCase()}`;
}

export function styleColorHexForName(name: any): string | undefined {
  const key = scalarString(name).replace(/\s+/g, '');
  if (!key) return undefined;
  return STYLE_COLOR_NAME_HEX[key] || undefined;
}

function collectScalarLeaves(value: any): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(collectScalarLeaves);
  if (isRecord(value)) return Object.values(value).flatMap(collectScalarLeaves);
  const text = scalarString(value);
  return text ? [text] : [];
}

export function normalizePromptItems(value: any): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const leaf of collectScalarLeaves(value)) {
    for (const part of leaf.split(PROMPT_SPLIT_RE)) {
      const text = part.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push(text);
    }
  }
  return items;
}

export function joinPromptItems(...values: any[]): string {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    for (const item of normalizePromptItems(value)) {
      if (seen.has(item)) continue;
      seen.add(item);
      items.push(item);
    }
  }
  return items.join('；');
}

export function normalizePalette(value: any): StylePaletteItem[] {
  const out: StylePaletteItem[] = [];
  const add = (name: any, hex?: any) => {
    const cleanName = scalarString(name || hex);
    const clean = cleanStyleHex(hex) || styleColorHexForName(name);
    if (!cleanName && !clean) return;
    out.push({ ...(clean ? { hex: clean } : {}), name: cleanName || clean || '色彩' });
  };

  if (typeof value === 'string') {
    for (const item of value.split(PROMPT_SPLIT_RE)) add(item);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        add(item.name || item.label || item.color || item.value || item.hex, item.hex || item.value);
      } else {
        add(item);
      }
    }
  } else if (isRecord(value)) {
    const maybePalette = value.colorPalette || value.color_palette || value.palette || value.colors;
    if (maybePalette !== undefined) return normalizePalette(maybePalette);
    for (const [name, hex] of Object.entries(value)) add(name, hex);
  }

  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.name}|${item.hex || ''}`;
    if (!item.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeStringField(value: any): string | undefined {
  const text = scalarString(value);
  return text ? text : undefined;
}

function normalizeRuleText(value: any): string | undefined {
  const text = collectScalarLeaves(value).map((item) => item.trim()).filter(Boolean).join('；');
  return text || undefined;
}

function mergeClean(target: Record<string, any>, key: string, value: any) {
  if (value === undefined) return;
  if (key === 'colorPalette') {
    if (value === null) {
      target[key] = [];
      return;
    }
    const palette = normalizePalette(value);
    if (palette.length) target[key] = palette;
    return;
  }
  if (value === null) {
    target[key] = '';
    return;
  }
  const text = scalarString(value);
  if (text) target[key] = text;
}

export function normalizeStyleTemplateSnapshot(snapshot: any) {
  const raw = isRecord(snapshot) ? snapshot : {};
  const visual = raw.visual_rules || raw.visualRules || raw.visual || {};
  const edit = raw.edit_rules || raw.editRules || raw.edit || {};
  const prompt = raw.prompt_fragment || raw.promptFragment || raw.prompt || {};
  const styleBible = raw.styleBible || raw.style_bible || {};
  return { raw, visual, edit, prompt, styleBible };
}

export function styleTemplateHashOf(snapshot: any): string | null {
  if (!isRecord(snapshot)) return null;
  const id = scalarString(snapshot.id || snapshot.templateId || snapshot.template_id);
  if (!id) return null;
  const updatedAt = scalarString(snapshot.updatedAt || snapshot.updated_at || snapshot.modifiedAt || snapshot.modified_at);
  return `${id}:${updatedAt || ''}`;
}

export function buildStyleBibleConstraintsFromTemplate(snapshot: any): StyleConstraints {
  const { raw, visual, edit, prompt, styleBible } = normalizeStyleTemplateSnapshot(snapshot);
  const colorPalette = normalizePalette(
    visual.color_palette ?? visual.colorPalette ?? raw.colorPalette ?? styleBible.colorPalette,
  );
  const negativePrompt = joinPromptItems(
    raw.negative_rules,
    raw.negativeRules,
    prompt.negative_prompt,
    prompt.negativePrompt,
    raw.negativePrompt,
    styleBible.negativePrompt,
  );
  const additionalPrompt = joinPromptItems(
    prompt.positive_prompt,
    prompt.positivePrompt,
    raw.additionalPrompt,
    styleBible.additionalPrompt,
  );
  const editingRhythm = normalizeRuleText([edit.pace, edit.transition, raw.editingRhythm, styleBible.editingRhythm]);

  return {
    anchor: {
      ...(colorPalette.length ? { colorPalette } : {}),
      ...(normalizeStringField(visual.camera ?? visual.cameraStyle ?? raw.cameraStyle ?? styleBible.cameraStyle)
        ? { cameraStyle: normalizeStringField(visual.camera ?? visual.cameraStyle ?? raw.cameraStyle ?? styleBible.cameraStyle) }
        : {}),
      ...(normalizeStringField(edit.mood ?? raw.mood ?? styleBible.mood ?? styleBible.tone)
        ? { mood: normalizeStringField(edit.mood ?? raw.mood ?? styleBible.mood ?? styleBible.tone) }
        : {}),
      ...(negativePrompt ? { negativePrompt } : {}),
      ...(additionalPrompt ? { additionalPrompt } : {}),
    },
    reference: {
      ...(normalizeStringField(visual.lighting ?? raw.lighting ?? styleBible.lighting)
        ? { lighting: normalizeStringField(visual.lighting ?? raw.lighting ?? styleBible.lighting) }
        : {}),
      ...(normalizeStringField(visual.texture ?? raw.texture ?? styleBible.texture)
        ? { texture: normalizeStringField(visual.texture ?? raw.texture ?? styleBible.texture) }
        : {}),
      ...(editingRhythm ? { editingRhythm } : {}),
    },
    reserved: {
      ...(normalizeRuleText(raw.music_rules ?? raw.musicRules ?? styleBible.audio ?? styleBible.audioStyle)
        ? { audio: normalizeRuleText(raw.music_rules ?? raw.musicRules ?? styleBible.audio ?? styleBible.audioStyle) }
        : {}),
      ...(normalizeRuleText(raw.subtitle_rules ?? raw.subtitleRules ?? styleBible.subtitleStyle)
        ? { subtitleStyle: normalizeRuleText(raw.subtitle_rules ?? raw.subtitleRules ?? styleBible.subtitleStyle) }
        : {}),
      ...(normalizeRuleText(raw.dialogue_rules ?? raw.dialogueRules ?? raw.dialogueStyle ?? styleBible.dialogueStyle ?? styleBible.narrationStyle ?? styleBible.voiceoverStyle ?? styleBible.dialogueRules)
        ? { dialogueStyle: normalizeRuleText(raw.dialogue_rules ?? raw.dialogueRules ?? raw.dialogueStyle ?? styleBible.dialogueStyle ?? styleBible.narrationStyle ?? styleBible.voiceoverStyle ?? styleBible.dialogueRules) }
        : {}),
    },
  };
}

export function normalizeLLMStyleBibleOutput(styleBible: any) {
  const raw = isRecord(styleBible) ? styleBible : {};
  const out: Record<string, any> = { ...raw };

  for (const key of STRING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    out[key] = scalarString(raw[key]);
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'colorPalette')) {
    out.colorPalette = normalizePalette(raw.colorPalette);
  }
  if (!scalarString(out.dialogueStyle)) {
    const dialogueStyle = normalizeRuleText(
      raw.dialogueStyle ?? raw.narrationStyle ?? raw.voiceoverStyle ?? raw.dialogueRules,
    );
    if (dialogueStyle) out.dialogueStyle = dialogueStyle;
  }

  if (Array.isArray(raw.characters)) {
    out.characters = raw.characters
      .filter(isRecord)
      .map((ch) => {
        const next: Record<string, string> = {};
        for (const key of ['name', 'role', 'appearance', 'clothing', 'description', 'desc', 'avatarUrl', 'imageUrl', 'referenceImageUrl']) {
          const value = scalarString(ch[key]);
          if (value) next[key] = value;
        }
        return next;
      })
      .filter((ch) => Object.keys(ch).length > 0);
  } else if (Object.prototype.hasOwnProperty.call(raw, 'characters')) {
    out.characters = [];
  }

  return out;
}

export function normalizeAnchoredColorPalette(generated: any, anchor: StylePaletteItem[]): StylePaletteItem[] {
  const llm = normalizePalette(generated);
  const anchored = normalizePalette(anchor);
  if (!anchored.length) return llm;
  const total = Math.max(anchored.length, llm.length);
  const out: StylePaletteItem[] = [];
  for (let i = 0; i < total; i += 1) {
    const anchorItem = anchored[i];
    const llmItem = llm[i];
    const name = scalarString(anchorItem?.name) || scalarString(llmItem?.name) || `色彩${i + 1}`;
    const hex = cleanStyleHex(llmItem?.hex)
      || cleanStyleHex(anchorItem?.hex)
      || styleColorHexForName(name)
      || styleColorHexForName(llmItem?.name);
    out.push({ ...(hex ? { hex } : {}), name });
  }
  return out.filter((item) => item.name || item.hex);
}

export function mergeStyleBibleWithConstraints(styleBible: any, constraints: StyleConstraints, userControls: any = {}) {
  const sb: Record<string, any> = normalizeLLMStyleBibleOutput(styleBible);
  const anchor = constraints?.anchor || {};
  const reference = constraints?.reference || {};
  const reserved = constraints?.reserved || {};

  for (const key of ['lighting', 'texture', 'editingRhythm'] as const) {
    if (!scalarString(sb[key]) && nonEmpty(reference[key])) sb[key] = reference[key];
  }
  for (const key of ['audio', 'subtitleStyle', 'dialogueStyle'] as const) {
    if (!scalarString(sb[key]) && nonEmpty(reserved[key])) sb[key] = reserved[key];
  }

  if (Array.isArray(anchor.colorPalette) && anchor.colorPalette.length) {
    sb.colorPalette = normalizeAnchoredColorPalette(sb.colorPalette, anchor.colorPalette);
  }
  if (nonEmpty(anchor.cameraStyle)) sb.cameraStyle = anchor.cameraStyle;
  if (nonEmpty(anchor.mood)) sb.mood = anchor.mood;
  if (nonEmpty(anchor.negativePrompt)) sb.negativePrompt = anchor.negativePrompt;
  if (nonEmpty(anchor.additionalPrompt)) sb.additionalPrompt = anchor.additionalPrompt;

  const controls = isRecord(userControls) ? userControls : {};
  for (const key of ['visualStyle', 'visualStyleDesc', 'era', 'mood', 'cameraStyle', 'lighting', 'texture', 'editingRhythm', 'audio', 'subtitleStyle', 'dialogueStyle'] as const) {
    if (!Object.prototype.hasOwnProperty.call(controls, key)) continue;
    mergeClean(sb, key, controls[key]);
  }
  if (Object.prototype.hasOwnProperty.call(controls, 'colorPalette')) mergeClean(sb, 'colorPalette', controls.colorPalette);
  if (Object.prototype.hasOwnProperty.call(controls, 'negativePrompt')) {
    if (controls.negativePrompt === null) sb.negativePrompt = '';
    else if (scalarString(controls.negativePrompt)) sb.negativePrompt = joinPromptItems(sb.negativePrompt, controls.negativePrompt);
  }
  if (Object.prototype.hasOwnProperty.call(controls, 'additionalPrompt')) {
    if (controls.additionalPrompt === null) sb.additionalPrompt = '';
    else if (scalarString(controls.additionalPrompt)) sb.additionalPrompt = joinPromptItems(sb.additionalPrompt, controls.additionalPrompt);
  }
  if (Object.prototype.hasOwnProperty.call(controls, 'styleIntensity')) {
    const n = Number(controls.styleIntensity);
    if (Number.isFinite(n)) sb.styleIntensity = Math.max(0, Math.min(100, n));
  }

  return sb;
}
