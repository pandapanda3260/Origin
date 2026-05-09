import { basename } from 'node:path';
import { hasFillLightPositiveMention } from './content-sanitize';
import { resolveLocalImagePath } from './image-gen';
import { resolveAssetReferenceState } from './visual-reference-state';
import { selectCharacterReferencePanels, type CharacterReferencePanel } from './panel-selection';
import { pickSceneForShots } from './scene-selection';
import {
  normalizeReferenceName,
  VIDEO_REFERENCE_IMAGE_BUDGET,
  type DroppedReference,
  type ReferenceManifestItem,
  type VideoReferenceRole,
} from './video-reference-manifest';

type Candidate = Omit<ReferenceManifestItem, 'imageNo'> & {
  type: VideoReferenceRole;
  name: string;
  score: number;
  _order: number;
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
  return compactText(reference.currentUrl || reference.lastKnownGoodUrl || asset?.imageUrl || asset?.rawUrl || asset?.realPhotoUrl || asset?.coverUrl);
}

function assetId(asset: any): string | undefined {
  const id = compactText(asset?.id || asset?.assetId || asset?.uuid);
  return id || undefined;
}

function collectCharacters(project: any, assets: any): any[] {
  return [
    ...(Array.isArray(assets?.characters) ? assets.characters : []),
    ...(Array.isArray(project?.characters) ? project.characters : []),
  ];
}

function findCharacterByName(characters: any[], name: string): any | null {
  const key = normalizeReferenceName(name);
  return characters.find((ch) => normalizeReferenceName(ch?.name || ch?.role || ch?.id || ch?.label) === key) || null;
}

function publicImageUrlFromLocalPath(path: string, ownerId: number): string {
  const normalized = String(path || '');
  if (!normalized.includes(`/data/images/${ownerId}/`)) return '';
  const m = /^([0-9a-fA-F-]{36})\.png$/.exec(basename(normalized));
  return m ? `/api/images/file/${m[1]}` : '';
}

function panelUrlForCharacter(character: any, panel: CharacterReferencePanel, ownerId: number): string {
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

function shotsFromInput(input: BuildVideoReferenceManifestInput): any[] {
  if (Array.isArray(input.shots) && input.shots.length) return input.shots;
  const allShots = Array.isArray(input.project?.shots) ? input.project.shots : [];
  if (Array.isArray(input.groupShotIndices) && input.groupShotIndices.length) {
    return input.groupShotIndices.map((idx) => allShots[idx]).filter(Boolean);
  }
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
  if (list.some((item) => item.url === candidate.url || (
    item.role === candidate.role &&
    normalizeReferenceName(item.assetName) === normalizeReferenceName(candidate.assetName)
  ))) return;
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
  const defaults = roleDefaults('first_frame');
  pushCandidate(candidates, {
    type: 'first_frame',
    role: 'first_frame',
    name: 'first_frame',
    label: `segment ${(input.groupIdx ?? 0) + 1} first frame`,
    url,
    localPath: resolveLocalImagePath(url, input.ownerId) || undefined,
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
    .sort((a, b) => (b.score - a.score) || (a._order - b._order));

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

  take(firstFrames[0]);
  take(scenes[0]);
  take(chars[0]);
  take(props[0] || chars[1]);
  take(chars[1] || props[1] || chars[2]);

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
    maxSlots: budget,
  });
  selectedPanels.forEach((panel, idx) => {
    const ch = findCharacterByName(chars, panel.characterName);
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
    const name = assetName(ch, `角色${idx + 1}`);
    const norm = normalizeReferenceName(name);
    if (!norm) return;
    const explicit = explicitCharNorms.has(norm);
    const mentions = countOccurrences(normText, norm);
    if (!explicit && mentions <= 0) return;
    const url = assetUrl(ch);
    if (!url) {
      if (panelCoveredCharacterNames.has(norm)) return;
      dropped.push({ role: 'character', assetName: name, reason: 'missing_file' });
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
      localPath: resolveLocalImagePath(url, input.ownerId) || undefined,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: hint || defaults.promptHint,
      matchReason: explicit ? 'shot.characters exact match' : 'group text name match',
      score: (explicit ? 100 : 70) + mentions * 5 - idx,
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
    const name = assetName(scene, `场景${idx + 1}`);
    const norm = normalizeReferenceName(name);
    const mentions = norm ? countOccurrences(normText, norm) : 0;
    const isMain = !!scene?.isMain;
    const explicitMatch = !!explicitScene && (
      (!!explicitSceneId && assetId(scene) === explicitSceneId) ||
      (!!explicitSceneName && norm === explicitSceneName)
    );
    if (!explicitMatch && !mentions && !isMain) return;
    const url = assetUrl(scene);
    if (!url) {
      dropped.push({ role: 'scene', assetName: name, reason: 'missing_file' });
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
      localPath: resolveLocalImagePath(url, input.ownerId) || undefined,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: hint || defaults.promptHint,
      matchReason: explicitMatch
        ? `shot ${explicitSceneSelection.matchReason} match`
        : mentions
          ? 'group visual/location text match'
          : 'fallback main scene',
      score: explicitMatch
        ? 260 - idx
        : (mentions ? 85 + mentions * 8 : 45) + (isMain ? 10 : 0) - idx,
    });
  });
  if (!candidates.some((c) => c.role === 'scene')) {
    const fallback = scenes.find((s) => assetUrl(s));
    if (fallback) {
      const name = assetName(fallback, '主场景');
      const url = assetUrl(fallback);
      const defaults = roleDefaults('scene');
      pushCandidate(candidates, {
        type: 'scene',
        role: 'scene',
        assetId: assetId(fallback),
        assetName: name,
        name,
        label: `${name} scene reference`,
        url,
        localPath: resolveLocalImagePath(url, input.ownerId) || undefined,
        useFor: defaults.useFor,
        immutable: defaults.immutable,
        promptHint: defaults.promptHint,
        matchReason: 'fallback first scene with image',
        score: 35,
      });
    }
  }

  const props: any[] = Array.isArray(assets?.props) ? assets.props : [];
  props.forEach((prop, idx) => {
    const name = assetName(prop, `道具${idx + 1}`);
    if (hasFillLightPositiveMention(name)) {
      dropped.push({ role: 'prop', assetName: name, reason: 'filtered_constraint' });
      return;
    }
    const norm = normalizeReferenceName(name);
    const mentions = norm ? countOccurrences(normText, norm) : 0;
    if (!mentions) return;
    const url = assetUrl(prop);
    if (!url) {
      dropped.push({ role: 'prop', assetName: name, reason: 'missing_file' });
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
      localPath: resolveLocalImagePath(url, input.ownerId) || undefined,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: hint || defaults.promptHint,
      matchReason: 'group visual/dialogue/keyInfo text match',
      score: 80 + mentions * 8 - idx,
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
