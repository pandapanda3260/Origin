import { createHash, randomUUID } from 'node:crypto';
import { resolveLLMConfig } from './llm';
import { resolveLocalImagePath } from './image-gen';
import {
  FRAME_IMAGE_REFERENCE_IMAGE_BUDGET,
  buildFrameImageGenerationPlan,
  summarizePlanForAudit,
  type FrameImageGenerationPlan,
  type FrameImagePlanSummary,
  type FrameReference,
  type FrameRefRole,
} from './frame-image-plan';
import {
  computeFirstFrameSourceHash,
  storyboardShotIndices,
} from './frame-workflow-state';
import { listAssetLibraryItems } from './asset-library';
import { getProjectByIdForUser, patchProjectForUser } from './projects-db';

export type FirstFrameEditAssetRole = 'character' | 'scene' | 'prop';
export type FirstFrameMaterialTileRole = 'scene' | 'char' | 'prop';

export type FirstFrameReferenceOverride = {
  role?: string;
  assetId?: string;
  assetName?: string;
  slot?: number;
  imageNo?: number;
};

export type FirstFrameReferenceAdd = {
  role: FirstFrameEditAssetRole;
  assetId: string;
};

export type FirstFrameReferenceSelection = {
  sourceHash: string | null;
  mode: 'manual';
  includeIds: string[];
  excludeIds?: string[];
  order?: string[];
  version: string;
};

export type FirstFrameReferenceAttachment = {
  id: string;
  imageId: string;
  role: FirstFrameMaterialTileRole;
  name?: string;
  url: string;
  thumbUrl?: string;
  uploadedAt: string;
  uploadedBy: number;
};

export type FirstFrameReferenceMaterial = {
  id: string;
  imageId: string;
  role: FirstFrameMaterialTileRole;
  name?: string;
  url: string;
  thumbUrl?: string;
  uploadedAt: string;
  uploadedBy: number;
};

export type FirstFrameMaterialTile = {
  id: string;
  imageId: string;
  role: FirstFrameMaterialTileRole;
  url: string;
  thumbUrl: string;
  name?: string;
  order: number;
  source: 'default' | 'manual' | 'upload' | 'library';
};

export type FirstFrameMaterialPanel = {
  sourceHash: string | null;
  selectionVersion: string;
  // Product-side display allowance. `cap` stays the effective model submission limit.
  productCap: number;
  cap: number;
  used: number;
  remaining: number;
  mode: 'auto' | 'manual';
  groups: {
    scene: FirstFrameMaterialTile[];
    char: FirstFrameMaterialTile[];
    prop: FirstFrameMaterialTile[];
  };
  candidateGroups: {
    scene: FirstFrameMaterialTile[];
    char: FirstFrameMaterialTile[];
    prop: FirstFrameMaterialTile[];
  };
  orderedTileIds: string[];
  orderedTiles: FirstFrameMaterialTile[];
  omitted?: {
    unavailableImage?: number;
    capacityLimited?: number;
    legacyUnavailable?: number;
  };
  invalid?: {
    code: 'selection_over_capacity' | 'selection_unavailable';
    message: string;
  };
};

export type FirstFrameEditDraft = {
  sourceHash: string | null;
  content?: string;
  promptOverride?: string;
  referenceOverrides?: {
    excluded?: FirstFrameReferenceOverride[];
    added?: FirstFrameReferenceAdd[];
  };
  firstFrameReferenceSelection?: FirstFrameReferenceSelection;
  firstFrameReferenceAttachments?: FirstFrameReferenceAttachment[];
  negativePromptOverride?: string;
  updatedAt: string;
  updatedBy: number;
};

export type FirstFrameDraftValidationError = {
  field: string;
  message: string;
};

export type FirstFrameDraftWarningField =
  | 'content'
  | 'negativePromptOverride'
  | 'referenceOverrides'
  | 'firstFrameReferenceSelection';

export type FirstFrameDraftWarning = {
  code: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
  scope?: 'global' | 'field' | 'list';
  field?: FirstFrameDraftWarningField;
};

export type FirstFrameDraftFingerprintPayload = {
  content?: string;
  referenceOverrides?: {
    excluded?: FirstFrameReferenceOverride[];
    added?: FirstFrameReferenceAdd[];
  };
  firstFrameReferenceSelection?: Omit<FirstFrameReferenceSelection, 'sourceHash' | 'version'> & {
    sourceHash?: string | null;
    version?: string;
  };
  firstFrameReferenceAttachments?: FirstFrameReferenceAttachment[];
  negativePromptOverride?: string;
};

export const LEGACY_STYLE_RULE_BLOCK_PREFIX = '【旧局部风格规则（已合并为提示词补充）】';
export const LEGACY_STYLE_RULE_NOTICE_MESSAGE = '已把旧版“局部风格规则”合并到提示词补充中，请检查是否需要保留。若需要保留项目风格与锁定规则，请不要在该标记块前插入文本。';

export type FirstFramePlanNotice = {
  code: 'legacy_style_rules_merged';
  message: string;
};

export type FirstFrameEditDraftState = {
  draft: FirstFrameEditDraft | null;
  didMigrate: boolean;
};

export type FirstFrameBasePromptOrigin = 'system' | 'draft_commit' | 'backup_restore' | 'history_restore';

export type FirstFrameBasePromptState = {
  content: string;
  sourceHash: string | null;
  updatedAt: string;
  updatedBy: number;
  origin: FirstFrameBasePromptOrigin;
};

export type FirstFrameBackupState = {
  content: string;
  sourceHash: string | null;
  createdAt: string;
};

export type FirstFramePromptReconcileState = {
  plan: FrameImageGenerationPlan;
  planSummary: FrameImagePlanSummary;
  sourceHash: string | null;
  shotIndices: number[];
  modelSnapshot: FrameImageGenerationPlan['modelSnapshot'];
  firstFrameBasePrompt: FirstFrameBasePromptState;
  firstFrameBackup: FirstFrameBackupState;
  firstFrameBasePromptStale: boolean;
  firstFrameDraftStale: boolean;
  slotPatch: Record<string, any> | null;
};

export class FirstFrameDraftValidationException extends Error {
  errors: FirstFrameDraftValidationError[];

  constructor(errors: FirstFrameDraftValidationError[]) {
    super(errors[0]?.message || 'validation_failed');
    this.name = 'FirstFrameDraftValidationException';
    this.errors = errors;
  }
}

export class StaleFirstFrameDraftException extends Error {
  constructor(message = 'stale_edit_draft') {
    super(message);
    this.name = 'StaleFirstFrameDraftException';
  }
}

export class MissingFirstFrameDraftException extends Error {
  constructor(message = 'no_edit_draft') {
    super(message);
    this.name = 'MissingFirstFrameDraftException';
  }
}

export function isFirstFrameEditDraftStale(draftSourceHash: string | null | undefined, currentSourceHash: string | null | undefined): boolean {
  if (!draftSourceHash || !currentSourceHash) return true;
  return draftSourceHash !== currentSourceHash;
}

export const MAX_PROMPT_OVERRIDE_CHARS = 5000;
export const MAX_NEGATIVE_PROMPT_CHARS = 500;
export const MAX_STYLE_RULES = 20;
export const MAX_STYLE_RULE_CHARS = 200;

function cleanText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+\n/g, '\n').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function cleanDraftTextForSave(value: unknown): string {
  return String(value ?? '').replace(/\s+\n/g, '\n').trim();
}

function draftContentValue(draft: any): unknown {
  if (draft && typeof draft === 'object' && Object.prototype.hasOwnProperty.call(draft, 'content')) {
    return draft.content;
  }
  return draft?.promptOverride;
}

function hashText(value: string) {
  return createHash('sha256').update(value || '').digest('hex');
}

function cleanLegacyStyleRuleOverrides(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => cleanText(item, MAX_STYLE_RULE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_STYLE_RULES);
}

function legacyStyleRuleBlock(rules: string[]): string {
  return `${LEGACY_STYLE_RULE_BLOCK_PREFIX}\n${rules.map((rule) => `- ${rule}`).join('\n')}`;
}

export function isLegacyStyleRulePromptOverride(value: unknown): boolean {
  return String(value ?? '').trimStart().startsWith(LEGACY_STYLE_RULE_BLOCK_PREFIX);
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}

function cleanAssetRole(value: unknown): FirstFrameEditAssetRole | null {
  const raw = String(value || '').trim();
  if (raw === 'character' || raw === 'char') return 'character';
  if (raw === 'scene') return 'scene';
  if (raw === 'prop') return 'prop';
  return null;
}

function cleanTileRole(value: unknown): FirstFrameMaterialTileRole | null {
  const raw = String(value || '').trim();
  if (raw === 'character' || raw === 'char') return 'char';
  if (raw === 'scene') return 'scene';
  if (raw === 'prop') return 'prop';
  return null;
}

function frameRoleToTileRole(role: unknown): FirstFrameMaterialTileRole | null {
  const raw = String(role || '').trim();
  if (raw === 'character' || raw === 'crowd') return 'char';
  if (raw === 'scene') return 'scene';
  if (raw === 'prop') return 'prop';
  return null;
}

function tileRoleToFrameRole(role: FirstFrameMaterialTileRole): FrameRefRole {
  return role === 'char' ? 'character' : role;
}

function assetUrl(asset: any): string {
  return String(
    asset?.reference?.currentUrl ||
    asset?.reference?.lastKnownGoodUrl ||
    asset?.imageUrl ||
    asset?.rawUrl ||
    asset?.pencilUrl ||
    asset?.realPhotoUrl ||
    '',
  ).trim();
}

function assetName(asset: any): string {
  return String(asset?.name || asset?.role || asset?.sceneName || asset?.location || asset?.propName || asset?.title || '').trim();
}

function assetLocalPath(asset: any, url: string, userId: number): string | undefined {
  return cleanId(asset?.reference?.localPath || asset?.localPath || asset?.filePath || asset?.path)
    || (url ? resolveLocalImagePath(url, userId) || undefined : undefined);
}

function cleanId(value: unknown): string {
  return String(value || '').trim();
}

function cleanIdList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  return uniqByKey(raw.map(cleanId).filter(Boolean), (item) => item);
}

function parseImageIdFromUrl(value: unknown): string {
  const url = String(value || '').trim();
  const m = /\/api\/images\/file\/([0-9a-fA-F-]{36})/.exec(url);
  return m ? m[1] : '';
}

function selectionVersion(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function nextFirstFrameReferenceMaterialsVersion(): string {
  return `materials:${selectionVersion()}`;
}

function normalizeReferenceSelection(input: any, sourceHash: string | null): FirstFrameReferenceSelection | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rawIncludeIds = cleanIdList(input.includeIds);
  const orderIds = cleanIdList(input.order);
  const includeSet = new Set(rawIncludeIds);
  const orderedIncludeIds = orderIds.filter((id) => includeSet.has(id));
  const orderedSet = new Set(orderedIncludeIds);
  const includeIds = [...orderedIncludeIds, ...rawIncludeIds.filter((id) => !orderedSet.has(id))];
  const excludeIds = cleanIdList(input.excludeIds);
  const hasManualShape = input.mode === 'manual' || Array.isArray(input.includeIds) || Array.isArray(input.excludeIds) || Array.isArray(input.order);
  if (!hasManualShape) return undefined;
  return {
    sourceHash,
    mode: 'manual',
    includeIds,
    ...(excludeIds.length ? { excludeIds } : {}),
    version: cleanId(input.version) || selectionVersion(),
  };
}

function normalizeReferenceAttachments(input: any, userId: number): FirstFrameReferenceAttachment[] {
  const raw = Array.isArray(input) ? input : [];
  return uniqByKey(raw.map((item: any) => {
    const role = cleanTileRole(item?.role);
    const url = cleanId(item?.url);
    const imageId = cleanId(item?.imageId) || parseImageIdFromUrl(url);
    const id = cleanId(item?.id) || (imageId ? `upload:${imageId}` : '');
    if (!role || !url || !imageId || !id) return null;
    return {
      id,
      imageId,
      role,
      ...(cleanId(item?.name) ? { name: cleanText(item.name, 80) } : {}),
      url,
      thumbUrl: cleanId(item?.thumbUrl) || url,
      uploadedAt: cleanId(item?.uploadedAt) || new Date(0).toISOString(),
      uploadedBy: Number.isFinite(Number(item?.uploadedBy)) ? Math.floor(Number(item.uploadedBy)) : userId,
    };
  }).filter(Boolean) as FirstFrameReferenceAttachment[], (item) => item.id);
}

export function normalizeFirstFrameReferenceMaterials(project: any): FirstFrameReferenceMaterial[] {
  const raw = Array.isArray(project?.firstFrameReferenceMaterials) ? project.firstFrameReferenceMaterials : [];
  return uniqByKey(raw.map((item: any) => {
    const role = cleanTileRole(item?.role);
    const url = cleanId(item?.url);
    const imageId = cleanId(item?.imageId) || parseImageIdFromUrl(url);
    const id = cleanId(item?.id) || (imageId ? `upload:${imageId}` : '');
    if (!role || !url || !imageId || !id) return null;
    const uploadedBy = Number.isFinite(Number(item?.uploadedBy)) ? Math.floor(Number(item.uploadedBy)) : 0;
    return {
      id,
      imageId,
      role,
      ...(cleanId(item?.name) ? { name: cleanText(item.name, 80) } : {}),
      url,
      thumbUrl: cleanId(item?.thumbUrl) || url,
      uploadedAt: cleanId(item?.uploadedAt) || new Date(0).toISOString(),
      uploadedBy,
    };
  }).filter(Boolean) as FirstFrameReferenceMaterial[], (item) => item.id || item.imageId);
}

export function firstFrameReferenceMaterialsVersion(project: any): string {
  const explicit = cleanId(project?.firstFrameReferenceMaterialsVersion);
  if (explicit) return explicit;
  const materials = normalizeFirstFrameReferenceMaterials(project);
  return materials.length ? `materials:${hashText(stableJson(materials)).slice(0, 16)}` : '';
}

function assetLibraryRoleForStage(stage: unknown): FirstFrameMaterialTileRole | null {
  const raw = cleanId(stage);
  if (raw === 'asset_character') return 'char';
  if (raw === 'asset_scene') return 'scene';
  if (raw === 'asset_prop') return 'prop';
  return null;
}

function projectAssetLibraryItems(project: any, userId: number): any[] {
  const projectId = cleanId(project?.id);
  if (projectId) {
    try {
      return ['asset_character', 'asset_scene', 'asset_prop'].flatMap((stage) => (
        listAssetLibraryItems({
          ownerId: userId,
          projectId,
          assetKind: 'image',
          stage,
          limit: 100,
        }).items || []
      ));
    } catch (error) {
      console.warn('[first-frame-material-panel] asset library items skipped:', error);
    }
  }
  const attached = Array.isArray(project?.assetLibrary?.current) ? project.assetLibrary.current : [];
  return attached.filter((asset: any) => !!assetLibraryRoleForStage(asset?.stage) && asset?.kind === 'image');
}

function firstFrameAssetLibraryVersion(project: any, userId: number): string {
  const items = projectAssetLibraryItems(project, userId)
    .map((asset: any) => {
      const role = assetLibraryRoleForStage(asset?.stage);
      if (!role || asset?.kind !== 'image') return null;
      return {
        assetId: cleanId(asset.assetId),
        stage: cleanId(asset.stage),
        url: cleanId(asset.url),
        thumbUrl: cleanId(asset.thumbUrl),
        updatedAt: cleanId(asset.updatedAt),
      };
    })
    .filter(Boolean);
  return items.length ? `library:${hashText(stableJson(items)).slice(0, 16)}` : '';
}

function assetLibraryDisplayName(role: FirstFrameMaterialTileRole, asset: any): string {
  const explicit = cleanId(asset.name || asset.title || asset.assetName);
  if (explicit) return explicit;
  const base = role === 'char' ? '资产库角色图' : role === 'scene' ? '资产库场景图' : '资产库道具图';
  const at = cleanId(asset.updatedAt || asset.createdAt);
  if (at) {
    const date = new Date(at);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${base} ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
  }
  const shortId = cleanId(asset.assetId).slice(0, 8);
  return shortId ? `${base} ${shortId}` : base;
}

function candidateAssetIds(role: FirstFrameEditAssetRole, asset: any): string[] {
  const fields = role === 'character'
    ? [asset?.characterId, asset?.id, asset?.assetId, asset?.name, asset?.role]
    : role === 'scene'
      ? [asset?.sceneId, asset?.id, asset?.assetId, asset?.name, asset?.sceneName, asset?.location]
      : [asset?.propId, asset?.id, asset?.assetId, asset?.name, asset?.propName, asset?.title];
  return fields.map((v) => String(v || '').trim()).filter(Boolean);
}

function projectAssetsForRole(project: any, role: FirstFrameEditAssetRole): any[] {
  if (role === 'character') return Array.isArray(project?.assets?.characters) ? project.assets.characters : [];
  if (role === 'scene') return Array.isArray(project?.assets?.scenes) ? project.assets.scenes : [];
  return Array.isArray(project?.assets?.props) ? project.assets.props : [];
}

export function findFirstFrameAsset(project: any, role: FirstFrameEditAssetRole, assetId: string): any | null {
  const target = String(assetId || '').trim();
  if (!target) return null;
  return projectAssetsForRole(project, role).find((asset) => candidateAssetIds(role, asset).includes(target)) || null;
}

function referenceExcludeKey(ref: FrameReference): string {
  return [
    ref.slot ? `slot:${ref.slot}` : '',
    ref.imageNo ? `image:${ref.imageNo}` : '',
    ref.role ? `role:${ref.role}` : '',
    ref.assetId ? `id:${ref.assetId}` : '',
    ref.assetName ? `name:${ref.assetName}` : '',
  ].filter(Boolean).join('|').toLowerCase();
}

function normalizedReferenceOverrideKey(ref: FirstFrameReferenceOverride): string {
  return [
    ref.role ? `role:${ref.role}` : '',
    ref.assetId ? `id:${ref.assetId}` : '',
    ref.assetName ? `name:${ref.assetName}` : '',
    Number.isFinite(Number(ref.slot)) ? `slot:${Number(ref.slot)}` : '',
    Number.isFinite(Number(ref.imageNo)) ? `image:${Number(ref.imageNo)}` : '',
  ].filter(Boolean).join('|').toLowerCase();
}

function normalizedReferenceAddKey(ref: FirstFrameReferenceAdd): string {
  return `${ref.role}:${ref.assetId}`.toLowerCase();
}

function uniqByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function normalizeFirstFrameDraftForFingerprint(input: any): FirstFrameDraftFingerprintPayload {
  const draft = input && typeof input === 'object' ? input : {};
  const out: FirstFrameDraftFingerprintPayload = {};
  const prompt = cleanText(draftContentValue(draft), MAX_PROMPT_OVERRIDE_CHARS);
  if (prompt) out.content = prompt;

  const negative = cleanText(draft.negativePromptOverride, MAX_NEGATIVE_PROMPT_CHARS);
  if (negative) out.negativePromptOverride = negative;

  const rawExcluded = Array.isArray(draft.referenceOverrides?.excluded)
    ? draft.referenceOverrides.excluded
    : [];
  const excluded = uniqByKey(rawExcluded.map((item: any) => ({
    ...(item?.role ? { role: String(item.role).trim() } : {}),
    ...(item?.assetId ? { assetId: String(item.assetId).trim() } : {}),
    ...(item?.assetName ? { assetName: String(item.assetName).trim() } : {}),
    ...(Number.isFinite(Number(item?.slot)) ? { slot: Math.floor(Number(item.slot)) } : {}),
    ...(Number.isFinite(Number(item?.imageNo)) ? { imageNo: Math.floor(Number(item.imageNo)) } : {}),
  })).filter((item: FirstFrameReferenceOverride) => (
    item.role || item.assetId || item.assetName || item.slot || item.imageNo
  )), normalizedReferenceOverrideKey).sort((a, b) => normalizedReferenceOverrideKey(a).localeCompare(normalizedReferenceOverrideKey(b)));

  const rawAdded = Array.isArray(draft.referenceOverrides?.added)
    ? draft.referenceOverrides.added
    : [];
  const added = uniqByKey(rawAdded.map((item: any) => {
    const role = cleanAssetRole(item?.role);
    const assetId = String(item?.assetId || '').trim();
    return role && assetId ? { role, assetId } : null;
  }).filter(Boolean) as FirstFrameReferenceAdd[], normalizedReferenceAddKey)
    .sort((a, b) => normalizedReferenceAddKey(a).localeCompare(normalizedReferenceAddKey(b)));

  if (excluded.length || added.length) {
    out.referenceOverrides = {
      ...(excluded.length ? { excluded } : {}),
      ...(added.length ? { added } : {}),
    };
  }

  const selection = normalizeReferenceSelection(draft.firstFrameReferenceSelection, typeof draft.firstFrameReferenceSelection?.sourceHash === 'string' ? draft.firstFrameReferenceSelection.sourceHash : null);
  if (selection) {
    out.firstFrameReferenceSelection = {
      mode: 'manual',
      includeIds: selection.includeIds,
      ...(selection.excludeIds?.length ? { excludeIds: selection.excludeIds } : {}),
    };
  }

  const attachments = normalizeReferenceAttachments(draft.firstFrameReferenceAttachments, 0);
  if (attachments.length) out.firstFrameReferenceAttachments = attachments;

  return out;
}

export function firstFrameDraftFingerprint(draft: any): string {
  return hashText(stableJson({
    draft: normalizeFirstFrameDraftForFingerprint(draft),
  }));
}

function overrideMatchesReference(override: FirstFrameReferenceOverride, ref: FrameReference): boolean {
  if (override.slot && ref.slot === Number(override.slot)) return true;
  if (override.imageNo && ref.imageNo === Number(override.imageNo)) return true;
  const role = String(override.role || '').trim();
  const assetId = String(override.assetId || '').trim();
  const assetNameValue = String(override.assetName || '').trim();
  if (assetId && String(ref.assetId || '').trim() === assetId) return true;
  if (assetNameValue && String(ref.assetName || '').trim() === assetNameValue) {
    return !role || role === ref.role;
  }
  return false;
}

function normalizedLegacyReferenceOverrides(draft: FirstFrameEditDraft | null | undefined): FirstFrameDraftFingerprintPayload['referenceOverrides'] | null {
  const normalized = normalizeFirstFrameDraftForFingerprint({ referenceOverrides: draft?.referenceOverrides }).referenceOverrides;
  return normalized && ((normalized.excluded || []).length || (normalized.added || []).length) ? normalized : null;
}

function legacyReferenceOverrideVersion(draft: FirstFrameEditDraft | null | undefined): string {
  const legacy = normalizedLegacyReferenceOverrides(draft);
  return legacy ? hashText(stableJson(legacy)).slice(0, 16) : '';
}

function referenceDedupeKey(ref: FrameReference): string {
  const imageId = parseImageIdFromUrl(ref.remoteUrl);
  if (imageId) return `image:${imageId}`;
  return [
    ref.role ? `role:${ref.role}` : '',
    ref.assetId ? `id:${ref.assetId}` : '',
    ref.assetName ? `name:${ref.assetName}` : '',
    ref.remoteUrl ? `url:${ref.remoteUrl}` : '',
    ref.textFallback ? `text:${ref.textFallback}` : '',
  ].filter(Boolean).join('|').toLowerCase();
}

function dedupeFrameReferences(refs: FrameReference[]): FrameReference[] {
  return uniqByKey(refs, referenceDedupeKey);
}

function normalizeDraftInput(input: any, sourceHash: string | null, userId: number): FirstFrameEditDraft {
  const content = cleanDraftTextForSave(draftContentValue(input));
  const negativePromptOverride = cleanDraftTextForSave(input?.negativePromptOverride);
  const textErrors: FirstFrameDraftValidationError[] = [];
  if (content.length > MAX_PROMPT_OVERRIDE_CHARS) {
    textErrors.push({ field: 'content', message: `Prompt 不能超过 ${MAX_PROMPT_OVERRIDE_CHARS} 字符` });
  }
  if (negativePromptOverride.length > MAX_NEGATIVE_PROMPT_CHARS) {
    textErrors.push({ field: 'negativePromptOverride', message: `负向约束不能超过 ${MAX_NEGATIVE_PROMPT_CHARS} 字符` });
  }
  if (textErrors.length) throw new FirstFrameDraftValidationException(textErrors);

  const excluded = Array.isArray(input?.referenceOverrides?.excluded)
    ? input.referenceOverrides.excluded.map((item: any) => ({
        ...(item?.role ? { role: String(item.role).trim() } : {}),
        ...(item?.assetId ? { assetId: String(item.assetId).trim() } : {}),
        ...(item?.assetName ? { assetName: String(item.assetName).trim() } : {}),
        ...(Number.isFinite(Number(item?.slot)) ? { slot: Math.floor(Number(item.slot)) } : {}),
        ...(Number.isFinite(Number(item?.imageNo)) ? { imageNo: Math.floor(Number(item.imageNo)) } : {}),
      })).filter((item: FirstFrameReferenceOverride) => item.role || item.assetId || item.assetName || item.slot || item.imageNo)
    : [];
  const added = Array.isArray(input?.referenceOverrides?.added)
    ? input.referenceOverrides.added.map((item: any) => {
        const role = cleanAssetRole(item?.role);
        const assetId = String(item?.assetId || '').trim();
        return role && assetId ? { role, assetId } : null;
      }).filter(Boolean) as FirstFrameReferenceAdd[]
    : [];
  const selection = normalizeReferenceSelection(input?.firstFrameReferenceSelection, sourceHash);
  const attachments = normalizeReferenceAttachments(input?.firstFrameReferenceAttachments, userId);
  return {
    sourceHash,
    ...(content ? { content } : {}),
    ...((excluded.length || added.length) ? { referenceOverrides: { ...(excluded.length ? { excluded } : {}), ...(added.length ? { added } : {}) } } : {}),
    ...(selection ? { firstFrameReferenceSelection: selection } : {}),
    ...(attachments.length ? { firstFrameReferenceAttachments: attachments } : {}),
    ...(negativePromptOverride ? { negativePromptOverride } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
}

export function currentFirstFrameEditDraft(project: any, groupIdx: number): FirstFrameEditDraftState {
  const slot = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] : null;
  const rawDraft = slot?.firstFrameEditDraft;
  if (!rawDraft || typeof rawDraft !== 'object') return { draft: null, didMigrate: false };
  const updatedAt = String(rawDraft.updatedAt || '').trim();
  const updatedBy = Number(rawDraft.updatedBy || 0);
  const content = cleanText(draftContentValue(rawDraft), MAX_PROMPT_OVERRIDE_CHARS);
  const legacyStyleRules = cleanLegacyStyleRuleOverrides(rawDraft.styleRuleOverrides);
  const shouldMergeLegacyRules = legacyStyleRules.length > 0 && !isLegacyStyleRulePromptOverride(content);
  const migratedContent = shouldMergeLegacyRules
    ? cleanText([content, legacyStyleRuleBlock(legacyStyleRules)].filter(Boolean).join('\n\n'), MAX_PROMPT_OVERRIDE_CHARS)
    : content;
  return {
    draft: {
      sourceHash: typeof rawDraft.sourceHash === 'string' ? rawDraft.sourceHash : null,
      ...(migratedContent ? { content: migratedContent } : {}),
      ...(rawDraft.referenceOverrides && typeof rawDraft.referenceOverrides === 'object' ? { referenceOverrides: rawDraft.referenceOverrides } : {}),
      ...(rawDraft.firstFrameReferenceSelection && typeof rawDraft.firstFrameReferenceSelection === 'object'
        ? { firstFrameReferenceSelection: normalizeReferenceSelection(rawDraft.firstFrameReferenceSelection, typeof rawDraft.sourceHash === 'string' ? rawDraft.sourceHash : null) }
        : {}),
      ...(Array.isArray(rawDraft.firstFrameReferenceAttachments)
        ? { firstFrameReferenceAttachments: normalizeReferenceAttachments(rawDraft.firstFrameReferenceAttachments, updatedBy || 0) }
        : {}),
      ...(rawDraft.negativePromptOverride ? { negativePromptOverride: cleanText(rawDraft.negativePromptOverride, MAX_NEGATIVE_PROMPT_CHARS) } : {}),
      updatedAt: updatedAt || new Date(0).toISOString(),
      updatedBy: Number.isFinite(updatedBy) ? updatedBy : 0,
    },
    didMigrate: shouldMergeLegacyRules,
  };
}

function assignPatchField(target: Record<string, any>, patch: Record<string, any>, field: string) {
  if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
  if (patch[field] === null) {
    delete target[field];
    return;
  }
  if (patch[field] !== undefined) target[field] = patch[field];
}

export function mergeFirstFrameDraftPatch(baseDraft: any, patch: any) {
  const base = baseDraft && typeof baseDraft === 'object' ? baseDraft : {};
  const patchObject = patch && typeof patch === 'object' ? patch : {};
  const next: Record<string, any> = { ...base };
  if (!next.content && next.promptOverride) next.content = next.promptOverride;
  delete next.promptOverride;

  assignPatchField(next, patchObject, 'content');
  if (!Object.prototype.hasOwnProperty.call(patchObject, 'content')) {
    assignPatchField(next, patchObject, 'promptOverride');
    if (next.promptOverride !== undefined) {
      next.content = next.promptOverride;
      delete next.promptOverride;
    }
  }
  assignPatchField(next, patchObject, 'negativePromptOverride');
  assignPatchField(next, patchObject, 'firstFrameReferenceSelection');
  assignPatchField(next, patchObject, 'firstFrameReferenceAttachments');

  if (Object.prototype.hasOwnProperty.call(patchObject, 'referenceOverrides')) {
    const patchRefs = patchObject.referenceOverrides;
    if (patchRefs === null) {
      delete next.referenceOverrides;
    } else if (patchRefs && typeof patchRefs === 'object') {
      const baseRefs = base.referenceOverrides && typeof base.referenceOverrides === 'object'
        ? base.referenceOverrides
        : {};
      const refs: Record<string, any> = { ...baseRefs };
      assignPatchField(refs, patchRefs, 'excluded');
      assignPatchField(refs, patchRefs, 'added');
      if (Array.isArray(refs.excluded) && !refs.excluded.length) delete refs.excluded;
      if (Array.isArray(refs.added) && !refs.added.length) delete refs.added;
      if (refs.excluded || refs.added) next.referenceOverrides = refs;
      else delete next.referenceOverrides;
    }
  }

  return next;
}

function referenceConflictWithAdded(
  override: FirstFrameReferenceOverride,
  added: Array<FirstFrameReferenceAdd & { assetName?: string }>,
): boolean {
  const overrideRole = cleanAssetRole(override.role) || null;
  const overrideAssetId = String(override.assetId || '').trim();
  const overrideAssetName = String(override.assetName || '').trim().toLowerCase();
  if (!overrideAssetId && !overrideAssetName) return false;
  return added.some((item) => {
    if (overrideRole && overrideRole !== item.role) return false;
    if (overrideAssetId && overrideAssetId === item.assetId) return true;
    return Boolean(overrideAssetName && item.assetName && overrideAssetName === item.assetName.toLowerCase());
  });
}

function normalizeReferenceOverrideConflicts(
  project: any,
  draft: FirstFrameEditDraft,
): { draft: FirstFrameEditDraft; warnings: FirstFrameDraftWarning[] } {
  const excluded = draft.referenceOverrides?.excluded || [];
  const added = draft.referenceOverrides?.added || [];
  if (!excluded.length || !added.length) return { draft, warnings: [] };

  const addedWithNames = added.map((item) => ({
    ...item,
    assetName: assetName(findFirstFrameAsset(project, item.role, item.assetId)),
  }));
  const filteredExcluded = excluded.filter((item) => !referenceConflictWithAdded(item, addedWithNames));
  if (filteredExcluded.length === excluded.length) return { draft, warnings: [] };

  const referenceOverrides = {
    ...(filteredExcluded.length ? { excluded: filteredExcluded } : {}),
    added,
  };
  return {
    draft: {
      ...draft,
      referenceOverrides,
    },
    warnings: [{
      code: 'reference_conflict_normalized',
      message: '同一参考资产同时出现在新增和排除列表中，已按“新增优先”自动移除排除项。',
      severity: 'info',
      field: 'referenceOverrides',
    }],
  };
}

export function validateAndNormalizeFirstFrameDraftWithWarnings(args: {
  project: any;
  groupIdx: number;
  userId: number;
  input: any;
  plan: FrameImageGenerationPlan;
}): { draft: FirstFrameEditDraft; warnings: FirstFrameDraftWarning[] } {
  const sourceHash = computeFirstFrameEditSourceHash(args.project, args.userId, args.groupIdx, args.plan);
  let draft = normalizeDraftInput(args.input, sourceHash, args.userId);
  const warnings: FirstFrameDraftWarning[] = [];
  const conflictResult = normalizeReferenceOverrideConflicts(args.project, draft);
  draft = conflictResult.draft;
  if (draft.firstFrameReferenceSelection) {
    draft = {
      ...draft,
      firstFrameReferenceSelection: {
        sourceHash,
        mode: 'manual',
        includeIds: normalizeReferenceSelectionIdsForPlan({
          project: args.project,
          userId: args.userId,
          plan: args.plan,
          baseDraft: draft,
          includeIds: draft.firstFrameReferenceSelection.includeIds,
        }),
        ...(draft.firstFrameReferenceSelection.excludeIds?.length ? { excludeIds: draft.firstFrameReferenceSelection.excludeIds } : {}),
        version: draft.firstFrameReferenceSelection.version,
      },
    };
  }
  warnings.push(...conflictResult.warnings);
  const errors: FirstFrameDraftValidationError[] = [];
  if (draft.content && draft.content.length > MAX_PROMPT_OVERRIDE_CHARS) {
    errors.push({ field: 'content', message: `Prompt 不能超过 ${MAX_PROMPT_OVERRIDE_CHARS} 字符` });
  }
  if (draft.negativePromptOverride && draft.negativePromptOverride.length > MAX_NEGATIVE_PROMPT_CHARS) {
    errors.push({ field: 'negativePromptOverride', message: `负向约束不能超过 ${MAX_NEGATIVE_PROMPT_CHARS} 字符` });
  }
  const added = draft.referenceOverrides?.added || [];
  for (const add of added) {
    if (!findFirstFrameAsset(args.project, add.role, add.assetId)) {
      errors.push({ field: 'referenceOverrides', message: `补充参考图不存在：${add.role}/${add.assetId}` });
    }
  }
  const effective = effectiveFirstFrameReferences(args.project, args.userId, args.plan, draft);
  const cap = effectiveReferenceCap(args.plan);
  if (effective.imageRefs.length > cap) {
    errors.push({ field: 'firstFrameReferenceSelection', message: `已达模型参考图上限 ${cap} 张` });
  }
  const baseImageRefCount = args.plan.referenceManifest.filter((ref) => ref.delivery === 'image').length;
  if (effective.imageRefs.length < baseImageRefCount) {
    warnings.push({
      code: 'reference_count_reduced',
      message: `参考图数量已从 ${baseImageRefCount} 张减少到 ${effective.imageRefs.length} 张。`,
      severity: 'warn',
      field: draft.firstFrameReferenceSelection ? 'firstFrameReferenceSelection' : 'referenceOverrides',
    });
  }
  if (errors.length) throw new FirstFrameDraftValidationException(errors);
  return { draft, warnings };
}

export function validateAndNormalizeFirstFrameDraft(args: {
  project: any;
  groupIdx: number;
  userId: number;
  input: any;
  plan: FrameImageGenerationPlan;
}): FirstFrameEditDraft {
  return validateAndNormalizeFirstFrameDraftWithWarnings(args).draft;
}

export function buildFirstFramePlanPreview(args: {
  project: any;
  groupIdx: number;
  ownerId: number;
  user: any;
  explicitShotIndices?: any;
}): {
  plan: FrameImageGenerationPlan;
  planSummary: FrameImagePlanSummary;
  sourceHash: string | null;
  shotIndices: number[];
  modelSnapshot: FrameImageGenerationPlan['modelSnapshot'];
} {
  const storyboards = Array.isArray(args.project?.storyboards) ? args.project.storyboards : [];
  const sb = storyboards[args.groupIdx] || {};
  const hasExplicitShotBinding = Array.isArray(sb?.shotIndices) && sb.shotIndices.length > 0;
  const explicitShotIndices = Array.isArray(args.explicitShotIndices) && args.explicitShotIndices.length
    ? args.explicitShotIndices
    : (hasExplicitShotBinding ? undefined : [args.groupIdx]);
  const shotIndices = storyboardShotIndices(args.project, args.groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices,
  });
  const imgCfg = resolveLLMConfig(args.user, 'image');
  const capMulti = Math.max(1, Math.floor(imgCfg.capabilities?.image?.multiRefImage ?? 1));
  const modelSnapshot = {
    provider: imgCfg.provider,
    model: imgCfg.model,
    baseUrl: imgCfg.baseUrl,
    quality: imgCfg.imageQuality || 'medium',
    multiRefImageCap: capMulti,
  };
  const plan = buildFrameImageGenerationPlan({
    project: args.project,
    groupIdx: args.groupIdx,
    shotIndices,
    ownerId: args.ownerId,
    frameType: 'first_frame',
    modelSnapshot,
  });
  return {
    plan,
    planSummary: summarizePlanForAudit(plan),
    sourceHash: computeFirstFrameEditSourceHash(args.project, args.ownerId, args.groupIdx, plan),
    shotIndices,
    modelSnapshot,
  };
}

function normalizeFirstFrameBasePrompt(value: any): FirstFrameBasePromptState | null {
  if (!value || typeof value !== 'object') return null;
  const content = cleanText(value.content, MAX_PROMPT_OVERRIDE_CHARS);
  if (!content) return null;
  const origin = value.origin === 'draft_commit' || value.origin === 'backup_restore' || value.origin === 'history_restore'
    ? value.origin
    : 'system';
  const updatedBy = Number(value.updatedBy || 0);
  return {
    content,
    sourceHash: typeof value.sourceHash === 'string' ? value.sourceHash : null,
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : new Date(0).toISOString(),
    updatedBy: Number.isFinite(updatedBy) ? updatedBy : 0,
    origin,
  };
}

function normalizeFirstFrameBackup(value: any): FirstFrameBackupState | null {
  if (!value || typeof value !== 'object') return null;
  const content = cleanText(value.content, MAX_PROMPT_OVERRIDE_CHARS);
  if (!content) return null;
  return {
    content,
    sourceHash: typeof value.sourceHash === 'string' ? value.sourceHash : null,
    createdAt: typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : new Date(0).toISOString(),
  };
}

export function reconcileFirstFramePromptStateInPatch(args: {
  project: any;
  user: any;
  groupIdx: number;
  now?: string;
  explicitShotIndices?: any;
}): FirstFramePromptReconcileState {
  const preview = buildFirstFramePlanPreview({
    project: args.project,
    groupIdx: args.groupIdx,
    ownerId: args.user.id,
    user: args.user,
    explicitShotIndices: args.explicitShotIndices,
  });
  const storyboards = Array.isArray(args.project?.storyboards) ? args.project.storyboards : [];
  const slot = storyboards[args.groupIdx] || {};
  const { draft } = currentFirstFrameEditDraft(args.project, args.groupIdx);
  const now = args.now || new Date().toISOString();
  const systemContent = cleanText(preview.plan.finalPrompt, MAX_PROMPT_OVERRIDE_CHARS);
  const existingBase = normalizeFirstFrameBasePrompt(slot.firstFrameBasePrompt);
  const existingBackup = normalizeFirstFrameBackup(slot.firstFrameBackup);
  let firstFrameBasePrompt = existingBase;
  let firstFrameBackup = existingBackup;
  const slotPatch: Record<string, any> = {};
  const canAutoRefreshSystemPrompt = !draft && existingBase?.origin === 'system';
  const baseHashChanged = !!(existingBase && (existingBase.sourceHash || null) !== (preview.sourceHash || null));

  if (!firstFrameBasePrompt || (baseHashChanged && canAutoRefreshSystemPrompt)) {
    firstFrameBasePrompt = {
      content: systemContent,
      sourceHash: preview.sourceHash,
      updatedAt: now,
      updatedBy: Number(args.user.id || 0),
      origin: 'system',
    };
    slotPatch.firstFrameBasePrompt = firstFrameBasePrompt;
  }

  const backupHashChanged = !!(existingBackup && (existingBackup.sourceHash || null) !== (preview.sourceHash || null));
  if (!firstFrameBackup || ((baseHashChanged || backupHashChanged) && canAutoRefreshSystemPrompt)) {
    firstFrameBackup = {
      content: systemContent,
      sourceHash: preview.sourceHash,
      createdAt: now,
    };
    slotPatch.firstFrameBackup = firstFrameBackup;
  }

  const changed = Object.keys(slotPatch).length > 0;
  const effectiveBase = firstFrameBasePrompt || {
    content: systemContent,
    sourceHash: preview.sourceHash,
    updatedAt: now,
    updatedBy: Number(args.user.id || 0),
    origin: 'system' as const,
  };
  const effectiveBackup = firstFrameBackup || {
    content: systemContent,
    sourceHash: preview.sourceHash,
    createdAt: now,
  };

  return {
    plan: preview.plan,
    planSummary: preview.planSummary,
    sourceHash: preview.sourceHash,
    shotIndices: preview.shotIndices,
    modelSnapshot: preview.modelSnapshot,
    firstFrameBasePrompt: effectiveBase,
    firstFrameBackup: effectiveBackup,
    firstFrameBasePromptStale: (effectiveBase.sourceHash || null) !== (preview.sourceHash || null),
    firstFrameDraftStale: !!(draft && isFirstFrameEditDraftStale(draft.sourceHash, preview.sourceHash)),
    slotPatch: changed ? slotPatch : null,
  };
}

export function reconcileFirstFramePromptState(args: {
  projectId: string;
  user: any;
  groupIdx: number;
}): FirstFramePromptReconcileState | null {
  let state: FirstFramePromptReconcileState | null = null;
  patchProjectForUser(args.projectId, args.user.id, (fresh) => {
    if (!fresh) return null;
    state = reconcileFirstFramePromptStateInPatch({
      project: fresh,
      user: args.user,
      groupIdx: args.groupIdx,
    });
    if (!state.slotPatch) return {};
    const storyboards = Array.isArray(fresh.storyboards) ? [...fresh.storyboards] : [];
    const prev = storyboards[args.groupIdx] || {};
    storyboards[args.groupIdx] = { ...prev, ...state.slotPatch };
    return { storyboards };
  });
  if (state) return state;
  const fresh = getProjectByIdForUser(args.projectId, args.user.id);
  return fresh ? reconcileFirstFramePromptStateInPatch({ project: fresh, user: args.user, groupIdx: args.groupIdx }) : null;
}

export function availableFirstFrameAssets(project: any) {
  return (['character', 'scene', 'prop'] as FirstFrameEditAssetRole[]).flatMap((role) =>
    projectAssetsForRole(project, role).map((asset) => ({
      role,
      assetId: candidateAssetIds(role, asset)[0] || '',
      assetName: assetName(asset),
      imageUrl: assetUrl(asset),
    })).filter((item) => item.assetId && item.assetName),
  );
}

type InternalReferenceTile = FirstFrameMaterialTile & {
  frameRole: FrameRefRole;
  assetId?: string;
  assetName?: string;
  localPath: string;
  textFallback: string;
};

function effectiveReferenceCap(plan: FrameImageGenerationPlan): number {
  return Math.min(FRAME_IMAGE_REFERENCE_IMAGE_BUDGET, Math.max(0, Math.floor(plan.modelSnapshot.multiRefImageCap || 0)));
}

export function computeFirstFrameEditSourceHash(
  project: any,
  userId: number,
  groupIdx: number,
  plan?: FrameImageGenerationPlan,
): string | null {
  const baseSourceHash = computeFirstFrameSourceHash(project, userId, groupIdx);
  if (!baseSourceHash || !plan) return baseSourceHash;
  return hashText(stableJson({
    frameType: 'first_frame_edit',
    baseSourceHash,
    selectorVersion: 1,
    cap: effectiveReferenceCap(plan),
    model: {
      provider: plan.modelSnapshot.provider,
      model: plan.modelSnapshot.model,
      quality: plan.modelSnapshot.quality || null,
    },
    references: plan.referenceManifest.map((ref) => ({
      role: ref.role || '',
      assetId: ref.assetId || '',
      assetName: ref.assetName || '',
      remoteUrl: ref.remoteUrl || '',
      slot: ref.slot || 0,
      delivery: ref.delivery || '',
      droppedReason: ref.droppedReason || '',
    })),
  }));
}

function tileIdForReference(ref: FrameReference, role: FirstFrameMaterialTileRole, imageId: string): string {
  const identity = cleanId(ref.assetId) || cleanId(ref.assetName) || imageId || String(ref.slot || '');
  const panel = cleanId((ref as any).panel);
  return panel ? `ref:${role}:${identity}:${panel}` : `ref:${role}:${identity}`;
}

function referenceToTile(ref: FrameReference, userId: number, source: FirstFrameMaterialTile['source'] = 'default'): InternalReferenceTile | null {
  const role = frameRoleToTileRole(ref.role);
  const url = cleanId(ref.remoteUrl);
  if (!role || !url) return null;
  const localPath = ref.localPath || resolveLocalImagePath(url, userId) || '';
  const imageId = parseImageIdFromUrl(url);
  if (!localPath || !imageId) return null;
  const name = cleanId(ref.assetName) || cleanId(ref.assetId);
  return {
    id: tileIdForReference(ref, role, imageId),
    imageId,
    role,
    url,
    thumbUrl: url,
    ...(name ? { name } : {}),
    order: Math.max(0, Number(ref.slot || 0)),
    source,
    frameRole: tileRoleToFrameRole(role),
    ...(cleanId(ref.assetId) ? { assetId: cleanId(ref.assetId) } : {}),
    ...(name ? { assetName: name } : {}),
    localPath,
    textFallback: ref.textFallback || name || 'reference image',
  };
}

function attachmentToTile(attachment: FirstFrameReferenceAttachment, userId: number, order: number): InternalReferenceTile | null {
  const url = cleanId(attachment.url);
  const localPath = resolveLocalImagePath(url, userId) || '';
  const imageId = cleanId(attachment.imageId) || parseImageIdFromUrl(url);
  if (!url || !localPath || !imageId) return null;
  const name = cleanId(attachment.name) || '上传参考图';
  return {
    id: attachment.id,
    imageId,
    role: attachment.role,
    url,
    thumbUrl: cleanId(attachment.thumbUrl) || url,
    name,
    order,
    source: 'upload',
    frameRole: tileRoleToFrameRole(attachment.role),
    assetId: attachment.id,
    assetName: name,
    localPath,
    textFallback: name,
  };
}

function materialToTile(material: FirstFrameReferenceMaterial, userId: number, order: number): InternalReferenceTile | null {
  const url = cleanId(material.url);
  const localPath = resolveLocalImagePath(url, userId) || '';
  const imageId = cleanId(material.imageId) || parseImageIdFromUrl(url);
  if (!url || !localPath || !imageId) return null;
  const name = cleanId(material.name) || '上传参考图';
  return {
    id: material.id || `upload:${imageId}`,
    imageId,
    role: material.role,
    url,
    thumbUrl: cleanId(material.thumbUrl) || url,
    name,
    order,
    source: 'upload',
    frameRole: tileRoleToFrameRole(material.role),
    assetId: material.id || `upload:${imageId}`,
    assetName: name,
    localPath,
    textFallback: name,
  };
}

function assetLibraryToTile(asset: any, userId: number, order: number): InternalReferenceTile | null {
  const role = assetLibraryRoleForStage(asset?.stage);
  if (!role || asset?.kind !== 'image') return null;
  const url = cleanId(asset.url);
  const localPath = resolveLocalImagePath(url, userId) || '';
  const imageId = parseImageIdFromUrl(url) || cleanId(asset.assetId);
  if (!url || !localPath || !imageId) return null;
  const name = assetLibraryDisplayName(role, asset);
  const id = `library:${cleanId(asset.assetId) || imageId}`;
  return {
    id,
    imageId,
    role,
    url,
    thumbUrl: cleanId(asset.thumbUrl) || url,
    name,
    order,
    source: 'library',
    frameRole: tileRoleToFrameRole(role),
    assetId: id,
    assetName: name,
    localPath,
    textFallback: name,
  };
}

function legacyAddedFrameReferences(
  project: any,
  userId: number,
  draft: FirstFrameEditDraft | null,
): FrameReference[] {
  const legacy = normalizedLegacyReferenceOverrides(draft);
  return (legacy?.added || []).map((add) => {
    const asset = findFirstFrameAsset(project, add.role, add.assetId);
    if (!asset) return null;
    const url = assetUrl(asset);
    const localPath = assetLocalPath(asset, url, userId);
    const role: FrameRefRole = add.role === 'character' ? 'character' : add.role;
    return {
      slot: 0,
      role,
      assetId: add.assetId,
      assetName: assetName(asset),
      remoteUrl: url || undefined,
      localPath,
      textFallback: `${assetName(asset)}: ${String(asset?.description || asset?.appearance || asset?.features || '').slice(0, 180)}`,
      delivery: localPath ? 'image' : 'text_only',
      droppedReason: localPath ? undefined : (url ? 'unresolvable' : 'no_image_available'),
    } as FrameReference;
  }).filter(Boolean) as FrameReference[];
}

function legacyEffectiveFirstFrameReferences(
  project: any,
  userId: number,
  plan: FrameImageGenerationPlan,
  draft: FirstFrameEditDraft | null,
): { manifest: FrameReference[]; imageRefs: FrameReference[] } {
  const legacy = normalizedLegacyReferenceOverrides(draft);
  const excluded = legacy?.excluded || [];
  const filtered = plan.referenceManifest.filter((ref) => !excluded.some((item) => overrideMatchesReference(item, ref)));
  const added = legacyAddedFrameReferences(project, userId, draft);
  const manifest = dedupeFrameReferences([...filtered, ...added]).map((ref, idx) => ({ ...ref, slot: idx + 1 }));
  let imageNo = 1;
  const renumbered = manifest.map((ref) => {
    if (ref.delivery === 'image') return { ...ref, imageNo: imageNo++ };
    const { imageNo: _imageNo, ...rest } = ref;
    return rest as FrameReference;
  });
  return {
    manifest: renumbered,
    imageRefs: renumbered.filter((ref) => ref.delivery === 'image'),
  };
}

function buildReferenceTileCandidates(
  project: any,
  userId: number,
  plan: FrameImageGenerationPlan,
  draft: FirstFrameEditDraft | null,
): {
  candidates: InternalReferenceTile[];
  candidateById: Map<string, InternalReferenceTile>;
  unavailableImage: number;
} {
  const candidates: InternalReferenceTile[] = [];
  const imageIds = new Set<string>();
  let unavailableImage = 0;
  for (const ref of plan.referenceManifest) {
    const role = frameRoleToTileRole(ref.role);
    if (!role) continue;
    const tile = referenceToTile(ref, userId, 'default');
    if (!tile) {
      if (ref.droppedReason === 'no_image_available' || ref.droppedReason === 'unresolvable' || !ref.remoteUrl) {
        unavailableImage += 1;
      }
      continue;
    }
    if (imageIds.has(tile.imageId)) continue;
    imageIds.add(tile.imageId);
    candidates.push(tile);
  }
  if (normalizedLegacyReferenceOverrides(draft)) {
    const legacyRefs = legacyEffectiveFirstFrameReferences(project, userId, plan, draft).imageRefs;
    for (const ref of legacyRefs) {
      const tile = referenceToTile(ref, userId, 'manual');
      if (!tile) {
        unavailableImage += 1;
        continue;
      }
      if (imageIds.has(tile.imageId)) continue;
      imageIds.add(tile.imageId);
      candidates.push(tile);
    }
  }
  const materials = normalizeFirstFrameReferenceMaterials(project);
  materials.forEach((material, idx) => {
    const tile = materialToTile(material, userId, 2000 + idx);
    if (!tile) {
      unavailableImage += 1;
      return;
    }
    if (imageIds.has(tile.imageId)) return;
    imageIds.add(tile.imageId);
    candidates.push(tile);
  });
  const libraryAssets = projectAssetLibraryItems(project, userId);
  libraryAssets.forEach((asset, idx) => {
    const role = assetLibraryRoleForStage(asset?.stage);
    if (!role || asset?.kind !== 'image') return;
    const tile = assetLibraryToTile(asset, userId, 3000 + idx);
    if (!tile) {
      unavailableImage += 1;
      return;
    }
    if (imageIds.has(tile.imageId)) return;
    imageIds.add(tile.imageId);
    candidates.push(tile);
  });
  const attachments = draft?.firstFrameReferenceAttachments || [];
  attachments.forEach((attachment, idx) => {
    const tile = attachmentToTile(attachment, userId, 1000 + idx);
    if (!tile) {
      unavailableImage += 1;
      return;
    }
    if (imageIds.has(tile.imageId)) return;
    imageIds.add(tile.imageId);
    candidates.push(tile);
  });
  const candidateById = new Map<string, InternalReferenceTile>();
  candidates.forEach((tile) => candidateById.set(tile.id, tile));
  return { candidates, candidateById, unavailableImage };
}

function selectionIdsForDraft(
  project: any,
  userId: number,
  plan: FrameImageGenerationPlan,
  draft: FirstFrameEditDraft | null,
  candidateById: Map<string, InternalReferenceTile>,
): { mode: 'auto' | 'manual'; ids: string[]; missingSelected: number } {
  const selection = draft?.firstFrameReferenceSelection;
  if (selection?.mode === 'manual') {
    const includeIds = cleanIdList(selection.includeIds);
    const missingSelected = includeIds.filter((id) => !candidateById.has(id)).length;
    return { mode: 'manual', ids: includeIds.filter((id) => candidateById.has(id)), missingSelected };
  }
  if (normalizedLegacyReferenceOverrides(draft)) {
    const imageRefIds = legacyEffectiveFirstFrameReferences(project, userId, plan, draft)
      .imageRefs
      .map((ref) => {
        const role = frameRoleToTileRole(ref.role);
        const imageId = parseImageIdFromUrl(ref.remoteUrl);
        return role && imageId ? tileIdForReference(ref, role, imageId) : '';
      })
      .filter(Boolean);
    const ids = cleanIdList(imageRefIds);
    return {
      mode: 'manual',
      ids: ids.filter((id) => candidateById.has(id)),
      missingSelected: ids.filter((id) => !candidateById.has(id)).length,
    };
  }
  const imageRefIds = plan.referenceManifest
    .filter((ref) => ref.delivery === 'image')
    .map((ref) => {
      const role = frameRoleToTileRole(ref.role);
      const imageId = parseImageIdFromUrl(ref.remoteUrl);
      return role && imageId ? tileIdForReference(ref, role, imageId) : '';
    })
    .filter((id) => id && candidateById.has(id));
  return { mode: 'auto', ids: cleanIdList(imageRefIds), missingSelected: 0 };
}

function materialPanelVersion(sourceHash: string | null, draft: FirstFrameEditDraft | null, mode: 'auto' | 'manual', materialVersion: string): string {
  const materialSuffix = materialVersion ? `|${materialVersion}` : '';
  if (mode === 'manual' && draft?.firstFrameReferenceSelection?.version) return `${draft.firstFrameReferenceSelection.version}${materialSuffix}`;
  if (mode === 'manual') {
    const legacyVersion = legacyReferenceOverrideVersion(draft);
    if (legacyVersion) return `legacy:${legacyVersion}${materialSuffix}`;
  }
  return `auto:${hashText(sourceHash || 'no-source').slice(0, 16)}${materialSuffix}`;
}

export function buildFirstFrameMaterialPanel(args: {
  project: any;
  userId: number;
  plan: FrameImageGenerationPlan;
  draft: FirstFrameEditDraft | null;
  sourceHash: string | null;
}): FirstFrameMaterialPanel {
  const cap = effectiveReferenceCap(args.plan);
  const { candidates, candidateById, unavailableImage } = buildReferenceTileCandidates(args.project, args.userId, args.plan, args.draft);
  const referencePoolVersion = [
    firstFrameReferenceMaterialsVersion(args.project),
    firstFrameAssetLibraryVersion(args.project, args.userId),
  ].filter(Boolean).join('|');
  const selected = selectionIdsForDraft(args.project, args.userId, args.plan, args.draft, candidateById);
  const selectedTiles = selected.ids.map((id) => candidateById.get(id)).filter(Boolean) as InternalReferenceTile[];
  const visibleTiles = selectedTiles.slice(0, cap);
  const groups: FirstFrameMaterialPanel['groups'] = { scene: [], char: [], prop: [] };
  const candidateGroups: FirstFrameMaterialPanel['candidateGroups'] = { scene: [], char: [], prop: [] };
  candidates.forEach((tile, order) => {
    candidateGroups[tile.role].push({
      id: tile.id,
      imageId: tile.imageId,
      role: tile.role,
      url: tile.url,
      thumbUrl: tile.thumbUrl,
      ...(tile.name ? { name: tile.name } : {}),
      order,
      source: tile.source,
    });
  });
  const orderedTiles = visibleTiles.map((tile, order): FirstFrameMaterialTile => ({
      id: tile.id,
      imageId: tile.imageId,
      role: tile.role,
      url: tile.url,
      thumbUrl: tile.thumbUrl,
      ...(tile.name ? { name: tile.name } : {}),
      order,
      source: tile.source,
  }));
  orderedTiles.forEach((tile) => {
    groups[tile.role].push(tile);
  });
  const used = visibleTiles.length;
  const eligibleUnused = Math.max(0, candidates.length - used);
  const overCapacitySelected = Math.max(0, selectedTiles.length - cap);
  const omitted = {
    ...(unavailableImage || selected.missingSelected ? { unavailableImage: unavailableImage + selected.missingSelected } : {}),
    ...(eligibleUnused || overCapacitySelected ? { capacityLimited: Math.max(eligibleUnused, overCapacitySelected) } : {}),
  };
  const invalid = overCapacitySelected
    ? {
      code: 'selection_over_capacity' as const,
      message: `参考图已超过当前模型上限 ${cap} 张，请先移除多余参考图。`,
    }
    : selected.missingSelected
      ? {
        code: 'selection_unavailable' as const,
        message: '部分已选参考图已不可用，请刷新后重新选择。',
      }
      : undefined;
  return {
    sourceHash: args.sourceHash,
	    selectionVersion: materialPanelVersion(args.sourceHash, args.draft, selected.mode, referencePoolVersion),
	    productCap: FRAME_IMAGE_REFERENCE_IMAGE_BUDGET,
    cap,
    used,
    remaining: Math.max(0, cap - used),
    mode: selected.mode,
    groups,
    candidateGroups,
    orderedTileIds: orderedTiles.map((tile) => tile.id),
    orderedTiles,
    ...(Object.keys(omitted).length ? { omitted } : {}),
    ...(invalid ? { invalid } : {}),
  };
}

function selectedTilesForDraft(args: {
  project: any;
  userId: number;
  plan: FrameImageGenerationPlan;
  draft: FirstFrameEditDraft;
}): InternalReferenceTile[] {
  const { candidateById } = buildReferenceTileCandidates(args.project, args.userId, args.plan, args.draft);
  const selected = selectionIdsForDraft(args.project, args.userId, args.plan, args.draft, candidateById);
  const cap = effectiveReferenceCap(args.plan);
  return selected.ids.map((id) => candidateById.get(id)).filter(Boolean).slice(0, cap) as InternalReferenceTile[];
}

export function selectedFirstFrameReferenceTileIds(args: {
  project: any;
  userId: number;
  plan: FrameImageGenerationPlan;
  draft: FirstFrameEditDraft | null;
}): string[] {
  const { candidateById } = buildReferenceTileCandidates(args.project, args.userId, args.plan, args.draft);
  return selectionIdsForDraft(args.project, args.userId, args.plan, args.draft, candidateById).ids;
}

export function availableFirstFrameReferenceTileIds(args: {
  project: any;
  userId: number;
  plan: FrameImageGenerationPlan;
  draft: FirstFrameEditDraft | null;
}): string[] {
  const { candidates } = buildReferenceTileCandidates(args.project, args.userId, args.plan, args.draft);
  return candidates.map((tile) => tile.id);
}

export function createFirstFrameReferenceSelection(sourceHash: string | null, includeIds: unknown, order?: unknown): FirstFrameReferenceSelection {
  const ids = cleanIdList(includeIds);
  const orderIds = cleanIdList(order).filter((id) => ids.includes(id));
  return {
    sourceHash,
    mode: 'manual',
    includeIds: ids,
    ...(orderIds.length ? { order: orderIds } : {}),
    version: selectionVersion(),
  };
}

function planReferenceTileIds(plan: FrameImageGenerationPlan, userId: number): Set<string> {
  const ids = new Set<string>();
  for (const ref of plan.referenceManifest) {
    const tile = referenceToTile(ref, userId, 'default');
    if (tile) ids.add(tile.id);
  }
  return ids;
}

function selectedLegacyAddedAttachments(args: {
  project: any;
  userId: number;
  plan: FrameImageGenerationPlan;
  baseDraft: FirstFrameEditDraft | null;
  includeIds: string[];
}): FirstFrameReferenceAttachment[] {
  if (!normalizedLegacyReferenceOverrides(args.baseDraft)) return [];
  const selectedIds = new Set(args.includeIds);
  const existingIds = new Set((args.baseDraft?.firstFrameReferenceAttachments || []).map((item) => item.id));
  const defaultTileIds = planReferenceTileIds(args.plan, args.userId);
  return legacyAddedFrameReferences(args.project, args.userId, args.baseDraft)
    .map((ref) => referenceToTile(ref, args.userId, 'manual'))
    .filter((tile): tile is InternalReferenceTile => !!tile)
    .filter((tile) => selectedIds.has(tile.id) && !existingIds.has(tile.id) && !defaultTileIds.has(tile.id))
    .map((tile) => ({
      id: tile.id,
      imageId: tile.imageId,
      role: tile.role,
      ...(tile.name ? { name: tile.name } : {}),
      url: tile.url,
      thumbUrl: tile.thumbUrl,
      uploadedAt: args.baseDraft?.updatedAt || new Date(0).toISOString(),
      uploadedBy: args.baseDraft?.updatedBy || args.userId,
    }));
}

function normalizeReferenceSelectionIdsForPlan(args: {
  project?: any;
  userId: number;
  plan?: FrameImageGenerationPlan;
  baseDraft: FirstFrameEditDraft | null;
  includeIds: string[];
  extraAttachments?: FirstFrameReferenceAttachment[];
}): string[] {
  const includeIds = cleanIdList(args.includeIds);
  if (!args.project || !args.plan || !includeIds.length) return includeIds;
  const draftForCandidates: FirstFrameEditDraft | null = {
    ...(args.baseDraft || {
      sourceHash: null,
      updatedAt: new Date(0).toISOString(),
      updatedBy: args.userId,
    }),
    firstFrameReferenceAttachments: [
      ...((args.baseDraft?.firstFrameReferenceAttachments) || []),
      ...((args.extraAttachments) || []),
    ],
  };
  const selected = new Set(includeIds);
  const { candidates } = buildReferenceTileCandidates(args.project, args.userId, args.plan, draftForCandidates);
  const ordered = candidates.map((tile) => tile.id).filter((id) => selected.has(id));
  const orderedSet = new Set(ordered);
  return [...ordered, ...includeIds.filter((id) => !orderedSet.has(id))];
}

function migratedReferenceSelectionDraftInput(args: {
  baseDraft: FirstFrameEditDraft | null;
  sourceHash: string | null;
  userId: number;
  includeIds: unknown;
  project?: any;
  plan?: FrameImageGenerationPlan;
  extraAttachments?: FirstFrameReferenceAttachment[];
}): any {
  const includeIds = cleanIdList(args.includeIds);
  const migrationProject = args.project;
  const migrationPlan = args.plan;
  const shouldMigrateLegacy = !!(migrationProject && migrationPlan && normalizedLegacyReferenceOverrides(args.baseDraft));
  const migratedAttachments = shouldMigrateLegacy
    ? selectedLegacyAddedAttachments({
      project: migrationProject,
      userId: args.userId,
      plan: migrationPlan,
      baseDraft: args.baseDraft,
      includeIds,
    })
    : [];
  const extraAttachments = [
    ...migratedAttachments,
    ...((args.extraAttachments) || []),
  ];
  const normalizedIncludeIds = normalizeReferenceSelectionIdsForPlan({
    project: migrationProject,
    userId: args.userId,
    plan: migrationPlan,
    baseDraft: args.baseDraft,
    includeIds,
    extraAttachments,
  });
  return {
    ...(args.baseDraft || {}),
    ...(shouldMigrateLegacy ? { referenceOverrides: null } : {}),
    firstFrameReferenceAttachments: [
      ...((args.baseDraft?.firstFrameReferenceAttachments) || []),
      ...extraAttachments,
    ],
    firstFrameReferenceSelection: createFirstFrameReferenceSelection(args.sourceHash, normalizedIncludeIds),
  };
}

export function buildFirstFrameDraftWithReferenceSelection(args: {
  baseDraft: FirstFrameEditDraft | null;
  sourceHash: string | null;
  userId: number;
  includeIds: unknown;
  project?: any;
  plan?: FrameImageGenerationPlan;
}): FirstFrameEditDraft {
  return normalizeDraftInput(migratedReferenceSelectionDraftInput(args), args.sourceHash, args.userId);
}

export function buildFirstFrameDraftWithReferenceAttachment(args: {
  baseDraft: FirstFrameEditDraft | null;
  sourceHash: string | null;
  userId: number;
  attachment: FirstFrameReferenceAttachment;
  includeIds: unknown;
  project?: any;
  plan?: FrameImageGenerationPlan;
}): FirstFrameEditDraft {
  return normalizeDraftInput(migratedReferenceSelectionDraftInput({
    ...args,
    extraAttachments: [args.attachment],
  }), args.sourceHash, args.userId);
}

export function effectiveFirstFrameReferences(
  project: any,
  userId: number,
  plan: FrameImageGenerationPlan,
  draft: FirstFrameEditDraft | null,
): { manifest: FrameReference[]; imageRefs: FrameReference[] } {
  if (draft?.firstFrameReferenceSelection?.mode === 'manual') {
    const selectedTiles = selectedTilesForDraft({ project, userId, plan, draft });
    const manifest = selectedTiles.map((tile, idx): FrameReference => ({
      slot: idx + 1,
      imageNo: idx + 1,
      role: tile.frameRole,
      assetId: tile.assetId,
      assetName: tile.assetName || tile.name,
      remoteUrl: tile.url,
      localPath: tile.localPath,
      textFallback: tile.textFallback,
      delivery: 'image',
    }));
    return {
      manifest,
      imageRefs: manifest,
    };
  }
  return legacyEffectiveFirstFrameReferences(project, userId, plan, draft);
}

export function applyFirstFrameDraftToPlan(args: {
  project: any;
  userId: number;
  plan: FrameImageGenerationPlan;
  draft: FirstFrameEditDraft;
}): FrameImageGenerationPlan {
  const refs = effectiveFirstFrameReferences(args.project, args.userId, args.plan, args.draft);
  const customBlocks: string[] = [];
  const content = cleanText(args.draft.content, MAX_PROMPT_OVERRIDE_CHARS);
  const legacyAppendOnly = content && isLegacyStyleRulePromptOverride(content);
  if (legacyAppendOnly) {
    customBlocks.push(content);
  }
  if (args.draft.negativePromptOverride) {
    customBlocks.push('【User negative constraints】\n' + args.draft.negativePromptOverride);
  }
  const finalPrompt = content && !legacyAppendOnly
    ? content
    : [args.plan.finalPrompt, ...customBlocks].filter(Boolean).join('\n\n');
  return {
    ...args.plan,
    referenceManifest: refs.manifest,
    finalPrompt,
  };
}

export function firstFramePromptHash(prompt: string) {
  return hashText(prompt || '');
}
