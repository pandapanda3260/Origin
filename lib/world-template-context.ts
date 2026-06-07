export type WorldContext = {
  era?: string;
  setting?: {
    era?: string;
    geography?: string;
    society?: string;
    powerSystem?: string;
    rules?: string[];
  };
  worldRules?: string[];
  storyRules?: {
    allowedConflicts?: string[];
    forbiddenPlots?: string[];
    toneBoundaries?: string[];
  };
  characterCandidates?: Array<{
    name?: string;
    role?: string;
    appearance?: string;
    hardFacts?: string[];
    softDefaults?: string[];
  }>;
  locations?: string[];
  props?: string[];
  terminology?: Record<string, string>;
  forbiddenRules?: string[];
  hardFacts?: string[];
  softDefaults?: string[];
};

export type WorldContextProjectionStage =
  | 'script_create'
  | 'script_continue'
  | 'episode_create'
  | 'style_bible'
  | 'assets_extract'
  | 'shots_generate'
  | 'storyboard_sketch_prompt'
  | 'first_frame_image'
  | 'tail_frame_image'
  | 'video_prompt'
  | 'video_prompt_refine'
  | 'video_submit'
  | 'edit_analyze'
  | 'edit_edl'
  | 'export'
  | string;

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

function uniqueStrings(values: any, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (value: any) => {
    if (out.length >= max || value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) {
      const text = scalarString(value.name || value.title || value.label || value.summary || value.description || value.detail);
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
      return;
    }
    const text = scalarString(value);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  visit(values);
  return out;
}

function fieldStrength(item: any, field: string, fallback: 'hard' | 'soft'): 'hard' | 'soft' {
  const meta = isRecord(item?.fieldMeta) && isRecord(item.fieldMeta[field]) ? item.fieldMeta[field] : null;
  const strength = scalarString(meta?.strength).toLowerCase();
  if (strength === 'hard') return 'hard';
  if (strength === 'soft') return 'soft';
  return fallback;
}

const CHARACTER_VISUAL_HARD_FIELDS = new Set(['appearance', 'detail', 'description', 'desc', 'scaleRule', 'negativeRules', 'signatureColors', 'canonicalPrompt']);

function characterVisualFieldFallback(field: string): 'hard' | 'soft' {
  return CHARACTER_VISUAL_HARD_FIELDS.has(field) ? 'hard' : 'soft';
}

function pushFact(target: { hard: string[]; soft: string[] }, strength: 'hard' | 'soft', value: string) {
  const text = scalarString(value);
  if (!text) return;
  const list = strength === 'hard' ? target.hard : target.soft;
  if (!list.includes(text)) list.push(text);
}

function compactJoin(values: any[], maxLen = 800): string | undefined {
  const text = uniqueStrings(values, 20).join('；').slice(0, maxLen).trim();
  return text || undefined;
}

function normalizeCharacters(values: any): WorldContext['characterCandidates'] {
  if (!Array.isArray(values)) return undefined;
  const out: NonNullable<WorldContext['characterCandidates']> = [];
  for (const item of values) {
    if (!isRecord(item)) continue;
    const name = scalarString(item.name || item.role || item.title);
    const role = scalarString(item.role || item.identity || item.type);
    const appearance = compactJoin([item.appearance, item.clothing, item.description, item.desc], 260);
    if (!name && !role && !appearance) continue;
    const characterFacts = { hard: [] as string[], soft: [] as string[] };
    pushFact(characterFacts, 'hard', [name, role].filter(Boolean).join(' / '));
    for (const field of ['appearance', 'clothing', 'equipment', 'description', 'desc']) {
      const text = scalarString((item as any)[field]);
      if (text) pushFact(characterFacts, fieldStrength(item, field, characterVisualFieldFallback(field)), `${name || role || '角色'} ${field}：${text}`);
    }
    out.push({
      ...(name ? { name } : {}),
      ...(role && role !== name ? { role } : {}),
      ...(appearance ? { appearance } : {}),
      ...(characterFacts.hard.length ? { hardFacts: characterFacts.hard } : {}),
      ...(characterFacts.soft.length ? { softDefaults: characterFacts.soft } : {}),
    });
    if (out.length >= 10) break;
  }
  return out.length ? out : undefined;
}

function normalizeTerminology(value: any): Record<string, string> | undefined {
  if (!value) return undefined;
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        const key = scalarString(item.term || item.name || item.title || item.key);
        const desc = scalarString(item.meaning || item.description || item.value || item.desc);
        if (key) out[key] = desc || key;
      } else {
        const text = scalarString(item);
        if (text) out[text] = text;
      }
    }
  } else if (isRecord(value)) {
    for (const [key, desc] of Object.entries(value)) {
      const cleanKey = scalarString(key);
      const cleanDesc = scalarString(desc);
      if (cleanKey) out[cleanKey] = cleanDesc || cleanKey;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function summarizeEntityFacts(label: string, values: any, defaultStrength: 'hard' | 'soft', max = 10) {
  const facts = { hard: [] as string[], soft: [] as string[] };
  if (!Array.isArray(values)) return facts;
  for (const item of values) {
    if (!isRecord(item)) continue;
    const name = scalarString(item.name || item.title || item.role || item.id || item.characterId);
    if (!name) continue;
    const baseFields = label === '角色'
      ? ['role', 'identity', 'entityType', 'species']
      : ['description', 'detail', 'summary', 'function', 'ownership', 'visualFeatures', 'atmosphere'];
    const identityParts = baseFields.map((field) => scalarString(item[field])).filter(Boolean);
    if (identityParts.length) pushFact(facts, label === '角色' ? 'hard' : defaultStrength, `${label}：${name}（${identityParts.join('；')}）`);
    if (label === '角色') {
      if (facts.hard.length + facts.soft.length >= max) break;
      continue;
    }
    for (const field of ['appearance', 'clothing', 'equipment', 'scaleRule', 'temperament', 'actionTraits', 'description', 'detail', 'atmosphere', 'function', 'ownership', 'visualFeatures']) {
      const text = scalarString(item[field]);
      if (!text) continue;
      pushFact(facts, fieldStrength(item, field, defaultStrength), `${label}默认：${name} ${field}=${text}`);
    }
    if (facts.hard.length + facts.soft.length >= max) break;
  }
  return facts;
}

export function buildWorldContextFromSnapshot(snapshot: any): WorldContext {
  const raw = isRecord(snapshot) ? snapshot : {};
  const worldRulesRaw = raw.world_rules || raw.worldRules || raw.rules || raw.setting || {};
  const era = compactJoin([
    raw.era,
    raw.period,
    raw.geography,
    raw.summary,
    isRecord(worldRulesRaw) ? worldRulesRaw.era : undefined,
    isRecord(worldRulesRaw) ? worldRulesRaw.geography : undefined,
  ], 600);
  const worldRules = uniqueStrings([
    raw.worldRules,
    raw.world_rules,
    raw.power_system,
    raw.powerSystem,
    raw.society_structure,
    raw.societyStructure,
    raw.plot_rules,
    raw.plotRules,
    isRecord(worldRulesRaw) ? Object.values(worldRulesRaw) : worldRulesRaw,
  ], 14);
  const forbiddenRules = uniqueStrings([raw.forbidden_rules, raw.forbiddenRules, raw.forbidden], 12);
  const settingRaw = isRecord(raw.setting) ? raw.setting : {};
  const settingRules = uniqueStrings([settingRaw.rules, settingRaw.worldRules], 12);
  const setting = {
    ...(scalarString(settingRaw.era || raw.era || raw.period) ? { era: scalarString(settingRaw.era || raw.era || raw.period) } : {}),
    ...(scalarString(settingRaw.geography || raw.geography) ? { geography: scalarString(settingRaw.geography || raw.geography) } : {}),
    ...(scalarString(settingRaw.society || raw.society || raw.societyStructure) ? { society: scalarString(settingRaw.society || raw.society || raw.societyStructure) } : {}),
    ...(scalarString(settingRaw.powerSystem || settingRaw.power_system || raw.powerSystem || raw.power_system) ? { powerSystem: scalarString(settingRaw.powerSystem || settingRaw.power_system || raw.powerSystem || raw.power_system) } : {}),
    ...(settingRules.length ? { rules: settingRules } : {}),
  };
  const storyRulesRaw = isRecord(raw.storyRules || raw.story_rules) ? (raw.storyRules || raw.story_rules) : {};
  const storyRules = {
    allowedConflicts: uniqueStrings([storyRulesRaw.allowedConflicts, storyRulesRaw.allowed_conflicts, raw.allowedConflicts], 10),
    forbiddenPlots: uniqueStrings([storyRulesRaw.forbiddenPlots, storyRulesRaw.forbidden_plots, raw.forbiddenPlots], 10),
    toneBoundaries: uniqueStrings([storyRulesRaw.toneBoundaries, storyRulesRaw.tone_boundaries, raw.toneBoundaries], 10),
  };
  const locations = uniqueStrings([raw.locations, raw.scenes, raw.environments, raw.places], 12);
  const props = uniqueStrings([raw.props, raw.items, raw.keyItems, raw.artifacts], 12);
  const characterCandidates = normalizeCharacters(raw.characters || raw.characterCandidates);
  const terminology = normalizeTerminology(raw.terminology || raw.terms || raw.titles);
  const semanticFacts = { hard: [] as string[], soft: [] as string[] };
  if (era) pushFact(semanticFacts, 'hard', `时代/世界背景：${era}`);
  if (Object.keys(setting).length) {
    const settingParts = [
      setting.era ? `时代=${setting.era}` : '',
      setting.geography ? `地理=${setting.geography}` : '',
      setting.society ? `社会=${setting.society}` : '',
      setting.powerSystem ? `规则体系=${setting.powerSystem}` : '',
      setting.rules?.length ? `基础规则=${setting.rules.join('；')}` : '',
    ].filter(Boolean);
    if (settingParts.length) pushFact(semanticFacts, 'hard', `世界设定：${settingParts.join('；')}`);
  }
  if (worldRules.length || settingRules.length) pushFact(semanticFacts, 'hard', `世界规则：${uniqueStrings([worldRules, settingRules], 16).join('；')}`);
  if (storyRules.allowedConflicts.length) pushFact(semanticFacts, 'soft', `允许冲突：${storyRules.allowedConflicts.join('；')}`);
  if (storyRules.forbiddenPlots.length) pushFact(semanticFacts, 'hard', `禁止剧情：${storyRules.forbiddenPlots.join('；')}`);
  if (storyRules.toneBoundaries.length) pushFact(semanticFacts, 'hard', `语气边界：${storyRules.toneBoundaries.join('；')}`);
  if (forbiddenRules.length) pushFact(semanticFacts, 'hard', `世界观禁忌：${forbiddenRules.join('；')}`);
  if (terminology) pushFact(semanticFacts, 'hard', `术语/称谓：${JSON.stringify(terminology)}`);
  const characterFacts = summarizeEntityFacts('角色', raw.characters || raw.characterCandidates, 'soft', 18);
  const locationFacts = summarizeEntityFacts('地点', raw.locations || raw.scenes || raw.environments || raw.places, 'soft', 10);
  const propFacts = summarizeEntityFacts('道具', raw.props || raw.items || raw.keyItems || raw.artifacts, 'soft', 10);
  semanticFacts.hard.push(...characterFacts.hard, ...locationFacts.hard, ...propFacts.hard);
  semanticFacts.soft.push(...characterFacts.soft, ...locationFacts.soft, ...propFacts.soft);
  for (const ch of characterCandidates || []) {
    semanticFacts.hard.push(...((ch as any).hardFacts || []));
    semanticFacts.soft.push(...((ch as any).softDefaults || []));
  }
  const context: WorldContext = {
    ...(era ? { era } : {}),
    ...(Object.keys(setting).length ? { setting } : {}),
    ...(worldRules.concat(settingRules).length ? { worldRules: uniqueStrings([worldRules, settingRules], 16) } : {}),
    ...(storyRules.allowedConflicts.length || storyRules.forbiddenPlots.length || storyRules.toneBoundaries.length ? { storyRules } : {}),
    ...(characterCandidates ? { characterCandidates } : {}),
    ...(locations.length ? { locations } : {}),
    ...(props.length ? { props } : {}),
    ...(terminology ? { terminology } : {}),
    ...(forbiddenRules.concat(storyRules.forbiddenPlots, storyRules.toneBoundaries).length
      ? { forbiddenRules: uniqueStrings([forbiddenRules, storyRules.forbiddenPlots, storyRules.toneBoundaries], 18) }
      : {}),
    ...(semanticFacts.hard.length ? { hardFacts: uniqueStrings(semanticFacts.hard, 24) } : {}),
    ...(semanticFacts.soft.length ? { softDefaults: uniqueStrings(semanticFacts.soft, 24) } : {}),
  };
  return context;
}

export function worldTemplateHashOf(snapshot: any): string | null {
  if (!isRecord(snapshot)) return null;
  const id = scalarString(snapshot.id || snapshot.templateId || snapshot.template_id);
  if (!id) return null;
  const updatedAt = scalarString(snapshot.updatedAt || snapshot.updated_at || snapshot.modifiedAt || snapshot.modified_at);
  return `${id}:${updatedAt || ''}`;
}

export function projectWorldContextForStyleBibleStage(
  worldContext: WorldContext,
  stage: string,
  scriptText = '',
): WorldContext {
  if (!worldContext || stage !== 'characters') return worldContext;
  const script = String(scriptText || '');
  const candidates = (worldContext.characterCandidates || []).filter((candidate) => {
    const name = scalarString(candidate.name);
    const role = scalarString(candidate.role);
    return textAppearsInScript(name, script) || textAppearsInScript(role, script);
  });
  const fallbackCandidates = candidates.length
    ? candidates
    : (worldContext.characterCandidates || []).slice(0, 4);
  return {
    ...(worldContext.era ? { era: worldContext.era.slice(0, 240) } : {}),
    ...(worldContext.setting ? {
      setting: {
        ...(worldContext.setting.era ? { era: worldContext.setting.era } : {}),
        ...(worldContext.setting.geography ? { geography: worldContext.setting.geography } : {}),
        ...(worldContext.setting.society ? { society: worldContext.setting.society.slice(0, 180) } : {}),
        ...(worldContext.setting.powerSystem ? { powerSystem: worldContext.setting.powerSystem.slice(0, 180) } : {}),
        ...(worldContext.setting.rules?.length ? { rules: worldContext.setting.rules.slice(0, 4) } : {}),
      },
    } : {}),
    ...(worldContext.worldRules?.length ? { worldRules: worldContext.worldRules.slice(0, 5) } : {}),
    ...(worldContext.storyRules ? {
      storyRules: {
        ...(worldContext.storyRules.allowedConflicts?.length
          ? { allowedConflicts: worldContext.storyRules.allowedConflicts.slice(0, 3) }
          : {}),
        ...(worldContext.storyRules.toneBoundaries?.length
          ? { toneBoundaries: worldContext.storyRules.toneBoundaries.slice(0, 3) }
          : {}),
      },
    } : {}),
    ...(fallbackCandidates.length ? { characterCandidates: fallbackCandidates.slice(0, 6) } : {}),
    ...(worldContext.forbiddenRules?.length ? { forbiddenRules: worldContext.forbiddenRules.slice(0, 4) } : {}),
  };
}

function compactContext(input: WorldContext | undefined, limits: {
  worldRules?: number;
  forbiddenRules?: number;
  hardFacts?: number;
  softDefaults?: number;
  characters?: number;
  locations?: number;
  props?: number;
  terminology?: number;
  includeStoryAllowed?: boolean;
  includeStoryForbidden?: boolean;
  includeToneBoundaries?: boolean;
}): WorldContext | undefined {
  if (!input) return undefined;
  const terminologyEntries = Object.entries(input.terminology || {}).slice(0, limits.terminology ?? 8);
  const characterCandidates = input.characterCandidates?.length
    ? input.characterCandidates.slice(0, limits.characters ?? 6)
    : undefined;
  const characterHardFacts = uniqueStrings(characterCandidates?.map((candidate) => (candidate as any).hardFacts || []) || [], limits.hardFacts ?? 14);
  const characterSoftDefaults = uniqueStrings(characterCandidates?.map((candidate) => (candidate as any).softDefaults || []) || [], limits.softDefaults ?? 12);
  const hardFacts = uniqueStrings([characterHardFacts, input.hardFacts], limits.hardFacts ?? 14);
  const softDefaults = uniqueStrings([characterSoftDefaults, input.softDefaults], limits.softDefaults ?? 12);
  const storyRules = input.storyRules ? {
    ...(limits.includeStoryAllowed && input.storyRules.allowedConflicts?.length
      ? { allowedConflicts: input.storyRules.allowedConflicts.slice(0, 4) }
      : {}),
    ...(limits.includeStoryForbidden && input.storyRules.forbiddenPlots?.length
      ? { forbiddenPlots: input.storyRules.forbiddenPlots.slice(0, 4) }
      : {}),
    ...(limits.includeToneBoundaries && input.storyRules.toneBoundaries?.length
      ? { toneBoundaries: input.storyRules.toneBoundaries.slice(0, 4) }
      : {}),
  } : undefined;
  const out: WorldContext = {
    ...(input.era ? { era: input.era.slice(0, 320) } : {}),
    ...(input.setting ? {
      setting: {
        ...(input.setting.era ? { era: input.setting.era.slice(0, 120) } : {}),
        ...(input.setting.geography ? { geography: input.setting.geography.slice(0, 160) } : {}),
        ...(input.setting.society ? { society: input.setting.society.slice(0, 180) } : {}),
        ...(input.setting.powerSystem ? { powerSystem: input.setting.powerSystem.slice(0, 180) } : {}),
        ...(input.setting.rules?.length ? { rules: input.setting.rules.slice(0, 5) } : {}),
      },
    } : {}),
    ...(input.worldRules?.length ? { worldRules: input.worldRules.slice(0, limits.worldRules ?? 8) } : {}),
    ...(storyRules && Object.keys(storyRules).length ? { storyRules } : {}),
    ...(characterCandidates?.length ? { characterCandidates } : {}),
    ...(input.locations?.length ? { locations: input.locations.slice(0, limits.locations ?? 8) } : {}),
    ...(input.props?.length ? { props: input.props.slice(0, limits.props ?? 8) } : {}),
    ...(terminologyEntries.length ? { terminology: Object.fromEntries(terminologyEntries) } : {}),
    ...(input.forbiddenRules?.length ? { forbiddenRules: input.forbiddenRules.slice(0, limits.forbiddenRules ?? 8) } : {}),
    ...(hardFacts.length ? { hardFacts } : {}),
    ...(softDefaults.length ? { softDefaults } : {}),
  };
  return hasWorldContextContent(out) ? out : undefined;
}

function hasWorldContextContent(value: WorldContext | undefined): boolean {
  if (!value) return false;
  return !!(
    value.era ||
    (value.setting && Object.keys(value.setting).length) ||
    value.worldRules?.length ||
    value.storyRules?.allowedConflicts?.length ||
    value.storyRules?.forbiddenPlots?.length ||
    value.storyRules?.toneBoundaries?.length ||
    value.characterCandidates?.length ||
    value.locations?.length ||
    value.props?.length ||
    (value.terminology && Object.keys(value.terminology).length) ||
    value.forbiddenRules?.length ||
    value.hardFacts?.length ||
    value.softDefaults?.length
  );
}

export function projectWorldContextForStage(
  stage: WorldContextProjectionStage,
  snapshot: any,
  opts: { scriptText?: string; project?: any; target?: any } = {},
): WorldContext | undefined {
  const full = buildWorldContextFromSnapshot(snapshot);
  if (!hasWorldContextContent(full)) return undefined;
  const stageKey = String(stage || '').trim();
  if (stageKey === 'style_bible') {
    return compactContext(full, {
      worldRules: 6,
      forbiddenRules: 5,
      characters: 6,
      locations: 6,
      props: 4,
      terminology: 6,
      includeStoryAllowed: true,
      includeStoryForbidden: true,
      includeToneBoundaries: true,
    });
  }
  if (stageKey === 'assets_extract') {
    return compactContext(full, {
      worldRules: 6,
      forbiddenRules: 6,
      characters: 10,
      locations: 10,
      props: 10,
      terminology: 8,
      includeStoryForbidden: true,
      includeToneBoundaries: true,
    });
  }
  if (stageKey === 'shots_generate' || stageKey === 'storyboard_sketch_prompt') {
    return compactContext(full, {
      worldRules: 7,
      forbiddenRules: 7,
      characters: 8,
      locations: 8,
      props: 8,
      terminology: 6,
      includeStoryForbidden: true,
      includeToneBoundaries: true,
    });
  }
  if (stageKey === 'video_prompt' || stageKey === 'video_prompt_refine') {
    return compactContext(full, {
      worldRules: 8,
      forbiddenRules: 8,
      characters: 8,
      locations: 6,
      props: 6,
      terminology: 8,
      includeStoryForbidden: true,
      includeToneBoundaries: true,
    });
  }
  if (stageKey === 'first_frame_image' || stageKey === 'tail_frame_image') {
    return compactContext(full, {
      worldRules: 7,
      forbiddenRules: 8,
      characters: 8,
      locations: 8,
      props: 8,
      terminology: 5,
      includeStoryForbidden: true,
      includeToneBoundaries: true,
    });
  }
  if (stageKey === 'script_create' || stageKey === 'script_continue' || stageKey === 'episode_create') {
    return compactContext(full, {
      worldRules: 10,
      forbiddenRules: 10,
      characters: 10,
      locations: 10,
      props: 10,
      terminology: 10,
      includeStoryAllowed: true,
      includeStoryForbidden: true,
      includeToneBoundaries: true,
    });
  }
  return compactContext(full, {
    worldRules: 6,
    forbiddenRules: 6,
    characters: 6,
    locations: 6,
    props: 6,
    terminology: 6,
    includeStoryForbidden: true,
  });
}

function textAppearsInScript(text: string, script: string): boolean {
  const clean = text.replace(/\s+/g, '').trim();
  if (clean.length < 2) return false;
  return script.replace(/\s+/g, '').includes(clean);
}

export function formatWorldContextForPrompt(
  worldContext?: WorldContext,
  opts: { includeSoft?: boolean; includeStyleBibleCharactersNote?: boolean } = {},
): string {
  if (!worldContext) return '';
  const includeSoft = opts.includeSoft !== false;
  if (worldContext.hardFacts?.length || (includeSoft && worldContext.softDefaults?.length)) {
    const parts: string[] = [];
    if (worldContext.hardFacts?.length) {
      parts.push(`世界观禁忌/硬事实（必须遵守，不得被单集改写）：\n${worldContext.hardFacts.map((item) => `- ${item}`).join('\n')}`);
    }
    if (includeSoft && worldContext.softDefaults?.length) {
      parts.push(`世界观软默认（用于保持连续性；如果当前剧本/本集明确给出不同设定，以当前剧本/本集为准）：\n${worldContext.softDefaults.map((item) => `- ${item}`).join('\n')}`);
    }
    if (!parts.length) return '';
    return [
      '世界观上下文（只提供内容语境，不是视觉风格模板）：',
      ...parts,
      ...(opts.includeStyleBibleCharactersNote
        ? ['注意：styleBible.characters 只能包含剧本中真实出现的角色；候选池只可用于匹配和补充视觉描述，禁止把剧本未出现的候选角色写入 characters。']
        : []),
    ].join('\n\n');
  }
  const parts: string[] = [];
  if (worldContext.era) parts.push(`时代/世界背景：${worldContext.era}`);
  if (worldContext.setting) {
    const settingParts = [
      worldContext.setting.era ? `时代：${worldContext.setting.era}` : '',
      worldContext.setting.geography ? `地理：${worldContext.setting.geography}` : '',
      worldContext.setting.society ? `社会结构：${worldContext.setting.society}` : '',
      worldContext.setting.powerSystem ? `力量/规则体系：${worldContext.setting.powerSystem}` : '',
      worldContext.setting.rules?.length ? `基础规则：${worldContext.setting.rules.join('；')}` : '',
    ].filter(Boolean);
    if (settingParts.length) parts.push(`世界设定：${settingParts.join('；')}`);
  }
  if (worldContext.worldRules?.length) parts.push(`世界规则：\n${worldContext.worldRules.map((item) => `- ${item}`).join('\n')}`);
  if (worldContext.storyRules) {
    const storyParts = [
      worldContext.storyRules.allowedConflicts?.length ? `允许冲突：${worldContext.storyRules.allowedConflicts.join('；')}` : '',
      worldContext.storyRules.forbiddenPlots?.length ? `禁止剧情：${worldContext.storyRules.forbiddenPlots.join('；')}` : '',
      worldContext.storyRules.toneBoundaries?.length ? `语气边界：${worldContext.storyRules.toneBoundaries.join('；')}` : '',
    ].filter(Boolean);
    if (storyParts.length) parts.push(`叙事规则：${storyParts.join('\n')}`);
  }
  if (worldContext.characterCandidates?.length) {
    parts.push(
      `角色候选池（只能用于匹配剧本中真实出现的角色，不得新增剧本未出现角色）：\n` +
        worldContext.characterCandidates
          .map((ch) => `- ${[ch.name, ch.role, ch.appearance].filter(Boolean).join('：')}`)
          .join('\n'),
    );
  }
  if (worldContext.locations?.length) parts.push(`地点/场景候选：${worldContext.locations.join('；')}`);
  if (worldContext.props?.length) parts.push(`道具/物件候选：${worldContext.props.join('；')}`);
  if (worldContext.terminology && Object.keys(worldContext.terminology).length) {
    parts.push(`术语/称谓：${JSON.stringify(worldContext.terminology)}`);
  }
  if (worldContext.forbiddenRules?.length) parts.push(`世界观禁忌：${worldContext.forbiddenRules.join('；')}`);
  if (!parts.length) return '';
  return [
    '世界观上下文（只提供内容语境，不是视觉风格模板）：',
    ...parts,
    ...(opts.includeStyleBibleCharactersNote
      ? ['注意：styleBible.characters 只能包含剧本中真实出现的角色；候选池只可用于匹配和补充视觉描述，禁止把剧本未出现的候选角色写入 characters。']
      : []),
  ].join('\n\n');
}
