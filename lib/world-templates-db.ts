import { randomUUID } from 'node:crypto';
import { getDb } from './db';

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
    createdAt: data.createdAt || row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: WorldTemplateRow) {
  const data = parseData(row);
  const characters = Array.isArray(data.characters) ? data.characters : [];
  const characterPreviewUrls = characters
    .map((ch: any) => (
      ch?.realPhotoUrl
      || ch?.rawUrl
      || ch?.imageUrl
      || ch?.pencilUrl
      || ch?.referencePanels?.headshotUrl
      || ch?.referencePanels?.frontUrl
      || ch?.referencePanels?.sheetUrl
      || ''
    ))
    .filter(Boolean)
    .slice(0, 4);
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    sourceProjectId: row.source_project_id || data.sourceProjectId || null,
    coverImageId: row.cover_image_id || data.coverImageId || null,
    coverImageUrl: data.coverImageUrl || characterPreviewUrls[0] || null,
    schemaVersion: row.schema_version || data.schemaVersion || 1,
    source: row.source || data.source || 'user',
    migrationKey: data.migrationKey || templateFingerprint(data),
    characterCount: characters.length,
    characterPreviewUrls,
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
  const data = stripVisualFields({
    ...raw,
    id,
    name,
    sourceProjectId,
    coverImageId,
    schemaVersion,
    source,
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
  const identity = lock?.identityLock || {};
  const visual = lock?.visualLock || {};
  const performance = lock?.performanceLock || {};
  const voice = lock?.voiceLock || {};
  const referencePanels = mapReferencePanels(lock?.referenceLock || {});
  const previewUrl = firstText(referencePanels.headshotUrl, referencePanels.frontUrl, referencePanels.sheetUrl, sourceAsset?.realPhotoUrl, sourceAsset?.imageUrl, sourceAsset?.rawUrl);
  return {
    id: firstText(lock?.characterId, sourceAsset?.id),
    characterId: firstText(lock?.characterId, sourceAsset?.characterId),
    sourceAssetId: firstText(lock?.sourceAssetId, sourceAsset?.id),
    name: firstText(lock?.canonicalName, sourceAsset?.name, identity.role),
    aliases: cleanList(lock?.aliases || [sourceAsset?.name, sourceAsset?.role], 12),
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
    canonicalPrompt: firstText(visual.canonicalPrompt, sourceAsset?.imagePrompt),
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

function mapCharactersFromProject(project: any, characterIds?: string[]) {
  const allowed = characterIds?.length ? new Set(characterIds.map(String)) : null;
  const assets = Array.isArray(project?.characters) ? project.characters : [];
  const assetsById = new Map<string, any>();
  for (const asset of assets) {
    for (const key of [asset?.characterId, asset?.id, asset?.name, asset?.role]) {
      const id = String(key || '').trim();
      if (id) assetsById.set(id, asset);
    }
  }
  const locks = Array.isArray(project?.consistency?.characters) ? project.consistency.characters : [];
  if (locks.length) {
    return locks
      .filter((lock: any) => {
        const explicitlySelected = !!allowed && (
          allowed.has(String(lock?.characterId || '')) ||
          allowed.has(String(lock?.canonicalName || ''))
        );
        if (allowed) return explicitlySelected;
        return lock?.status === 'locked';
      })
      .map((lock: any) => mapCharacterLockToWorldCharacter(lock, assetsById.get(String(lock?.sourceAssetId || '')) || assetsById.get(String(lock?.characterId || ''))));
  }
  return assets
    .filter((asset: any) => !allowed || allowed.has(String(asset?.characterId || '')) || allowed.has(String(asset?.id || '')) || allowed.has(String(asset?.name || '')))
    .map((asset: any) => ({
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
    }));
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

export function buildWorldTemplateFromProject(project: any, opts: { templateId?: string; name?: string; include?: BuildWorldTemplateInclude } = {}) {
  const styleBible = project?.styleBible && typeof project.styleBible === 'object' ? project.styleBible : {};
  const worldRulesRaw = styleBible.worldRules || styleBible.world_rules || {};
  const environments = Array.isArray(project?.environments) ? project.environments : [];
  const props = Array.isArray(project?.props) ? project.props : [];
  const include = opts.include || {};
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
    characters: includeEnabled(include, 'characters') ? mapCharactersFromProject(project) : [],
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
