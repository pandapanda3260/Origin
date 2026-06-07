import { inferEntityTypeFromCharacter } from './character-panels';
import type { CharacterLock } from './character-consistency';

type ResolutionReason =
  | 'sourceAssetId'
  | 'characterId'
  | 'id'
  | 'canonicalName'
  | 'alias'
  | 'no_match'
  | 'ambiguous';

export type CharacterAssetResolution = {
  asset: any | null;
  reason: ResolutionReason;
  key?: string;
  candidates?: string[];
};

function cleanText(value: any): string {
  return String(value ?? '').trim();
}

function normalizedKey(value: any): string {
  return cleanText(value).toLowerCase();
}

function hasOwn(obj: any, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function cleanAssetText(value: any): string {
  return cleanText(value);
}

function firstText(...values: any[]): string {
  return values.map(cleanText).find(Boolean) || '';
}

function cleanList(values: any[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = cleanText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function assetDisplayName(asset: any): string {
  return firstText(asset?.id, asset?.characterId, asset?.name, asset?.role) || 'unknown';
}

export function listCharacterAssetsForAuthority(project: any): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const sources = [
    ...(Array.isArray(project?.assets?.characters) ? project.assets.characters : []),
    ...(Array.isArray(project?.characters) ? project.characters : []),
  ];
  for (const asset of sources) {
    if (!asset || typeof asset !== 'object') continue;
    const key = firstText(asset.sourceAssetId, asset.characterId, asset.id, asset.name);
    const dedupeKey = normalizedKey(key);
    if (dedupeKey && seen.has(dedupeKey)) continue;
    if (dedupeKey) seen.add(dedupeKey);
    out.push(asset);
  }
  return out;
}

function assetIdKeys(asset: any): string[] {
  return [
    asset?.sourceAssetId,
    asset?.characterId,
    asset?.id,
  ].map(normalizedKey).filter(Boolean);
}

function assetNameKeys(asset: any): string[] {
  return [
    asset?.name,
    asset?.title,
  ].map(normalizedKey).filter(Boolean);
}

function uniqueMatch(assets: any[], keys: string[], getAssetKeys: (asset: any) => string[]): CharacterAssetResolution | null {
  const normalized = keys.map(normalizedKey).filter(Boolean);
  if (!normalized.length) return null;
  for (const key of normalized) {
    const matches = assets.filter((asset) => getAssetKeys(asset).includes(key));
    if (matches.length === 1) return { asset: matches[0], reason: 'id', key };
    if (matches.length > 1) {
      return {
        asset: null,
        reason: 'ambiguous',
        key,
        candidates: matches.map(assetDisplayName),
      };
    }
  }
  return null;
}

function uniqueNamedMatch(assets: any[], keys: string[], reason: ResolutionReason): CharacterAssetResolution | null {
  const normalized = keys.map(normalizedKey).filter(Boolean);
  if (!normalized.length) return null;
  for (const key of normalized) {
    const matches = assets.filter((asset) => assetNameKeys(asset).includes(key));
    if (matches.length === 1) return { asset: matches[0], reason, key };
    if (matches.length > 1) {
      return {
        asset: null,
        reason: 'ambiguous',
        key,
        candidates: matches.map(assetDisplayName),
      };
    }
  }
  return null;
}

export function resolveCharacterAssetForEntity(project: any, entity: any): CharacterAssetResolution {
  const assets = listCharacterAssetsForAuthority(project);
  if (!assets.length) return { asset: null, reason: 'no_match' };

  const sourceAssetMatch = uniqueMatch(assets, [entity?.sourceAssetId], assetIdKeys);
  if (sourceAssetMatch) return { ...sourceAssetMatch, reason: sourceAssetMatch.reason === 'ambiguous' ? 'ambiguous' : 'sourceAssetId' };

  const characterIdMatch = uniqueMatch(assets, [entity?.characterId], assetIdKeys);
  if (characterIdMatch) return { ...characterIdMatch, reason: characterIdMatch.reason === 'ambiguous' ? 'ambiguous' : 'characterId' };

  const idMatch = uniqueMatch(assets, [entity?.id], assetIdKeys);
  if (idMatch) return { ...idMatch, reason: idMatch.reason === 'ambiguous' ? 'ambiguous' : 'id' };

  const nameMatch = uniqueNamedMatch(assets, [entity?.canonicalName, entity?.name, entity?.title], 'canonicalName');
  if (nameMatch) return nameMatch;

  const aliases = Array.isArray(entity?.aliases) ? entity.aliases : [];
  const aliasMatch = uniqueNamedMatch(assets, aliases, 'alias');
  if (aliasMatch) return aliasMatch;

  return { asset: null, reason: 'no_match' };
}

export function buildAssetAuthoritativeCharacterLock(lock: CharacterLock, asset: any | null | undefined): CharacterLock {
  if (!asset || typeof asset !== 'object') return lock;

  const entityType = inferEntityTypeFromCharacter(asset);
  const identityLock = {
    ...lock.identityLock,
    entityType,
  };
  const role = cleanAssetText(asset.role);
  const identity = cleanAssetText(asset.identity);
  const species = cleanAssetText(asset.species);
  if (role) identityLock.role = role;
  if (identity) identityLock.identity = identity;
  if (entityType === 'non-human') {
    if (species) identityLock.species = species;
    else if (lock.identityLock.entityType === 'human') delete identityLock.species;
  } else {
    delete identityLock.species;
  }

  const visualLock = {
    ...lock.visualLock,
    canonicalPrompt: '',
  };
  const appearance = cleanAssetText(asset.appearance || asset.detail || asset.description || asset.intro);
  if (appearance) visualLock.appearance = appearance;
  if (hasOwn(asset, 'clothing')) visualLock.clothing = cleanAssetText(asset.clothing);
  if (hasOwn(asset, 'equipment')) visualLock.equipment = cleanAssetText(asset.equipment);
  if (entityType === 'non-human' && !visualLock.clothing) {
    visualLock.negativeRules = (visualLock.negativeRules || [])
      .filter((rule) => !/wardrobe|clothing|服装/i.test(String(rule || '')));
  }

  const performanceLock = { ...lock.performanceLock };
  const temperament = cleanAssetText(asset.temperament);
  const actionTraits = cleanAssetText(asset.actionTraits);
  if (temperament) performanceLock.temperament = temperament;
  if (actionTraits) performanceLock.actionTraits = actionTraits;

  return {
    ...lock,
    canonicalName: cleanAssetText(asset.name || lock.canonicalName),
    aliases: cleanList([
      asset.name,
      asset.role,
      ...(Array.isArray(asset.aliases) ? asset.aliases : []),
    ]),
    identityLock,
    visualLock,
    performanceLock,
  };
}

export function applyAssetAuthorityToWorldCharacter(character: any, asset: any | null | undefined): any {
  if (!character || typeof character !== 'object' || !asset || typeof asset !== 'object') return character;
  const entityType = inferEntityTypeFromCharacter(asset);
  const next = { ...character };
  const name = cleanAssetText(asset.name || asset.title);
  const role = firstText(asset.role, asset.identity, asset.description, asset.intro, asset.name);
  const identity = firstText(asset.identity, asset.description, asset.intro, asset.role);
  const description = firstText(asset.description, asset.intro, asset.identity, asset.role);
  if (name) next.name = name;
  next.aliases = cleanList([
    asset.name,
    asset.role,
    ...(Array.isArray(asset.aliases) ? asset.aliases : []),
  ]);
  next.role = role;
  next.identity = identity;
  next.description = description;
  next.entityType = entityType;
  next.species = entityType === 'non-human' ? cleanAssetText(asset.species) : '';
  const appearance = cleanAssetText(asset.appearance || asset.detail || asset.description || asset.intro);
  if (appearance) next.appearance = appearance;
  if (hasOwn(asset, 'clothing')) next.clothing = cleanAssetText(asset.clothing);
  if (hasOwn(asset, 'equipment')) next.equipment = cleanAssetText(asset.equipment);
  next.temperament = cleanAssetText(asset.temperament);
  next.actionTraits = cleanAssetText(asset.actionTraits);
  next.canonicalPrompt = '';
  return next;
}
