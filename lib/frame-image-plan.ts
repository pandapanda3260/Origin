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
  appliedEditDraft?: boolean;
  actualImageInput?: {
    quality: string;
    size: string;
    style: string;
    referenceImageCount: number;
    draftFingerprint?: string;
  };
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

const MAX_FINAL_PROMPT_CHARS = 5000;
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

  const characterLockRoster = buildCharacterLockRoster(project, charNames, 'zh', groupText);
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
              ? ' 非人/拟人角色，必须保留原物种身体结构'
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
    ? `${chosenScene.name || chosenScene.location || '场景'}: ${truncate(
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
    styleBible.additionalPrompt && `附加风格提示：${styleBible.additionalPrompt}`,
    (styleBible.negativePrompt || styleBible.videoNegativePrompt) && `负向风格约束：${styleBible.negativePrompt || styleBible.videoNegativePrompt}`,
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
        'Self first frame: identity and continuity anchor for this segment — keep the same subject, wardrobe, location, and lighting family, but do not copy its exact pose, crop, or composition.',
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
        ? '（非人/拟人角色，必须保留原物种身体结构）'
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

function tailSignalScore(signals: any, key: string): number {
  const n = Number(signals?.[key]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

function buildTailFrameTargetLines(plan: FrameImageGenerationPlan): string[] {
  const shot = plan.primaryShot || {};
  const signals = shot?.tailFrameSignals && typeof shot.tailFrameSignals === 'object'
    ? shot.tailFrameSignals
    : {};
  const visual = shotVisualForFramePrompt(shot);
  const dialogue = clean(shot?.dialogue || shot?.scriptRef);
  const keyInfo = clean(shot?.keyInfo);
  const isSingleShotSegment = plan.shotIndices.length === 1;

  const lines: string[] = [
    '【尾帧目标】',
    '这是本片段的结束瞬间，发生在 Image 1 / 首帧之后数秒。它不能是首帧的重画或近似重复。',
    '- 呈现镜头动作推进后的完成状态。',
  ];

  if (visual) lines.push(`- 结束状态来源：${truncate(visual, 180)}`);
  if (keyInfo) lines.push(`- 需要在尾帧中明确呈现的关键信息：${truncate(keyInfo, 80)}`);
  if (dialogue && dialogue !== '——') {
    lines.push(`- 台词/声音后的情绪落点：${truncate(dialogue, 120)}`);
  }
  if (isSingleShotSegment) {
    lines.push('- 单镜头片段规则：首帧是该镜头的开始，尾帧是同一镜头动作/情绪落定后的结束状态。');
  }

  if (tailSignalScore(signals, 'actionLandingNeed') >= 3) {
    lines.push('- 动作落点：改变可见的手部、身体或物体位置，体现动作已经推进或停稳。');
  }
  if (tailSignalScore(signals, 'visualTransformationNeed') >= 3) {
    lines.push('- 视觉状态变化：体现物体状态、环境细节、光线、雾气、水面、碎屑或其他镜头专属视觉证据的变化。');
  }
  if (tailSignalScore(signals, 'revealNeed') >= 3) {
    lines.push('- 揭示落点：让被揭示的重要信息比首帧更清楚。');
  }
  if (tailSignalScore(signals, 'emotionPeakNeed') >= 3) {
    lines.push('- 情绪落点：呈现角色情绪反应已经发生后的状态，不要停留在首帧同一个表情瞬间。');
  }

  lines.push(
    '- 相比 Image 1 必须有可见差异：至少改变一个有意义元素，如姿态、道具/物体位置、面部/情绪状态、前景/背景关系、距离/裁切或环境运动痕迹。',
  );
  lines.push(
    '- 保持身份、服装、地点、光线类型和关键道具连续，但不要复制首帧的完全相同姿态、裁切或构图，除非镜头明确要求没有变化。',
  );
  return lines;
}

export function renderFramePrompt(plan: FrameImageGenerationPlan): string {
  const { frameType, shotIndices, primaryShot, primaryShotIdx, contextShots } = plan;
  const lines: string[] = [];

  // 1. Task + frame goal
  if (frameType === 'first_frame') {
    lines.push(
      '【任务】生成一张用于图生视频流程的全彩电影感首帧。',
    );
    lines.push(
      '【画面目标】这是视频片段 t=0 的准确开场画面。不是分镜表、不是铅笔稿、不是漫画格、不是角色设定三视图。',
    );
  } else {
    lines.push(
      '【任务】生成一张用于图生视频流程的全彩电影感尾帧。',
    );
    lines.push(
      '【画面目标】这是视频片段的准确结束画面，用来控制本段如何收束并衔接下一段。不是分镜表，也不是草图。',
    );
  }
  lines.push(
    '真人实拍质感的电影画面，专业美术置景，自然调色，真实光线，真实材质纹理。',
  );
  lines.push(
    '无字幕、无说明文字、无可读文字、无水印、无分格边框、无分屏布局。',
  );

  // 2. Primary shot + context
  lines.push('');
  lines.push(
    frameType === 'first_frame'
      ? `【主镜头】以镜头 ${primaryShotIdx + 1} 作为开场节拍。`
      : `【主镜头】以镜头 ${primaryShotIdx + 1} 作为结束节拍（这是本片段的最后一个镜头）。`,
  );
  const pShotType = clean(primaryShot?.shotType || primaryShot?.framing);
  const pCamera = clean(primaryShot?.camera || primaryShot?.movement);
  const pVisual = shotVisualForFramePrompt(primaryShot);
  const pDialogue = clean(primaryShot?.dialogue || primaryShot?.scriptRef);
  if (pShotType) lines.push(`- 景别：${pShotType}`);
  if (pCamera) lines.push(`- 运镜：${pCamera}`);
  if (pVisual) lines.push(`- 画面：${pVisual}`);
  if (pDialogue && pDialogue !== '——') lines.push(`- 台词/声音提示：${pDialogue}`);

  if (frameType === 'tail_frame') {
    lines.push('');
    lines.push(...buildTailFrameTargetLines(plan));
  }

  if (contextShots.length) {
    lines.push('');
    lines.push(
      '【上下文镜头】只用于动作和情绪连续性参考，不要改变主镜头构图。',
    );
    for (let i = 0; i < contextShots.length; i += 1) {
      const sh = contextShots[i];
      const idx = plan.contextShotIndices[i] + 1;
      const visual = shotVisualForFramePrompt(sh);
      if (visual) lines.push(`- 镜头 ${idx}：${truncate(visual, 160)}`);
    }
  }

  // 3. Reference images (only those actually submitted)
  const imageRefs = plan.referenceManifest.filter((r) => r.delivery === 'image');
  if (imageRefs.length) {
    lines.push('');
    lines.push('【参考图】');
    for (const r of imageRefs) {
      const roleText =
        r.role === 'scene'
          ? '场景 - 锁定空间、材质、光线和基调'
          : r.role === 'character'
            ? `角色（${r.assetName || ''}）- 锁定脸部、服装、体型和物种特征`
            : r.role === 'prop'
              ? `道具（${r.assetName || ''}）- 锁定形状、颜色和材质`
              : r.role === 'prev_tail'
                ? '上一片段尾帧 - 连续性锚点'
                : r.role === 'self_first_frame'
                  ? '本片段首帧 - 身份和连续性锚点，不是构图复制目标'
                  : String(r.role);
      // imageNo 在 delivery='image' 的 ref 上 1-based 连续, 和 image[] 数组对齐。
      lines.push(`- Image ${r.imageNo} = ${roleText}`);
    }
  }

  // 4. Locks (text)
  if (plan.characterLockText) {
    lines.push('');
    lines.push('【角色锁定】');
    lines.push(plan.characterLockText);
  }
  if (plan.sceneLockText) {
    lines.push('');
    lines.push('【场景锁定】');
    lines.push(plan.sceneLockText);
  }
  if (plan.propLockText) {
    lines.push('');
    lines.push('【道具锁定】');
    lines.push(plan.propLockText);
  }
  if (plan.styleLock) {
    lines.push('');
    lines.push('【项目风格锁定】');
    lines.push(plan.styleLock);
  }

  // 5. Drift guardrails
  if (plan.driftGuardrails) {
    lines.push('');
    lines.push(plan.driftGuardrails.replace(/^\n+/, ''));
  }

  // 6. Composition rules
  lines.push('');
  lines.push('【构图规则】');
  lines.push(`- 目标画幅比例：${plan.aspectRatio}。${plan.compositionGuidance}`);
  lines.push('- 使用一个完整统一的镜头画面，匹配主镜头的景别和运镜意图。');
  lines.push(
    '- 角色身份、服装、物种/体型、场景材质、道具和色彩体系必须与参考保持一致。',
  );
  lines.push(
    '- 如果出现非人/拟人角色，必须保留原物种身体结构和真实尺度，绝不能变成普通人类。',
  );
  if (frameType === 'first_frame') {
    lines.push('- 这张图必须能直接作为视频生成的首帧使用。');
  } else {
    lines.push('- 这张图必须能直接作为视频生成的收束尾帧使用。');
    lines.push(
      '- 与首帧保持连续，同时呈现明显更晚的结束状态：地点、光线类型、服装和道具一致，但动作、情绪或物体状态已变化。',
    );
  }

  // 7. Hard prohibitions
  lines.push('');
  lines.push('【硬性禁止】');
  lines.push(
    '- 禁止字幕、说明文字、可读文字、水印、分格边框、分屏布局、多格图、角色设定表。',
  );
  lines.push('- 必须遵守下方所有用户负向约束。');

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
