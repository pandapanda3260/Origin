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

function worldPanelsOf(world: any): Record<string, any> {
  if (isRecord(world?.referencePanels)) return world.referencePanels;
  if (isRecord(world?.panels)) return world.panels;
  return {};
}

function worldSceneOrPropImageUrl(world: any): string {
  return firstText(world?.imageUrl, world?.rawUrl, world?.pencilUrl);
}

// 角色只认真三视图：模板里必须真的有 referencePanels.sheetUrl 才算有图。
// 绝不拿特写/预览图（previewUrl/realPhotoUrl）冒充三视图——那会让卡片把特写当
// 三视图展示、标"已完成"，并让"生成全部图片"跳过该角色，真三视图永远不补。
function buildInjectedCharacterPanels(world: any, asset: any, originalUrl: string): Record<string, any> | undefined {
  const sourcePanels = worldPanelsOf(world);
  const sheetUrl = firstText(sourcePanels.sheetUrl);
  if (!sheetUrl) return undefined;
  const entityType = normalizeCharacterEntityType(asset?.entityType || world?.entityType);
  const schema = firstText(sourcePanels.schema) || (asset?.isCrowd
    ? 'anonymous-crowd-reference-v1'
    : entityType === 'non-human'
      ? 'non-human-character-sheet-v1'
      : 'human-character-sheet-v1');
  const sourceImageUrl = firstText(sourcePanels.sourceImageUrl, originalUrl, sheetUrl);
  const panels: Record<string, any> = { schema, sheetUrl };
  writeNonEmpty(panels, 'headshotUrl', sourcePanels.headshotUrl);
  writeNonEmpty(panels, 'frontUrl', sourcePanels.frontUrl);
  writeNonEmpty(panels, 'sideUrl', sourcePanels.sideUrl);
  writeNonEmpty(panels, 'backUrl', sourcePanels.backUrl);
  writeNonEmpty(panels, 'sourceImageId', firstText(sourcePanels.sourceImageId, imageIdFromUrl(sourceImageUrl)));
  writeNonEmpty(panels, 'sourceImageUrl', sourceImageUrl);
  return panels;
}

function readyReference(existing: any, url: string) {
  const reference = {
    ...(isRecord(existing) ? existing : {}),
    currentUrl: url,
    lastKnownGoodUrl: url,
    status: 'ready',
    updatedAt: new Date().toISOString(),
    source: 'world_template',
  };
  delete (reference as any).lastError;
  return reference;
}

function applyWorldImage(item: any, world: any, kind: AssetKind): { item: any; filled: boolean } {
  if (hasUsableAssetImage(item)) return { item, filled: false };
  if (kind === 'characters') {
    const sheetUrl = firstText(worldPanelsOf(world).sheetUrl);
    // 没有真三视图：只注入文本，图留空走正常生成链（不标 ready、不挡"生成全部图片"）
    if (!sheetUrl) return { item, filled: false };
    // 资产契约：imageUrl/rawUrl/realPhotoUrl 三字段同源 = 三视图原图
    const originalUrl = firstText(worldPanelsOf(world).sourceImageUrl, world?.imageUrl, world?.rawUrl, sheetUrl);
    const next = { ...item };
    next.imageUrl = originalUrl;
    next.rawUrl = originalUrl;
    next.realPhotoUrl = originalUrl;
    const panels = buildInjectedCharacterPanels(world, item, originalUrl);
    if (panels) next.panels = panels;
    next.reference = readyReference(next.reference, originalUrl);
    delete next.imageLastError;
    delete next.imageFailedAt;
    return { item: next, filled: true };
  }
  const imageUrl = worldSceneOrPropImageUrl(world);
  if (!imageUrl) return { item, filled: false };
  const next = { ...item };
  writeNonEmpty(next, 'imageUrl', firstText(world?.imageUrl, world?.rawUrl, imageUrl));
  writeNonEmpty(next, 'rawUrl', firstText(world?.rawUrl, world?.imageUrl, imageUrl));
  next.reference = readyReference(next.reference, imageUrl);
  delete next.imageLastError;
  delete next.imageFailedAt;
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
