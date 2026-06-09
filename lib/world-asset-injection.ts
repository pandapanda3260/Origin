type AssetKind = 'characters' | 'scenes' | 'props';

type InjectionLog = {
  kind: AssetKind;
  index: number;
  name: string;
  action: 'injected' | 'skipped';
  reason?: string;
  worldName?: string;
};

type InjectionStats = {
  characters: { injected: number; imageFilled: number; skipped: number };
  scenes: { injected: number; imageFilled: number; skipped: number };
  props: { injected: number; imageFilled: number; skipped: number };
};

export type WorldAssetInjectionResult = {
  assets: {
    characters: any[];
    scenes: any[];
    props: any[];
  };
  stats: InjectionStats;
  logs: InjectionLog[];
};

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clonePlain<T>(value: T): T {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value: any): string {
  return String(value || '').trim();
}

export function normalizeAssetMatchKey(value: any): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, '');
}

function firstText(...values: any[]): string {
  return values.map(cleanText).find(Boolean) || '';
}

function firstArray(...values: any[]): any[] {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function nonEmptyAssetValue(value: any): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function normalizeCharacterEntityType(value: any): string {
  const text = cleanText(value).toLowerCase();
  if (!text) return '';
  if (text === 'non-human' || text === 'nonhuman' || text.includes('非人')) return 'non-human';
  if (text === 'human' || text.includes('人物') || text.includes('人类')) return 'human';
  return text;
}

function panelSchemaEntityType(value: any): string {
  const schema = cleanText(value?.schema).toLowerCase();
  if (!schema) return '';
  if (schema.includes('non-human') || schema.includes('nonhuman')) return 'non-human';
  if (schema.includes('human-character')) return 'human';
  return '';
}

function worldCharacterStrongKey(character: any) {
  if (!isRecord(character)) return '';
  return firstText(character.characterId, character.id, character.sourceAssetId).toLowerCase();
}

function mergeWorldCharacterPools(...pools: any[]) {
  const byKey = new Map<string, any>();
  const out: any[] = [];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const character of pool) {
      const key = worldCharacterStrongKey(character);
      if (!key) {
        out.push(character);
        continue;
      }
      const existing = byKey.get(key);
      byKey.set(key, existing ? { ...character, ...existing } : character);
    }
  }
  return [...byKey.values(), ...out];
}

function writeNonEmpty(target: Record<string, any>, key: string, value: any) {
  if (nonEmptyAssetValue(value)) target[key] = clonePlain(value);
}

function imageIdFromUrl(url: any): string {
  const m = /\/api\/images\/file\/([0-9a-fA-F-]{36})/.exec(String(url || ''));
  return m ? m[1] : '';
}

function isBlockingReferenceStatus(status: any): boolean {
  const text = cleanText(status).toLowerCase();
  return text === 'missing' || text === 'failed' || text === 'legacy_sketch_only';
}

function hasUsableAssetImage(item: any): boolean {
  if (!isRecord(item)) return false;
  const reference = isRecord(item.reference) ? item.reference : {};
  if (isBlockingReferenceStatus(reference.status)) return false;
  const panels = isRecord(item.panels) ? item.panels : {};
  return [
    item.imageUrl,
    item.rawUrl,
    item.realPhotoUrl,
    item.pencilUrl,
    reference.currentUrl,
    reference.lastKnownGoodUrl,
    panels.sheetUrl,
    panels.headshotUrl,
    panels.frontUrl,
    panels.sideUrl,
    panels.backUrl,
  ].some(nonEmptyAssetValue);
}

function worldImageUrl(world: any): string {
  const panels = isRecord(world?.referencePanels)
    ? world.referencePanels
    : isRecord(world?.panels)
      ? world.panels
      : {};
  return firstText(
    panels.sheetUrl,
    panels.headshotUrl,
    panels.frontUrl,
    panels.sideUrl,
    panels.backUrl,
    world?.realPhotoUrl,
    world?.rawUrl,
    world?.imageUrl,
    world?.pencilUrl,
  );
}

function buildInjectedPanels(world: any, asset: any): Record<string, any> | undefined {
  const sourcePanels = isRecord(world?.referencePanels)
    ? world.referencePanels
    : isRecord(world?.panels)
      ? world.panels
      : {};
  const sheetUrl = firstText(sourcePanels.sheetUrl, world?.realPhotoUrl, world?.imageUrl, world?.rawUrl, world?.pencilUrl);
  const headshotUrl = firstText(sourcePanels.headshotUrl);
  const frontUrl = firstText(sourcePanels.frontUrl);
  const sideUrl = firstText(sourcePanels.sideUrl);
  const backUrl = firstText(sourcePanels.backUrl);
  const sourceImageUrl = firstText(sourcePanels.sourceImageUrl, sheetUrl, headshotUrl, frontUrl);
  if (!sheetUrl && !headshotUrl && !frontUrl && !sideUrl && !backUrl && !sourceImageUrl) return undefined;
  const entityType = normalizeCharacterEntityType(asset?.entityType || world?.entityType);
  const schema = asset?.isCrowd
    ? 'anonymous-crowd-reference-v1'
    : entityType === 'non-human'
      ? 'non-human-character-sheet-v1'
      : 'human-character-sheet-v1';
  const panels: Record<string, any> = { schema };
  writeNonEmpty(panels, 'sheetUrl', sheetUrl || sourceImageUrl);
  writeNonEmpty(panels, 'headshotUrl', headshotUrl);
  writeNonEmpty(panels, 'frontUrl', frontUrl);
  writeNonEmpty(panels, 'sideUrl', sideUrl);
  writeNonEmpty(panels, 'backUrl', backUrl);
  writeNonEmpty(panels, 'sourceImageId', firstText(sourcePanels.sourceImageId, imageIdFromUrl(sourceImageUrl)));
  writeNonEmpty(panels, 'sourceImageUrl', sourceImageUrl);
  return panels;
}

function applyWorldImage(item: any, world: any, kind: AssetKind): { item: any; filled: boolean } {
  if (hasUsableAssetImage(item)) return { item, filled: false };
  const imageUrl = worldImageUrl(world);
  if (!imageUrl) return { item, filled: false };
  const next = { ...item };
  if (kind === 'characters') {
    writeNonEmpty(next, 'realPhotoUrl', firstText(world?.realPhotoUrl, imageUrl));
    writeNonEmpty(next, 'imageUrl', firstText(world?.imageUrl, world?.rawUrl, imageUrl));
    writeNonEmpty(next, 'rawUrl', firstText(world?.rawUrl, world?.imageUrl, imageUrl));
    const panels = buildInjectedPanels(world, item);
    if (panels) next.panels = panels;
  } else {
    writeNonEmpty(next, 'imageUrl', firstText(world?.imageUrl, world?.rawUrl, imageUrl));
    writeNonEmpty(next, 'rawUrl', firstText(world?.rawUrl, world?.imageUrl, imageUrl));
  }
  next.reference = {
    ...(isRecord(next.reference) ? next.reference : {}),
    currentUrl: imageUrl,
    lastKnownGoodUrl: imageUrl,
    status: 'ready',
    updatedAt: new Date().toISOString(),
    source: 'world_template',
  };
  delete next.imageLastError;
  delete next.imageFailedAt;
  if (next.reference) delete next.reference.lastError;
  return { item: next, filled: true };
}

function matchKeysForAsset(item: any, kind: AssetKind): string[] {
  const keys = [normalizeAssetMatchKey(item?.name)].filter(Boolean);
  if (kind === 'characters') {
    const characterId = normalizeAssetMatchKey(item?.characterId);
    if (characterId) keys.push(characterId);
  }
  return Array.from(new Set(keys));
}

function matchKeysForWorld(item: any, kind: AssetKind): string[] {
  const keys = [normalizeAssetMatchKey(item?.name || item?.title)].filter(Boolean);
  if (kind === 'characters') {
    const characterId = normalizeAssetMatchKey(item?.characterId);
    if (characterId) keys.push(characterId);
  }
  return Array.from(new Set(keys));
}

function findUniqueWorldMatch(item: any, worldItems: any[], kind: AssetKind) {
  const assetKeys = new Set(matchKeysForAsset(item, kind));
  if (!assetKeys.size) return { match: null, reason: 'missing_match_key' };
  const matches: any[] = [];
  for (const worldItem of worldItems) {
    const hit = matchKeysForWorld(worldItem, kind).some((key) => assetKeys.has(key));
    if (hit) matches.push(worldItem);
  }
  if (!matches.length) return { match: null, reason: 'no_world_match' };
  if (matches.length > 1) return { match: null, reason: 'ambiguous_world_match' };
  return { match: matches[0], reason: '' };
}

function canInjectCharacter(asset: any, world: any): { ok: boolean; reason?: string } {
  const assetEntity = normalizeCharacterEntityType(asset?.entityType);
  const worldEntity = normalizeCharacterEntityType(world?.entityType);
  const worldSchemaEntity = panelSchemaEntityType(world?.referencePanels || world?.panels);
  if (assetEntity && worldEntity && assetEntity !== worldEntity) return { ok: false, reason: 'entity_type_mismatch' };
  if (assetEntity && worldSchemaEntity && assetEntity !== worldSchemaEntity) return { ok: false, reason: 'panel_schema_entity_mismatch' };
  if (assetEntity === 'non-human' && !worldEntity && !worldSchemaEntity) return { ok: false, reason: 'missing_non_human_world_evidence' };
  return { ok: true };
}

function injectCharacter(asset: any, world: any) {
  const guard = canInjectCharacter(asset, world);
  if (!guard.ok) return { item: asset, injected: false, imageFilled: false, reason: guard.reason || 'character_guard_failed' };
  let next = { ...asset };
  for (const key of [
    'name',
    'role',
    'identity',
    'entityType',
    'species',
    'gender',
    'ageBand',
    'appearance',
    'description',
    'temperament',
    'actionTraits',
    'castingOverride',
  ]) {
    writeNonEmpty(next, key, world?.[key]);
  }
  const image = applyWorldImage(next, world, 'characters');
  next = image.item;
  return { item: next, injected: true, imageFilled: image.filled };
}

function injectScene(asset: any, world: any) {
  let next = { ...asset };
  writeNonEmpty(next, 'name', world?.name || world?.title);
  writeNonEmpty(next, 'description', world?.description);
  writeNonEmpty(next, 'atmosphere', world?.atmosphere);
  const image = applyWorldImage(next, world, 'scenes');
  next = image.item;
  return { item: next, injected: true, imageFilled: image.filled };
}

function uniqueTextParts(values: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function injectProp(asset: any, world: any) {
  let next = { ...asset };
  writeNonEmpty(next, 'name', world?.name || world?.title);
  const featureParts = uniqueTextParts([world?.visualFeatures, world?.function, asset?.features]);
  if (featureParts.length) next.features = featureParts.join('；');
  const image = applyWorldImage(next, world, 'props');
  next = image.item;
  return { item: next, injected: true, imageFilled: image.filled };
}

function injectList(items: any[], worldItems: any[], kind: AssetKind, stats: InjectionStats, logs: InjectionLog[]) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const name = firstText(item?.name, item?.title, item?.id, item?.characterId);
    const { match, reason } = findUniqueWorldMatch(item, worldItems, kind);
    if (!match) {
      stats[kind].skipped += 1;
      logs.push({ kind, index, name, action: 'skipped', reason });
      return item;
    }
    const result: any = kind === 'characters'
      ? injectCharacter(item, match)
      : kind === 'scenes'
        ? injectScene(item, match)
        : injectProp(item, match);
    if (!result.injected) {
      stats[kind].skipped += 1;
      logs.push({ kind, index, name, action: 'skipped', reason: result.reason, worldName: firstText(match?.name, match?.title) });
      return item;
    }
    stats[kind].injected += 1;
    if (result.imageFilled) stats[kind].imageFilled += 1;
    logs.push({ kind, index, name, action: 'injected', worldName: firstText(match?.name, match?.title) });
    return result.item;
  });
}

export function injectWorldTemplateIntoAssets(input: {
  assets: {
    characters?: any[];
    scenes?: any[];
    props?: any[];
  };
  worldTemplateSnapshot?: any;
}): WorldAssetInjectionResult {
  const assets = input.assets || {};
  const world = isRecord(input.worldTemplateSnapshot) ? input.worldTemplateSnapshot : {};
  const stats: InjectionStats = {
    characters: { injected: 0, imageFilled: 0, skipped: 0 },
    scenes: { injected: 0, imageFilled: 0, skipped: 0 },
    props: { injected: 0, imageFilled: 0, skipped: 0 },
  };
  const logs: InjectionLog[] = [];
  const worldCharacters = mergeWorldCharacterPools(world.characters, world.characterCandidates);
  const worldScenes = firstArray(world.locations, world.scenes, world.environments, world.places);
  const worldProps = firstArray(world.props, world.items, world.keyItems, world.artifacts);
  return {
    assets: {
      characters: injectList(assets.characters || [], worldCharacters, 'characters', stats, logs),
      scenes: injectList(assets.scenes || [], worldScenes, 'scenes', stats, logs),
      props: injectList(assets.props || [], worldProps, 'props', stats, logs),
    },
    stats,
    logs,
  };
}
