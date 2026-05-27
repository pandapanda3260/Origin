import { basename, relative } from 'node:path';
import { resolveLocalImagePath } from './image-gen';
import { isBlockingReferenceStatus, resolveAssetReferenceState } from './visual-reference-state';
import { selectCharacterReferencePanels, type CharacterReferencePanel } from './panel-selection';
import { pickSceneForShots } from './scene-selection';
import {
  materialRoleToVideoRole,
  type StoryboardMaterialRole,
} from './reference-roles';
import {
  normalizeReferenceName,
  VIDEO_REFERENCE_IMAGE_BUDGET,
  type DroppedReference,
  type ReferenceManifestItem,
  type VideoReferenceRole,
} from './video-reference-manifest';
import { dataPath } from './runtime-paths';

type Candidate = Omit<ReferenceManifestItem, 'imageNo'> & {
  type: VideoReferenceRole;
  name: string;
  score: number;
  _order: number;
  mentionCount?: number;
  firstMentionIndex?: number;
  relevanceScore?: number;
};

export type BuildVideoReferenceManifestInput = {
  project?: any;
  assets?: any;
  shots?: any[];
  groupShotIndices?: number[];
  groupIdx?: number;
  ownerId: number;
  storyboardImageUrl?: string | null;
  budget?: number;
};

export type BuildVideoReferenceManifestResult = {
  manifest: ReferenceManifestItem[];
  droppedReferences: DroppedReference[];
  candidates: ReferenceManifestItem[];
  budget: number;
};

function compactText(value: unknown): string {
  return String(value || '').trim();
}

function assetName(asset: any, fallback: string): string {
  return compactText(asset?.name || asset?.role || asset?.propName || asset?.location || fallback);
}

function assetUrl(asset: any): string {
  const reference = resolveAssetReferenceState(asset);
  if (isBlockingReferenceStatus(reference.status)) return '';
  return compactText(reference.currentUrl || reference.lastKnownGoodUrl || asset?.imageUrl || asset?.rawUrl || asset?.realPhotoUrl || asset?.coverUrl);
}

function assetId(asset: any): string | undefined {
  const id = compactText(asset?.id || asset?.assetId || asset?.uuid);
  return id || undefined;
}

function uiTypeForRole(role: StoryboardMaterialRole): 'scene' | 'char' | 'prop' {
  return role === 'character' ? 'char' : role;
}

function materialIdentityKeys(role: StoryboardMaterialRole, asset: any, idx?: number): string[] {
  const source = asset || {};
  const fields = role === 'character'
    ? [source.characterId, source.materialId, source.id, source.assetId, source.name, source.role, source.identity]
    : role === 'scene'
      ? [source.sceneId, source.materialId, source.id, source.assetId, source.name, source.sceneName, source.location, source.title]
      : [source.propId, source.materialId, source.id, source.assetId, source.name, source.propName, source.title, source.propType];
  const prefixes = role === 'character' ? ['character', 'char'] : [role];
  const keys: string[] = [];
  for (const field of fields) {
    const value = compactText(field);
    if (value) {
      for (const prefix of prefixes) keys.push(`${prefix}:${value}`);
    }
  }
  const url = assetUrl(source);
  if (url) {
    for (const prefix of prefixes) keys.push(`${prefix}:url:${url}`);
  }
  return [...new Set(keys)];
}

function isMaterialAssetExcluded(
  project: any,
  role: StoryboardMaterialRole,
  asset: any,
  groupIdx: number | undefined,
  idx?: number,
): boolean {
  if (!asset || !Number.isInteger(groupIdx) || Number(groupIdx) < 0) return false;
  const exclusions = project?.storyboardMaterialExclusions?.[String(groupIdx)];
  if (!exclusions) return false;
  const buckets = [exclusions[role], exclusions[uiTypeForRole(role)]].filter(Boolean);
  if (!buckets.length) return false;
  const keys = materialIdentityKeys(role, asset, idx);
  return buckets.some((bucket: any) => keys.some((key) => !!bucket[key]));
}

function collectCharacters(project: any, assets: any): any[] {
  return [
    ...(Array.isArray(assets?.characters) ? assets.characters : []),
    ...(Array.isArray(project?.characters) ? project.characters : []),
  ];
}

function isStoryboardMaterialForGroup(asset: any, groupIdx: number | undefined, role: VideoReferenceRole): boolean {
  if (role === 'first_frame') return false;
  if (!Number.isInteger(groupIdx) || Number(groupIdx) < 0) return false;
  if (asset?.reference?.status === 'missing' || asset?.reference?.status === 'failed') return false;
  const materialGroupIdx = Number(asset?.storyboardMaterialGroupIdx);
  if (!Number.isFinite(materialGroupIdx) || materialGroupIdx !== Number(groupIdx)) return false;
  if (!asset?.storyboardMaterialRole) return false;
  return materialRoleToVideoRole(asset.storyboardMaterialRole) === role;
}

function findCharacterByName(characters: any[], name: string): any | null {
  const key = normalizeReferenceName(name);
  return characters.find((ch) => normalizeReferenceName(ch?.name || ch?.role || ch?.id || ch?.label) === key) || null;
}

function publicImageUrlFromLocalPath(path: string, ownerId: number): string {
  const normalized = String(path || '');
  const rel = relative(dataPath('images', String(ownerId)), normalized);
  if (!rel || rel.startsWith('..') || rel.includes('/')) return '';
  const m = /^([0-9a-fA-F-]{36})\.png$/.exec(basename(normalized));
  return m ? `/api/images/file/${m[1]}` : '';
}

function panelUrlForCharacter(character: any, panel: CharacterReferencePanel, ownerId: number): string {
  const reference = resolveAssetReferenceState(character);
  if (isBlockingReferenceStatus(reference.status)) return '';
  const panels = character?.panels || {};
  const key = panel.panel === 'sheet' ? 'sheetUrl' : `${panel.panel}Url`;
  const urls = [
    panels?.[key],
    panel.panel === 'sheet' ? character?.rawUrl || character?.imageUrl || character?.realPhotoUrl || character?.pencilUrl : null,
  ].filter(Boolean);
  for (const url of urls) {
    if (resolveLocalImagePath(url, ownerId) === panel.path) return String(url);
  }
  const urlFromPath = publicImageUrlFromLocalPath(panel.path, ownerId);
  if (urlFromPath) return urlFromPath;
  return String(urls[0] || '');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    count += 1;
    pos = idx + Math.max(needle.length, 1);
  }
  return count;
}

function firstOccurrenceIndex(haystack: string, needle: string): number {
  if (!haystack || !needle) return Number.MAX_SAFE_INTEGER;
  const idx = haystack.indexOf(needle);
  return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
}

function shotsFromInput(input: BuildVideoReferenceManifestInput): any[] {
  if (Array.isArray(input.groupShotIndices) && input.groupShotIndices.length) {
    const projectShots = Array.isArray(input.project?.shots) ? input.project.shots : [];
    if (projectShots.length) {
      return input.groupShotIndices.map((idx) => projectShots[idx]).filter(Boolean);
    }
    const inputShots = Array.isArray(input.shots) ? input.shots : [];
    const canIndexInputShots = input.groupShotIndices.every((idx) => Number.isInteger(idx) && idx >= 0 && idx < inputShots.length);
    return canIndexInputShots
      ? input.groupShotIndices.map((idx) => inputShots[idx]).filter(Boolean)
      : inputShots;
  }
  if (Array.isArray(input.shots) && input.shots.length) return input.shots;
  const allShots = Array.isArray(input.project?.shots) ? input.project.shots : [];
  if (allShots.length) return allShots;
  return [];
}

function shotText(shots: any[]): string {
  return shots.map((sh: any) => [
    sh?.visual,
    sh?.description,
    sh?.desc,
    sh?.dialogue,
    sh?.scriptRef,
    sh?.keyInfo,
    sh?.location,
    sh?.sceneId,
    sh?.sceneName,
    sh?.scene,
    Array.isArray(sh?.characters) ? sh.characters.join(' ') : '',
  ].filter(Boolean).join(' ')).join(' ');
}

function firstChars(shots: any[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sh of shots) {
    if (!Array.isArray(sh?.characters)) continue;
    for (const name of sh.characters) {
      const raw = compactText(name);
      const norm = normalizeReferenceName(raw);
      if (!raw || !norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(raw);
    }
  }
  return out;
}

function pushCandidate(list: Candidate[], candidate: Omit<Candidate, '_order'>) {
  if (!candidate.url) return;
  // The current video-reference policy intentionally pushes at most one image
  // per character. If future work allows multiple panels for the same character,
  // this de-dupe key must include panelInfo.panel.
  const duplicateIdx = list.findIndex((item) => item.url === candidate.url || (
    item.role === candidate.role &&
    normalizeReferenceName(item.assetName) === normalizeReferenceName(candidate.assetName)
  ));
  if (duplicateIdx >= 0) {
    if ((candidate.score || 0) > (list[duplicateIdx].score || 0)) {
      list[duplicateIdx] = { ...candidate, _order: list[duplicateIdx]._order };
    }
    return;
  }
  list.push({ ...candidate, _order: list.length });
}

function roleDefaults(role: VideoReferenceRole): Pick<ReferenceManifestItem, 'useFor' | 'immutable' | 'promptHint'> {
  if (role === 'first_frame') {
    return {
      useFor: ['锁定第 0 帧开场构图', '光照', '主体位置', '画面比例', '色调基准'],
      immutable: ['构图', '光照方向', '主体站位', '画面比例'],
      promptHint: '角色身份由 character reference 锁定，场景细节由 scene reference 锁定。',
    };
  }
  if (role === 'scene') {
    return {
      useFor: ['锁定环境布局', '空间结构', '材质', '氛围'],
      immutable: ['场景类型', '道路/地形结构', '主色调', '主要空间关系'],
    };
  }
  if (role === 'character') {
    return {
      useFor: ['锁定角色脸部', '体型', '服装', '物种特征'],
      immutable: ['脸型', '毛发/发色', '服装颜色', '身体类型'],
    };
  }
  return {
    useFor: ['锁定道具材质', '颜色', '尺度', '识别特征'],
    immutable: ['核心形状', '主色', '材质', '用途'],
  };
}

function characterPanelUseFor(panel: CharacterReferencePanel): string[] {
  if (panel.intent === 'face') return ['锁定近景脸部', '表情结构', '毛发/发色', '服装领口细节'];
  if (panel.intent === 'profile') return ['锁定侧脸/侧身轮廓', '体型', '服装侧面细节', '物种特征'];
  if (panel.intent === 'back') return ['锁定背面轮廓', '背部服装', '发型/毛发背面', '身体类型'];
  return ['锁定角色脸部', '体型', '服装', '物种特征'];
}

function addFirstFrameCandidate(candidates: Candidate[], input: BuildVideoReferenceManifestInput) {
  const url = compactText(input.storyboardImageUrl);
  if (!url) return;
  const localPath = resolveLocalImagePath(url, input.ownerId) || undefined;
  if (!localPath) return;
  const defaults = roleDefaults('first_frame');
  pushCandidate(candidates, {
    type: 'first_frame',
    role: 'first_frame',
    name: 'first_frame',
    label: `segment ${(input.groupIdx ?? 0) + 1} first frame`,
    url,
    localPath,
    useFor: defaults.useFor,
    immutable: defaults.immutable,
    promptHint: defaults.promptHint,
    matchReason: 'storyboardImageUrl',
    score: 1000,
    assetName: 'first frame',
  });
}

function slotSelect(candidates: Candidate[], budget: number): { selected: Candidate[]; dropped: DroppedReference[] } {
  const byRole = (role: VideoReferenceRole) => candidates
    .filter((c) => c.role === role)
    .sort((a, b) => {
      if (role === 'prop') {
        return ((b.mentionCount || 0) - (a.mentionCount || 0)) ||
          ((a.firstMentionIndex ?? Number.MAX_SAFE_INTEGER) - (b.firstMentionIndex ?? Number.MAX_SAFE_INTEGER)) ||
          ((b.relevanceScore ?? b.score) - (a.relevanceScore ?? a.score)) ||
          (a._order - b._order);
      }
      return (b.score - a.score) || (a._order - b._order);
    });

  const selected: Candidate[] = [];
  const selectedKeys = new Set<string>();
  const take = (candidate?: Candidate) => {
    if (!candidate) return;
    const key = `${candidate.role}:${candidate.url}`;
    if (selectedKeys.has(key)) return;
    if (selected.length >= budget) return;
    selected.push(candidate);
    selectedKeys.add(key);
  };

  const firstFrames = byRole('first_frame');
  const scenes = byRole('scene');
  const chars = byRole('character');
  const props = byRole('prop');

  [
    firstFrames[0],
    scenes[0],
    chars[0],
    chars[1],
    chars[2],
    props[0],
    chars[3],
    props[1],
    chars[4],
    props[2],
  ].forEach(take);

  const dropped: DroppedReference[] = [];
  for (const c of candidates) {
    if (selected.some((s) => s.url === c.url)) continue;
    if (c.role === 'first_frame') continue;
    dropped.push({
      role: c.role,
      assetName: c.assetName,
      reason: 'image_budget_exceeded',
    });
  }
  return { selected, dropped };
}

export function buildVideoReferenceManifest(input: BuildVideoReferenceManifestInput): BuildVideoReferenceManifestResult {
  const project = input.project || {};
  const assets = input.assets || project.assets || {};
  const shots = shotsFromInput(input);
  const text = shotText(shots);
  const normText = normalizeReferenceName(text);
  const explicitCharNames = firstChars(shots);
  const explicitCharNorms = new Set(explicitCharNames.map(normalizeReferenceName).filter(Boolean));
  const budget = Math.max(1, Math.min(Number(input.budget || VIDEO_REFERENCE_IMAGE_BUDGET), VIDEO_REFERENCE_IMAGE_BUDGET));

  const candidates: Candidate[] = [];
  const dropped: DroppedReference[] = [];

  addFirstFrameCandidate(candidates, input);

  const chars: any[] = collectCharacters(project, assets);

  const selectedPanels = selectCharacterReferencePanels({
    project: {
      ...project,
      assets: { ...(project.assets || {}), ...assets },
      shots: Array.isArray(project?.shots) ? project.shots : input.shots,
    },
    ownerId: input.ownerId,
    groupShotIndices: input.groupShotIndices,
    shots,
    maxSlots: 5,
    perCharacterLimit: 1,
  });
  selectedPanels.forEach((panel, idx) => {
    const ch = findCharacterByName(chars, panel.characterName);
    const chIdx = ch ? chars.indexOf(ch) : -1;
    if (ch && isMaterialAssetExcluded(project, 'character', ch, input.groupIdx, chIdx >= 0 ? chIdx : undefined)) return;
    const url = ch ? panelUrlForCharacter(ch, panel, input.ownerId) : '';
    if (!url) {
      dropped.push({ role: 'character', assetName: panel.characterName, reason: 'url_lookup_failed' });
      return;
    }
    const defaults = roleDefaults('character');
    pushCandidate(candidates, {
      type: 'character',
      role: 'character',
      assetId: ch ? assetId(ch) : undefined,
      assetName: panel.characterName,
      name: panel.characterName,
      label: `${panel.characterName} character reference (${panel.panel})`,
      url,
      localPath: panel.path,
      useFor: characterPanelUseFor(panel),
      immutable: defaults.immutable,
      promptHint: `Preserve identity, costume, species/body features, and ${panel.intent} details.`,
      matchReason: `panel selection ${panel.reason}`,
      score: 180 + panel.priority * 5 - idx,
      panelInfo: {
        panel: panel.panel,
        intent: panel.intent,
      },
    });
  });
  const panelCoveredCharacterNames = new Set(
    candidates
      .filter((c) => c.role === 'character')
      .map((c) => normalizeReferenceName(c.assetName || c.name))
      .filter(Boolean),
  );

  chars.forEach((ch, idx) => {
    if (isMaterialAssetExcluded(project, 'character', ch, input.groupIdx, idx)) return;
    const name = assetName(ch, `角色${idx + 1}`);
    const norm = normalizeReferenceName(name);
    if (!norm) return;
    const explicit = explicitCharNorms.has(norm);
    const mentions = countOccurrences(normText, norm);
    const manualMatch = isStoryboardMaterialForGroup(ch, input.groupIdx, 'character');
    if (!manualMatch && !explicit && mentions <= 0) return;
    const url = assetUrl(ch);
    if (!url) {
      if (panelCoveredCharacterNames.has(norm)) return;
      dropped.push({ role: 'character', assetName: name, reason: 'asset_missing' });
      return;
    }
    const localPath = resolveLocalImagePath(url, input.ownerId) || undefined;
    if (!localPath) {
      if (panelCoveredCharacterNames.has(norm)) return;
      dropped.push({ role: 'character', assetName: name, reason: 'asset_missing' });
      return;
    }
    const defaults = roleDefaults('character');
    const hint = [ch?.appearance, ch?.clothing, ch?.temperament, ch?.entityType]
      .filter(Boolean)
      .join(' ')
      .slice(0, 160);
    pushCandidate(candidates, {
      type: 'character',
      role: 'character',
      assetId: assetId(ch),
      assetName: name,
      name,
      label: `${name} character reference`,
      url,
      localPath,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: hint || defaults.promptHint,
      matchReason: manualMatch
        ? 'storyboard material group match'
        : explicit
          ? 'shot.characters exact match'
          : 'group text name match',
      score: (manualMatch ? 520 : explicit ? 100 : 70) + mentions * 5 - idx,
    });
  });

  const scenes: any[] = Array.isArray(assets?.scenes)
    ? assets.scenes
    : Array.isArray(assets?.environments)
      ? assets.environments
      : Array.isArray(project?.environments)
        ? project.environments
        : [];
  const explicitSceneSelection = pickSceneForShots(
    { project, assets, shots, text },
    { requireImage: true, preferFirstShot: true },
  );
  const explicitScene = explicitSceneSelection.scene;
  const explicitSceneId = explicitScene ? assetId(explicitScene) : '';
  const explicitSceneName = explicitScene ? normalizeReferenceName(assetName(explicitScene, '')) : '';
  scenes.forEach((scene, idx) => {
    if (isMaterialAssetExcluded(project, 'scene', scene, input.groupIdx, idx)) return;
    const name = assetName(scene, `场景${idx + 1}`);
    const norm = normalizeReferenceName(name);
    const mentions = norm ? countOccurrences(normText, norm) : 0;
    const isMain = !!scene?.isMain;
    const explicitMatch = !!explicitScene && (
      (!!explicitSceneId && assetId(scene) === explicitSceneId) ||
      (!!explicitSceneName && norm === explicitSceneName)
    );
    const manualMatch = isStoryboardMaterialForGroup(scene, input.groupIdx, 'scene');
    if (!manualMatch && !explicitMatch && !mentions && !isMain) return;
    const url = assetUrl(scene);
    if (!url) {
      dropped.push({ role: 'scene', assetName: name, reason: 'asset_missing' });
      return;
    }
    const localPath = resolveLocalImagePath(url, input.ownerId) || undefined;
    if (!localPath) {
      dropped.push({ role: 'scene', assetName: name, reason: 'asset_missing' });
      return;
    }
    const defaults = roleDefaults('scene');
    const sceneReference = resolveAssetReferenceState(scene);
    const hint = [sceneReference.effectiveDescription, scene?.location, scene?.lighting, scene?.atmosphere, scene?.elements]
      .filter(Boolean)
      .join(' ')
      .slice(0, 180);
    pushCandidate(candidates, {
      type: 'scene',
      role: 'scene',
      assetId: assetId(scene),
      assetName: name,
      name,
      label: `${name} scene reference`,
      url,
      localPath,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: hint || defaults.promptHint,
      matchReason: manualMatch
        ? 'storyboard material group match'
        : explicitMatch
        ? `shot ${explicitSceneSelection.matchReason} match`
        : mentions
          ? 'group visual/location text match'
          : 'fallback main scene',
      score: manualMatch
        ? 540 - idx
        : explicitMatch
          ? 260 - idx
          : (mentions ? 85 + mentions * 8 : 45) + (isMain ? 10 : 0) - idx,
    });
  });
  if (!candidates.some((c) => c.role === 'scene')) {
    const fallback = scenes.find((s, idx) => assetUrl(s) && !isMaterialAssetExcluded(project, 'scene', s, input.groupIdx, idx));
    if (fallback) {
      const name = assetName(fallback, '主场景');
      const url = assetUrl(fallback);
      const localPath = resolveLocalImagePath(url, input.ownerId) || undefined;
      if (localPath) {
        const defaults = roleDefaults('scene');
        pushCandidate(candidates, {
          type: 'scene',
          role: 'scene',
          assetId: assetId(fallback),
          assetName: name,
          name,
          label: `${name} scene reference`,
          url,
          localPath,
          useFor: defaults.useFor,
          immutable: defaults.immutable,
          promptHint: defaults.promptHint,
          matchReason: 'fallback first scene with image',
          score: 35,
        });
      }
    }
  }

  const props: any[] = Array.isArray(assets?.props) ? assets.props : [];
  props.forEach((prop, idx) => {
    if (isMaterialAssetExcluded(project, 'prop', prop, input.groupIdx, idx)) return;
    const name = assetName(prop, `道具${idx + 1}`);
    const norm = normalizeReferenceName(name);
    const mentions = norm ? countOccurrences(normText, norm) : 0;
    const manualMatch = isStoryboardMaterialForGroup(prop, input.groupIdx, 'prop');
    if (!manualMatch && !mentions) return;
    const firstMention = firstOccurrenceIndex(normText, norm);
    const url = assetUrl(prop);
    if (!url) {
      dropped.push({ role: 'prop', assetName: name, reason: 'asset_missing' });
      return;
    }
    const localPath = resolveLocalImagePath(url, input.ownerId) || undefined;
    if (!localPath) {
      dropped.push({ role: 'prop', assetName: name, reason: 'asset_missing' });
      return;
    }
    const defaults = roleDefaults('prop');
    const propReference = resolveAssetReferenceState(prop);
    const hint = [propReference.effectiveDescription, prop?.visual, prop?.material, prop?.imagePrompt]
      .filter(Boolean)
      .join(' ')
      .slice(0, 160);
    pushCandidate(candidates, {
      type: 'prop',
      role: 'prop',
      assetId: assetId(prop),
      assetName: name,
      name,
      label: `${name} prop reference`,
      url,
      localPath,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: hint || defaults.promptHint,
      matchReason: manualMatch
        ? 'storyboard material group match'
        : 'group visual/dialogue/keyInfo text match',
      score: (manualMatch ? 500 : 80) + mentions * 8 - idx,
      mentionCount: mentions,
      firstMentionIndex: firstMention,
      relevanceScore: 80,
    });
  });

  const slotResult = slotSelect(candidates, budget);
  const manifest = slotResult.selected.map((ref, idx) => ({
    imageNo: idx + 1,
    role: ref.role,
    assetId: ref.assetId,
    assetName: ref.assetName,
    label: ref.label,
    url: ref.url,
    localPath: ref.localPath,
    useFor: ref.useFor,
    immutable: ref.immutable,
    promptHint: ref.promptHint,
    priority: ref.priority,
    matchReason: ref.matchReason,
    score: ref.score,
    panelInfo: ref.panelInfo,
  }));

  return {
    manifest,
    droppedReferences: [...dropped, ...slotResult.dropped],
    candidates: candidates.map((ref, idx) => ({
      imageNo: idx + 1,
      role: ref.role,
      assetId: ref.assetId,
      assetName: ref.assetName,
      label: ref.label,
      url: ref.url,
      localPath: ref.localPath,
      useFor: ref.useFor,
      immutable: ref.immutable,
      promptHint: ref.promptHint,
      priority: ref.priority,
      matchReason: ref.matchReason,
      score: ref.score,
      panelInfo: ref.panelInfo,
    })),
    budget,
  };
}
