/**
 * FrameImageGenerationPlan —— 首/尾帧生成的结构化计划。
 *
 * 设计目标:
 *   在调用图像模型之前, 先产出一份可审计的结构化 plan, 明确本组使用的
 *   shot / 角色 / 场景 / 道具 / 提示词 / 参考图编号 / 模型能力快照等信息。
 *   executor 拿到 plan 后, 用 finalPrompt + referenceManifest 提交图像模型。
 *
 * 阶段性范围:
 *   - first_frame: primaryShot = 组内第一个 shot, 作为开场 beat。
 *   - tail_frame:  primaryShot = 组内最末 shot, 作为收尾 beat;
 *                  selfFirstFrame (本片段已生成的首帧图) 作为 slot 1 的连续性锚点。
 *   - referenceManifest 的编号语义 (重要):
 *       · slot     —— 候选序号 (1-based 连续, 含所有候选, 不论 delivery)。
 *       · imageNo  —— 仅 delivery='image' 的 ref 才有, 1-based 连续, 严格对齐
 *                     提交给模型的 image[] 数组下标 +1。
 *     renderer 的 "Image N = ..." 标签用的是 imageNo, 不是 slot, 避免 scene
 *     走 text_only 时出现 "Image 2 = character" 但 image[0] 其实就是它的错位。
 *   - provider capability 和业务预算分开: modelSnapshot.multiRefImageCap 表示模型能力,
 *     FRAME_IMAGE_REFERENCE_IMAGE_BUDGET=4 表示首/尾帧业务固定最多提交 4 张参考图。
 */

import { createHash } from 'node:crypto';
import {
  enforceHardVisualConstraints,
  enforceNoFillLightConstraint,
  hasFillLightPositiveMention,
  hasNoFillLightConstraint,
  sanitizeFillLightPositiveMentions,
} from './content-sanitize';
import {
  buildCharacterLockRoster,
  buildObservedDriftGuardrails,
  clean,
  dedupeAssetsByIdentity,
  joinPromptValues,
  truncate,
} from './frame-prompt-helpers';
import { resolveLocalImagePath as defaultResolveLocalImagePath } from './image-gen';
import { pickSceneForShots } from './scene-selection';
import { isBlockingReferenceStatus, resolveAssetReferenceState } from './visual-reference-state';
import {
  normalizeStoryboardMaterialRole,
  storyboardMaterialRoleToUiType,
  type StoryboardMaterialRole,
} from './reference-roles';

export type FrameType = 'first_frame' | 'tail_frame';

export type FrameRefRole = 'scene' | 'character' | 'prop' | 'prev_tail' | 'self_first_frame';

export type FrameReferenceDelivery = 'image' | 'text_only' | 'dropped';

export type FrameReferenceDroppedReason =
  | 'over_capacity'
  | 'unresolvable'
  | 'no_image_available';

export type FrameReference = {
  /** 候选序号 (manifest 输入顺序), 1-based 连续; 含所有候选 (不论 delivery)。
   *  注意: 这不是传给图像模型的 "Image N" 编号。 */
  slot: number;
  /** 传给图像模型的 "Image N" 编号, 1-based 连续; 仅 delivery='image' 的才有。
   *  与实际提交给模型的 image[] 数组下标 +1 严格一致, 保证 prompt 里的 "Image 1 = ..."
   *  指向 image[0] 而不是某个被跳过的 slot。 */
  imageNo?: number;
  role: FrameRefRole;
  assetId?: string;
  assetName?: string;
  /** 解析后的本地绝对路径, 仅在 delivery='image' 时保证存在。 */
  localPath?: string;
  remoteUrl?: string;
  /** 不作为 image 提交时的文字兜底描述。 */
  textFallback: string;
  delivery: FrameReferenceDelivery;
  /** 仅在 text_only / dropped 时可能出现。 */
  droppedReason?: FrameReferenceDroppedReason;
};

export type FrameImageModelSnapshot = {
  provider: string;
  model: string;
  baseUrl?: string;
  quality?: string;
  /** 当前 provider 能接受的参考图数量上限; 首/尾帧业务预算另由 FRAME_IMAGE_REFERENCE_IMAGE_BUDGET 限制。 */
  multiRefImageCap: number;
};

export type FrameImageGenerationPlan = {
  frameType: FrameType;
  groupIdx: number;
  shotIndices: number[];
  primaryShotIdx: number;
  primaryShot: any;
  contextShots: any[];
  aspectRatio: string;
  compositionGuidance: string;
  /** 与 contextShots 对齐的绝对 shot index (来自 shotIndices, 排除 primary 的位置)。 */
  contextShotIndices: number[];
  characters: Array<{
    name: string;
    description: string;
    imageUrl?: string;
    entityType?: string;
  }>;
  scene: { name?: string; description: string; imageUrl?: string } | null;
  props: Array<{ name: string; description: string; imageUrl?: string }>;
  styleLock: string;
  driftGuardrails: string;
  characterLockText: string;
  sceneLockText: string;
  propLockText: string;
  /** 本组所有 shot 的原始文本拼接 (visual/description/dialogue 等, 已 sanitize)。
   *  用作 renderer 硬约束扫描源, 确保 shot.visual 里的 "不要补光灯" 等用户约束能被命中。 */
  shotConstraintText: string;
  referenceManifest: FrameReference[];
  /** renderer 产出的最终 prompt, 提交前仍可能被 safe-image-gen 的审核恢复二次改写。 */
  finalPrompt: string;
  modelSnapshot: FrameImageModelSnapshot;
};

export type FrameImagePlanSummary = {
  frameType: FrameType;
  groupIdx: number;
  shotIndices: number[];
  primaryShotIdx: number;
  aspectRatio: string;
  compositionGuidance?: string;
  characterNames: string[];
  sceneName?: string;
  propNames: string[];
  sentReferences: Array<{
    slot: number;
    imageNo: number;
    role: FrameRefRole;
    assetName?: string;
  }>;
  textOnlyReferences: Array<{
    slot: number;
    role: FrameRefRole;
    assetName?: string;
    reason?: FrameReferenceDroppedReason;
  }>;
  droppedReferences: Array<{
    slot: number;
    role: FrameRefRole;
    assetName?: string;
    reason?: FrameReferenceDroppedReason;
  }>;
  finalPromptHash: string;
  finalPromptLength: number;
  modelSnapshot: FrameImageModelSnapshot;
};

export type BuildFramePlanInput = {
  project: any;
  groupIdx: number;
  shotIndices: number[];
  ownerId: number;
  frameType: FrameType;
  modelSnapshot: FrameImageModelSnapshot;
  /** 依赖注入, 便于测试。默认走 image-gen 的 resolveLocalImagePath。 */
  resolveLocalPath?: (url: string, ownerId: number) => string | null | undefined;
  /** tail_frame 专用: 本片段已生成首帧的远程 URL 和 (可选) 已解析的本地路径。
   *  若 localPath 可用且 cap>=1, 作为 slot 1 的 image delivery 最高优先级锚; 否则走 text_only。 */
  selfFirstFrame?: {
    remoteUrl: string;
    localPath?: string;
  };
};

const MAX_FINAL_PROMPT_CHARS = 2200;
export const FRAME_IMAGE_REFERENCE_IMAGE_BUDGET = 4;
const DEFAULT_FRAME_ASPECT_RATIO = '9:16';
const FRAME_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);

function hashText(text: string): string {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function normalizeFrameAspectRatio(value: any): string {
  const next = String(value || '').trim();
  return FRAME_ASPECT_RATIOS.has(next) ? next : '';
}

function resolveFrameAspectRatio(project: any): string {
  return (
    normalizeFrameAspectRatio(project?.styleOptions?.aspectRatio) ||
    normalizeFrameAspectRatio(project?.styleBible?.aspectRatio) ||
    normalizeFrameAspectRatio(project?.videoAspectRatio) ||
    DEFAULT_FRAME_ASPECT_RATIO
  );
}

function compositionGuidanceForAspectRatio(aspectRatio: string): string {
  if (aspectRatio === '9:16') return 'Compose for a vertical portrait frame, prioritizing subject focus, close/mid framing, and clear vertical staging over wide horizontal space.';
  if (aspectRatio === '1:1') return 'Compose around a stable square frame with centered visual weight, clear foreground/background depth, and no ultra-wide staging.';
  return 'Compose for a landscape frame with clear spatial relationships, environmental context, and horizontal movement when the shot calls for it.';
}

function importanceKey(value: unknown): string {
  return clean(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '');
}

function characterName(ch: any): string {
  return clean(ch?.name || ch?.role);
}

function propName(prop: any): string {
  return clean(prop?.name || prop?.propName);
}

function assetImageUrl(asset: any): string {
  const reference = resolveAssetReferenceState(asset);
  if (isBlockingReferenceStatus(reference.status)) return '';
  return clean(
    reference.currentUrl ||
    reference.lastKnownGoodUrl ||
    asset?.pencilUrl ||
    asset?.realPhotoUrl,
  );
}

function assetIdentityKeys(role: StoryboardMaterialRole, asset: any, idx?: number): string[] {
  const source = asset || {};
  const fields = role === 'character'
    ? [source.characterId, source.materialId, source.id, source.assetId, source.name, source.role, source.identity]
    : role === 'scene'
      ? [source.sceneId, source.materialId, source.id, source.assetId, source.name, source.sceneName, source.location, source.title]
      : [source.propId, source.materialId, source.id, source.assetId, source.name, source.propName, source.title, source.propType];
  const keys: string[] = [];
  const prefixes = role === 'character' ? ['character', 'char'] : [role];
  for (const field of fields) {
    const value = clean(field);
    if (value) {
      for (const prefix of prefixes) keys.push(`${prefix}:${value}`);
    }
  }
  const url = assetImageUrl(source);
  if (url) {
    for (const prefix of prefixes) keys.push(`${prefix}:url:${url}`);
  }
  return [...new Set(keys)];
}

function isMaterialAssetExcluded(project: any, role: StoryboardMaterialRole, asset: any, groupIdx: number, idx?: number): boolean {
  if (!asset) return false;
  const buckets = [
    project?.storyboardMaterialExclusions?.[String(groupIdx)]?.[role],
    project?.storyboardMaterialExclusions?.[String(groupIdx)]?.[storyboardMaterialRoleToUiType(role) || role],
  ].filter(Boolean);
  if (!buckets.length) return false;
  const keys = assetIdentityKeys(role, asset, idx);
  return buckets.some((bucket: any) => keys.some((key) => !!bucket[key]));
}

function isStoryboardMaterialForGroup(asset: any, groupIdx: number, role: StoryboardMaterialRole): boolean {
  if (asset?.reference?.status === 'missing') return false;
  const materialGroupIdx = Number(asset?.storyboardMaterialGroupIdx);
  if (!Number.isFinite(materialGroupIdx) || materialGroupIdx !== groupIdx) return false;
  if (!asset?.storyboardMaterialRole) return true;
  return normalizeStoryboardMaterialRole(asset.storyboardMaterialRole) === role;
}

function shotCharacterKeys(shot: any): string[] {
  if (!Array.isArray(shot?.characters)) return [];
  return shot.characters
    .map((name: any) => importanceKey(name))
    .filter(Boolean);
}

export function orderCharactersByImportance(
  primaryShot: any,
  groupShots: any[],
  allChars: any[],
  groupText: string,
): any[] {
  const primaryKey = shotCharacterKeys(primaryShot)[0] || '';
  const groupTextKey = importanceKey(groupText);
  const occurrenceCounts = new Map<string, number>();
  for (const shot of groupShots) {
    for (const key of shotCharacterKeys(shot)) {
      occurrenceCounts.set(key, (occurrenceCounts.get(key) || 0) + 1);
    }
  }

  return allChars
    .map((ch, index) => {
      const name = characterName(ch);
      const key = importanceKey(name);
      return {
        ch,
        index,
        key,
        primaryRank: key && primaryKey && key === primaryKey ? 0 : 1,
        occurrenceCount: key ? occurrenceCounts.get(key) || 0 : 0,
        firstMentionIndex: key && groupTextKey.includes(key) ? groupTextKey.indexOf(key) : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((a, b) =>
      (a.primaryRank - b.primaryRank) ||
      (b.occurrenceCount - a.occurrenceCount) ||
      (a.firstMentionIndex - b.firstMentionIndex) ||
      (a.index - b.index),
    )
    .map((item) => item.ch);
}

export function orderPropsByFirstOccurrence(usedProps: any[], groupText: string): any[] {
  const groupTextKey = importanceKey(groupText);
  return usedProps
    .map((prop, index) => {
      const key = importanceKey(propName(prop));
      return {
        prop,
        index,
        firstMentionIndex: key && groupTextKey.includes(key) ? groupTextKey.indexOf(key) : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((a, b) => (a.firstMentionIndex - b.firstMentionIndex) || (a.index - b.index))
    .map((item) => item.prop);
}

// ---------- public API ----------

export function buildFrameImageGenerationPlan(input: BuildFramePlanInput): FrameImageGenerationPlan {
  if (input.frameType !== 'first_frame' && input.frameType !== 'tail_frame') {
    throw new Error(`[frame-image-plan] unknown frameType='${(input as any).frameType}'`);
  }
  const { project, groupIdx, shotIndices, ownerId, frameType } = input;
  const resolveLocalPath = input.resolveLocalPath || defaultResolveLocalImagePath;
  const shots: any[] = Array.isArray(project?.shots) ? project.shots : [];

  const validShotIndices = shotIndices.filter(
    (i) => Number.isInteger(i) && i >= 0 && i < shots.length,
  );
  if (!validShotIndices.length) {
    throw new Error(`[frame-image-plan] group ${groupIdx}: no valid shot indices`);
  }
  const groupShots = validShotIndices.map((i) => shots[i]);
  // first_frame 用第一个 shot 作开场 beat; tail_frame 用最末 shot 作收尾 beat。
  const primaryPos = frameType === 'first_frame' ? 0 : groupShots.length - 1;
  const primaryShot = groupShots[primaryPos];
  const primaryShotIdx = validShotIndices[primaryPos];
  const contextShots = groupShots.filter((_, i) => i !== primaryPos);
  const contextShotIndices = validShotIndices.filter((_, i) => i !== primaryPos);

  // 本组所有 shot 的联合文本, 用于 asset 匹配。
  const rawGroupText = groupShots
    .map((sh: any) =>
      [
        sh?.visual,
        sh?.description,
        sh?.desc,
        sh?.dialogue,
        sh?.scriptRef,
        Array.isArray(sh?.characters) ? sh.characters.join(' ') : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join(' ');
  const groupText = sanitizeFillLightPositiveMentions(rawGroupText);

  // shot 文本单独拼一遍, 作为硬约束扫描源。和 groupText 的区别: 这里只含用户真正
  // 写进剧本/镜头表的字段 (visual/description/dialogue/keyInfo/imagePrompt 等),
  // 不含 characters 数组这类元数据。覆盖面要尽量大, 避免用户把 "不要补光灯" 之类
  // 硬约束写到某个字段却没被 enforceHardVisualConstraints 命中。
  const shotConstraintText = sanitizeFillLightPositiveMentions(
    groupShots
      .map((sh: any) =>
        [
          sh?.visual,
          sh?.description,
          sh?.desc,
          sh?.dialogue,
          sh?.scriptRef,
          sh?.keyInfo,
          sh?.imagePrompt,
        ]
          .filter(Boolean)
          .join(' '),
      )
      .filter(Boolean)
      .join('\n'),
  );

  // ---- characters ----
  const charNames = new Set<string>();
  for (const sh of groupShots) {
    if (Array.isArray(sh?.characters)) {
      for (const cn of sh.characters) {
        if (typeof cn === 'string' && cn.trim()) charNames.add(cn.trim());
      }
    }
  }
  const allChars: any[] = dedupeAssetsByIdentity([
    ...((project?.assets?.characters || []) as any[]),
    ...((project?.characters || []) as any[]),
  ]);
  const availableChars = allChars.filter((c: any, idx: number) =>
    !isMaterialAssetExcluded(project, 'character', c, groupIdx, idx),
  );
  const manualChars = availableChars.filter((c: any) => isStoryboardMaterialForGroup(c, groupIdx, 'character'));
  const matchedChars = orderCharactersByImportance(primaryShot, groupShots, availableChars
    .filter((c: any) => {
      if (isStoryboardMaterialForGroup(c, groupIdx, 'character')) return false;
      const nm = c?.name || c?.role;
      return nm && (charNames.has(nm) || groupText.includes(nm));
    }), groupText);
  const usedChars = [...manualChars, ...matchedChars].slice(0, 6);

  const characterLockRoster = buildCharacterLockRoster(project, charNames, 'en', groupText);
  const characterLockText = sanitizeFillLightPositiveMentions(
    characterLockRoster ||
      usedChars
        .map((c: any) => {
          const nm = c.name || c.role;
          const desc = [c.identity, c.appearance || c.description || c.detail, c.clothing, c.equipment]
            .filter(Boolean)
            .join(', ');
          const ent =
            c.entityType === 'non-human'
              ? ' NON-HUMAN anthropomorphic character, preserve species body'
              : '';
          return `${nm}${ent}: ${truncate(desc, 180)}`;
        })
        .join('\n'),
  );

  // ---- scene ----
  const sceneSelection = pickSceneForShots(
    {
      project,
      assets: project?.assets || {},
      shots: groupShots,
      text: groupText,
    },
    { requireImage: true, preferFirstShot: true },
  );
  const manualScenes = ((project?.assets?.scenes || []) as any[])
    .filter((scene: any, idx: number) =>
      isStoryboardMaterialForGroup(scene, groupIdx, 'scene') &&
      !isMaterialAssetExcluded(project, 'scene', scene, groupIdx, idx) &&
      !!assetImageUrl(scene),
    );
  const chosenScene = (manualScenes[0] || sceneSelection.scene) as any;
  const chosenSceneExcluded = isMaterialAssetExcluded(project, 'scene', chosenScene, groupIdx);
  const sceneLockTextRaw = chosenScene
    ? `${chosenScene.name || chosenScene.location || 'Scene'}: ${truncate(
        [
          chosenScene.description,
          chosenScene.location,
          chosenScene.lighting,
          chosenScene.atmosphere,
          chosenScene.elements,
          chosenScene.features,
        ]
          .filter(Boolean)
          .join(', '),
        220,
      )}`
    : '';
  const sceneLockText = sanitizeFillLightPositiveMentions(sceneLockTextRaw);

  // ---- props ----
  const allProps: any[] = (project?.assets?.props || []) as any[];
  const availableProps = allProps.filter((p: any, idx: number) => {
    if (isMaterialAssetExcluded(project, 'prop', p, groupIdx, idx)) return false;
    const nm = p?.name || p?.propName;
    return !!nm && !hasFillLightPositiveMention(nm);
  });
  const manualProps = availableProps.filter((p: any) => isStoryboardMaterialForGroup(p, groupIdx, 'prop'));
  const matchedProps = orderPropsByFirstOccurrence(availableProps
    .filter((p: any) => {
      if (isStoryboardMaterialForGroup(p, groupIdx, 'prop')) return false;
      const nm = p?.name || p?.propName;
      return groupText.includes(sanitizeFillLightPositiveMentions(nm));
    }), groupText);
  const usedProps = [...manualProps, ...matchedProps].slice(0, 6);
  const propLockText = sanitizeFillLightPositiveMentions(
    usedProps
      .map(
        (p: any) =>
          `${sanitizeFillLightPositiveMentions(p.name || p.propName)}: ${truncate(
            sanitizeFillLightPositiveMentions(
              [p.description, p.features, p.propType].filter(Boolean).join(', '),
            ),
            140,
          )}`,
      )
      .join('\n'),
  );

  // ---- style bible ----
  const styleBible = project?.styleBible || {};
  const aspectRatio = resolveFrameAspectRatio(project);
  const compositionGuidance = clean(styleBible.compositionGuidance) || compositionGuidanceForAspectRatio(aspectRatio);
  const styleLock = joinPromptValues([
    styleBible.vision || styleBible.visualStyle,
    styleBible.colorPalette,
    styleBible.cameraStyle,
    styleBible.mood || styleBible.tone,
    styleBible.lighting,
    styleBible.texture,
    styleBible.editingRhythm,
    styleBible.additionalPrompt && `Additional style prompt: ${styleBible.additionalPrompt}`,
    (styleBible.negativePrompt || styleBible.videoNegativePrompt) && `Negative style constraints: ${styleBible.negativePrompt || styleBible.videoNegativePrompt}`,
    styleBible.era,
  ]);

  // ---- drift guardrails ----
  const driftGuardrails = buildObservedDriftGuardrails(
    [groupText, characterLockText, sceneLockText, propLockText].join('\n'),
  );

  // ---- reference manifest ----
  type Candidate = Omit<FrameReference, 'slot' | 'delivery'>;
  const candidates: Candidate[] = [];

  const selfFirstFrameCandidate: Candidate | null =
    frameType === 'tail_frame' && input.selfFirstFrame?.remoteUrl
      ? {
      role: 'self_first_frame',
      assetName: 'this segment first frame',
      remoteUrl: input.selfFirstFrame.remoteUrl,
      localPath: input.selfFirstFrame.localPath,
      textFallback:
        'Self first frame: composition/identity anchor for this segment — match camera angle, wardrobe, props, and lighting of the opening frame.',
      }
      : null;

  const sceneCandidate: Candidate | null = chosenScene && !chosenSceneExcluded
    ? {
        role: 'scene',
        assetId: chosenScene.sceneId || chosenScene.id || undefined,
        assetName: chosenScene.name || chosenScene.location || 'scene',
        remoteUrl: assetImageUrl(chosenScene) || undefined,
        textFallback: sceneLockText,
      }
    : null;
  const chosenSceneUrl = assetImageUrl(chosenScene);
  const supplementalSceneCandidates = manualScenes
    .filter((scene: any) => {
      const url = assetImageUrl(scene);
      return scene !== chosenScene && url !== chosenSceneUrl;
    })
    .map((scene: any): Candidate => {
      const nm = scene.name || scene.sceneName || scene.location || 'supplemental scene';
      return {
        role: 'scene',
        assetId: scene.sceneId || scene.id || nm,
        assetName: nm,
        remoteUrl: assetImageUrl(scene),
        textFallback: `${nm}: ${truncate([scene.description, scene.location, scene.lighting, scene.atmosphere, scene.elements, scene.features].filter(Boolean).join(', '), 180)}`,
      };
    });

  const characterCandidates = usedChars.map((c: any): Candidate => {
    const nm = c.name || c.role;
    const baseDesc = [c.identity, c.appearance || c.description, c.clothing, c.equipment]
      .filter(Boolean)
      .join(', ');
    const ent =
      c.entityType === 'non-human'
        ? ' (NON-HUMAN anthropomorphic character, preserve species body)'
        : '';
    return {
      role: 'character',
      assetId: c.characterId || c.id || nm,
      assetName: nm,
      remoteUrl: assetImageUrl(c) || undefined,
      textFallback: `${nm}${ent}: ${truncate(baseDesc, 180)}`,
    };
  });

  const propCandidates = usedProps.map((p: any): Candidate => {
    const nm = p.name || p.propName;
    return {
      role: 'prop',
      assetId: p.propId || p.id || nm,
      assetName: nm,
      remoteUrl: assetImageUrl(p) || undefined,
      textFallback: `${sanitizeFillLightPositiveMentions(nm)}: ${truncate(
        sanitizeFillLightPositiveMentions(
          [p.description, p.features, p.propType].filter(Boolean).join(', '),
        ),
        140,
      )}`,
    };
  });

  const takeCandidate = (candidate: Candidate | null | undefined) => {
    if (candidate) candidates.push(candidate);
  };

  if (frameType === 'first_frame') {
    takeCandidate(characterCandidates[0]);
    takeCandidate(sceneCandidate);
    supplementalSceneCandidates.forEach(takeCandidate);
    takeCandidate(characterCandidates[1]);
    takeCandidate(propCandidates[0]);
    takeCandidate(characterCandidates[2]);
    propCandidates.slice(1).forEach(takeCandidate);
    characterCandidates.slice(3).forEach(takeCandidate);
  } else {
    takeCandidate(selfFirstFrameCandidate);
    takeCandidate(characterCandidates[0]);
    takeCandidate(sceneCandidate);
    supplementalSceneCandidates.forEach(takeCandidate);
    takeCandidate(propCandidates[0]);
    takeCandidate(characterCandidates[1]);
    characterCandidates.slice(2).forEach(takeCandidate);
    propCandidates.slice(1).forEach(takeCandidate);
  }

  const providerCap = Math.max(0, Math.floor(input.modelSnapshot.multiRefImageCap || 0));
  const cap = Math.min(FRAME_IMAGE_REFERENCE_IMAGE_BUDGET, providerCap);
  const manifest: FrameReference[] = [];
  let imageBudget = cap;
  let slot = 1;
  // imageNo 只在 delivery='image' 的 ref 上递增, 保证 "Image 1, 2, 3..." 连续,
  // 和提交给模型的 image[] 数组下标严格对齐 (避免 prompt 出现 "Image 2" 但 image[0]
  // 其实就是它的错位)。
  let nextImageNo = 1;
  for (const cand of candidates) {
    // 若 candidate 自带已解析的 localPath (比如 self_first_frame), 优先使用; 否则走 resolver。
    const preResolved = cand.localPath;
    const resolved = preResolved
      ? preResolved
      : cand.remoteUrl
        ? resolveLocalPath(cand.remoteUrl, ownerId) || undefined
        : undefined;
    let delivery: FrameReferenceDelivery;
    let droppedReason: FrameReferenceDroppedReason | undefined;
    if (imageBudget > 0 && resolved) {
      delivery = 'image';
      imageBudget -= 1;
    } else if (!cand.remoteUrl) {
      delivery = 'text_only';
      droppedReason = 'no_image_available';
    } else if (!resolved) {
      delivery = 'text_only';
      droppedReason = 'unresolvable';
    } else {
      delivery = 'text_only';
      droppedReason = 'over_capacity';
    }
    manifest.push({
      slot: slot++,
      imageNo: delivery === 'image' ? nextImageNo++ : undefined,
      role: cand.role,
      assetId: cand.assetId,
      assetName: cand.assetName,
      localPath: delivery === 'image' ? resolved : undefined,
      remoteUrl: cand.remoteUrl,
      textFallback: cand.textFallback,
      delivery,
      droppedReason,
    });
  }

  const plan: FrameImageGenerationPlan = {
    frameType,
    groupIdx,
    shotIndices: validShotIndices,
    primaryShotIdx,
    primaryShot,
    contextShots,
    aspectRatio,
    compositionGuidance,
    contextShotIndices,
    characters: usedChars.map((c: any) => ({
      name: c.name || c.role,
      description: truncate(
        [c.identity, c.appearance || c.description, c.clothing, c.equipment]
          .filter(Boolean)
          .join(', '),
        200,
      ),
      imageUrl: assetImageUrl(c),
      entityType: c.entityType,
    })),
    scene: chosenScene
      ? {
          name: chosenScene.name || chosenScene.location,
          description: truncate(
            [
              chosenScene.description,
              chosenScene.location,
              chosenScene.lighting,
              chosenScene.atmosphere,
              chosenScene.elements,
              chosenScene.features,
            ]
              .filter(Boolean)
              .join(', '),
            220,
          ),
          imageUrl: assetImageUrl(chosenScene),
        }
      : null,
    props: usedProps.map((p: any) => ({
      name: p.name || p.propName,
      description: truncate(
        [p.description, p.features, p.propType].filter(Boolean).join(', '),
        140,
      ),
      imageUrl: assetImageUrl(p),
    })),
    styleLock,
    driftGuardrails,
    characterLockText,
    sceneLockText,
    propLockText,
    shotConstraintText,
    referenceManifest: manifest,
    finalPrompt: '',
    modelSnapshot: input.modelSnapshot,
  };
  plan.finalPrompt = renderFramePrompt(plan);
  return plan;
}

function shotVisualForFramePrompt(shot: any): string {
  return (
    clean(shot?.imagePrompt) ||
    clean(shot?.visual) ||
    clean(shot?.description) ||
    clean(shot?.desc)
  );
}

export function renderFramePrompt(plan: FrameImageGenerationPlan): string {
  const { frameType, shotIndices, primaryShot, primaryShotIdx, contextShots } = plan;
  const lines: string[] = [];

  // 1. Task + frame goal
  if (frameType === 'first_frame') {
    lines.push(
      '【Task】Create ONE full-color cinematic video FIRST FRAME for an image-to-video generation pipeline.',
    );
    lines.push(
      '【Frame goal】This is the exact opening frame (t=0) of the video segment. NOT a storyboard sheet, NOT a pencil sketch, NOT a comic panel, NOT a character model sheet.',
    );
  } else {
    lines.push(
      '【Task】Create ONE full-color cinematic video TAIL FRAME for an image-to-video generation pipeline.',
    );
    lines.push(
      '【Frame goal】This is the exact closing frame of the video segment, used to control how the video ends and hand over to the next segment. NOT a storyboard sheet, NOT a sketch.',
    );
  }
  lines.push(
    'Photorealistic live-action cinematic frame, professional production design, natural color grading, realistic lighting, realistic material textures.',
  );
  lines.push(
    'No subtitles, no captions, no written text, no watermarks, no panel borders, no split-screen layout.',
  );

  // 2. Primary shot + context
  lines.push('');
  lines.push(
    frameType === 'first_frame'
      ? `【Primary shot】Use Shot ${primaryShotIdx + 1} as the opening beat.`
      : `【Primary shot】Use Shot ${primaryShotIdx + 1} as the closing beat (this is the last shot of the segment).`,
  );
  const pShotType = clean(primaryShot?.shotType || primaryShot?.framing);
  const pCamera = clean(primaryShot?.camera || primaryShot?.movement);
  const pVisual = shotVisualForFramePrompt(primaryShot);
  const pDialogue = clean(primaryShot?.dialogue || primaryShot?.scriptRef);
  if (pShotType) lines.push(`- framing: ${pShotType}`);
  if (pCamera) lines.push(`- camera: ${pCamera}`);
  if (pVisual) lines.push(`- visual: ${pVisual}`);
  if (pDialogue && pDialogue !== '——') lines.push(`- dialogue/audio cue: ${pDialogue}`);

  if (contextShots.length) {
    lines.push('');
    lines.push(
      '【Context shots】Use only for action/emotion continuity; do NOT change the composition of the primary shot.',
    );
    for (let i = 0; i < contextShots.length; i += 1) {
      const sh = contextShots[i];
      const idx = plan.contextShotIndices[i] + 1;
      const visual = shotVisualForFramePrompt(sh);
      if (visual) lines.push(`- Shot ${idx}: ${truncate(visual, 160)}`);
    }
  }

  // 3. Reference images (only those actually submitted)
  const imageRefs = plan.referenceManifest.filter((r) => r.delivery === 'image');
  if (imageRefs.length) {
    lines.push('');
    lines.push('【Reference images】');
    for (const r of imageRefs) {
      const roleText =
        r.role === 'scene'
          ? 'scene — lock space/materials/lighting/tone'
          : r.role === 'character'
            ? `character (${r.assetName || ''}) — lock face/wardrobe/body type/species`
            : r.role === 'prop'
              ? `prop (${r.assetName || ''}) — lock shape/color/material`
              : r.role === 'prev_tail'
                ? 'previous segment tail frame — continuity anchor'
                : r.role === 'self_first_frame'
                  ? 'this segment first frame — composition/identity anchor'
                  : String(r.role);
      // imageNo 在 delivery='image' 的 ref 上 1-based 连续, 和 image[] 数组对齐。
      lines.push(`- Image ${r.imageNo} = ${roleText}`);
    }
  }

  // 4. Locks (text)
  if (plan.characterLockText) {
    lines.push('');
    lines.push('【Character lock】');
    lines.push(plan.characterLockText);
  }
  if (plan.sceneLockText) {
    lines.push('');
    lines.push('【Scene lock】');
    lines.push(plan.sceneLockText);
  }
  if (plan.propLockText) {
    lines.push('');
    lines.push('【Prop lock】');
    lines.push(plan.propLockText);
  }
  if (plan.styleLock) {
    lines.push('');
    lines.push('【Project style lock】');
    lines.push(plan.styleLock);
  }

  // 5. Drift guardrails
  if (plan.driftGuardrails) {
    lines.push('');
    lines.push(plan.driftGuardrails.replace(/^\n+/, ''));
  }

  // 6. Composition rules
  lines.push('');
  lines.push('【Composition rules】');
  lines.push(`- Target aspect ratio: ${plan.aspectRatio}. ${plan.compositionGuidance}`);
  lines.push('- Use one coherent camera frame matching the primary shot framing/camera.');
  lines.push(
    '- Keep character identity, wardrobe, species/body type, scene materials, props and color palette consistent with the references.',
  );
  lines.push(
    '- If any non-human/anthropomorphic character appears, preserve its species body and realistic scale; never turn it into an ordinary human.',
  );
  if (frameType === 'first_frame') {
    lines.push('- The image must be usable directly as the first frame for video generation.');
  } else {
    lines.push('- The image must be usable directly as the closing frame for video generation.');
    lines.push(
      '- Maintain continuity with the opening frame: same location, lighting, wardrobe, and props unless the shot action explicitly changes them.',
    );
  }

  // 7. Hard prohibitions
  lines.push('');
  lines.push('【Hard prohibitions】');
  lines.push(
    '- No subtitles, no captions, no written text, no watermarks, no panel borders, no split-screen layout, no multi-panel, no model sheet.',
  );
  lines.push('- Respect any user negative constraints below.');

  let out = sanitizeFillLightPositiveMentions(lines.join('\n'));

  const constraintSource = [
    plan.shotConstraintText,
    plan.characterLockText,
    plan.sceneLockText,
    plan.propLockText,
    plan.styleLock,
    plan.driftGuardrails,
  ].join('\n');
  const noFillLight = hasNoFillLightConstraint(constraintSource);
  out = enforceHardVisualConstraints(out, constraintSource);
  if (out.length > MAX_FINAL_PROMPT_CHARS) {
    out = out.slice(0, MAX_FINAL_PROMPT_CHARS) + '…';
    if (noFillLight) out = enforceNoFillLightConstraint(out);
  }
  return out;
}

export function summarizePlanForAudit(plan: FrameImageGenerationPlan): FrameImagePlanSummary {
  const sent = plan.referenceManifest.filter((r) => r.delivery === 'image');
  const textOnly = plan.referenceManifest.filter((r) => r.delivery === 'text_only');
  const dropped = plan.referenceManifest.filter((r) => r.delivery === 'dropped');
  return {
    frameType: plan.frameType,
    groupIdx: plan.groupIdx,
    shotIndices: plan.shotIndices,
    primaryShotIdx: plan.primaryShotIdx,
    aspectRatio: plan.aspectRatio,
    compositionGuidance: plan.compositionGuidance,
    characterNames: plan.characters.map((c) => c.name).filter(Boolean),
    sceneName: plan.scene?.name,
    propNames: plan.props.map((p) => p.name).filter(Boolean),
    sentReferences: sent.map((r) => ({
      slot: r.slot,
      imageNo: r.imageNo as number,
      role: r.role,
      assetName: r.assetName,
    })),
    textOnlyReferences: textOnly.map((r) => ({
      slot: r.slot,
      role: r.role,
      assetName: r.assetName,
      reason: r.droppedReason,
    })),
    droppedReferences: dropped.map((r) => ({
      slot: r.slot,
      role: r.role,
      assetName: r.assetName,
      reason: r.droppedReason,
    })),
    finalPromptHash: hashText(plan.finalPrompt),
    finalPromptLength: plan.finalPrompt.length,
    modelSnapshot: plan.modelSnapshot,
  };
}
