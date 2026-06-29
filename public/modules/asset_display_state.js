const ASSET_CARD_DISPLAY_W = 1024;
const ASSET_CARD_THUMB_W = 512;
const ASSET_LIGHTBOX_W = 1600;
const SCENE_VIEW_ROLES = ['establishing', 'reverse', 'alt', 'topdown'];
const PROP_VIEW_SLOTS = ['hero', 'front', 'back', 'side_left', 'side_right', 'top'];

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function firstAssetUrl(...values) {
  for (const value of values) {
    const url = text(value);
    if (url) return url;
  }
  return '';
}

function assetVariant(url, width, options) {
  const value = text(url);
  if (!value) return '';
  const resolver = options && options.imageVariantUrl;
  if (typeof resolver === 'function') return resolver(value, { w: width });
  return value;
}

function assetOriginal(url, options) {
  const value = text(url);
  if (!value) return '';
  const resolver = options && options.imageVariantUrl;
  if (typeof resolver === 'function') return resolver(value, { w: 0 });
  return value;
}

export function normalizeCharacterEntityType(value) {
  const v = text(value).toLowerCase();
  if (!v) return '';
  if (v === 'non-human' || v === 'nonhuman' || v.indexOf('非人') >= 0) return 'non-human';
  if (v === 'human' || v.indexOf('人物') >= 0 || v.indexOf('人类') >= 0) return 'human';
  return v;
}

export function panelSchemaEntityType(panels) {
  const schema = text(asObject(panels).schema).toLowerCase();
  if (!schema) return '';
  if (schema.indexOf('non-human') >= 0 || schema.indexOf('nonhuman') >= 0) return 'non-human';
  if (schema.indexOf('human-character') >= 0) return 'human';
  return '';
}

function characterIdentityKeys(item) {
  item = asObject(item);
  return [item.characterId, item.id, item.name].filter(Boolean).map((value) => {
    return String(value).trim().toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, '');
  }).filter(Boolean);
}

function hasSharedCharacterKey(left, right) {
  const leftKeys = characterIdentityKeys(left);
  const rightKeys = characterIdentityKeys(right);
  if (!leftKeys.length || !rightKeys.length) return false;
  return leftKeys.some((key) => rightKeys.indexOf(key) >= 0);
}

export function canUseCharacterFallback(current, fallback, options = {}) {
  if (!fallback || typeof fallback !== 'object') return false;
  const currentEntity = normalizeCharacterEntityType(current && current.entityType);
  const fallbackEntity = normalizeCharacterEntityType(fallback.entityType);
  const fallbackSchemaEntity = panelSchemaEntityType(fallback.panels);

  if (currentEntity && fallbackEntity && currentEntity !== fallbackEntity) return false;
  if (currentEntity && fallbackSchemaEntity && currentEntity !== fallbackSchemaEntity) return false;
  if (currentEntity === 'non-human' && !fallbackEntity && !fallbackSchemaEntity) return false;
  if (fallbackSchemaEntity === 'human' && currentEntity === 'non-human') return false;
  if (fallbackSchemaEntity === 'non-human' && currentEntity === 'human') return false;
  if (options.requireIdentityMatch && !hasSharedCharacterKey(current, fallback)) return false;
  return true;
}

export function characterOwnImageUrl(item) {
  item = asObject(item);
  const ownUrl = firstAssetUrl(item.originalUrl, item.realPhotoUrl, item.rawUrl, item.imageUrl);
  if (!ownUrl) return '';
  return canUseCharacterFallback(item, item, { requireIdentityMatch: false }) ? ownUrl : '';
}

export function characterFallbackImageUrl(project, item, idx) {
  project = asObject(project);
  item = asObject(item);
  const reference = asObject(item.reference);
  const ownReferenceUrl = firstAssetUrl(reference.lastKnownGoodUrl, reference.currentUrl);
  if (ownReferenceUrl && canUseCharacterFallback(item, item, { requireIdentityMatch: false })) return ownReferenceUrl;

  const topChar = arr(project.characters)[idx] || null;
  const topReference = asObject(topChar && topChar.reference);
  const topPanels = asObject(topChar && topChar.panels);
  const topUrl = topChar ? firstAssetUrl(
    topChar.originalUrl,
    topChar.realPhotoUrl,
    topChar.rawUrl,
    topChar.imageUrl,
    topChar.pencilUrl,
    topReference.lastKnownGoodUrl,
    topReference.currentUrl,
    topPanels.sheetUrl,
  ) : '';
  if (topUrl && canUseCharacterFallback(item, topChar, { requireIdentityMatch: false })) return topUrl;

  const keys = [item.characterId, item.id, item.name].filter(Boolean).map((value) => String(value));
  const locks = arr(asObject(project.consistency).characters);
  for (let lockIdx = 0; lockIdx < locks.length; lockIdx += 1) {
    const lock = asObject(locks[lockIdx]);
    let matches = keys.indexOf(String(lock.characterId || '')) >= 0 || keys.indexOf(String(lock.canonicalName || '')) >= 0;
    if (!matches && !keys.length && typeof idx === 'number') matches = lockIdx === idx;
    if (!matches) continue;
    const lockFallback = {
      characterId: lock.characterId || lock.sourceAssetId,
      id: lock.sourceAssetId || lock.characterId,
      name: lock.canonicalName,
      entityType: asObject(lock.identityLock).entityType,
    };
    if (!canUseCharacterFallback(item, lockFallback, { requireIdentityMatch: true })) continue;
    const referenceLock = asObject(lock.referenceLock);
    const lockUrl = firstAssetUrl(
      referenceLock.sheetUrl,
      referenceLock.headshotUrl,
      referenceLock.frontUrl,
      referenceLock.sideUrl,
      referenceLock.backUrl,
    );
    if (lockUrl) return lockUrl;
  }

  return '';
}

export function resolveCharacterImageUrl(project, item, idx) {
  return characterOwnImageUrl(item) || characterFallbackImageUrl(project, item, idx) || '';
}

function characterReferenceFailureMessage(_lastError) {
  return '本次生成结果不可用，请重新生成';
}

export function deriveAssetCardState(item, idx, options = {}) {
  item = asObject(item);
  const reference = asObject(item.reference);
  const project = asObject(options.project);
  const mainOriginalUrl = resolveCharacterImageUrl(project, item, idx);
  const mainImageUrl = item.displayUrl || assetVariant(mainOriginalUrl, ASSET_CARD_DISPLAY_W, options);
  const thumbnailUrl = item.thumbUrl || assetVariant(mainOriginalUrl, ASSET_CARD_THUMB_W, options);
  const zoomUrl = assetVariant(item.originalUrl || mainOriginalUrl, ASSET_LIGHTBOX_W, options);
  const failed = reference.status === 'failed';
  const degraded = reference.status === 'degraded' && !!mainImageUrl;
  const failedAttemptUrl = failed ? (reference.lastAttemptUrl || '') : '';
  const failedReason = reference.lastError && reference.lastError.reason ? String(reference.lastError.reason) : '';
  const canPreviewFailedAttempt = failed && failedAttemptUrl && failedReason === 'character_panel_split_failed';
  const failedAttemptDisplayUrl = assetVariant(failedAttemptUrl, ASSET_CARD_DISPLAY_W, options);
  const failedAttemptThumbUrl = assetVariant(failedAttemptUrl, ASSET_CARD_THUMB_W, options);
  const failedAttemptZoomUrl = assetVariant(failedAttemptUrl, ASSET_LIGHTBOX_W, options);
  const failedAttemptOriginalUrl = assetOriginal(failedAttemptUrl, options);
  return {
    status: failed ? 'failed' : (degraded ? 'degraded' : (mainImageUrl ? 'ready' : 'missing')),
    originalUrl: assetOriginal(mainOriginalUrl, options),
    mainImageUrl,
    thumbnailUrl,
    zoomUrl,
    previewMode: canPreviewFailedAttempt ? 'failed_attempt' : (mainImageUrl ? 'accepted' : 'missing'),
    previewImageUrl: canPreviewFailedAttempt ? failedAttemptDisplayUrl : mainImageUrl,
    previewThumbUrl: canPreviewFailedAttempt ? failedAttemptThumbUrl : thumbnailUrl,
    previewZoomUrl: canPreviewFailedAttempt ? failedAttemptZoomUrl : zoomUrl,
    previewOriginalUrl: canPreviewFailedAttempt ? failedAttemptOriginalUrl : assetOriginal(mainOriginalUrl, options),
    failedAttemptUrl,
    failedAttemptThumbUrl,
    failedAttemptZoomUrl,
    statusLabel: failed ? '生成失败' : (degraded ? '可用（比例兜底）' : (mainImageUrl ? '已完成' : '待生成')),
    statusMessage: failed
      ? characterReferenceFailureMessage(reference.lastError)
      : (degraded ? '生成完成，采用比例兜底切片，可用于后续镜头/视频引用' : ''),
  };
}

export function normalizeSceneViewRole(role) {
  const value = text(role);
  return SCENE_VIEW_ROLES.indexOf(value) >= 0 ? value : '';
}

export function sceneView(item, role) {
  const normalized = normalizeSceneViewRole(role) || 'establishing';
  const views = arr(asObject(item).views);
  for (let i = 0; i < views.length; i += 1) {
    if (normalizeSceneViewRole(views[i] && views[i].role) === normalized) return views[i];
  }
  return null;
}

export function resolveSceneImageUrl(item, role = 'establishing') {
  item = asObject(item);
  const normalized = normalizeSceneViewRole(role) || 'establishing';
  const view = sceneView(item, normalized);
  const ref = asObject(view && view.reference);
  if (view) return firstAssetUrl(ref.currentUrl, ref.lastKnownGoodUrl, view.imageUrl, view.rawUrl);
  if (normalized === 'establishing') {
    const topRef = asObject(item.reference);
    return firstAssetUrl(topRef.currentUrl, topRef.lastKnownGoodUrl, item.originalUrl, item.rawUrl, item.imageUrl, item.displayUrl);
  }
  return '';
}

export function normalizePropViewRole(role) {
  const value = text(role);
  return PROP_VIEW_SLOTS.indexOf(value) >= 0 || value === 'side' ? value : '';
}

export function propViews(item) {
  return asObject(asObject(item).views);
}

export function propViewBySlot(item, slot) {
  const normalized = normalizePropViewRole(slot);
  if (!normalized) return null;
  const views = propViews(item);
  const slots = asObject(views.slots);
  if (slots[normalized]) return slots[normalized];
  if (views[normalized]) return views[normalized];
  if ((normalized === 'side_left' || normalized === 'side_right') && views.side) return views.side;
  return null;
}

export function propViewOriginalUrl(item, slot) {
  const view = propViewBySlot(item, slot);
  const ref = asObject(view && view.reference);
  return firstAssetUrl(ref.currentUrl, ref.lastKnownGoodUrl, view && view.imageUrl, view && view.rawUrl);
}

export function resolvePropImageUrl(item) {
  item = asObject(item);
  const ref = asObject(item.reference);
  return firstAssetUrl(
    propViewOriginalUrl(item, 'front'),
    propViewOriginalUrl(item, 'hero'),
    propViewOriginalUrl(item, 'side'),
    propViewOriginalUrl(item, 'back'),
    propViewOriginalUrl(item, 'top'),
    ref.currentUrl,
    ref.lastKnownGoodUrl,
    item.originalUrl,
    item.rawUrl,
    item.imageUrl,
    item.displayUrl,
  );
}
