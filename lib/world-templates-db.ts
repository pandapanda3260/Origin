import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import {
  applyAssetAuthorityToWorldCharacter,
  buildAssetAuthoritativeCharacterLock,
  listCharacterAssetsForAuthority,
  resolveCharacterAssetForEntity,
} from './character-lock-authority';

type WorldTemplateRow = {
  id: string;
  owner_id: number;
  name: string;
  source_project_id: string | null;
  cover_image_id: string | null;
  schema_version: number;
  source: string;
  data_json: string;
  created_at: string;
  updated_at: string;
};

function cleanId(value: any) {
  const id = String(value || '').trim();
  if (id && id.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(id)) return id;
  return `tpl_${randomUUID()}`;
}

function cleanString(value: any, max: number) {
  return String(value || '').trim().slice(0, max);
}

const WORLD_TEMPLATE_VISUAL_FIELD_KEYS = [
  'styleBible',
  'style_bible',
  'hasStyleBible',
  'visualStyle',
  'visual_style',
  'visualStyleDesc',
  'visual_style_desc',
  'colorPalette',
  'color_palette',
  'cameraStyle',
  'camera_style',
  'editingRhythm',
  'editing_rhythm',
  'lighting',
  'texture',
  'negativePrompt',
  'negative_prompt',
  'videoNegativePrompt',
  'video_negative_prompt',
  'additionalPrompt',
  'additional_prompt',
  'styleBibleGenerationContext',
  'style_bible_generation_context',
  'promptFragment',
  'prompt_fragment',
  'styleTemplateId',
  'style_template_id',
  'styleTemplateSnapshot',
  'style_template_snapshot',
  'visualRules',
  'visual_rules',
  'editRules',
  'edit_rules',
  'subtitleStyle',
  'subtitle_style',
  'subtitleRules',
  'subtitle_rules',
  'musicRules',
  'music_rules',
  'audio',
];
const warnedVisualFieldKeys = new Set<string>();

function stripVisualFields(data: any, templateId: string, warn: boolean) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const next = { ...data };
  for (const key of WORLD_TEMPLATE_VISUAL_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      if (warn) {
        const warnKey = `${templateId}:${key}`;
        if (!warnedVisualFieldKeys.has(warnKey)) {
          warnedVisualFieldKeys.add(warnKey);
          console.warn(`[world-templates] stripped legacy visual field ${key} from ${templateId}`);
        }
      }
    }
  }
  return next;
}

function parseData(row: WorldTemplateRow) {
  let data: any = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch { data = {}; }
  return stripVisualFields(data, row.id, true);
}

function firstArray(...values: any[]) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function entityPreviewUrl(item: any) {
  return (
    item?.coverImageUrl
    || item?.thumbnailUrl
    || item?.realPhotoUrl
    || item?.rawUrl
    || item?.imageUrl
    || item?.pencilUrl
    || item?.referenceImageUrl
    || item?.referencePanels?.headshotUrl
    || item?.referencePanels?.frontUrl
    || item?.referencePanels?.sheetUrl
    || ''
  );
}

function previewUrlsFromEntities(items: any[], max = 4) {
  return items
    .map((item: any) => entityPreviewUrl(item))
    .filter(Boolean)
    .slice(0, max);
}

function worldCharacterKey(character: any) {
  if (!character || typeof character !== 'object') return firstText(character).toLowerCase();
  return firstText(character.characterId, character.id, character.sourceAssetId, character.name, character.title, character.role).toLowerCase();
}

function mergeWorldCharacterPools(...pools: any[]) {
  const byKey = new Map<string, any>();
  const out: any[] = [];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const character of pool) {
      const key = worldCharacterKey(character);
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

function removeCharactersAlreadyInPool(pool: any, authoritativePool: any) {
  const authoritativeKeys = new Set(
    mergeWorldCharacterPools(authoritativePool).map(worldCharacterKey).filter(Boolean),
  );
  if (!authoritativeKeys.size) return Array.isArray(pool) ? pool : [];
  return (Array.isArray(pool) ? pool : []).filter((character) => {
    const key = worldCharacterKey(character);
    return !key || !authoritativeKeys.has(key);
  });
}

function preferredStyleTemplateIdFrom(value: any) {
  const preference = value?.styleTemplatePreference;
  return cleanString(
    value?.preferredStyleTemplateId
      || value?.preferred_style_template_id
      || preference?.styleTemplateId
      || preference?.templateId
      || preference?.id
      || '',
    100,
  );
}

function preferredStyleTemplateNameFrom(value: any) {
  const preference = value?.styleTemplatePreference;
  return cleanString(
    value?.preferredStyleTemplateName
      || value?.preferred_style_template_name
      || preference?.styleTemplateName
      || preference?.name
      || preference?.title
      || '',
    120,
  );
}

function normalizedPreferredStyleFields(value: any) {
  const preferredStyleTemplateId = preferredStyleTemplateIdFrom(value);
  const preferredStyleTemplateName = preferredStyleTemplateNameFrom(value);
  const preferredStyleTemplateSource = cleanString(
    value?.preferredStyleTemplateSource
      || value?.preferred_style_template_source
      || value?.styleTemplatePreference?.source
      || '',
    80,
  );
  const out: Record<string, string> = {};
  if (preferredStyleTemplateId) out.preferredStyleTemplateId = preferredStyleTemplateId;
  if (preferredStyleTemplateName) out.preferredStyleTemplateName = preferredStyleTemplateName;
  if (preferredStyleTemplateSource) out.preferredStyleTemplateSource = preferredStyleTemplateSource;
  return out;
}

function rowToPublic(row: WorldTemplateRow) {
  const data = parseData(row);
  return {
    ...data,
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    sourceProjectId: row.source_project_id || data.sourceProjectId || null,
    coverImageId: row.cover_image_id || data.coverImageId || null,
    schemaVersion: row.schema_version || data.schemaVersion || 1,
    source: row.source || data.source || 'user',
    ...normalizedPreferredStyleFields(data),
    createdAt: data.createdAt || row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: WorldTemplateRow) {
  const data = parseData(row);
  const characters = mergeWorldCharacterPools(data.characters, data.characterCandidates);
  const locations = firstArray(data.locations, data.scenes, data.environments, data.places);
  const props = firstArray(data.props, data.items, data.keyItems, data.artifacts);
  const characterPreviewUrls = previewUrlsFromEntities(characters, 4);
  const locationPreviewUrls = previewUrlsFromEntities(locations, 4);
  const propPreviewUrls = previewUrlsFromEntities(props, 4);
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    sourceProjectId: row.source_project_id || data.sourceProjectId || null,
    coverImageId: row.cover_image_id || data.coverImageId || null,
    coverImageUrl: data.coverImageUrl || locationPreviewUrls[0] || propPreviewUrls[0] || characterPreviewUrls[0] || null,
    schemaVersion: row.schema_version || data.schemaVersion || 1,
    source: row.source || data.source || 'user',
    ...normalizedPreferredStyleFields(data),
    migrationKey: data.migrationKey || templateFingerprint(data),
    characterCount: characters.length,
    locationCount: locations.length,
    propCount: props.length,
    characterPreviewUrls,
    locationPreviewUrls,
    propPreviewUrls,
    createdAt: data.createdAt || row.created_at,
    updatedAt: row.updated_at,
    summaryOnly: true,
  };
}

function stableTemplateValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableTemplateValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    const v = stableTemplateValue(value[key]);
    if (typeof v !== 'undefined') out[key] = v;
  }
  return out;
}

function templateFingerprint(input: any) {
  const root = { ...(input && typeof input === 'object' ? input : {}) };
  for (const key of [
    'id',
    'createdAt',
    'updatedAt',
    'created_at',
    'updated_at',
    'source',
    'legacyId',
    'migrationKey',
    'schemaVersion',
    'schema_version',
  ]) {
    delete root[key];
  }
  let h = 2166136261;
  const text = JSON.stringify(stableTemplateValue(root));
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function normalizeTemplate(input: any) {
  const raw = input && typeof input === 'object' ? input : {};
  const id = cleanId(raw.id);
  const name = cleanString(raw.name || raw.title || '未命名世界观模板', 120) || '未命名世界观模板';
  const sourceProjectId = cleanString(raw.sourceProjectId || raw.source_project_id || raw.projectId || '', 120) || null;
  const coverImageId = cleanString(raw.coverImageId || raw.cover_image_id || '', 120) || null;
  const schemaVersion = Math.max(1, Math.min(99, Number(raw.schemaVersion || raw.schema_version || 1) || 1));
  const source = cleanString(raw.source || 'user', 80) || 'user';
  const preferredStyleFields = normalizedPreferredStyleFields(raw);
  const data = stripVisualFields({
    ...raw,
    id,
    name,
    sourceProjectId,
    coverImageId,
    schemaVersion,
    source,
    ...preferredStyleFields,
  }, id, true);
  return { id, name, sourceProjectId, coverImageId, schemaVersion, source, data };
}

function resolveCoverImageId(userId: number, coverImageId: string | null) {
  if (!coverImageId) return null;
  const row = getDb()
    .prepare<{ id: string; uid: number }, { id: string }>(
      'SELECT id FROM images WHERE id = @id AND owner_id = @uid LIMIT 1',
    )
    .get({ id: coverImageId, uid: userId });
  return row ? coverImageId : null;
}

export function listWorldTemplates(userId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, WorldTemplateRow>(
      `SELECT * FROM world_templates WHERE owner_id = @uid ORDER BY updated_at DESC, created_at DESC`,
    )
    .all({ uid: userId });
  return rows.map(rowToPublic);
}

export function listWorldTemplateSummaries(userId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, WorldTemplateRow>(
      `SELECT * FROM world_templates WHERE owner_id = @uid ORDER BY updated_at DESC, created_at DESC`,
    )
    .all({ uid: userId });
  return rows.map(rowToSummary);
}

export function getWorldTemplate(userId: number, id: string) {
  const db = getDb();
  const row = db
    .prepare<{ uid: number; id: string }, WorldTemplateRow>(
      `SELECT * FROM world_templates WHERE owner_id = @uid AND id = @id`,
    )
    .get({ uid: userId, id });
  return row ? rowToPublic(row) : null;
}

export function upsertWorldTemplate(userId: number, input: any) {
  const tpl = normalizeTemplate(input);
  const db = getDb();
  const coverImageId = resolveCoverImageId(userId, tpl.coverImageId);
  const data = { ...tpl.data, coverImageId };
  db.prepare(
    `INSERT INTO world_templates
       (id, owner_id, name, source_project_id, cover_image_id, schema_version, source, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, id) DO UPDATE SET
       name = excluded.name,
       source_project_id = excluded.source_project_id,
       cover_image_id = excluded.cover_image_id,
       schema_version = excluded.schema_version,
       source = excluded.source,
       data_json = excluded.data_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    tpl.id,
    userId,
    tpl.name,
    tpl.sourceProjectId,
    coverImageId,
    tpl.schemaVersion,
    tpl.source,
    JSON.stringify(data),
  );
  return getWorldTemplate(userId, tpl.id)!;
}

export function deleteWorldTemplate(userId: number, id: string) {
  const db = getDb();
  const info = db
    .prepare('DELETE FROM world_templates WHERE owner_id = ? AND id = ?')
    .run(userId, id);
  return info.changes > 0;
}

function cleanList(values: any, max = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (value: any) => {
    if (out.length >= max || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const key of ['name', 'title', 'label', 'summary', 'description', 'detail', 'rule']) {
        if (value[key]) visit(value[key]);
      }
      return;
    }
    const text = String(value || '').trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  visit(values);
  return out;
}

function firstText(...values: any[]) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isEmptyTemplateValue(value: any): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function mergeMissingTemplateValue(current: any, incoming: any): { value: any; changed: boolean } {
  if (isEmptyTemplateValue(incoming)) return { value: current, changed: false };
  if (isEmptyTemplateValue(current)) return { value: clonePlain(incoming), changed: true };
  if (Array.isArray(current) || Array.isArray(incoming)) {
    return { value: current, changed: false };
  }
  if (current && incoming && typeof current === 'object' && typeof incoming === 'object') {
    let changed = false;
    const next = { ...current };
    for (const key of Object.keys(incoming)) {
      const merged = mergeMissingTemplateValue(next[key], incoming[key]);
      if (merged.changed) {
        next[key] = merged.value;
        changed = true;
      }
    }
    return { value: next, changed };
  }
  return { value: current, changed: false };
}

function entityKey(entity: any) {
  return firstText(entity?.characterId, entity?.id, entity?.sourceAssetId, entity?.name, entity?.title, entity?.role).toLowerCase();
}

function entityFieldMeta(entity: any, key: string) {
  const meta = entity?.fieldMeta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) && meta[key] && typeof meta[key] === 'object' && !Array.isArray(meta[key])
    ? meta[key]
    : null;
}

const CHARACTER_HARD_BACKFILL_FIELDS = new Set([
  'appearance',
  'detail',
  'description',
  'desc',
  'scaleRule',
  'negativeRules',
  'signatureColors',
  'canonicalPrompt',
]);

function characterBackfillFieldStrength(key: string): 'hard' | 'soft' {
  return CHARACTER_HARD_BACKFILL_FIELDS.has(key) ? 'hard' : 'soft';
}

function mergeMissingEntityFields(current: any, incoming: any, opts: { source: string; strength: 'hard' | 'soft'; now: string; fieldStrength?: (key: string) => 'hard' | 'soft' }) {
  if (!current || typeof current !== 'object' || !incoming || typeof incoming !== 'object') return { value: current, changed: false };
  let changed = false;
  const next = { ...current };
  const nextMeta = next.fieldMeta && typeof next.fieldMeta === 'object' && !Array.isArray(next.fieldMeta)
    ? { ...next.fieldMeta }
    : {};
  for (const key of Object.keys(incoming)) {
    if (key === 'id' || key === 'characterId' || key === 'sourceAssetId' || key === 'fieldMeta') continue;
    const merged = mergeMissingTemplateValue(next[key], incoming[key]);
    if (merged.changed) {
      const incomingMeta = entityFieldMeta(incoming, key);
      const incomingStrength = firstText(incomingMeta?.strength).toLowerCase();
      next[key] = merged.value;
      nextMeta[key] = {
        ...(nextMeta[key] || {}),
        ...(incomingMeta || {}),
        source: firstText(incomingMeta?.source, opts.source),
        strength: incomingStrength === 'hard' || incomingStrength === 'soft'
          ? incomingStrength
          : opts.fieldStrength
            ? opts.fieldStrength(key)
            : opts.strength,
        updatedAt: opts.now,
      };
      changed = true;
    }
  }
  if (changed) next.fieldMeta = nextMeta;
  return { value: next, changed };
}

function mergeEntityArrayByKey(current: any, incoming: any, opts: { source: string; strength: 'hard' | 'soft'; now: string; appendMissing?: boolean; fieldStrength?: (key: string) => 'hard' | 'soft' }) {
  const currentList = Array.isArray(current) ? current : [];
  const incomingList = Array.isArray(incoming) ? incoming : [];
  if (!currentList.length && opts.appendMissing && incomingList.length) {
    return { value: clonePlain(incomingList), changed: true };
  }
  if (!currentList.length || !incomingList.length) return { value: current, changed: false };
  const incomingByKey = new Map<string, any>();
  for (const item of incomingList) {
    const key = entityKey(item);
    if (key) incomingByKey.set(key, item);
  }
  let changed = false;
  const next = currentList.map((item) => {
    const key = entityKey(item);
    const incomingItem = key ? incomingByKey.get(key) : null;
    if (!incomingItem) return item;
    const merged = mergeMissingEntityFields(item, incomingItem, opts);
    changed = changed || merged.changed;
    return merged.value;
  });
  if (opts.appendMissing) {
    const existingKeys = new Set(next.map(entityKey).filter(Boolean));
    for (const item of incomingList) {
      const key = entityKey(item);
      if (key && !existingKeys.has(key)) {
        next.push(clonePlain(item));
        existingKeys.add(key);
        changed = true;
      }
    }
  }
  return { value: next, changed };
}

function filterTemplateInclude(input: any, include: BuildWorldTemplateInclude | undefined) {
  const out = { ...(input && typeof input === 'object' ? input : {}) };
  if (include?.characters === false) {
    out.characters = [];
    out.characterCandidates = [];
  }
  if (include?.locations === false) out.locations = [];
  if (include?.props === false) out.props = [];
  if (include?.terminology === false) out.terminology = {};
  return out;
}

function mapReferencePanels(referenceLock: any) {
  const panels = {
    sheetUrl: firstText(referenceLock?.sheetUrl),
    headshotUrl: firstText(referenceLock?.headshotUrl),
    frontUrl: firstText(referenceLock?.frontUrl),
    sideUrl: firstText(referenceLock?.sideUrl),
    backUrl: firstText(referenceLock?.backUrl),
  };
  return Object.fromEntries(Object.entries(panels).filter(([, value]) => value));
}

function mapCharacterLockToWorldCharacter(lock: any, sourceAsset?: any) {
  const projectedLock = sourceAsset ? buildAssetAuthoritativeCharacterLock(lock, sourceAsset) : lock;
  const identity = projectedLock?.identityLock || {};
  const visual = projectedLock?.visualLock || {};
  const performance = projectedLock?.performanceLock || {};
  const voice = projectedLock?.voiceLock || {};
  const referencePanels = mapReferencePanels(projectedLock?.referenceLock || {});
  const previewUrl = firstText(referencePanels.headshotUrl, referencePanels.frontUrl, referencePanels.sheetUrl, sourceAsset?.realPhotoUrl, sourceAsset?.imageUrl, sourceAsset?.rawUrl);
  return {
    id: firstText(projectedLock?.characterId, sourceAsset?.id),
    characterId: firstText(projectedLock?.characterId, sourceAsset?.characterId),
    sourceAssetId: firstText(projectedLock?.sourceAssetId, sourceAsset?.id),
    name: firstText(projectedLock?.canonicalName, sourceAsset?.name, identity.role),
    aliases: cleanList(projectedLock?.aliases || [sourceAsset?.name, sourceAsset?.role], 12),
    role: firstText(identity.role, sourceAsset?.role),
    identity: firstText(identity.identity, sourceAsset?.identity),
    entityType: identity.entityType === 'non-human' ? 'non-human' : 'human',
    species: firstText(identity.species),
    gender: firstText(identity.gender),
    ageBand: firstText(identity.ageBand),
    appearance: firstText(visual.appearance, sourceAsset?.appearance),
    clothing: firstText(visual.clothing, sourceAsset?.clothing),
    equipment: firstText(visual.equipment, sourceAsset?.equipment),
    description: firstText(sourceAsset?.description, sourceAsset?.intro, identity.identity),
    temperament: firstText(performance.temperament, sourceAsset?.temperament),
    actionTraits: firstText(performance.actionTraits, sourceAsset?.actionTraits),
    gestureRules: cleanList(performance.gestureRules, 8),
    negativeRules: cleanList(visual.negativeRules, 12),
    signatureColors: cleanList(visual.signatureColors, 8),
    canonicalPrompt: sourceAsset ? '' : firstText(visual.canonicalPrompt),
    referencePanels,
    realPhotoUrl: previewUrl || undefined,
    imageUrl: firstText(sourceAsset?.imageUrl, sourceAsset?.rawUrl) || undefined,
    voiceHint: {
      voiceGender: firstText(voice.voiceGender) || undefined,
      voiceAge: firstText(voice.voiceAge) || undefined,
      timbre: firstText(voice.timbre) || undefined,
      speechStyle: firstText(voice.speechStyle) || undefined,
      accent: firstText(voice.accent) || undefined,
      negativeRules: cleanList(voice.negativeRules, 8),
    },
  };
}

function mapCharacterAssetToWorldCharacter(asset: any) {
  return {
    id: firstText(asset.characterId, asset.id),
    characterId: firstText(asset.characterId, asset.id),
    name: firstText(asset.name, asset.role),
    role: firstText(asset.role),
    identity: firstText(asset.identity),
    entityType: asset.entityType === 'non-human' ? 'non-human' : 'human',
    appearance: firstText(asset.appearance, asset.detail, asset.intro),
    clothing: firstText(asset.clothing),
    equipment: firstText(asset.equipment),
    realPhotoUrl: firstText(asset.realPhotoUrl, asset.imageUrl, asset.rawUrl) || undefined,
    imageUrl: firstText(asset.imageUrl, asset.rawUrl) || undefined,
  };
}

function splitWorldCharactersFromProject(project: any, characterIds?: string[]) {
  const allowed = characterIds?.length ? new Set(characterIds.map(String)) : null;
  const assets = listCharacterAssetsForAuthority(project);
  const locks = Array.isArray(project?.consistency?.characters) ? project.consistency.characters : [];
  if (locks.length) {
    const characters: any[] = [];
    const characterCandidates: any[] = [];
    for (const lock of locks) {
      const explicitlySelected = !!allowed && (
        allowed.has(String(lock?.characterId || '')) ||
        allowed.has(String(lock?.canonicalName || ''))
      );
      if (allowed && !explicitlySelected) continue;
      const mapped = mapCharacterLockToWorldCharacter(lock, resolveCharacterAssetForEntity(project, lock).asset);
      if (allowed || lock?.status === 'locked') {
        characters.push(mapped);
      } else {
        characterCandidates.push(mapped);
      }
    }
    return {
      characters: mergeWorldCharacterPools(characters),
      characterCandidates: removeCharactersAlreadyInPool(mergeWorldCharacterPools(characterCandidates), characters),
    };
  }
  const characters = assets
    .filter((asset: any) => !allowed || allowed.has(String(asset?.characterId || '')) || allowed.has(String(asset?.id || '')) || allowed.has(String(asset?.name || '')))
    .map(mapCharacterAssetToWorldCharacter);
  return {
    characters: mergeWorldCharacterPools(characters),
    characterCandidates: [],
  };
}

function mapCharactersFromProject(project: any, characterIds?: string[]) {
  return splitWorldCharactersFromProject(project, characterIds).characters;
}

function applyAssetAuthorityToSnapshotCharacters(project: any, characters: any) {
  if (!Array.isArray(characters)) return characters;
  return characters.map((character) => {
    const resolution = resolveCharacterAssetForEntity(project, character);
    return applyAssetAuthorityToWorldCharacter(character, resolution.asset);
  });
}

type BuildWorldTemplateInclude = {
  characters?: boolean;
  locations?: boolean;
  props?: boolean;
  terminology?: boolean;
};

function includeEnabled(include: BuildWorldTemplateInclude | undefined, key: keyof BuildWorldTemplateInclude) {
  return include?.[key] !== false;
}

function preferredStyleTemplateFromProject(project: any) {
  const snapshot = project?.styleTemplateSnapshot && typeof project.styleTemplateSnapshot === 'object'
    ? project.styleTemplateSnapshot
    : {};
  const preferredStyleTemplateId = cleanString(
    project?.selectedStyleTemplateId
      || snapshot.id
      || snapshot.templateId
      || snapshot.template_id
      || '',
    100,
  );
  if (!preferredStyleTemplateId) return {};
  const preferredStyleTemplateName = cleanString(
    snapshot.name
      || snapshot.title
      || snapshot.styleName
      || snapshot.label
      || '',
    120,
  );
  return {
    preferredStyleTemplateId,
    ...(preferredStyleTemplateName ? { preferredStyleTemplateName } : {}),
    preferredStyleTemplateSource: 'project_style_selection',
  };
}

export function buildWorldTemplateFromProject(project: any, opts: { templateId?: string; name?: string; include?: BuildWorldTemplateInclude } = {}) {
  const styleBible = project?.styleBible && typeof project.styleBible === 'object' ? project.styleBible : {};
  const worldRulesRaw = styleBible.worldRules || styleBible.world_rules || {};
  const environments = Array.isArray(project?.environments) ? project.environments : [];
  const props = Array.isArray(project?.props) ? project.props : [];
  const include = opts.include || {};
  const preferredStyleFields = preferredStyleTemplateFromProject(project);
  const characterSplit = includeEnabled(include, 'characters')
    ? splitWorldCharactersFromProject(project)
    : { characters: [], characterCandidates: [] };
  const setting = {
    era: firstText(worldRulesRaw.era, styleBible.era),
    geography: firstText(worldRulesRaw.geography, styleBible.geography),
    society: firstText(worldRulesRaw.society, worldRulesRaw.societyStructure, styleBible.society),
    powerSystem: firstText(worldRulesRaw.powerSystem, worldRulesRaw.power_system, styleBible.powerSystem),
    rules: cleanList([worldRulesRaw.rules, worldRulesRaw.basicRules, styleBible.worldRules], 16),
  };
  return {
    id: opts.templateId || `world_${cleanId(project?.id || randomUUID())}`,
    name: opts.name || `${firstText(project?.title, '未命名项目')} 世界观`,
    sourceProjectId: firstText(project?.id),
    schemaVersion: 2,
    source: 'project_sync',
    ...preferredStyleFields,
    summary: firstText(styleBible.summary, styleBible.logline, project?.description),
    setting,
    worldRules: cleanList([styleBible.worldRules, worldRulesRaw.rules], 16),
    storyRules: {
      allowedConflicts: cleanList(styleBible.allowedConflicts || styleBible.conflicts, 12),
      forbiddenPlots: cleanList(styleBible.forbiddenPlots || styleBible.forbiddenRules, 12),
      toneBoundaries: cleanList(styleBible.toneBoundaries || styleBible.toneRules, 12),
    },
    terminology: includeEnabled(include, 'terminology') ? (styleBible.terminology || styleBible.terms || {}) : {},
    forbiddenRules: cleanList([styleBible.forbiddenRules, worldRulesRaw.forbiddenRules], 16),
    characters: characterSplit.characters,
    characterCandidates: characterSplit.characterCandidates,
    locations: includeEnabled(include, 'locations') ? environments.map((env: any) => ({
      id: firstText(env.id, env.sceneId),
      name: firstText(env.name, env.sceneName, env.title),
      description: firstText(env.description, env.detail, env.intro),
      atmosphere: firstText(env.atmosphere, env.mood),
      imageUrl: firstText(env.imageUrl, env.rawUrl) || undefined,
    })) : [],
    props: includeEnabled(include, 'props') ? props.map((prop: any) => ({
      id: firstText(prop.id, prop.propId),
      name: firstText(prop.name, prop.title),
      function: firstText(prop.function, prop.description, prop.detail),
      ownership: firstText(prop.ownership, prop.owner),
      visualFeatures: firstText(prop.visualFeatures, prop.appearance),
      imageUrl: firstText(prop.imageUrl, prop.rawUrl) || undefined,
    })) : [],
  };
}

export function buildWorldTemplateFromProjectSnapshot(
  project: any,
  opts: { templateId?: string; name?: string; include?: BuildWorldTemplateInclude; mode?: 'create' | 'update' } = {},
) {
  const snapshot = project?.worldTemplateSnapshot && typeof project.worldTemplateSnapshot === 'object'
    ? clonePlain(project.worldTemplateSnapshot)
    : null;
  if (!snapshot) return null;
  const templateId = opts.templateId
    || (opts.mode === 'create' ? `world_${cleanId(project?.id || randomUUID())}` : firstText(snapshot.id))
    || `world_${cleanId(project?.id || randomUUID())}`;
  const preferredStyleFields = preferredStyleTemplateFromProject(project);
  const projectCharacterSplit = splitWorldCharactersFromProject(project);
  const snapshotCharacters = applyAssetAuthorityToSnapshotCharacters(project, snapshot.characters);
  const snapshotCandidates = applyAssetAuthorityToSnapshotCharacters(project, snapshot.characterCandidates);
  const characterCandidates = removeCharactersAlreadyInPool(
    mergeWorldCharacterPools(snapshotCandidates, projectCharacterSplit.characterCandidates),
    snapshotCharacters,
  );
  const projectedSnapshot = {
    ...snapshot,
    characters: snapshotCharacters,
    characterCandidates,
  };
  return filterTemplateInclude({
    ...projectedSnapshot,
    ...preferredStyleFields,
    id: templateId,
    name: opts.name || firstText(snapshot.name, snapshot.title, `${firstText(project?.title, project?.name, '未命名项目')} 世界观`),
    sourceProjectId: firstText(project?.id, snapshot.sourceProjectId, snapshot.source_project_id),
    schemaVersion: Math.max(2, Number(snapshot.schemaVersion || snapshot.schema_version || 2) || 2),
    source: 'project_snapshot_sync',
  }, opts.include);
}

export function mergeWorldTemplateSnapshotIntoSource(
  sourceTemplate: any,
  snapshotTemplate: any,
  opts: { name?: string; templateId?: string; include?: BuildWorldTemplateInclude } = {},
) {
  const source = sourceTemplate && typeof sourceTemplate === 'object' ? clonePlain(sourceTemplate) : {};
  const incoming = filterTemplateInclude(snapshotTemplate, opts.include);
  const id = opts.templateId || firstText(source.id, incoming.id);
  let changed = false;
  const next = {
    ...source,
    id,
    name: opts.name || firstText(source.name, incoming.name, '未命名世界观模板'),
    sourceProjectId: firstText(source.sourceProjectId, source.source_project_id, incoming.sourceProjectId, incoming.source_project_id) || null,
    coverImageId: firstText(source.coverImageId, source.cover_image_id, incoming.coverImageId, incoming.cover_image_id) || null,
    schemaVersion: Math.max(2, Number(source.schemaVersion || source.schema_version || incoming.schemaVersion || 2) || 2),
    source: firstText(source.source, incoming.source, 'project_snapshot_sync'),
  };
  if (next.name !== source.name && opts.name) changed = true;

  for (const key of Object.keys(incoming)) {
    if (['id', 'name', 'sourceProjectId', 'source_project_id', 'coverImageId', 'cover_image_id', 'schemaVersion', 'schema_version', 'source'].includes(key)) continue;
    if ((key === 'characters' || key === 'characterCandidates') && opts.include?.characters === false) {
      if (!Array.isArray((next as any)[key]) || (next as any)[key].length) {
        (next as any)[key] = [];
        changed = true;
      }
      continue;
    }
    if (key === 'characters' || key === 'characterCandidates' || key === 'locations' || key === 'props') {
      const merged = mergeEntityArrayByKey((next as any)[key], incoming[key], {
        source: 'snapshot_sync',
        strength: 'soft',
        now: new Date().toISOString(),
        appendMissing: true,
      });
      if (merged.changed) {
        (next as any)[key] = merged.value;
        changed = true;
      }
      continue;
    }
    const merged = mergeMissingTemplateValue((next as any)[key], incoming[key]);
    if (merged.changed) {
      (next as any)[key] = merged.value;
      changed = true;
    }
  }

  return { template: next, changed };
}

function assetsByAnyKey(project: any) {
  const assets = Array.isArray(project?.characters)
    ? project.characters
    : Array.isArray(project?.assets?.characters)
      ? project.assets.characters
      : [];
  const map = new Map<string, any>();
  for (const asset of assets) {
    for (const key of [asset?.characterId, asset?.id, asset?.name, asset?.role]) {
      const clean = firstText(key).toLowerCase();
      if (clean) map.set(clean, asset);
    }
  }
  return map;
}

export function mergeProjectFactsIntoWorldSnapshot(project: any, opts: { now?: string } = {}) {
  const snapshot = project?.worldTemplateSnapshot && typeof project.worldTemplateSnapshot === 'object'
    ? clonePlain(project.worldTemplateSnapshot)
    : null;
  if (!snapshot) return { worldTemplateSnapshot: null, changed: false };
  const now = opts.now || new Date().toISOString();
  let changed = false;
  const locks = Array.isArray(project?.consistency?.characters) ? project.consistency.characters : [];
  const incomingCharacters = locks.map((lock: any) => {
    return mapCharacterLockToWorldCharacter(lock, resolveCharacterAssetForEntity(project, lock).asset);
  });
  const characterMerge = mergeEntityArrayByKey(snapshot.characters, incomingCharacters, {
    source: 'project_backfill',
    strength: 'soft',
    fieldStrength: characterBackfillFieldStrength,
    now,
    appendMissing: false,
  });
  if (characterMerge.changed) {
    snapshot.characters = characterMerge.value;
    changed = true;
  }

  const incomingLocations = Array.isArray(project?.environments)
    ? project.environments
    : Array.isArray(project?.assets?.scenes)
      ? project.assets.scenes
      : [];
  const locationMerge = mergeEntityArrayByKey(snapshot.locations, incomingLocations.map((env: any) => ({
    id: firstText(env.id, env.sceneId),
    name: firstText(env.name, env.sceneName, env.title),
    description: firstText(env.description, env.detail, env.intro),
    atmosphere: firstText(env.atmosphere, env.mood),
    imageUrl: firstText(env.imageUrl, env.rawUrl) || undefined,
  })), {
    source: 'project_backfill',
    strength: 'soft',
    now,
    appendMissing: false,
  });
  if (locationMerge.changed) {
    snapshot.locations = locationMerge.value;
    changed = true;
  }

  const incomingProps = Array.isArray(project?.props)
    ? project.props
    : Array.isArray(project?.assets?.props)
      ? project.assets.props
      : [];
  const propMerge = mergeEntityArrayByKey(snapshot.props, incomingProps.map((prop: any) => ({
    id: firstText(prop.id, prop.propId),
    name: firstText(prop.name, prop.title),
    function: firstText(prop.function, prop.description, prop.detail),
    ownership: firstText(prop.ownership, prop.owner),
    visualFeatures: firstText(prop.visualFeatures, prop.appearance),
    imageUrl: firstText(prop.imageUrl, prop.rawUrl) || undefined,
  })), {
    source: 'project_backfill',
    strength: 'soft',
    now,
    appendMissing: false,
  });
  if (propMerge.changed) {
    snapshot.props = propMerge.value;
    changed = true;
  }

  return { worldTemplateSnapshot: snapshot, changed };
}

export function mergeProjectCharacterLocksIntoWorldTemplate(
  userId: number,
  templateId: string,
  project: any,
  opts: { characterIds?: string[] } = {},
) {
  const template = getWorldTemplate(userId, templateId);
  if (!template) return null;
  const incoming = mapCharactersFromProject(project, opts.characterIds);
  const byKey = new Map<string, any>();
  for (const ch of Array.isArray((template as any).characters) ? (template as any).characters : []) {
    const key = firstText(ch.characterId, ch.id, ch.name);
    if (key) byKey.set(key, ch);
  }
  for (const ch of incoming) {
    const key = firstText(ch.characterId, ch.id, ch.name);
    if (key) byKey.set(key, { ...(byKey.get(key) || {}), ...ch });
  }
  return upsertWorldTemplate(userId, {
    ...template,
    characters: Array.from(byKey.values()),
  });
}
