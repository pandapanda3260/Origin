import { firstFrameImageUrl } from '/modules/frameRecommendations.js';

const SCENE_VIEW_ROLES = ['establishing', 'reverse', 'alt', 'topdown'];
const PROP_VIEW_SLOTS = ['hero', 'front', 'back', 'side_left', 'side_right', 'top'];

const REF_W = 280;
const PLAN_W = 280;
const SEG_W = 440;
const VID_W = 260;
const GAP_X = 140;
const GAP_Y = 36;
const ROW_H = 124;
const SEG_PAD_Y = 58;

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

function normalizeCharacterEntityType(value) {
  const v = text(value).toLowerCase();
  if (!v) return '';
  if (v === 'non-human' || v === 'nonhuman' || v.indexOf('非人') >= 0) return 'non-human';
  if (v === 'human' || v.indexOf('人物') >= 0 || v.indexOf('人类') >= 0) return 'human';
  return v;
}

function panelSchemaEntityType(panels) {
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

function canUseCharacterFallback(current, fallback, options = {}) {
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

export function resolveCharacterImageUrl(project, item, idx) {
  project = asObject(project);
  item = asObject(item);
  const ownUrl = firstAssetUrl(item.originalUrl, item.realPhotoUrl, item.rawUrl, item.imageUrl);
  if (ownUrl && canUseCharacterFallback(item, item, { requireIdentityMatch: false })) return ownUrl;

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

function normalizeSceneViewRole(role) {
  const value = text(role);
  return SCENE_VIEW_ROLES.indexOf(value) >= 0 ? value : '';
}

function sceneView(item, role) {
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

function normalizePropViewRole(role) {
  const value = text(role);
  return PROP_VIEW_SLOTS.indexOf(value) >= 0 || value === 'side' ? value : '';
}

function propViews(item) {
  const views = asObject(asObject(item).views);
  return views || {};
}

function propViewBySlot(item, slot) {
  const normalized = normalizePropViewRole(slot);
  if (!normalized) return null;
  const views = propViews(item);
  const slots = asObject(views.slots);
  if (slots[normalized]) return slots[normalized];
  if (views[normalized]) return views[normalized];
  if ((normalized === 'side_left' || normalized === 'side_right') && views.side) return views.side;
  return null;
}

function propViewOriginalUrl(item, slot) {
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

export function resolveVideoCoverUrl(project, groupIdx) {
  const storyboards = arr(asObject(project).storyboards);
  const videoTasks = arr(asObject(project).videoTasks);
  const sb = asObject(storyboards[groupIdx]);
  const vt = asObject(videoTasks[groupIdx]);
  return firstAssetUrl(sb.videoCoverUrl, vt.coverUrl, firstFrameImageUrl(sb));
}

export function resolveVideoStatus(project, groupIdx) {
  const storyboards = arr(asObject(project).storyboards);
  const videoTasks = arr(asObject(project).videoTasks);
  const sb = asObject(storyboards[groupIdx]);
  const vt = asObject(videoTasks[groupIdx]);
  const rawStatus = text(sb.videoStatus || vt.status).toLowerCase();
  if (rawStatus === 'failed' || rawStatus === 'timeout' || rawStatus === 'error') return 'failed';
  if (rawStatus === 'generating' || rawStatus === 'running' || rawStatus === 'queued') return 'generating';
  if (sb.videoIsCurrent === false || vt.isCurrent === false || vt.outdated) return 'outdated';
  if ((rawStatus === 'succeeded' || rawStatus === 'done' || rawStatus === 'completed') && vt.filename) return 'ready';
  if (sb.videoTaskId || vt.taskId || sb.videoUrl || vt.url || vt.protectedUrl) return 'ready';
  return 'missing';
}

function shotUidOf(project, shotIdx) {
  const shot = arr(asObject(project).shots)[shotIdx] || {};
  return text(shot.uid || shot.id || shot.shotUid || shot.shotId) || `shot-${shotIdx + 1}`;
}

function groupsFromProject(project, opts) {
  const storyboards = arr(asObject(project).storyboards);
  const groups = arr(opts && opts.groups);
  if (groups.length) {
    return groups.map((group, idx) => {
      const gIdx = Number.isInteger(Number(group && (group.gIdx ?? group.groupIdx))) ? Number(group.gIdx ?? group.groupIdx) : idx;
      const sb = asObject(storyboards[gIdx]);
      const shotIndices = arr(group && group.shotIndices).length ? arr(group.shotIndices) : (arr(sb.shotIndices).length ? arr(sb.shotIndices) : [gIdx]);
      return { gIdx, shotIndices: shotIndices.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0) };
    });
  }
  return storyboards.map((sb, gIdx) => {
    const shotIndices = arr(sb && sb.shotIndices).length ? arr(sb.shotIndices) : [gIdx];
    return { gIdx, shotIndices: shotIndices.map((value) => Number(value)).filter((n) => Number.isInteger(n) && n >= 0) };
  });
}

function buildReference(project) {
  const assets = asObject(asObject(project).assets);
  const characters = arr(assets.characters).map((item, idx) => ({
    id: text(item && (item.id || item.characterId || item.name)) || `character-${idx + 1}`,
    name: text(item && item.name) || `角色${idx + 1}`,
    coverUrl: resolveCharacterImageUrl(project, item, idx),
  }));
  const scenes = arr(assets.scenes).map((item, idx) => ({
    id: text(item && (item.id || item.sceneId || item.name)) || `scene-${idx + 1}`,
    name: text(item && item.name) || `场景${idx + 1}`,
    coverUrl: resolveSceneImageUrl(item, 'establishing'),
  }));
  const props = arr(assets.props).map((item, idx) => ({
    id: text(item && (item.id || item.propId || item.name)) || `prop-${idx + 1}`,
    name: text(item && item.name) || `道具${idx + 1}`,
    coverUrl: resolvePropImageUrl(item),
  }));
  return {
    empty: characters.length + scenes.length + props.length === 0,
    characters,
    scenes,
    props,
  };
}

function buildShotPlan(project) {
  const shots = arr(asObject(project).shots);
  return {
    generated: shots.length > 0,
    shotCount: shots.length,
    steps: {
      confirmShots: !!project.shotsApproved,
      prepareAssets: !!project.assetsApproved,
      composePrompt: !!(project.videoPromptsApproved || project.promptsApproved),
    },
  };
}

function buildSegments(project, opts) {
  const storyboards = arr(asObject(project).storyboards);
  return groupsFromProject(project, opts).map((group) => {
    const sb = asObject(storyboards[group.gIdx]);
    const coverUrl = firstFrameImageUrl(sb);
    const shotRows = group.shotIndices.map((shotIdx) => ({
      shotIdx,
      shotUid: shotUidOf(project, shotIdx),
      candidates: coverUrl ? [{ id: `first:${group.gIdx}:${shotIdx}`, url: coverUrl, kind: 'segment-cover-placeholder', label: '片段封面占位' }] : [],
      coverUrl,
    }));
    return {
      gIdx: group.gIdx,
      shotIndices: group.shotIndices,
      shotRows,
      coverUrl,
      video: {
        coverUrl: resolveVideoCoverUrl(project, group.gIdx),
        status: resolveVideoStatus(project, group.gIdx),
        taskId: text(asObject(arr(project.videoTasks)[group.gIdx]).taskId || sb.videoTaskId),
      },
    };
  });
}

function layoutBoard(model) {
  const colRef = 0;
  const colPlan = colRef + REF_W + GAP_X;
  const colSeg = colPlan + PLAN_W + GAP_X;
  const colVid = colSeg + SEG_W + GAP_X;
  const segYs = [];
  let cursorY = 0;
  model.segments.forEach((segment) => {
    const rows = Math.max(1, segment.shotRows.length);
    const h = SEG_PAD_Y + rows * ROW_H;
    segYs.push({ gIdx: segment.gIdx, y: cursorY, h });
    cursorY += h + GAP_Y;
  });
  const stackH = Math.max(260, cursorY ? cursorY - GAP_Y : 260);
  const refH = model.reference.empty ? 220 : Math.min(560, Math.max(260, 120 + (model.reference.characters.length + model.reference.scenes.length + model.reference.props.length) * 44));
  const planH = 240;
  const nodes = [
    { id: 'reference', kind: 'reference', x: colRef, y: (stackH - refH) / 2, w: REF_W, h: refH, data: model.reference },
    { id: 'shot-plan', kind: 'shot-plan', x: colPlan, y: (stackH - planH) / 2, w: PLAN_W, h: planH, data: model.shotPlan },
  ];
  segYs.forEach((slot) => {
    const segment = model.segments.find((item) => item.gIdx === slot.gIdx);
    nodes.push({ id: `segment:${slot.gIdx}`, kind: 'segment', x: colSeg, y: slot.y, w: SEG_W, h: slot.h, data: segment });
    nodes.push({ id: `video:${slot.gIdx}`, kind: 'video', x: colVid, y: slot.y, w: VID_W, h: slot.h, data: segment.video });
  });
  const edges = [{ from: 'reference', to: 'shot-plan' }];
  model.segments.forEach((segment) => {
    edges.push({ from: 'shot-plan', to: `segment:${segment.gIdx}` });
    edges.push({ from: `segment:${segment.gIdx}`, to: `video:${segment.gIdx}` });
  });
  return { nodes, edges, bounds: { x: 0, y: 0, w: colVid + VID_W, h: stackH } };
}

export function buildBoardViewModel(project, opts = {}) {
  project = asObject(project);
  const model = {
    reference: buildReference(project),
    shotPlan: buildShotPlan(project),
    segments: buildSegments(project, opts),
  };
  const layout = layoutBoard(model);
  return { ...model, ...layout };
}
