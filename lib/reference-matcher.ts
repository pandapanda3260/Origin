import { basename, relative } from 'node:path';
import { resolveLocalImagePath } from './image-gen';
import { isBlockingReferenceStatus, resolveAssetReferenceState } from './visual-reference-state';
import { selectCharacterReferencePanels, type CharacterReferencePanel } from './panel-selection';
import { pickSceneForShots } from './scene-selection';
import {
  pickSceneTopdownAnchor,
  pickSceneView,
  resolveSceneImageUrl,
  type SceneViewRole,
} from './scene-views';
import {
  pickPropView,
  type PropViewRole,
} from './prop-views';
import {
  materialRoleToVideoRole,
  type StoryboardMaterialRole,
} from './reference-roles';
import {
  normalizeReferenceName,
  buildReferenceBriefLine,
  VIDEO_REFERENCE_IMAGE_BUDGET,
  type DroppedReference,
  type ReferenceManifestItem,
  type VideoReferenceRole,
} from './video-reference-manifest';
import { dataPath } from './runtime-paths';

type Candidate = Omit<ReferenceManifestItem, 'imageNo'> & {
  type: VideoReferenceRole;
  viewRole?: SceneViewRole;
  propViewRole?: PropViewRole;
  name: string;
  score: number;
  _order: number;
  mentionCount?: number;
  firstMentionIndex?: number;
  relevanceScore?: number;
  firstShotOrder?: number;
  closeUpBoost?: number;
  focusPairKey?: string;
  focusPairOrder?: number;
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
  includeStoryboardFirstFrame?: boolean;
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

function assetMentionAliases(asset: any, fallback: string): string[] {
  const raw = [
    assetName(asset, fallback),
    asset?.title,
    ...(Array.isArray(asset?.aliases) ? asset.aliases : []),
  ]
    .map(compactText)
    .filter(Boolean);
  const aliases = new Set<string>(raw);
  for (const name of raw) {
    const short = name.replace(/^(?:移动|智能|电子|家用|现代|小型|桌面|立式|便携|可移动)/, '');
    if (short !== name && normalizeReferenceName(short).length >= 2) aliases.add(short);
  }
  return [...aliases];
}

function assetUrl(asset: any): string {
  const reference = resolveAssetReferenceState(asset);
  if (isBlockingReferenceStatus(reference.status)) return '';
  return compactText(reference.currentUrl || reference.lastKnownGoodUrl || asset?.imageUrl || asset?.rawUrl || asset?.realPhotoUrl || asset?.coverUrl);
}

function sceneAssetUrl(scene: any): string {
  return resolveSceneImageUrl(scene, { strategy: 'videoManifest', gate: true });
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
  const url = role === 'scene' ? sceneAssetUrl(source) : assetUrl(source);
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

function propMentionStats(normText: string, prop: any, fallback: string): { count: number; firstMentionIndex: number } {
  let count = 0;
  let firstMentionIndex = Number.MAX_SAFE_INTEGER;
  for (const alias of assetMentionAliases(prop, fallback)) {
    const norm = normalizeReferenceName(alias);
    if (norm.length < 2) continue;
    count += countOccurrences(normText, norm);
    firstMentionIndex = Math.min(firstMentionIndex, firstOccurrenceIndex(normText, norm));
  }
  return { count, firstMentionIndex };
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

function shotEntityText(shot: any): string {
  return [
    shot?.visual,
    shot?.description,
    shot?.desc,
    shot?.dialogue,
    shot?.scriptRef,
    shot?.keyInfo,
    shot?.focus,
    shot?.composition,
    Array.isArray(shot?.characters) ? shot.characters.join(' ') : '',
  ].filter(Boolean).join(' ');
}

function isCloseOrFeatureShot(shot: any): boolean {
  const text = String([
    shot?.shotType,
    shot?.cameraType,
    shot?.camera,
    shot?.composition,
    shot?.focus,
    shot?.visual,
    shot?.description,
  ].filter(Boolean).join(' ')).toLowerCase();
  return /大特写|特写|近景|中近景|半身|脸部|面部|头像|眼神|表情|道具特写|close-up|closeup|close shot|portrait|detail shot/.test(text);
}

function shotContainsEntity(shot: any, role: VideoReferenceRole, entityName: string): boolean {
  const norm = normalizeReferenceName(entityName);
  if (!norm) return false;
  if (role === 'character' && Array.isArray(shot?.characters)) {
    if (shot.characters.some((name: any) => normalizeReferenceName(name) === norm)) return true;
  }
  return normalizeReferenceName(shotEntityText(shot)).includes(norm);
}

function firstShotOrderForEntity(shots: any[], role: VideoReferenceRole, entityName: string): number {
  for (let i = 0; i < shots.length; i++) {
    if (shotContainsEntity(shots[i], role, entityName)) return i;
  }
  return Number.MAX_SAFE_INTEGER;
}

function closeUpBoostForEntity(shots: any[], role: VideoReferenceRole, entityName: string): number {
  if (role !== 'character' && role !== 'prop') return 1;
  return shots.some((shot) => isCloseOrFeatureShot(shot) && shotContainsEntity(shot, role, entityName)) ? 1.45 : 1;
}

function shotHitCountForEntity(shots: any[], role: VideoReferenceRole, entityName: string): number {
  return shots.reduce((sum, shot) => sum + (shotContainsEntity(shot, role, entityName) ? 1 : 0), 0);
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
  const duplicateIdx = list.findIndex((item) => {
    if (item.url === candidate.url) return true;
    if (item.role !== candidate.role) return false;
    if (item.role === 'scene') {
      return compactText(item.viewRole || 'establishing') === compactText(candidate.viewRole || 'establishing') &&
        normalizeReferenceName(item.assetName) === normalizeReferenceName(candidate.assetName);
    }
    if (normalizeReferenceName(item.assetName) !== normalizeReferenceName(candidate.assetName)) return false;
    if (item.role === 'character') {
      const itemPanel = compactText(item.panelInfo?.panel);
      const candidatePanel = compactText(candidate.panelInfo?.panel);
      if (itemPanel && candidatePanel) return itemPanel === candidatePanel;
    }
    return true;
  });
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
    useFor: ['锁定同一件道具外形', '材质', '颜色', '尺度', '识别特征'],
    immutable: ['核心形状', '主色', '材质', '用途', '支架/边框/结构'],
    promptHint: '同名道具全片只是一件规范实体；只允许视角、屏幕内容和光线变化，不得改成其他类型设备或复制多件。',
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

function candidateBaseScore(candidate: Candidate): number {
  if (candidate.role === 'prop') {
    return (candidate.relevanceScore ?? 0) + (candidate.mentionCount || 0) * 20 + candidate.score * 0.1;
  }
  if (candidate.role === 'scene') {
    return candidate.score + (candidate.mentionCount || 0) * 18;
  }
  if (candidate.role === 'character') {
    return candidate.score + (candidate.mentionCount || 0) * 8;
  }
  return candidate.score;
}

function sortWithinRole(role: VideoReferenceRole, items: Candidate[]): Candidate[] {
  return [...items].sort((a, b) => {
    if (role === 'prop') {
      return ((b.mentionCount || 0) - (a.mentionCount || 0)) ||
        ((a.firstMentionIndex ?? Number.MAX_SAFE_INTEGER) - (b.firstMentionIndex ?? Number.MAX_SAFE_INTEGER)) ||
        ((b.relevanceScore ?? b.score) - (a.relevanceScore ?? a.score)) ||
        (a._order - b._order);
    }
    return (b.score - a.score) ||
      ((a.firstShotOrder ?? Number.MAX_SAFE_INTEGER) - (b.firstShotOrder ?? Number.MAX_SAFE_INTEGER)) ||
      (a._order - b._order);
  });
}

function normalizedImportanceByRole(candidates: Candidate[]): Map<Candidate, number> {
  const out = new Map<Candidate, number>();
  const roles: VideoReferenceRole[] = ['scene', 'character', 'prop'];
  for (const role of roles) {
    const items = sortWithinRole(role, candidates.filter((c) => c.role === role));
    if (!items.length) continue;
    const scores = items.map(candidateBaseScore);
    const max = Math.max(...scores);
    items.forEach((candidate, idx) => {
      const rankScore = items.length <= 1 ? 1 : 1 - idx / items.length;
      const valueScore = max > 0 ? candidateBaseScore(candidate) / max : 1;
      out.set(candidate, Math.max(0, Math.min(1, valueScore * 0.75 + rankScore * 0.25)) * (candidate.closeUpBoost || 1));
    });
  }
  return out;
}

function slotSelect(candidates: Candidate[], budget: number): { selected: Candidate[]; dropped: DroppedReference[] } {
  const byRole = (role: VideoReferenceRole) => candidates
    .filter((c) => c.role === role);

  const selected: Candidate[] = [];
  const selectedKeys = new Set<string>();
  const take = (candidate?: Candidate, includeFocusPair = false) => {
    if (!candidate) return;
    const key = `${candidate.role}:${candidate.url}`;
    if (selectedKeys.has(key)) return;
    if (selected.length >= budget) return;
    selected.push(candidate);
    selectedKeys.add(key);
    if (includeFocusPair && candidate.focusPairKey) {
      const paired = candidates
        .filter((item) => item.focusPairKey === candidate.focusPairKey)
        .sort((a, b) => (a.focusPairOrder || 0) - (b.focusPairOrder || 0) || a._order - b._order);
      for (const item of paired) take(item, false);
    }
  };

  const firstFrames = sortWithinRole('first_frame', byRole('first_frame'));
  take(firstFrames[0]);

  const importance = normalizedImportanceByRole(candidates);
  const roleCounts = () => selected.reduce((acc, item) => {
    acc.set(item.role, (acc.get(item.role) || 0) + 1);
    return acc;
  }, new Map<VideoReferenceRole, number>());
  const sortByDynamicPriority = (items: Candidate[]) => {
    const counts = roleCounts();
    return [...items].sort((a, b) => {
      const aScore = (importance.get(a) || 0) * Math.pow(0.8, counts.get(a.role) || 0);
      const bScore = (importance.get(b) || 0) * Math.pow(0.8, counts.get(b.role) || 0);
      return (bScore - aScore) ||
        ((a.firstShotOrder ?? Number.MAX_SAFE_INTEGER) - (b.firstShotOrder ?? Number.MAX_SAFE_INTEGER)) ||
        (a._order - b._order);
    });
  };
  const remaining = () => candidates.filter((candidate) => {
    if (candidate.role === 'first_frame') return false;
    return !selectedKeys.has(`${candidate.role}:${candidate.url}`);
  });

  const primaryScene = sortByDynamicPriority(byRole('scene').filter((item) => item.viewRole !== 'topdown'))[0];
  take(primaryScene);
  take(sortByDynamicPriority(byRole('character'))[0], true);
  if (primaryScene) {
    const primarySceneName = normalizeReferenceName(primaryScene.assetName || primaryScene.label);
    const primarySceneId = compactText(primaryScene.assetId);
    const topdownForPrimary = sortByDynamicPriority(byRole('scene').filter((item) => (
      item.viewRole === 'topdown' &&
      ((primarySceneId && compactText(item.assetId) === primarySceneId) ||
        normalizeReferenceName(item.assetName || item.label) === primarySceneName)
    )))[0];
    take(topdownForPrimary);
  }

  while (selected.length < budget) {
    const next = sortByDynamicPriority(remaining())[0];
    if (!next) break;
    take(next, true);
  }

  const dropped: DroppedReference[] = [];
  for (const c of candidates) {
    if (selected.some((s) => s.url === c.url)) continue;
    if (c.role === 'first_frame') continue;
	    dropped.push({
	      role: c.role,
	      viewRole: c.viewRole,
	      propViewRole: c.propViewRole,
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
  const primaryShot = shots[0];
  const text = shotText(shots);
  const normText = normalizeReferenceName(text);
  const explicitCharNames = firstChars(shots);
  const explicitCharNorms = new Set(explicitCharNames.map(normalizeReferenceName).filter(Boolean));
  const requestedBudget = Number(input.budget || VIDEO_REFERENCE_IMAGE_BUDGET);
  const budget = Math.max(1, Math.floor(Number.isFinite(requestedBudget) ? requestedBudget : VIDEO_REFERENCE_IMAGE_BUDGET));

  const candidates: Candidate[] = [];
  const dropped: DroppedReference[] = [];

  if (input.includeStoryboardFirstFrame !== false) {
    addFirstFrameCandidate(candidates, input);
  }

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
    enableFocusCharacterPair: true,
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
    const panelMentions = countOccurrences(normText, normalizeReferenceName(panel.characterName));
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
      mentionCount: panelMentions,
      firstMentionIndex: firstOccurrenceIndex(normText, normalizeReferenceName(panel.characterName)),
      firstShotOrder: firstShotOrderForEntity(shots, 'character', panel.characterName),
      closeUpBoost: closeUpBoostForEntity(shots, 'character', panel.characterName),
      focusPairKey: panel.focusPair ? normalizeReferenceName(panel.characterName) : undefined,
      focusPairOrder: panel.focusPair && panel.panel === 'sheet' ? 1 : panel.focusPair && panel.panel === 'headshot' ? 2 : undefined,
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
      mentionCount: mentions,
      firstMentionIndex: firstOccurrenceIndex(normText, norm),
      firstShotOrder: firstShotOrderForEntity(shots, 'character', name),
      closeUpBoost: closeUpBoostForEntity(shots, 'character', name),
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
    const hitCount = shotHitCountForEntity(shots, 'scene', name);
    const isMain = !!scene?.isMain;
    const explicitMatch = !!explicitScene && (
      (!!explicitSceneId && assetId(scene) === explicitSceneId) ||
      (!!explicitSceneName && norm === explicitSceneName)
    );
    const manualMatch = isStoryboardMaterialForGroup(scene, input.groupIdx, 'scene');
    if (!manualMatch && !explicitMatch && !mentions && !isMain) return;
    const pickedView = pickSceneView(scene, shots[0]);
    const url = pickedView.url || sceneAssetUrl(scene);
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
    const baseScore = manualMatch
      ? 540 - idx
      : explicitMatch
        ? 260 - idx
        : (mentions ? 85 + mentions * 8 : 45) + (isMain ? 10 : 0) - idx;
    pushCandidate(candidates, {
      type: 'scene',
      role: 'scene',
      viewRole: pickedView.role,
      assetId: assetId(scene),
      assetName: name,
      name,
      label: `${name} ${pickedView.role} scene reference`,
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
      score: baseScore,
      mentionCount: hitCount || mentions,
      firstMentionIndex: firstOccurrenceIndex(normText, norm),
      relevanceScore: explicitMatch ? 100 : manualMatch ? 100 : isMain ? 45 : 30,
      firstShotOrder: firstShotOrderForEntity(shots, 'scene', name),
    });
    const topdown = pickSceneTopdownAnchor(scene);
    if (topdown?.url) {
      const topdownPath = resolveLocalImagePath(topdown.url, input.ownerId) || undefined;
      if (topdownPath) {
        pushCandidate(candidates, {
          type: 'scene',
          role: 'scene',
          viewRole: 'topdown',
          assetId: assetId(scene),
          assetName: name,
          name,
          label: `${name} topdown layout anchor`,
          url: topdown.url,
          localPath: topdownPath,
          useFor: ['锁定俯视空间布局', '入口/家具/大物件相对位置', '场景朝向'],
          immutable: ['主要空间关系', '入口/家具/大物件相对方位', '场景布局'],
          promptHint: '俯视空间锚只用于保持布局、方位和相对位置，不要求最终镜头变成俯视图。',
          matchReason: 'same scene topdown layout anchor',
          score: Math.max(1, baseScore - 1),
          mentionCount: hitCount || mentions,
          firstMentionIndex: firstOccurrenceIndex(normText, norm),
          relevanceScore: explicitMatch ? 98 : manualMatch ? 98 : isMain ? 44 : 29,
          firstShotOrder: firstShotOrderForEntity(shots, 'scene', name),
        });
      }
    }
  });
  if (!candidates.some((c) => c.role === 'scene')) {
    const fallback = scenes.find((s, idx) => sceneAssetUrl(s) && !isMaterialAssetExcluded(project, 'scene', s, input.groupIdx, idx));
    if (fallback) {
      const name = assetName(fallback, '主场景');
      const url = sceneAssetUrl(fallback);
      const localPath = resolveLocalImagePath(url, input.ownerId) || undefined;
      if (localPath) {
        const defaults = roleDefaults('scene');
        pushCandidate(candidates, {
          type: 'scene',
          role: 'scene',
          viewRole: 'establishing',
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
          mentionCount: shotHitCountForEntity(shots, 'scene', name),
          firstMentionIndex: firstOccurrenceIndex(normText, normalizeReferenceName(name)),
          relevanceScore: 25,
          firstShotOrder: firstShotOrderForEntity(shots, 'scene', name),
        });
      }
    }
  }

  const props: any[] = Array.isArray(assets?.props) ? assets.props : [];
  props.forEach((prop, idx) => {
    if (isMaterialAssetExcluded(project, 'prop', prop, input.groupIdx, idx)) return;
    const name = assetName(prop, `道具${idx + 1}`);
    const mentionStats = propMentionStats(normText, prop, name);
    const mentions = mentionStats.count;
    const manualMatch = isStoryboardMaterialForGroup(prop, input.groupIdx, 'prop');
    if (!manualMatch && !mentions) return;
    const firstMention = mentionStats.firstMentionIndex;
    const pickedView = pickPropView(prop, primaryShot);
    const url = pickedView.url || assetUrl(prop);
    if (!url) {
      dropped.push({ role: 'prop', propViewRole: pickedView.role, assetName: name, reason: 'asset_missing' });
      return;
    }
    const localPath = resolveLocalImagePath(url, input.ownerId) || undefined;
    if (!localPath) {
      dropped.push({ role: 'prop', propViewRole: pickedView.role, assetName: name, reason: 'asset_missing' });
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
      propViewRole: pickedView.role,
      assetId: assetId(prop),
      assetName: name,
      name,
      label: `${name} prop reference`,
      url,
      localPath,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: hint || defaults.promptHint,
      panelInfo: {
        panel: pickedView.role,
        intent: 'prop-view',
      },
      matchReason: manualMatch
        ? 'storyboard material group match'
        : 'group visual/dialogue/keyInfo text match',
      score: (manualMatch ? 500 : 80) + mentions * 8 - idx,
      mentionCount: mentions,
      firstMentionIndex: firstMention,
      relevanceScore: 80,
      firstShotOrder: firstShotOrderForEntity(shots, 'prop', name),
      closeUpBoost: closeUpBoostForEntity(shots, 'prop', name),
    });
  });

  const slotResult = slotSelect(candidates, budget);
  const manifestBase = slotResult.selected.map((ref, idx) => ({
    imageNo: idx + 1,
	    role: ref.role,
	    viewRole: ref.viewRole,
	    propViewRole: ref.propViewRole,
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
  const manifest = manifestBase.map((ref) => ({
    ...ref,
    referenceBrief: buildReferenceBriefLine(ref, manifestBase),
  }));

  return {
    manifest,
    droppedReferences: [...dropped, ...slotResult.dropped],
    candidates: candidates.map((ref, idx) => ({
      imageNo: idx + 1,
	      role: ref.role,
	      viewRole: ref.viewRole,
	      propViewRole: ref.propViewRole,
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
