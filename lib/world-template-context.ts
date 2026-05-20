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
  }>;
  locations?: string[];
  props?: string[];
  terminology?: Record<string, string>;
  forbiddenRules?: string[];
};

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
    out.push({
      ...(name ? { name } : {}),
      ...(role && role !== name ? { role } : {}),
      ...(appearance ? { appearance } : {}),
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

function textAppearsInScript(text: string, script: string): boolean {
  const clean = text.replace(/\s+/g, '').trim();
  if (clean.length < 2) return false;
  return script.replace(/\s+/g, '').includes(clean);
}

export function formatWorldContextForPrompt(worldContext?: WorldContext): string {
  if (!worldContext) return '';
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
    '注意：styleBible.characters 只能包含剧本中真实出现的角色；候选池只可用于匹配和补充视觉描述，禁止把剧本未出现的候选角色写入 characters。',
  ].join('\n\n');
}
