/**
 * 批量任务的 3 个执行器（与原站 batchType 对齐）：
 *   1. asset_images       —— 给角色/场景/道具生成参考图
 *   2. storyboard_prompts —— 把镜头描述转成图像生成提示词（纯文本 LLM）
 *   3. storyboard_images  —— 给每个分镜组生成手稿风格分镜图
 *
 * 注册时机：lib/init-executors.ts 在 app 启动时调用一次。
 */

import { registerExecutor, aliasExecutor, type BatchExecCtx } from './batches';
import { resolveLocalImagePath } from './image-gen';
import { generateImageWithModerationRecovery } from './safe-image-gen';
import { generateVideo, VideoGenerationError, classifyVideoFailureStage, type VideoReferenceImage } from './video-gen';
import { chatComplete, chatCompleteJsonWithRetry, parseJsonLoose, resolveLLMConfig } from './llm';
import { buildShotsMessages, buildVideoPromptMessages } from './prompts';
import { getProjectByIdForUser, patchProjectForUser } from './projects-db';
import { isIndependentMultiImageModeEnabled, isMultiRefVideoModeEnabled } from './feature-flags';
import {
  buildVideoPromptAttemptMessages,
  videoPromptTemperatureForAttempt,
  VIDEO_PROMPT_MAX_ATTEMPTS,
} from './video-prompt-attempts';
import {
  applyCharacterPanelResult,
  existingPanelVersion,
  inferEntityTypeFromCharacter,
  splitCharacterPanels,
  type SplitCharacterPanelsResult,
} from './character-panels';
import type { CharacterReferencePanel } from './panel-selection';
import {
  ensureProjectConsistency,
  mutateCharacterLock,
  renderCharacterLockRosterLine,
  type CharacterLock,
} from './character-consistency';
import { buildVideoReferenceManifest } from './reference-matcher';
import {
  enforceHardVisualConstraints,
  enforceNoFillLightConstraint,
  hasFillLightPositiveMention,
  hasNoFillLightConstraint,
  sanitizeFillLightPositiveMentions,
  sanitizePromptObject,
} from './content-sanitize';
import {
  cleanDialogueCharCount,
  evaluateDialogueBudget,
  hashString,
  plannedDurationFromShots,
  resolveGenerationDurationSec,
  type DialoguePolicy,
  type DroppedReference,
  type ReferenceManifestItem,
  type VideoGenerationPlan,
  type VideoReferenceRole,
} from './video-reference-manifest';
import {
  assertVideoPromptReadyForGroups,
  markStoryboardVideoOutdated,
  markVideoTaskOutdated,
  type VideoPromptFailureStage,
} from './video-prompt-state';
import { buildSeedancePromptParts } from './video-prompt-runtime';
import { validateCharacterConsistencyForGroup } from './character-consistency-gate';
import { markFirstFrameReady, normalizeFirstFrameState, resolveStoryboardFirstFrameUrl, checkTailFramePreflight, formatTailFramePreflightError } from './visual-reference-state';
import { pickSceneForShots } from './scene-selection';
import { buildFrameImageGenerationPlan, summarizePlanForAudit } from './frame-image-plan';
import { buildCharacterLockRoster, joinPromptValues } from './frame-prompt-helpers';

function isPlanReferenceRole(role: string): role is VideoReferenceRole {
  return role === 'first_frame' || role === 'scene' || role === 'character' || role === 'prop';
}

function findCharacterLock(project: any, character: any): CharacterLock | null {
  const withConsistency = ensureProjectConsistency(project || {}, { source: 'migration' });
  const locks: CharacterLock[] = Array.isArray(withConsistency.consistency?.characters) ? withConsistency.consistency.characters : [];
  const ids = new Set(
    [
      character?.characterId,
      character?.id,
      character?.name,
      character?.role,
    ].filter(Boolean).map((v) => String(v)),
  );
  return locks.find((lock) => (
    ids.has(lock.characterId) ||
    (lock.sourceAssetId && ids.has(lock.sourceAssetId)) ||
    ids.has(lock.canonicalName) ||
    lock.aliases.some((alias) => ids.has(alias))
  )) || null;
}

function referenceDefaults(role: VideoReferenceRole): Pick<ReferenceManifestItem, 'useFor' | 'immutable' | 'promptHint'> {
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

function collectRuntimeHardConstraints(prompt: string): Array<{ id: string; text: string; source: 'runtime' }> {
  const lines = String(prompt || '').match(/HARD USER NEGATIVE CONSTRAINT:[^\n]+/g) || [];
  return lines.map((text, idx) => ({
    id: `runtime_hard_${idx + 1}`,
    text,
    source: 'runtime' as const,
  }));
}

function compactManifestSignature(refs: any[]): string {
  if (!Array.isArray(refs)) return '';
  return refs
    .map((ref: any) => [
      ref?.imageNo,
      ref?.role,
      ref?.url,
      ref?.label,
      ref?.assetName,
      ref?.panelInfo?.panel,
      ref?.panelInfo?.intent,
    ].map((v) => String(v || '')).join('|'))
    .join('\n');
}

function manifestsDiffer(a: any[], b: any[]): boolean {
  return compactManifestSignature(a) !== compactManifestSignature(b);
}

function dedupeDroppedReferences(refs: any[]): DroppedReference[] {
  const out: DroppedReference[] = [];
  const seen = new Set<string>();
  for (const ref of refs || []) {
    if (!ref || !ref.role) continue;
    const role = String(ref.role);
    if (role !== 'scene' && role !== 'character' && role !== 'prop') continue;
    const assetName = String(ref.assetName || ref.label || '').trim();
    const key = `${role}|${assetName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role: role as DroppedReference['role'],
      assetName: assetName || undefined,
      reason: ref.reason || 'image_budget_exceeded',
    });
  }
  return out;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorWithFailureStage(message: string, failureStage: VideoPromptFailureStage): Error & { failureStage: VideoPromptFailureStage } {
  const err = new Error(message) as Error & { failureStage: VideoPromptFailureStage };
  err.failureStage = failureStage;
  return err;
}

function errorWithRecoveryHint(
  message: string,
  errorCode: string,
  recoveryHint: string,
): Error & { errorCode: string; recoveryHint: string } {
  const err = new Error(message) as Error & { errorCode: string; recoveryHint: string };
  err.errorCode = errorCode;
  err.recoveryHint = recoveryHint;
  return err;
}

function isTransientNetworkError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return /socket hang up|secure TLS|TLS connection|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|fetch failed|network|aborted/i.test(msg);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function planReferencesFromManifest(refs: ReferenceManifestItem[]): ReferenceManifestItem[] {
  return refs
    .filter((ref) => isPlanReferenceRole(ref.role))
    .map((ref, idx) => {
      const role = ref.role as VideoReferenceRole;
      const defaults = referenceDefaults(role);
      return {
        ...ref,
        imageNo: idx + 1,
        role,
        label: ref.label || `${role} reference`,
        useFor: Array.isArray(ref.useFor) && ref.useFor.length ? ref.useFor : defaults.useFor,
        immutable: Array.isArray(ref.immutable) && ref.immutable.length ? ref.immutable : defaults.immutable,
        promptHint: ref.promptHint || defaults.promptHint,
      };
    });
}

function planReferencesFromAuditRefs(refs: any[]): ReferenceManifestItem[] {
  return (refs || [])
    .filter((ref) => isPlanReferenceRole(ref.role))
    .map((ref, idx) => {
      const role = ref.role as VideoReferenceRole;
      const defaults = referenceDefaults(role);
      return {
        imageNo: idx + 1,
        role,
        assetId: ref.assetId,
        assetName: ref.assetName,
        label: ref.label || `${role} reference`,
        url: ref.sourceUrl || ref.path,
        localPath: ref.path,
        useFor: defaults.useFor,
        immutable: defaults.immutable,
        promptHint: ref.promptHint || defaults.promptHint,
      };
    });
}

function buildVideoPlanSnapshot(opts: {
  projectId: string;
  groupIdx: number;
  groupShotIndices: number[];
  videoPromptSource: VideoGenerationPlan['promptAudit']['sourcePrompt']['source'];
  sanitizedFor: string[];
  finalPrompt: { preview: string; hash: string; length: number };
  dialoguePolicy: DialoguePolicy;
  dialoguePolicyNotes?: string;
  references: ReferenceManifestItem[];
  droppedReferences: DroppedReference[];
  prompt: string;
  userRatio: string;
  durationSec: number;
  plannedDurationSec?: number;
  videoWarnings: any[];
  dialogueChars: number;
  status: 'submitting' | 'completed' | 'failed';
  modelSnapshot?: VideoGenerationPlan['modelSnapshot'];
  failureStage?: VideoPromptFailureStage;
  errorMsg?: string;
}): VideoGenerationPlan {
  return {
    version: 'video_plan_v1',
    projectId: opts.projectId,
    groupIdx: opts.groupIdx,
    shotIndices: opts.groupShotIndices,
    promptAudit: {
      sourcePrompt: {
        source: opts.videoPromptSource,
        sanitizedFor: opts.sanitizedFor,
      },
      finalPrompt: opts.finalPrompt,
      dialoguePolicy: opts.dialoguePolicy,
      dialoguePolicyNotes: opts.dialoguePolicyNotes,
    },
    references: opts.references,
    droppedReferences: dedupeDroppedReferences(opts.droppedReferences),
    constraints: {
      hard: [
        ...collectRuntimeHardConstraints(opts.prompt),
        ...opts.sanitizedFor.map((id) => ({
          id,
          text: id === 'fill_light_positive'
            ? 'Prompt sanitized positive fill-light mentions before video generation.'
            : 'Prompt enforced no-fill-light hard constraint before video generation.',
          source: 'sanitizer' as const,
        })),
      ],
      negative: [],
    },
    params: {
      ratio: opts.userRatio,
      durationSec: opts.durationSec,
      plannedDurationSec: opts.plannedDurationSec,
      subtitles: 'none',
      audioMode: 'seedance_dialogue_audio',
    },
    audit: {
      status: opts.status,
      referenceCount: opts.references.length,
      dialogueChars: opts.dialogueChars,
      warnings: opts.videoWarnings.map((warning: any) => warning?.message || String(warning)).filter(Boolean),
      failureStage: opts.failureStage,
      errorMsg: opts.errorMsg,
    },
    modelSnapshot: opts.modelSnapshot,
  };
}

/* ============================================================
   helper：根据 target.{type, idx} 找到对应资产 + 构造提示词
   ============================================================ */

/**
 * 把 styleBible 转成一段固定的英文 "STYLE BIBLE LOCK"——同一个项目下的
 * **每一张场景图**都拼上完全相同的这段，从 prompt 层面强行让所有场景共享
 * 同一套色调 / 灯光 / 风格关键字，避免场景参考图和后续镜头参考割裂。
 *
 * 注意：这段会作为权威约束放在 prompt 末尾，覆盖前面 imagePrompt 里可能写
 * 出来的局部冲突。如果 styleBible 缺失就返回空串，不强加约束。
 */
function buildSceneStyleLock(styleBible: any): string {
  if (!styleBible || typeof styleBible !== 'object') return '';
  const parts: string[] = [];
  // 视觉风格关键词（治愈系 / 王家卫怀旧 等）
  const vs = styleBible.visualStyle || styleBible.vision;
  if (vs) parts.push(`Project visual style: ${vs}.`);
  if (styleBible.visualStyleDesc) parts.push(`Style detail: ${styleBible.visualStyleDesc}`);
  // 色板：6 个 hex+中文名拼成英文友好的 list
  if (Array.isArray(styleBible.colorPalette) && styleBible.colorPalette.length) {
    const palette = styleBible.colorPalette
      .filter((c: any) => c && (c.hex || c.name))
      .map((c: any) => `${c.hex || ''}${c.name ? ` (${c.name})` : ''}`.trim())
      .join(', ');
    if (palette) parts.push(`Project color palette (the image's overall color must come from this palette, NOT from the model's default white-balance guess): ${palette}.`);
  }
  // 时代/世界观（决定材质 / 道具风格 / 整体光线倾向）
  if (styleBible.era) parts.push(`Era & setting: ${styleBible.era}`);
  if (styleBible.mood || styleBible.tone) parts.push(`Overall mood: ${styleBible.mood || styleBible.tone}`);
  // 镜头风格（决定景别偏好 / 构图）
  if (styleBible.cameraStyle) parts.push(`Camera language: ${styleBible.cameraStyle}`);
  // worldRules 太长会挤掉别的提示，截到 240 字
  if (styleBible.worldRules) {
    const wr = String(styleBible.worldRules).slice(0, 240);
    parts.push(`World rules: ${wr}`);
  }
  if (!parts.length) return '';
  return sanitizeFillLightPositiveMentions([
    '=== PROJECT STYLE BIBLE LOCK (every scene image in this project MUST share this exact look) ===',
    ...parts,
    'CRITICAL: do NOT introduce colors, lighting temperatures, or material styles outside the project palette above. All scenes in this project must look like they came from the same DP and the same color grading session.',
  ].join('\n'));
}

function resolveAssetTarget(project: any, target: any) {
  const type: 'char' | 'scene' | 'prop' = target.type;
  const idx: number = target.idx;
  const cat = type === 'char' ? 'characters' : type === 'scene' ? 'scenes' : 'props';
  const item =
    project?.assets?.[cat]?.[idx] ??
    (cat === 'characters' ? project?.characters?.[idx] :
     cat === 'scenes' ? project?.environments?.[idx] :
     project?.props?.[idx]);
  return { item, type, idx, cat };
}

/**
 * 当 LLM 没写 imagePrompt 时的兜底 prompt。
 * 注意：风格统一（白底 + 写实摄影 + 三视图）已经在 image-gen.ts 的
 * forceStyleSuffix() 里强制兜底了，这里只描述"主体"，不再写风格。
 */
function buildAssetPrompt(asset: any, type: string, _styleBible: any): string {
  if (type === 'char') {
    const traits = [asset.temperament, asset.actionTraits, ...(asset.tags || [])]
      .filter(Boolean)
      .join(', ');
    return sanitizeFillLightPositiveMentions([
      `Subject: ${asset.name || 'unnamed character'}.`,
      asset.detail || asset.intro || '',
      traits && `Traits: ${traits}.`,
      asset.appearance && `Appearance: ${asset.appearance}.`,
      asset.clothing && `Clothing: ${asset.clothing}.`,
    ].filter(Boolean).join('\n'));
  }
  if (type === 'scene') {
    const parts: string[] = [`Subject: ${asset.name || 'unnamed scene'}.`];
    if (asset.location) parts.push(`Located in: ${asset.location}.`);
    if (asset.description) parts.push(asset.description);
    if (asset.timeSetting) parts.push(`Shot at: ${asset.timeSetting}.`);
    if (asset.weather) parts.push(`Weather: ${asset.weather}.`);
    if (asset.lighting) parts.push(`Lighting: ${asset.lighting}.`);
    if (asset.atmosphere) parts.push(`Atmosphere: ${asset.atmosphere}.`);
    if (Array.isArray(asset.elements) && asset.elements.length) parts.push(`Key elements: ${asset.elements.join(', ')}.`);
    return sanitizeFillLightPositiveMentions(parts.filter(Boolean).join('\n'));
  }
  return sanitizeFillLightPositiveMentions([
    `Subject: ${asset.name || 'unnamed prop'}.`,
    asset.features && `Appearance: ${asset.features}.`,
    asset.propType && `Type: ${asset.propType}.`,
  ].filter(Boolean).join('\n'));
}

/* ============================================================
   1. asset_images executor
   ============================================================ */
registerExecutor('asset_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const { item, type, idx, cat } = resolveAssetTarget(proj, ctx.target);
  if (!item) throw new Error(`找不到 ${cat}[${idx}]`);

  ctx.progress({ stage: 'building_prompt' });
  const reusablePrompt = sanitizeFillLightPositiveMentions(item.imagePrompt || buildAssetPrompt(item, type, (proj as any).styleBible));
  let prompt = reusablePrompt;

  // 场景元数据注入：原网站效果之所以好看，是因为它把"时段/天气/灯光/氛围/位置"
  // 这些场景级参数也喂进了图像 prompt（不光显示在卡上）。我们的 LLM 现在会抽
  // 这些字段（参考资产场景抽取规则），这里在出图前拼一段"SCENE METADATA"
  // 段落让图像模型必须 reflect 出来。即便 imagePrompt 已经写过部分氛围，
  // 这段也作为权威约束追加到末尾。
  if (type === 'scene') {
    const sceneMeta: string[] = [];
    if (item.location) sceneMeta.push(`Location context: ${item.location}.`);
    if (item.timeSetting) sceneMeta.push(`Time of day: ${item.timeSetting} — lighting and shadows must match this time.`);
    if (item.weather) sceneMeta.push(`Weather: ${item.weather}.`);
    if (item.lighting) sceneMeta.push(`Lighting style: ${item.lighting}.`);
    if (item.atmosphere) sceneMeta.push(`Atmosphere / mood keywords (the image must feel like these): ${item.atmosphere}.`);
    if (Array.isArray(item.elements) && item.elements.length) sceneMeta.push(`Key elements that must appear: ${item.elements.join(', ')}.`);
    if (sceneMeta.length) {
      prompt = `${prompt}\n\n=== SCENE METADATA (must reflect in image, override conflicting hints above) ===\n${sceneMeta.join('\n')}`;
    }

    // ----- 项目级色调锁定 -----
    // 场景资产现在只生成一张主环境参考图；这里从 styleBible 抽出 color
    // palette / visualStyle / mood / era，让这张图稳定承载全片环境质感。
    const styleLock = buildSceneStyleLock((proj as any).styleBible);
    if (styleLock) {
      prompt = `${prompt}\n\n${styleLock}`;
    }
  }

  // 角色元数据注入：把用户当前编辑过的外貌/服装/道具放到末尾作为权威覆盖，
  // 避免旧 imagePrompt 或重写 LLM 把这些细节弱化。气质/动作特征也影响表演
  // 气场（皱眉/手插腰），同样要求图像模型反映出来。
  if (type === 'char') {
    const lock = findCharacterLock(proj as any, item);
    if (lock) {
      prompt = `${prompt}\n\n=== CHARACTER CONSISTENCY LOCK (authoritative, must match exactly) ===\n${renderCharacterLockRosterLine(lock, 'en')}`;
    } else {
      const charMeta: string[] = [];
      if (item.appearance) charMeta.push(`Current appearance (authoritative override): ${item.appearance}.`);
      if (item.clothing) charMeta.push(`Current clothing (authoritative override): ${item.clothing}.`);
      if (item.equipment) charMeta.push(`Holding / wearing: ${item.equipment}.`);
      if (item.temperament) charMeta.push(`Temperament keywords (must show in face/posture): ${item.temperament}.`);
      if (item.actionTraits) charMeta.push(`Signature gestures (pose hints for the front view): ${item.actionTraits}.`);
      if (charMeta.length) {
        prompt = `${prompt}\n\n=== CHARACTER METADATA (must reflect in image, override conflicting hints above) ===\n${charMeta.join('\n')}`;
      }
    }
  }

  ctx.progress({ stage: 'calling_image_api' });
  // 尺寸策略：
  //   - 真人角色：1536×1024（宽图），三视图横向排开
  //   - 非人角色（拟人海鲜/机甲/动物）：1536×1024 也用三视图（前/侧/背）
  //   - 场景：1536×1024 establishing shot
  //   - 道具：1024×1024 白底 product shot
  const entityType: 'human' | 'non-human' =
    type === 'char' ? inferEntityTypeFromCharacter(item) : 'human';

  const referenceImagePath: string | undefined = undefined;

  prompt = sanitizeFillLightPositiveMentions(prompt);

  const result = await generateImageWithModerationRecovery(ctx.user, {
    prompt,
    size: type === 'char' ? '1536x1024' : type === 'scene' ? '1536x1024' : '1024x1024',
    style: 'natural',
    kind: type === 'char' ? 'character' : type === 'scene' ? 'scene' : 'prop',
    entityType: type === 'char' ? entityType : undefined,
    projectId: ctx.projectId,
    assetRef: `${cat}[${idx}]`,
    // 角色参考图和场景主环境图细节多，低画质会糊掉脸和场景纹理；
    // prop 单图保持 low 既快又够用。
    quality: type === 'prop' ? 'low' : 'medium',
    referenceImagePath,
  });

  let panelResult: SplitCharacterPanelsResult | null = null;
  if (type === 'char') {
    ctx.progress({ stage: 'splitting_character_panels' });
    panelResult = await splitCharacterPanels({
      user: ctx.user,
      projectId: ctx.projectId,
      assetRef: `${cat}[${idx}]`,
      sourceImageUrl: result.url,
      entityType,
      prompt: result.submittedPrompt,
      version: existingPanelVersion(item) + 1,
    });
    if (!panelResult.ok) {
      console.warn(`[asset_images] character panel split failed for ${cat}[${idx}]: ${panelResult.error}`);
    }
  }

  // 写回项目：把 imageUrl + rawUrl + imagePrompt 落到资产对象
  // 注意：写入 imageUrl + rawUrl 两个字段，因为前端不同卡片读不同字段（兼容历史）
  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const assets = (fresh as any).assets || { characters: [], scenes: [], props: [] };
    if (!assets[cat]) assets[cat] = [];
    if (!assets[cat][idx]) assets[cat][idx] = {};
    const charExtra = type === 'char'
      ? { realPhotoUrl: result.url, pencilUrl: result.url, skippedStylize: true }
      : {};
    let nextAsset = {
      ...assets[cat][idx],
      imageUrl: result.url,
      rawUrl: result.url,
      imagePrompt: reusablePrompt,
      submittedImagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
      reference: {
        ...assets[cat][idx].reference,
        currentUrl: result.url,
        lastKnownGoodUrl: result.url,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      },
      imageGeneratedAt: new Date().toISOString(),
      ...charExtra,
    };
    if (type === 'char' && panelResult) nextAsset = applyCharacterPanelResult(nextAsset, panelResult);
    assets[cat][idx] = nextAsset;
    // 顶层 characters/environments/props 也同步（前端两种结构都读）
    const topKey = cat === 'characters' ? 'characters' : cat === 'scenes' ? 'environments' : 'props';
    const top = (fresh as any)[topKey] || [];
    if (!top[idx]) top[idx] = {};
    let nextTop = {
      ...top[idx],
      imageUrl: result.url,
      rawUrl: result.url,
      imagePrompt: reusablePrompt,
      submittedImagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
      ...charExtra,
    };
    if (type === 'char' && panelResult) nextTop = applyCharacterPanelResult(nextTop, panelResult);
    top[idx] = nextTop;
    const patch: any = { assets, [topKey]: top };
    if (type === 'char') {
      const panels = nextAsset.panels || {};
      const mutation = mutateCharacterLock(
        { ...(fresh as any), ...patch },
        nextAsset.characterId || nextAsset.id || nextAsset.name || `characters[${idx}]`,
        {
          referenceLock: {
            sheetUrl: panels.sheetUrl || result.url,
            headshotUrl: panels.headshotUrl,
            frontUrl: panels.frontUrl,
            sideUrl: panels.sideUrl,
            backUrl: panels.backUrl,
            sourceImageId: panels.sourceImageId || result.id,
            referenceStatus: panelResult && !panelResult.ok ? 'degraded' : 'ready',
            qualityScore: panelResult?.ok ? panelResult.panels.confidence : undefined,
          },
        },
        { source: 'asset_image' },
      );
      patch.consistency = mutation.project.consistency;
      patch.assets = mutation.project.assets;
      patch[topKey] = mutation.project[topKey];
    }
    return patch;
  });

  // task_completed 事件 payload：前端 onTaskCompleted 读 extra.rawUrl / extra.pencilUrl
  // 来实时更新卡片 UI（不刷新就能看到图）。之前我们漏发这两个字段，所以图必须
  // 刷新页面才显示——这里补上。
  return {
    resultUrl: result.url,
    patch: { type: 'asset_image', cat, idx, value: result.url, imageUrl: result.url, imagePrompt: reusablePrompt },
    extra: {
      type,
      idx,
      rawUrl: result.url,
      pencilUrl: type === 'char' ? result.url : undefined,
      skippedStylize: type === 'char' ? true : undefined,
      mode: result.mode,
      width: result.width,
      height: result.height,
      panels: panelResult?.ok ? panelResult.panels : undefined,
      panelsError: panelResult && !panelResult.ok ? panelResult.error : undefined,
      imageSafetyAudit: result.safetyAudit,
    },
  };
});

/* ============================================================
   2. storyboard_prompts executor —— 把单个镜头描述转成图像生成提示词
   ============================================================ */
const SP_SHOT_TO_IMG_PROMPT = `你是分镜手稿（pre-production storyboard）提示词工程师。把"短视频镜头"翻译成英文提示词，最终会被画成**黑白铅笔分镜稿**（不是成片！不是照片！）。

【硬性要求】
- 全英文输出，不要中文，不要 markdown，不要 ["..."] 围栏
- 50-150 词
- 描述对象就是一张分镜稿，所以只描写：①主体（人物名 + 服装外观 + 表情/姿态）②动作（只描述这一帧定格的动作）③ 构图与景别（wide shot / medium / close-up / over-shoulder）④ 机位（low angle / high angle / eye-level / POV）⑤ 光照方向（key light from left / backlit / overhead / silhouette）⑥ 关键道具与场景元素（counter, fish trays, apron, clipboard 等）
- 如果给了角色描述，必须保留外观/服装一致性（同一角色多个镜头里穿同样的衣服）

【非人/拟人角色规则 —— 极其重要】
- 如果角色被标记为 "非人/拟人"（NON-HUMAN），或者画面描述里出现了拟人化的海鲜 / 动物 / 机甲 / AI 生物（例如"帝王蟹队长 / 龙虾 / 生蚝 / 三文鱼 / 扇贝 / 章鱼 / 机甲战士"等），**必须保留它们的物种本体**（anthropomorphic king crab with carapace and pincers / anthropomorphic lobster / anthropomorphic salmon / anthropomorphic oyster shell with tiny limbs ...）。
- **绝对禁止把这些非人角色画成穿围裙的真人员工**。如果同一画面里同时有人类老板和拟人海鲜，那么人类只画给定的人类角色，其余成员必须是对应物种的拟人形态（壳、鳃、触手、眼柄、钳等清晰可辨）。
- 对于群像（"一排员工 / 一群成员 / 后厨工会"等），必须按画面描述里点名的物种逐个画出（例："a king crab raising large pincers in the center, behind it a lobster, an oyster shell, a salmon, a scallop standing in a row" —— 不要写成"a row of human workers in aprons"）。
- **体型必须接近现实物种 + 至多到人类肩膀高**：拟人海鲜是"小员工尺寸"，不是巨型怪兽。请在描述里显式写 "human-shoulder-height anthropomorphic king crab"、"small lobster-sized anthropomorphic lobster standing on hind legs"、"hand-sized anthropomorphic oyster" 之类，并明确标注 "smaller than the human character" / "the human boss is the tallest figure in the frame"。绝不能让蟹钳比人脸还大、海鲜覆盖整个画面；如果一定要给中近景，描述时也要保持人类比海鲜更高的比例。

【禁止】
- 不要写 "photorealistic / cinematic film / 35mm / film grain / hyper-real / 4K / vivid color / teal-orange / saturated"——这些会破坏手稿风
- 不要写 "color palette / warm color tone"，分镜稿是黑白
- 不要写"运镜动词"作为单独陈述（如 "the camera slowly pushes in"），改用"frame composition implies a slow push-in"或直接给静止构图
- 不要写台词或字幕
- 不要写 "three-view" 或 "white background"（那是资产图，不是分镜图）
- 不要把任何拟人化的非人角色降级成"a human worker / employee / staff member in apron"
- 不要解释，不要复述中文，不要写"Description:"前缀，直接输出 prompt 段落`;

registerExecutor('storyboard_prompts', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');
  const idx: number = ctx.target.idx ?? ctx.seq;
  const shot = (proj as any).shots?.[idx];
  if (!shot) throw new Error(`找不到 shots[${idx}]`);

  ctx.progress({ stage: 'building_prompt' });
  const styleBible = (proj as any).styleBible || {};
  const styleHint = joinPromptValues([
    styleBible.vision || styleBible.visualStyle,
    styleBible.colorPalette,
    styleBible.cameraStyle,
    styleBible.mood || styleBible.tone,
    styleBible.lighting,
  ]);

  // 兼容新老字段
  const shotType = shot.shotType || shot.framing || '';
  const camera = shot.camera || shot.movement || '';
  const visual = shot.visual || shot.description || shot.desc || '';
  const dialogue = shot.dialogue || shot.dialog || '';
  const characters: string[] = Array.isArray(shot.characters) ? shot.characters : [];
  const keyInfo = shot.keyInfo || '';

  // 拼角色上下文（保持跨镜头服装/外观一致性 + 非人物种保护）
  const allChars = ((proj as any).assets?.characters || []) as any[];
  let charContext = '';
  if (characters.length) {
    charContext = characters
      .map((nm) => allChars.find((c: any) => c.name === nm || c.role === nm))
      .filter(Boolean)
      .map((c: any) => {
        const desc = c.appearance || c.description || c.detail || '';
        const cloth = c.clothing ? `, clothing: ${c.clothing}` : '';
        const ent = c.entityType === 'non-human' ? ' [NON-HUMAN / 拟人化，必须保留物种形态]' : '';
        return `${c.name || c.role}${ent}: ${desc}${cloth}`.trim();
      })
      .join(' | ');
  }

  // 兜底：扫一遍画面描述，把项目里登记过的非人角色名字都列出来，
  // 防止 shot.characters 漏写时 LLM 把"帝王蟹队长"画成真人。
  const nonHumanMentions: string[] = [];
  if (visual && allChars.length) {
    for (const c of allChars) {
      if (c.entityType !== 'non-human') continue;
      const nm = c.name || c.role;
      if (!nm) continue;
      if (visual.includes(nm) && !characters.includes(nm)) {
        const desc = c.appearance || c.description || c.detail || '';
        nonHumanMentions.push(`${nm} [NON-HUMAN]: ${desc}`.trim());
      }
    }
  }

  const userMsg = sanitizeFillLightPositiveMentions([
    `镜头序号：${shot.idx ?? idx + 1}`,
    shotType && `景别：${shotType}`,
    camera && `运镜：${camera}`,
    visual && `画面描述：${visual}`,
    dialogue && dialogue !== '——' && `台词/旁白：${dialogue}`,
    keyInfo && `主题词：${keyInfo}`,
    charContext && `本镜头角色（必须保留外观/服装一致性）：${charContext}`,
    nonHumanMentions.length && `画面中提及的其它非人/拟人角色（绝对不能画成真人）：${nonHumanMentions.join(' | ')}`,
    styleHint && `整体视觉风格：${styleHint}`,
  ].filter(Boolean).join('\n'));

  ctx.progress({ stage: 'calling_llm' });
  const prompt = await chatComplete(
    ctx.user,
    [
      { role: 'system', content: SP_SHOT_TO_IMG_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.5, maxTokens: 600, modelRole: 'structured' },
  );
  const cleaned = sanitizeFillLightPositiveMentions(prompt.trim().replace(/^["'`]+|["'`]+$/g, ''));
  if (!cleaned) throw new Error('AI 没有返回提示词');

  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const shots = Array.isArray((fresh as any).shots) ? [...(fresh as any).shots] : [];
    if (shots[idx]) {
      shots[idx] = { ...shots[idx], imagePrompt: cleaned, imagePromptGenerated: true };
      return { shots };
    }
    return null;
  });

  return {
    patch: { type: 'shot_prompt', idx, imagePrompt: cleaned },
    extra: { tokens: Math.ceil(cleaned.length / 2), shotIdx: idx, imagePrompt: cleaned },
  };
});

/* ============================================================
   3. storyboard_images executor —— 给一个分镜 group 生成手稿风分镜图
   ============================================================ */
registerExecutor('storyboard_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const shots = (proj as any).shots || [];

  // 优先使用前端传过来的 shotIndices（按情绪段切分组后的真实镜头索引数组）
  // 退化场景：老的目标只传 groupIdx，就把它当成镜头索引（兼容旧调用）
  let shotIndices: number[] = Array.isArray(ctx.target.shotIndices) && ctx.target.shotIndices.length
    ? ctx.target.shotIndices.filter((i: any) => typeof i === 'number')
    : [groupIdx];
  // 越界保护
  shotIndices = shotIndices.filter((i) => i >= 0 && i < shots.length);
  if (!shotIndices.length) {
    throw new Error(`分组 #${groupIdx} 没有对应的镜头数据`);
  }

  const groupShots = shotIndices.map((i) => shots[i]);
  const firstShot = groupShots[0];

  ctx.progress({ stage: 'building_prompt' });

  if (isMultiRefVideoModeEnabled()) {
    // P0: 用结构化的 FrameImageGenerationPlan 统一组织首帧输入。
    //   - prompt / 参考图清单 / 资产锁 / 模型能力快照都通过 plan 产出;
    //   - 为保持零行为变更, multiRefImageCap 仍强制为 1 (只传一张参考图),
    //     P3 升级多图时再把 cap 交给 provider 能力决定。
    const imgCfg = resolveLLMConfig(ctx.user, 'image');
    const plan = buildFrameImageGenerationPlan({
      project: proj,
      groupIdx,
      shotIndices,
      ownerId: ctx.user.id,
      frameType: 'first_frame',
      modelSnapshot: {
        provider: imgCfg.provider,
        model: imgCfg.model,
        baseUrl: imgCfg.baseUrl,
        quality: imgCfg.imageQuality || 'medium',
        multiRefImageCap: 1,
      },
    });
    const basePrompt = plan.finalPrompt;
    const imageRef = plan.referenceManifest.find((r) => r.delivery === 'image');
    const referenceImagePath = imageRef?.localPath;
    const planSummary = summarizePlanForAudit(plan);

    ctx.progress({
      stage: 'calling_image_api',
      shotCount: groupShots.length,
      mode: 'first_frame',
      hint: '调用图像 API 生成彩色视频首帧…',
    });
    const result = await generateImageWithModerationRecovery(ctx.user, {
      prompt: basePrompt,
      size: '1536x1024',
      style: 'photographic',
      kind: 'storyboard',
      projectId: ctx.projectId,
      assetRef: `storyboards[${groupIdx}].firstFrame`,
      quality: 'medium',
      referenceImagePath,
    });

    // P1: storyboards[g].frames.first 作为新的结构化对外容器, 与旧的 firstFrameUrl /
    // firstFramePrompt / firstFrameMode / firstFrameSafetyAudit / firstFramePlanSummary
    // 并行输出, 方便 P2 尾帧以同一形状落到 frames.tail。旧字段保留做兼容。
    const frameFirst = {
      url: result.url,
      prompt: result.submittedPrompt,
      originalPrompt: basePrompt,
      mode: 'structured_v1' as const,
      status: 'ready' as const,
      planSummary,
      safetyAudit: result.safetyAudit,
      visualAnchorDescription: result.visualAnchorDescription,
      generatedAt: nowIso(),
    };

    patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      while (storyboards.length <= groupIdx) storyboards.push({});
      const prev = storyboards[groupIdx] || {};
      const {
        videoUrl: _oldVideoUrl,
        videoTaskId: _oldVideoTaskId,
        videoDurationSec: _oldVideoDurationSec,
        videoCoverUrl: _oldVideoCoverUrl,
        videoStatus: _oldVideoStatus,
        videoMode: _oldVideoMode,
        videoTaskFinishedAt: _oldVideoTaskFinishedAt,
        ...prevWithoutVideo
      } = prev;
      storyboards[groupIdx] = {
        ...prevWithoutVideo,
        url: result.url,
        imageUrl: result.url,
        rawUrl: result.url,
        firstFrameUrl: result.url,
        firstFrame: {
          ...markFirstFrameReady(prev, result.url, result.url),
          safetyAudit: result.safetyAudit,
          visualAnchorDescription: result.visualAnchorDescription,
        },
        firstFramePrompt: result.submittedPrompt,
        firstFrameMode: 'structured_v1',
        firstFrameLastError: undefined,
        firstFrameFailedAt: undefined,
        debugSketchUrl: prev.debugSketchUrl || prev.pencilUrl,
        imagePrompt: result.submittedPrompt,
        originalFirstFramePrompt: basePrompt,
        firstFrameSafetyAudit: result.safetyAudit,
        effectiveVisualDescription: result.visualAnchorDescription,
        idx: groupIdx,
        shotIdx: firstShot?.idx ?? shotIndices[0] + 1,
        shotIndices,
        firstFramePlanSummary: planSummary,
        frames: { ...(prev.frames || {}), first: frameFirst },
      };
      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
      if (videoTasks.length > groupIdx) videoTasks[groupIdx] = {};
      return { storyboards, videoTasks };
    });

    return {
      resultUrl: result.url,
      patch: {
        type: 'storyboard_image',
        idx: groupIdx,
        url: result.url,
        imageUrl: result.url,
        rawUrl: result.url,
        firstFrameUrl: result.url,
        firstFrameMode: 'structured_v1',
        shotIndices,
        imagePrompt: result.submittedPrompt,
        firstFrameSafetyAudit: result.safetyAudit,
        firstFramePlanSummary: planSummary,
        frames: { first: frameFirst },
      },
      extra: {
        mode: result.mode,
        groupIdx,
        url: result.url,
        rawUrl: result.url,
        imageUrl: result.url,
        firstFrameUrl: result.url,
        firstFrameMode: 'structured_v1',
        shotIndices,
        imagePrompt: result.submittedPrompt,
        originalImagePrompt: basePrompt,
        imageSafetyAudit: result.safetyAudit,
        firstFramePlanSummary: planSummary,
        frames: { first: frameFirst },
        invalidateVideo: true,
      },
    };
  }

  // 单组 prompt 长度上限（中转站对超长 prompt 不稳定，1200 字符是安全线）
  const MAX_PROMPT_CHARS = 1200;
  // 把组内所有镜头压成精简描述：每段最多 350 字符
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  const promptSections: string[] = groupShots.map((sh: any, i: number) => {
    const idx = shotIndices[i] + 1;
    const _shotType = sh.shotType || sh.framing || '';
    const _camera = sh.camera || sh.movement || '';
    const englishPrompt = sanitizeFillLightPositiveMentions((sh.imagePrompt || '').trim());
    const _visual = sanitizeFillLightPositiveMentions(sh.visual || sh.description || sh.desc || '');
    const body = englishPrompt || _visual;
    const head = `Frame ${idx}` + (_shotType ? ` (${_shotType}${_camera ? ', ' + _camera : ''})` : '');
    return `${head}: ${truncate(body, 350)}`;
  });

  // 多镜头：让模型把它们画成一张多格分镜稿（panel grid）
  // 用户要求 layout 必须是 1×2（2 格）或 2×2（4 格），不要 3 格不规则布局。
  // 所以这里精确告诉模型 panel 数 + 排布方式，并放在 prompt 最前面让权重最高。
  const n = groupShots.length;
  let sheetIntro = '';
  if (n === 1) {
    sheetIntro = 'A SINGLE storyboard frame (NOT a multi-panel sheet) — one full image showing this single beat. ';
  } else if (n === 2) {
    sheetIntro = 'A TWO-PANEL storyboard sheet, layout = 1 row × 2 columns (left panel + right panel, evenly split, thin pencil-line border between panels). Panels are read LEFT to RIGHT in time order. ';
  } else if (n === 3) {
    // 上游分组算法已经基本不会输出 3，但万一冒出来 (用户手动 groupBoundary)，
    // 走 2x2 布局把第 4 格留空 / 收尾镜头，避免 1×3 难看。
    sheetIntro = 'A FOUR-PANEL storyboard sheet, layout = 2 rows × 2 columns (top-left, top-right, bottom-left, bottom-right, evenly sized, thin pencil-line borders between panels). Use the first 3 panels for the 3 shots in time order; the 4th (bottom-right) panel must be a recap close-up of the most important visual element from the previous 3 panels. ';
  } else if (n === 4) {
    sheetIntro = 'A FOUR-PANEL storyboard sheet, layout = 2 rows × 2 columns (top-left → top-right → bottom-left → bottom-right, evenly sized, thin pencil-line borders between panels). Panels are read in this Z-order in time. ';
  } else {
    sheetIntro = `A storyboard sheet with ${n} sequential panels showing different beats of the same scene. `;
  }
  let basePrompt = sanitizeFillLightPositiveMentions(sheetIntro + promptSections.join(' | '));
  if (basePrompt.length > MAX_PROMPT_CHARS) {
    basePrompt = basePrompt.slice(0, MAX_PROMPT_CHARS) + '…';
  }
  // 在末尾再加一段硬性 layout 约束，避免模型自由发挥成 1×3 或 3×1
  if (n > 1) {
    basePrompt += '\n\n=== LAYOUT LOCK (must follow) ===\n';
    if (n === 2) {
      basePrompt += 'EXACTLY 2 panels, side by side (1 row × 2 columns). NEVER stack vertically. NEVER split into 3 panels. NEVER add a tiny inset panel.\n';
    } else if (n === 3 || n === 4) {
      basePrompt += 'EXACTLY 4 panels in a 2×2 grid (top row 2 panels, bottom row 2 panels, all four panels evenly sized). NEVER 1×3, NEVER 3×1, NEVER 1×4, NEVER irregular layout.\n';
    }
    basePrompt += 'All panels share ONE consistent pencil-sketch line style; same character look across panels (same person = same face/clothes everywhere).';
  }

  // 非人/拟人角色保险丝：扫描这一组所有镜头，如果文本里出现任何拟人化的非人角色，
  // 在 prompt 末尾追加一条强约束，避免 gpt-image 把蟹/虾/三文鱼默认画成真人。
  try {
    const projChars: any[] = ((proj as any).assets?.characters || []) as any[];
    const nonHumanSpeciesUsed = new Set<string>();
    for (const sh of groupShots) {
      const text = sanitizeFillLightPositiveMentions([
        sh.imagePrompt || '',
        sh.visual || sh.description || sh.desc || '',
        Array.isArray(sh.characters) ? sh.characters.join(' ') : '',
      ].join(' '));
      for (const c of projChars) {
        if (c?.entityType !== 'non-human') continue;
        const nm = c.name || c.role;
        if (!nm) continue;
        if (text.includes(nm)) {
          const appearance = sanitizeFillLightPositiveMentions(c.appearance || c.description || '').slice(0, 120);
          nonHumanSpeciesUsed.add(`${nm} (${appearance || 'anthropomorphic creature, keep species body'})`);
        }
      }
    }
    if (nonHumanSpeciesUsed.size) {
      basePrompt +=
        '\n\n=== NON-HUMAN CHARACTER LOCK (must follow) ===\n' +
        'The following characters are anthropomorphic NON-HUMAN creatures and MUST be drawn with their actual species body (carapace / shell / fins / tentacles / pincers / etc.), NEVER as ordinary human workers in aprons:\n' +
        Array.from(nonHumanSpeciesUsed).map((s) => '- ' + s).join('\n') +
        '\nIf a panel shows a group of "employees / staff / union members" that includes any of the above, draw each one as its correct anthropomorphic species — DO NOT replace any of them with humans.' +
        // 体型约束：不能画成"巨型海鲜怪兽" / 与人类对比悬殊。
        // 用户反馈："海鲜个头太大了 不像正常海鲜那么大"——所以这里强制要求：
        //   · 拟人海鲜的总高度 ≈ 人类员工的肩膀高 - 头顶（即 0.6×~1.0× 人类身高）
        //   · 不能让蟹钳比人脸还大、蟹腿覆盖整个画面
        //   · 物种保留特征但比例服从"小员工"设定（拟人小怪 ≠ kaiju 巨兽）
        '\n\n=== NON-HUMAN CHARACTER SCALE LOCK (must follow) ===\n' +
        'These anthropomorphic seafood/animal characters are SMALL EMPLOYEE-SCALE creatures, NOT giant kaiju monsters:\n' +
        '- Total body height of each non-human character must be roughly the same as a real-world version of that species (a king crab ≈ 60-80cm tall standing on hind legs, a lobster ≈ 50-70cm, an oyster ≈ 20-30cm, a salmon ≈ 60-90cm), or at most up to a human worker\'s shoulder/chest height.\n' +
        '- They must NEVER tower over the human character — if a human boss is in the same frame, the human is the TALLEST figure.\n' +
        '- Pincers / claws / shells must be proportionate to the character\'s small size — a crab\'s pincer should NOT be bigger than a human face.\n' +
        '- They stand or pose at human-friendly scale (like small mascots / kitchen staff), NOT as monstrous giants.\n' +
        'If any non-human character ends up taller than a human character in the same frame, the image is REJECTED.';
    }
  } catch {}

  basePrompt = sanitizeFillLightPositiveMentions(basePrompt);

  ctx.progress({
    stage: 'calling_image_api',
    shotCount: groupShots.length,
    hint: `调用图像 API 中（gpt-image-1 单张约 30-60 秒）…`,
  });
  const result = await generateImageWithModerationRecovery(ctx.user, {
    prompt: basePrompt,
    size: '1536x1024', // 16:9 多格分镜
    style: 'pencil', // 手稿风格
    kind: 'storyboard',
    projectId: ctx.projectId,
    assetRef: `storyboards[${groupIdx}]`,
    // 多格分镜把面部 / 道具 / 透视都压在一张图里，low 画质会糊脸
    quality: 'medium',
  });

  // 写回 project.storyboards[groupIdx]：注意 imageUrl + url 都写，前端两边都会读
  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    while (storyboards.length <= groupIdx) storyboards.push({});
    const prev = storyboards[groupIdx] || {};
    const prevFirstFrame = normalizeFirstFrameState(prev);
    const at = new Date().toISOString();
    storyboards[groupIdx] = {
      ...prev,
      url: result.url,
      imageUrl: result.url,
      rawUrl: result.url,
      pencilUrl: result.url,
      firstFrameUrl: result.url,
      firstFrameMode: 'legacy_pencil',
      firstFrame: {
        currentUrl: result.url,
        rawUrl: result.url,
        status: 'legacy_sketch_only',
        source: 'generated',
        lastKnownGoodUrl: result.url,
        lastError: undefined,
        history: [
          { url: result.url, at, source: 'generated' as const },
          ...prevFirstFrame.history.filter((item) => item.url !== result.url),
        ].slice(0, 20),
        safetyAudit: result.safetyAudit,
        visualAnchorDescription: result.visualAnchorDescription,
      },
      imagePrompt: result.submittedPrompt,
      originalImagePrompt: basePrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
      firstFrameLastError: undefined,
      firstFrameFailedAt: undefined,
      idx: groupIdx,
      shotIdx: firstShot?.idx ?? shotIndices[0] + 1,
      shotIndices,
    };
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    if (videoTasks.length > groupIdx) videoTasks[groupIdx] = {};
    return { storyboards, videoTasks };
  });

  return {
    resultUrl: result.url,
    patch: {
      type: 'storyboard_image',
      idx: groupIdx,
      url: result.url,
      pencilUrl: result.url,
      imageUrl: result.url,
      rawUrl: result.url,
      firstFrameUrl: result.url,
      firstFrameMode: 'legacy_pencil',
      firstFrameStatus: 'legacy_sketch_only',
    },
    extra: {
      mode: result.mode,
      groupIdx,
      url: result.url,
      rawUrl: result.url,
      imageUrl: result.url,
      firstFrameUrl: result.url,
      firstFrameMode: 'legacy_pencil',
      firstFrameStatus: 'legacy_sketch_only',
      imagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      invalidateVideo: true,
    },
  };
});

/* ============================================================
   3.5 tail_frame_images executor —— 给每个分镜组生成彩色视频尾帧
   ============================================================ */
registerExecutor('tail_frame_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const shots = (proj as any).shots || [];

  let shotIndices: number[] =
    Array.isArray(ctx.target.shotIndices) && ctx.target.shotIndices.length
      ? ctx.target.shotIndices.filter((i: any) => typeof i === 'number')
      : [groupIdx];
  shotIndices = shotIndices.filter((i) => i >= 0 && i < shots.length);
  if (!shotIndices.length) {
    throw new Error(`分组 #${groupIdx} 没有对应的镜头数据`);
  }

  // Preflight: 本片段首帧必须已就绪 + 模式是彩色视频首帧, legacy_pencil 手稿图不可做尾帧锚。
  const storyboards = (proj as any).storyboards || [];
  const sb = storyboards[groupIdx] || {};
  const preflightErr = checkTailFramePreflight(sb);
  if (preflightErr) {
    throw new Error(formatTailFramePreflightError(groupIdx, preflightErr));
  }
  const firstFrameUrl: string =
    sb.firstFrameUrl || sb.frames?.first?.url || sb.firstFrame?.currentUrl;

  // 首帧图的本地路径; 无法解析时降级为 text_only 锚 (plan 会标 droppedReason='unresolvable')。
  const selfFirstFrameLocal = resolveLocalImagePath(firstFrameUrl, ctx.user.id) || undefined;
  if (!selfFirstFrameLocal) {
    throw errorWithRecoveryHint(
      '首帧图片文件不可解析，无法生成尾帧。',
      'first_frame_file_unresolvable',
      '请重新生成首帧，或点击“上传”重新上传一张首帧图后，再生成尾帧。',
    );
  }

  ctx.progress({ stage: 'building_prompt' });

  const imgCfg = resolveLLMConfig(ctx.user, 'image');
  const plan = buildFrameImageGenerationPlan({
    project: proj,
    groupIdx,
    shotIndices,
    ownerId: ctx.user.id,
    frameType: 'tail_frame',
    modelSnapshot: {
      provider: imgCfg.provider,
      model: imgCfg.model,
      baseUrl: imgCfg.baseUrl,
      quality: imgCfg.imageQuality || 'medium',
      multiRefImageCap: 1,
    },
    selfFirstFrame: {
      remoteUrl: firstFrameUrl,
      localPath: selfFirstFrameLocal,
    },
  });

  const basePrompt = plan.finalPrompt;
  const imageRef = plan.referenceManifest.find((r) => r.delivery === 'image');
  const referenceImagePath = imageRef?.localPath;
  const planSummary = summarizePlanForAudit(plan);

  ctx.progress({
    stage: 'calling_image_api',
    shotCount: shotIndices.length,
    mode: 'tail_frame',
    hint: '调用图像 API 生成彩色视频尾帧…',
  });

  const result = await generateImageWithModerationRecovery(ctx.user, {
    prompt: basePrompt,
    size: '1536x1024',
    style: 'photographic',
    kind: 'storyboard',
    projectId: ctx.projectId,
    assetRef: `storyboards[${groupIdx}].tailFrame`,
    quality: 'medium',
    referenceImagePath,
  });

  const frameTail = {
    url: result.url,
    prompt: result.submittedPrompt,
    originalPrompt: basePrompt,
    mode: 'structured_v1' as const,
    status: 'ready' as const,
    planSummary,
    safetyAudit: result.safetyAudit,
    visualAnchorDescription: result.visualAnchorDescription,
    generatedAt: nowIso(),
  };

  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const sbs = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    while (sbs.length <= groupIdx) sbs.push({});
    const prev = sbs[groupIdx] || {};
    sbs[groupIdx] = {
      ...prev,
      tailFrameUrl: result.url,
      tailFramePrompt: result.submittedPrompt,
      originalTailFramePrompt: basePrompt,
      tailFrameMode: 'structured_v1',
      tailFrameSafetyAudit: result.safetyAudit,
      tailFramePlanSummary: planSummary,
      tailFrameLastError: undefined,
      tailFrameFailedAt: undefined,
      frames: { ...(prev.frames || {}), tail: frameTail },
    };
    return { storyboards: sbs };
  });

  return {
    resultUrl: result.url,
    patch: {
      type: 'tail_frame_image',
      idx: groupIdx,
      url: result.url,
      tailFrameUrl: result.url,
      tailFrameMode: 'structured_v1',
      shotIndices,
      tailFramePrompt: result.submittedPrompt,
      tailFrameSafetyAudit: result.safetyAudit,
      tailFramePlanSummary: planSummary,
      frames: { tail: frameTail },
    },
    extra: {
      mode: result.mode,
      groupIdx,
      url: result.url,
      tailFrameUrl: result.url,
      tailFrameMode: 'structured_v1',
      shotIndices,
      tailFramePrompt: result.submittedPrompt,
      originalTailFramePrompt: basePrompt,
      tailFrameSafetyAudit: result.safetyAudit,
      tailFramePlanSummary: planSummary,
      frames: { tail: frameTail },
    },
  };
});

/* ============================================================
   4. video_segments executor —— 给每个分镜组生成视频片段
   ============================================================ */
registerExecutor('video_segments', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? ctx.seq;
  const storyboards = (proj as any).storyboards || [];
  const sb = storyboards[groupIdx];
  if (!sb) throw new Error(`找不到 storyboards[${groupIdx}]`);
	  const promptReadiness = assertVideoPromptReadyForGroups(proj as any, [groupIdx]);
	  if (!promptReadiness.ok) {
	    const blocked = promptReadiness.blocked[0];
	    throw errorWithFailureStage(
	      `片段 ${groupIdx + 1} 视频提示词未就绪（${blocked?.reason || 'not_ready'}），` +
	        `已阻止视频生成。请先重新生成并确认该片段的视频提示词。`,
	      'preflight_video_prompt_not_ready',
	    );
	  }

  // 提示词来源优先：sb.videoPrompt（视频提示词页生成的）→ shot.imagePrompt → shot.visual
  const shots = (proj as any).shots || [];
  const shot = shots[groupIdx] || {};
  const _shotVisual = shot.visual || shot.description || shot.desc || '';
  let videoPromptSource: VideoGenerationPlan['promptAudit']['sourcePrompt']['source'] = sb.videoPrompt
    ? 'storyboard.videoPrompt'
    : (sb.firstFramePrompt || sb.imagePrompt || shot.imagePrompt)
      ? 'shot.imagePrompt'
      : 'shot.visual';
  let prompt =
    sb.videoPrompt ||
    sb.firstFramePrompt ||
    sb.imagePrompt ||
    shot.imagePrompt ||
    _shotVisual ||
    `Video segment for shot ${groupIdx + 1}`;

  // 收集本组所有 shot（按情绪段切分后的真实镜头索引）。
  // 优先级：
  //   1) ctx.target.shotIndices（前端最新分组，一定是正确的）
  //   2) sb.shotIndices（DB 缓存，老 storyboards 没存所以可能空）
  //   3) [groupIdx]（兜底，仅在没分组信息时用——会导致台词错位但不至于崩）
  let groupShotIndices: number[] = [];
  const tgtSi = (ctx.target as any).shotIndices;
  if (Array.isArray(tgtSi) && tgtSi.length) {
    groupShotIndices = tgtSi.filter((x: any) => Number.isInteger(x));
  } else if (Array.isArray(sb.shotIndices) && sb.shotIndices.length) {
    groupShotIndices = sb.shotIndices;
  } else if (sb.videoPrompt) {
    // 已经有视频提示词时（由 video_prompts 生成），prompt 已自包含台词信息，
    // 即使没有 shotIndices 也不会走错台词——只用 [groupIdx] 做兜底就行。
    groupShotIndices = [groupIdx];
    console.warn(
      `[video_segments] group ${groupIdx} 缺 shotIndices，但 videoPrompt 存在，兜底用 [${groupIdx}]`,
    );
  } else {
    // 既没有分组索引，又没有 sb.videoPrompt ——这种情况强行兜底到 shots[groupIdx]
    // 会用错误 shot 的台词和视觉，浪费视频生成额度（audit 原话）。直接抛错让用户重新生成提示词页。
    throw new Error(
      `group ${groupIdx} 分组索引丢失且缺 videoPrompt，请回到"视频提示词"页重新生成后再来这一步`,
    );
  }
	  if (!sb.videoPrompt) {
	    const firstGroupShot = shots[groupShotIndices[0]] || shot || {};
	    const firstGroupVisual = firstGroupShot.visual || firstGroupShot.description || firstGroupShot.desc || '';
	    videoPromptSource = (sb.firstFramePrompt || sb.imagePrompt || firstGroupShot.videoPrompt || firstGroupShot.imagePrompt)
	      ? 'shot.imagePrompt'
	      : 'shot.visual';
	    prompt =
      sb.firstFramePrompt ||
      sb.imagePrompt ||
      firstGroupShot.videoPrompt ||
      firstGroupShot.imagePrompt ||
	      firstGroupVisual ||
	      prompt;
	  }
	  const sanitizedFor: string[] = [];
	  const promptBeforeSanitize = prompt;
		  prompt = sanitizeFillLightPositiveMentions(prompt);
	  if (prompt !== promptBeforeSanitize) sanitizedFor.push('fill_light_positive');

  const groupShotsForPlan = groupShotIndices.map((si) => shots[si]).filter(Boolean);
  const plannedDurationSec = plannedDurationFromShots(groupShotsForPlan);
  const videoCfg = resolveLLMConfig(ctx.user, 'video');
  const videoCfgIsGrok = /^grok-video/i.test(videoCfg.model || '');
  const videoCfgIsVolcano =
    /volces\.com|volcengine|ark\.cn-/i.test(videoCfg.baseUrl || '') ||
    /seedance|doubao/i.test(videoCfg.model || '');

  // durationSec 是给视频模型的请求时长：源头来自镜头表计划时长，只做模型固定时长/
  // 供应商最小时长适配，不再按台词字数压到 5s / 10s 档位。
  const durationSec = resolveGenerationDurationSec({
    plannedDurationSec,
    model: videoCfg.model,
    baseUrl: videoCfg.baseUrl,
    minDurationSec: videoCfg.minDurationSec,
  });

  // 收集本组所有 shot 的台词（dialogue / scriptRef），强制传给视频模型
  // —— 视频提示词页 LLM 经常把对话遗漏/改写，这里直接从源头数据拿。
  //
  // 用户反馈："角色说词的时候有把自己名字念出来的 比如老板 明天翻倍"——
  // shot.dialogue 在 DB 里存的是 "老板：'明天目标，客单翻倍。'" 这种
  // "说话人：内容" 格式，直接当台词送 Seedance，模型把"老板"也读出来了。
  // 这里拆成 { speaker, text }：speaker 给 video-gen 当"指定说话人"元信息
  // （用于选音色/口型），text 才是实际念出来的台词。
  const dialoguePairs: Array<{ speaker: string; text: string }> = [];
  // 按"角色名："anchor 切：先用 RegExp.exec 收集所有 speaker 出现位置，
  // 然后取每两个 speaker 之间的内容作为 text（最后一个 speaker 取到 raw 末尾）。
  // 旧的"一个大正则一次匹配整段"写法在多句对白里只会匹配最后一句（lookahead lazy bug）。
  function parseDialogue(raw: string): Array<{ speaker: string; text: string }> {
    if (!raw) return [];
    // 角色名 = 最多 24 个非冒号/空白/引号的字符（涵盖中英文、长称谓）。
    // 字符类用 \u 转义去重：之前字面量引号在多次保存后被规范成 ASCII 引号重复塞进去，
    // 实际只排除了一两种引号，且 12 字符上限对"XX帝王蟹队长长官大人"之类的长称谓会掉。
    const SPEAKER_RE = /([^：:\s“”‘’"'「」『』]{1,24})[：:]/g;
    const anchors: Array<{ speaker: string; textStart: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = SPEAKER_RE.exec(raw)) !== null) {
      anchors.push({ speaker: m[1].trim(), textStart: m.index + m[0].length });
    }
    if (anchors.length === 0) {
      // 没识别出"角色:" 模式，整段作为旁白
      return [{ speaker: '', text: raw.trim() }];
    }
    const pairs: Array<{ speaker: string; text: string }> = [];
    for (let i = 0; i < anchors.length; i++) {
      const cur = anchors[i];
      // 下一个 speaker 在 raw 里的起始位置 = 它的 anchor 字符串前
      const nextStart =
        i + 1 < anchors.length
          ? // 下一个 anchor 的"角色名+冒号"在原文里的起始位置
            anchors[i + 1].textStart - anchors[i + 1].speaker.length - 1
          : raw.length;
      let text = raw.slice(cur.textStart, nextStart).trim();
      // 去除首尾的引号 / 全角引号
      text = text
        .replace(/^[「『""''""''『]+/, '')
        .replace(/[」』""''""''』]+$/, '')
        .trim();
      if (text) pairs.push({ speaker: cur.speaker, text });
    }
    return pairs;
  }
  for (const si of groupShotIndices) {
    const sh = shots[si];
    if (!sh) continue;
    const raw = String(sh.dialogue || sh.scriptRef || '').trim();
    if (!raw || raw === '——' || raw === '-' || raw === '无') continue;
    const parsed = parseDialogue(raw);
    for (const p of parsed) dialoguePairs.push(p);
  }
  // 注意：用户明确要求"台词一个字都不能少"，这里不做任何截断/改写/压缩。
  // 台词字数只用于质量提醒，不再反向决定视频时长。
  const dialogueCharSum = cleanDialogueCharCount(dialoguePairs);
  const dialogueBudget = evaluateDialogueBudget(dialogueCharSum, plannedDurationSec);
  const dialogueWarning = dialogueBudget.level === 'soft_warning'
    ? {
        key: 'dialogue_budget_warning',
        level: 'warn',
        message: dialogueBudget.message || `本组台词 ${dialogueCharSum} 字，可能语速偏快。`,
        dialogueChars: dialogueCharSum,
        durationSec,
      }
    : null;
  const videoWarnings: any[] = [dialogueWarning].filter(Boolean);
  console.log(
    `[video_segments] group ${groupIdx} 计划 ${plannedDurationSec}s，台词 ${dialogueCharSum} 字 → ` +
      `请求 ${durationSec}s 视频（${dialoguePairs.length} 句台词）` +
      (dialogueWarning ? `；${dialogueWarning.message}` : ''),
  );

  // 前端 batchOpts.ratio：'16:9' / '9:16' / '1:1' / '21:9' / '4:3' / '3:4'
  const userRatio = (ctx.options?.ratio as string) || '16:9';

  // 用户反馈："前面有场景彩色图和人物角色彩色图，不能单一参考分镜图"
  // —— 之前只把黑白分镜草图当 i2v 主参考，前面"资产"步骤生成的彩色场景图和
  // 角色三视图全没传过来，等于让视频模型基于黑白调凭空想象彩色画面。
  //
  // 这里把整条工作流串起来：
  //   1) 分镜草图 (storyboardPath)：给镜头构图/景别参考
  //   2) **彩色场景图 (sceneReferencePath)**：定环境、色调、光照、材质
  //   3) **彩色角色图 (characterReferencePaths[])**：定角色外形、服装、物种
  // video-gen 会把三者合成成一张"视觉圣经参考图"再送 Seedance。

  // ① 视频主参考图本地路径
  // 新模式：firstFrameUrl 是彩色视频首帧，作为 i2v 主参考。
  // 旧模式/旧项目：继续使用原 storyboard 黑白草图，保证可回退。
  const multiRefMode = isMultiRefVideoModeEnabled();
  const independentMultiImageMode = multiRefMode && isIndependentMultiImageModeEnabled();
  const resolvedFirstFrameUrl = resolveStoryboardFirstFrameUrl(sb);
  const hasFirstFrame = !!resolvedFirstFrameUrl;
  console.log(
    `[video_segments] group ${groupIdx} flags: ` +
      `multiRef=${multiRefMode} independentMultiImage=${independentMultiImageMode} ` +
      `hasFirstFrame=${hasFirstFrame} envIndependent=${String(process.env.ORIGIN_INDEPENDENT_MULTI_IMAGE_MODE || '') || 'default'}`,
	  );
	  if (independentMultiImageMode && !hasFirstFrame) {
	    throw errorWithFailureStage(
	      `片段 ${groupIdx + 1} 缺少彩色首帧 firstFrameUrl，已阻止视频生成。` +
	        `请先在分镜/首帧环节重新生成该片段，再生成视频。`,
	      'preflight_missing_first_frame',
	    );
	  }
  let referenceImagePath: string | undefined;
  const sbImageUrl: string = hasFirstFrame
    ? resolvedFirstFrameUrl
    : (sb.rawUrl || sb.url || sb.imageUrl || '');
  const sbMatch = /\/api\/images\/file\/([0-9a-f-]{36})/.exec(sbImageUrl);
  if (sbMatch) {
    referenceImagePath = `${process.cwd()}/data/images/${ctx.user.id}/${sbMatch[1]}.png`;
  }
	  const referenceImageRole: 'first_frame' | 'storyboard_sketch' = multiRefMode && hasFirstFrame ? 'first_frame' : 'storyboard_sketch';
  let storyboardReferencePath: string | undefined;
  if (referenceImageRole === 'first_frame') {
    const sketchUrl = sb.debugSketchUrl || sb.pencilUrl || '';
    const sketchMatch = /\/api\/images\/file\/([0-9a-f-]{36})/.exec(sketchUrl);
    if (sketchMatch) {
      storyboardReferencePath = `${process.cwd()}/data/images/${ctx.user.id}/${sketchMatch[1]}.png`;
    }
  }

  let sceneReferencePath: string | undefined;
  let sceneReferenceLabel = '';
  let sceneReferenceHint = '';

  const allChars: any[] = [
    ...((proj as any).assets?.characters || []),
    ...((proj as any).characters || []),
  ];
  const charNames = new Set<string>();
  for (const si of groupShotIndices) {
    const sh = shots[si];
    if (Array.isArray(sh?.characters)) {
      for (const cn of sh.characters) {
        if (typeof cn === 'string' && cn.trim()) charNames.add(cn.trim());
      }
    }
  }
  let characterReferencePaths: string[] = [];
  let characterReferencePanels: CharacterReferencePanel[] = [];
  let propReferencePaths: string[] = [];

  const referenceImages: VideoReferenceImage[] = [];
  const addReferenceImage = (ref: VideoReferenceImage) => {
    if (!independentMultiImageMode || !ref.path) return;
    if (referenceImages.some((item) => item.path === ref.path)) return;
    if (referenceImages.length >= 4) return;
    referenceImages.push(ref);
  };

  const canonicalRefs = buildVideoReferenceManifest({
    project: proj,
    assets: (proj as any).assets || {},
    shots,
    groupShotIndices,
    groupIdx,
    ownerId: ctx.user.id,
    storyboardImageUrl: sbImageUrl || null,
  });
  const persistedManifest = Array.isArray(sb.videoReferenceManifest) ? sb.videoReferenceManifest : [];
  const manifestChanged = persistedManifest.length > 0 && manifestsDiffer(persistedManifest, canonicalRefs.manifest);
  if (persistedManifest.length === 0 && canonicalRefs.manifest.length > 0) {
    videoWarnings.push({
      key: 'reference_manifest_rebuilt_in_executor',
      level: 'info',
      message: '该片段无视频提示词阶段持久化的参考图清单，已按当前项目资产重建 canonical manifest。',
    });
  }
  if (manifestChanged) {
    console.warn(`[video_segments] group ${groupIdx} reference manifest changed between video prompt and video generation`);
    videoWarnings.push({
      key: 'manifest_changed_between_prompt_and_video',
      level: 'warn',
      message: '视频提示词阶段看到的参考图清单与本次视频生成实际参考图不同，已使用最新首帧/资产重新生成 canonical manifest。',
    });
  }

  const firstFrameItem = canonicalRefs.manifest.find((ref) => ref.role === 'first_frame' && ref.localPath);
  if (firstFrameItem?.localPath) referenceImagePath = firstFrameItem.localPath;
  const sceneItem = canonicalRefs.manifest.find((ref) => ref.role === 'scene' && ref.localPath);
  sceneReferencePath = sceneItem?.localPath || undefined;
  sceneReferenceLabel = sceneItem?.assetName || sceneItem?.label || sceneReferenceLabel;
  sceneReferenceHint = sceneItem?.promptHint || sceneReferenceHint;
  characterReferencePaths = canonicalRefs.manifest
    .filter((ref) => ref.role === 'character' && ref.localPath)
    .map((ref) => ref.localPath as string);
  characterReferencePanels = canonicalRefs.manifest
    .filter((ref) => ref.role === 'character' && ref.localPath && ref.panelInfo)
    .map((ref: any) => ({
      characterName: ref.assetName || ref.label,
      panel: ref.panelInfo.panel,
      path: ref.localPath,
      intent: ref.panelInfo.intent,
      priority: Number(ref.score || ref.priority || 0),
      reason: ref.matchReason || `manifest:${ref.panelInfo.panel}`,
    }));
  propReferencePaths = canonicalRefs.manifest
    .filter((ref) => ref.role === 'prop' && ref.localPath)
    .map((ref) => ref.localPath as string);

  referenceImages.length = 0;
  for (const ref of canonicalRefs.manifest) {
    if (!ref.localPath) continue;
    addReferenceImage({
      role: ref.role,
      path: ref.localPath,
      sourceUrl: ref.url,
      assetId: ref.assetId,
      assetName: ref.assetName,
      label: ref.label,
      promptHint: ref.promptHint,
      priority: ref.priority || ref.score,
    });
  }

  const segmentGate = validateCharacterConsistencyForGroup(proj as any, {
    groupIdx,
    shotIndices: groupShotIndices,
    target: 'videoSegment',
  });
  if (!segmentGate.allowed) {
    throw errorWithFailureStage(
      `片段 ${groupIdx + 1} 角色一致性未通过：${segmentGate.blockers.map((b) => b.message).join('；')}`,
      'preflight_video_prompt_not_ready',
    );
  }

  // ===== 角色一致性主档（跨片段保持形象、表演和声音一致） =====
  const characterLockContextText = [
    prompt,
    ...groupShotIndices.map((si) => {
      const sh = shots[si] || {};
      return [
        sh.characters,
        sh.speaker,
        sh.visual,
        sh.description,
        sh.desc,
        sh.dialogue,
        sh.scriptRef,
        sh.keyInfo,
      ].flat().filter(Boolean).join(' ');
    }),
  ].join('\n');
  const characterLockRoster = buildCharacterLockRoster(proj as any, charNames, 'zh', characterLockContextText);
  const characterLockBlockHash = characterLockRoster ? hashString(characterLockRoster) : undefined;

  // ===== 前后片段衔接信息（避免镜头硬切 / 角色姿态突变） =====
  // 用户反馈："有些镜头前后连不上 因为每条是独立生成的"——这里把上一组终幅
  // 镜头的 visual 描述、本组首幅、下一组首幅都简短摘出来给模型，让 Seedance
  // 能"知道镜头衔接到哪里来 / 要去哪里"。
  const allSb: any[] = (proj as any).storyboards || [];
  const _summarizeShot = (sh: any): string => {
    if (!sh) return '';
    const st = sh.shotType ? `【${sh.shotType}】` : '';
    const cm = sh.camera ? `【${sh.camera}】` : '';
	    const v = sanitizeFillLightPositiveMentions(String(sh.visual || sh.description || '')).slice(0, 120);
    return `${st}${cm}${v}`.trim();
  };
  const _firstShotIdxOf = (gi: number): number | null => {
    const t = allSb[gi];
    if (!t) return null;
    if (Array.isArray(t.shotIndices) && t.shotIndices.length) return t.shotIndices[0];
    return gi; // 兜底
  };
  const _lastShotIdxOf = (gi: number): number | null => {
    const t = allSb[gi];
    if (!t) return null;
    if (Array.isArray(t.shotIndices) && t.shotIndices.length) {
      return t.shotIndices[t.shotIndices.length - 1];
    }
    return gi;
  };
  let prevTailSummary = '';
  let nextHeadSummary = '';
  if (groupIdx > 0) {
    const prevLastIdx = _lastShotIdxOf(groupIdx - 1);
    if (prevLastIdx != null) prevTailSummary = _summarizeShot(shots[prevLastIdx]);
  }
  if (groupIdx < allSb.length - 1) {
    const nextFirstIdx = _firstShotIdxOf(groupIdx + 1);
    if (nextFirstIdx != null) nextHeadSummary = _summarizeShot(shots[nextFirstIdx]);
  }
  let projectConstraintText = '';
  try {
    projectConstraintText = JSON.stringify({
      assets: (proj as any).assets || {},
      characters: (proj as any).characters || [],
      environments: (proj as any).environments || [],
      styleBible: (proj as any).styleBible || {},
    }).slice(0, 18000);
  } catch {}
  const beforeConstraintPrompt = prompt;
  prompt = enforceHardVisualConstraints(
    prompt,
    [
      beforeConstraintPrompt,
      projectConstraintText,
      ...groupShotIndices.map((si) => {
        const sh = shots[si];
        return [
          sh?.visual,
          sh?.description,
          sh?.desc,
          sh?.dialogue,
          sh?.scriptRef,
          sh?.keyInfo,
          sh?.location,
          sh?.scene,
        ].filter(Boolean).join(' ');
      }),
    ].join('\n'),
  );
	  if (prompt !== beforeConstraintPrompt) {
	    sanitizedFor.push('no_fill_light_constraint_enforced');
	    console.log(`[video_segments] group ${groupIdx} applied hard constraint: no fill lights`);
	  }

  console.log(
    `[video_segments] group ${groupIdx} refs: scene=${!!sceneReferencePath} ` +
      `panels=${characterReferencePanels.length} chars=${characterReferencePaths.length} sb=${!!referenceImagePath} ` +
      `props=${propReferencePaths.length} refRole=${referenceImageRole} ` +
      `independentRefs=${referenceImages.length} ` +
      `dialoguePairs=${dialoguePairs.length} prev=${!!prevTailSummary} next=${!!nextHeadSummary}`,
  );

		  const firstVideoWarning = dialogueWarning;
		  if (firstVideoWarning) {
		    ctx.progress({
		      stage: 'quality_warning',
		      durationSec,
		      plannedDurationSec,
		      warning: firstVideoWarning,
		      videoWarnings,
		      hint: firstVideoWarning.message,
		    });
		  }

  const videoInput = {
    prompt,
    ratio: userRatio,
    durationSec,
    projectId: ctx.projectId,
    groupIdx,
	    dialoguePairs,
	    characterLockRoster: characterLockRoster || undefined,
    prevTailSummary: prevTailSummary || undefined,
    nextHeadSummary: nextHeadSummary || undefined,
    referenceImagePath,
    referenceImageRole,
    storyboardReferencePath,
    sceneReferencePath,
    characterReferencePaths,
    characterReferencePanels,
    propReferencePaths,
    referenceImages: independentMultiImageMode ? referenceImages : undefined,
  };
	  const plannedFinalPrompt = videoCfgIsVolcano
    ? buildSeedancePromptParts(videoInput).finalPrompt
    : prompt;
  let videoPlan: VideoGenerationPlan = buildVideoPlanSnapshot({
    projectId: ctx.projectId,
    groupIdx,
    groupShotIndices,
    videoPromptSource,
    sanitizedFor,
    finalPrompt: {
      preview: plannedFinalPrompt.slice(0, 500),
      hash: hashString(plannedFinalPrompt),
      length: plannedFinalPrompt.length,
    },
    dialoguePolicy: 'budget_check_only',
    references: planReferencesFromManifest(canonicalRefs.manifest),
    droppedReferences: [
      ...(Array.isArray(sb.videoReferenceDropped) ? sb.videoReferenceDropped : []),
      ...canonicalRefs.droppedReferences,
    ],
    prompt,
	    userRatio,
	    durationSec,
	    plannedDurationSec,
	    videoWarnings,
    dialogueChars: cleanDialogueCharCount(dialoguePairs),
    status: 'submitting',
    modelSnapshot: {
      modelRole: 'video',
      provider: videoCfg.provider || (videoCfgIsGrok ? 'grok' : videoCfgIsVolcano ? 'seedance' : videoCfg.mode),
      model: videoCfg.model,
      filledAfterCall: false,
    },
  });

  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    while (videoTasks.length <= groupIdx) videoTasks.push({});
	    videoTasks[groupIdx] = {
	      ...(videoTasks[groupIdx] || {}),
	      groupIdx,
		      status: 'submitting',
		      prompt,
		      durationSec,
		      plannedDurationSec,
		      warnings: videoWarnings,
	      videoPlan,
	      consistency: {
	        ...((videoTasks[groupIdx] || {}).consistency || {}),
	        videoSegment: {
	          ...(((videoTasks[groupIdx] || {}).consistency || {}).videoSegment || {}),
	          characterLockBlockHash,
	          characterUsages: segmentGate.characterUsages,
	          score: segmentGate.score,
	          level: segmentGate.level,
	          warnings: segmentGate.warnings,
	        },
	      },
	      isCurrent: true,
	    };
    return { videoTasks };
  });

	  ctx.progress({ stage: 'submitting', durationSec, plannedDurationSec, videoWarnings });

		  let result;
		  try {
		    result = await generateVideo(
		      ctx.user,
		      videoInput,
		      (pct, hint) => ctx.progress({ stage: 'gen', pct, hint }),
		    );
		  } catch (e: any) {
		    const vgErr = e instanceof VideoGenerationError ? e : null;
		    const failureStage: VideoPromptFailureStage = vgErr?.failureStage || classifyVideoFailureStage(e);
		    const failureAudit = vgErr?.videoAudit;
		    const errMsg = e?.message || String(e);
		    const failureReferences = failureAudit?.referenceImages?.length
		      ? planReferencesFromAuditRefs(failureAudit.referenceImages)
		      : videoPlan.references;
		    videoPlan = buildVideoPlanSnapshot({
		      projectId: ctx.projectId,
		      groupIdx,
		      groupShotIndices,
		      videoPromptSource,
		      sanitizedFor,
		      finalPrompt: {
		        preview: failureAudit?.finalPromptPreview || videoPlan.promptAudit.finalPrompt.preview,
		        hash: failureAudit?.finalPromptHash || videoPlan.promptAudit.finalPrompt.hash,
		        length: failureAudit?.finalPromptLength || videoPlan.promptAudit.finalPrompt.length,
		      },
		      dialoguePolicy: failureAudit?.dialoguePolicy || 'budget_check_only',
		      dialoguePolicyNotes: failureAudit?.dialoguePolicyNotes,
		      references: failureReferences,
		      droppedReferences: videoPlan.droppedReferences,
		      prompt,
			      userRatio,
			      durationSec,
			      plannedDurationSec,
			      videoWarnings: [
		        ...videoWarnings,
		        ...(failureAudit?.fallbackReason ? [{ message: `reference fallback: ${failureAudit.fallbackReason}` }] : []),
		      ],
		      dialogueChars: cleanDialogueCharCount(dialoguePairs),
		      status: 'failed',
		      failureStage,
		      errorMsg: errMsg.slice(0, 500),
		      modelSnapshot: {
		        modelRole: 'video',
		        provider: failureAudit?.provider || videoPlan.modelSnapshot?.provider,
		        model: failureAudit?.model || videoPlan.modelSnapshot?.model,
		        providerTaskId: failureAudit?.providerTaskId,
		        filledAfterCall: !!failureAudit,
		      },
		    });
		    patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
		      if (!fresh) return null;
		      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
		      while (videoTasks.length <= groupIdx) videoTasks.push({});
		      videoTasks[groupIdx] = {
		        ...(videoTasks[groupIdx] || {}),
		        groupIdx,
		        taskId: vgErr?.taskId || videoTasks[groupIdx]?.taskId,
			        status: 'failed',
			        errorMsg: errMsg.slice(0, 500),
			        durationSec,
			        plannedDurationSec,
			        prompt,
		        warnings: videoWarnings,
		        videoPlan,
		        isCurrent: true,
		      };
		      return { videoTasks };
		    });
		    throw e;
		  }

		  const dialoguePolicy: DialoguePolicy = result.videoAudit?.dialoguePolicy || 'budget_check_only';
		  const actualAuditRefs = result.videoAudit?.referenceImages || [];
		  const sentPaths = new Set(actualAuditRefs.map((ref) => ref.path).filter(Boolean));
		  const planReferences: ReferenceManifestItem[] = actualAuditRefs.length
		    ? planReferencesFromAuditRefs(actualAuditRefs)
		    : planReferencesFromManifest(canonicalRefs.manifest);
		  videoPlan = buildVideoPlanSnapshot({
		    projectId: ctx.projectId,
		    groupIdx,
		    groupShotIndices,
		    videoPromptSource,
		    sanitizedFor,
		    finalPrompt: {
		      preview: result.videoAudit?.finalPromptPreview || plannedFinalPrompt.slice(0, 500),
		      hash: result.videoAudit?.finalPromptHash || hashString(plannedFinalPrompt),
		      length: result.videoAudit?.finalPromptLength || plannedFinalPrompt.length,
		    },
		    dialoguePolicy,
		    dialoguePolicyNotes: result.videoAudit?.dialoguePolicyNotes,
		    references: planReferences,
		    droppedReferences: [
		      ...(Array.isArray(sb.videoReferenceDropped) ? sb.videoReferenceDropped : []),
		      ...canonicalRefs.droppedReferences,
		      ...referenceImages
		        .filter((ref) => isPlanReferenceRole(ref.role) && ref.role !== 'first_frame' && ref.path && !sentPaths.has(ref.path))
		        .map((ref) => ({
		          role: ref.role as Exclude<VideoReferenceRole, 'first_frame'>,
		          assetName: ref.assetName || ref.label,
		          reason: 'filtered_constraint' as const,
		        })),
		    ],
			    prompt,
			    userRatio,
			    durationSec: result.durationSec,
			    plannedDurationSec,
			    videoWarnings: [
		      ...videoWarnings,
		      ...(result.videoAudit?.fallbackReason ? [{ message: `reference fallback: ${result.videoAudit.fallbackReason}` }] : []),
		    ],
		    dialogueChars: cleanDialogueCharCount(dialoguePairs),
		    status: 'completed',
		    modelSnapshot: result.videoAudit
		      ? {
		          modelRole: 'video',
		          provider: result.videoAudit.provider,
		          model: result.videoAudit.model,
		          providerTaskId: result.videoAudit.providerTaskId,
		          filledAfterCall: true,
		        }
		      : videoPlan.modelSnapshot,
		  });

	  // 写回 project.videoTasks 数组（前端 batch 页读这里）
	  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    while (videoTasks.length <= groupIdx) videoTasks.push({});
		    videoTasks[groupIdx] = {
		      groupIdx,
		      taskId: result.taskId,
		      status: 'completed',
		      url: result.protectedUrl,
		      coverUrl: result.coverUrl,
				      durationSec: result.durationSec,
				      plannedDurationSec,
				      prompt,
			      warnings: videoWarnings,
			      videoPlan,
		      consistency: {
		        ...((videoTasks[groupIdx] || {}).consistency || {}),
		        videoSegment: {
		          ...(((videoTasks[groupIdx] || {}).consistency || {}).videoSegment || {}),
		          characterLockBlockHash,
		          characterUsages: segmentGate.characterUsages,
		          score: segmentGate.score,
		          level: segmentGate.level,
		          warnings: segmentGate.warnings,
		        },
		      },
		      isCurrent: true,
			    };
    // 同时挂到 storyboards[groupIdx].videoUrl，方便编辑页直接读
	    // videoDurationSec 是真实生成文件时长；plannedDurationSec 是镜头表计划时长。
	    // 剪辑工作台优先用真实文件时长，避免生成结果比计划略长时出现时间线错位。
    const sbs = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
	    if (sbs[groupIdx]) {
	      sbs[groupIdx] = {
	        ...sbs[groupIdx],
	        videoUrl: result.protectedUrl,
	        videoTaskId: result.taskId,
		        videoDurationSec: result.durationSec,
		        plannedDurationSec,
		        videoWarnings,
	        videoIsCurrent: true,
	        videoInvalidatedAt: undefined,
	        videoInvalidatedReason: undefined,
	      };
	    }
    return { videoTasks, storyboards: sbs };
  });

  return {
    resultUrl: result.url,
    patch: {
      type: 'video_segment',
      groupIdx,
      url: result.url,
      coverUrl: result.coverUrl,
	      durationSec: result.durationSec,
	      plannedDurationSec,
	      taskId: result.taskId,
    },
    extra: {
      mode: result.mode,
      groupIdx,
	      durationSec: result.durationSec,
	      plannedDurationSec,
	      protectedUrl: result.protectedUrl,
      videoWarnings,
    },
  };
});

/* ============================================================
   5. shots executor —— 把剧本拆成 6-15 个镜头（一次 LLM 调用）
   ============================================================
   前端 generateShots() 的 stage hint 命名约定：
     prepare → planning → reasoning → writing → parsing → assembling
   这里我们没法精细拆 LLM 内部阶段，但能在调用前后发几个粗粒度
   stage 让进度条至少动起来。
   返回 patch.value = shots 数组，前端 onTaskCompleted 直接读。
   ============================================================ */
registerExecutor('shots', async (ctx: BatchExecCtx) => {
  const { script, styleBible, assets, durationSec } = (ctx.options || {}) as {
    script?: string;
    styleBible?: any;
    assets?: any;
    durationSec?: number | null;
  };
  if (!script || !script.trim()) {
    throw new Error('当前没有剧本，请先生成剧本再做镜头设计');
  }

  ctx.progress({ stage: 'prepare', percent: 8, hint: '正在准备剧本与资产上下文…' });

  // 把资产瘦身：只发名字 + 简短描述给 LLM，避免上下文炸掉
  const slimAssets = (() => {
    if (!assets) return null;
    const trim = (a: any) => a && {
      id: a.id,
      name: a.name,
      role: a.role,
      identity: a.identity,
      description: a.description || a.appearance || '',
    };
    return {
      characters: (assets.characters || []).map(trim),
      scenes: (assets.scenes || assets.environments || []).map(trim),
      props: (assets.props || []).map(trim),
    };
  })();

  ctx.progress({ stage: 'planning', percent: 18, hint: 'AI 正在分析剧本结构…' });
  const messages = buildShotsMessages({
    script,
    styleBible,
    assets: slimAssets,
    totalDurationSec: durationSec || undefined,
  });

  ctx.progress({ stage: 'writing', percent: 45, hint: 'AI 正在生成镜头表（这一步比较慢，请耐心等）…' });

  // 用带重试的 JSON 调用：镜头表是大段 JSON，模型偶尔会截断或多嘴
  let parsed: any;
  try {
    parsed = await chatCompleteJsonWithRetry(
      ctx.user,
      messages,
      // 镜头表可能很长（10+ 镜头），给足 token
      { temperature: 0.6, maxTokens: 4000, modelRole: 'structured' },
      (raw) => parseJsonLoose(raw),
      'shots-generate',
    );
  } catch (e: any) {
    throw new Error('镜头设计失败：' + (e?.message || String(e)));
  }

  ctx.progress({ stage: 'parsing', percent: 88, hint: '正在整理镜头表…' });

  let shotsArr: any[] = Array.isArray(parsed?.shots) ? parsed.shots : [];
  if (!shotsArr.length && Array.isArray(parsed)) shotsArr = parsed;
  if (!shotsArr.length) {
    throw new Error('AI 未返回有效镜头列表（shots 字段为空）');
  }

  /* ---------- 字段映射 / 兜底 ----------
     前端读：duration / shotType / camera / visual / dialogue / keyInfo / audio / emotion / intensity / scriptRef / characters
     LLM 偶尔回退到老 schema (durationSec/framing/movement/description/dialog/stylePillar)，
     这里统一标准化。
     注意：camera 必须保留 LLM 的细致词（如"缓慢推进"、"轻微推近"），
     不能再强行吸附到下拉菜单里——前端 _buildSelectOptions 已经会把任意值
     作为 option 加入，因此细致词可以原样显示。
  ------------------------------------- */
  const EMOTIONS = ['setup','rising','climax','falling','resolution','transition'];

  // 只对"明显是老 schema 的粗词"做最小升级，其他值原样保留
  const upgradeCamera = (raw: string): string => {
    const map: Record<string, string> = {
      '推': '推近',
      '拉': '拉远',
      '推镜头': '推近',
      '拉镜头': '拉远',
      '航拍': '升降',
      '轨道': '跟随',
      '固定机位': '固定镜头',
      '手持': '手持轻晃',
    };
    return map[raw] || raw;
  };
  const upgradeShotType = (raw: string): string => {
    const map: Record<string, string> = {
      '广角全景': '大全景',
      '广角': '大全景',
    };
    return map[raw] || raw;
  };

  const cleanStr = (...candidates: any[]): string => {
    for (const c of candidates) {
      if (c == null) continue;
      const s = String(c).trim();
      if (s) return s;
    }
    return '';
  };

  const sceneSelectionAssets = slimAssets || assets || {};
  shotsArr = shotsArr.map((sh, i) => {
    const dur = Number(sh.duration ?? sh.durationSec ?? 4);
    const visual = cleanStr(sh.visual, sh.description, sh.desc);
    const dialogue = cleanStr(sh.dialogue, sh.dialog);
    let keyInfo = cleanStr(sh.keyInfo, sh.key, sh.stylePillar);
    // keyInfo 兜底：太长就只保留前 8 个字符（前端期望主题词）
    if (keyInfo.length > 12) keyInfo = keyInfo.slice(0, 8);
    const audio = cleanStr(sh.audio, sh.sfx);
    const characters = Array.isArray(sh.characters)
      ? sh.characters.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim())
      : [];
    const intensityRaw = Number(sh.intensity);
    const intensity = Number.isFinite(intensityRaw)
      ? Math.max(1, Math.min(5, Math.round(intensityRaw)))
      : 3;

    const rawShotType = cleanStr(sh.shotType, sh.framing) || '中景';
    const rawCamera = cleanStr(sh.camera, sh.movement) || '固定镜头';
    const rawEmotion = cleanStr(sh.emotion);
    const pickedScene = pickSceneForShots({
      assets: sceneSelectionAssets,
      shots: [sh],
      text: [
        sh.sceneId,
        sh.sceneName,
        sh.scene,
        sh.location,
        visual,
        sh.description,
        sh.desc,
        sh.scriptRef,
      ].filter(Boolean).join(' '),
    });
    const sceneId = cleanStr(pickedScene.scene?.id, pickedScene.scene?.sceneId, sh.sceneId);
    const sceneName = cleanStr(
      pickedScene.scene?.name,
      pickedScene.scene?.sceneName,
      pickedScene.scene?.location,
      sh.sceneName,
      sh.scene,
      sh.location,
    );

    return {
      idx: typeof sh.idx === 'number' && sh.idx > 0 ? sh.idx : i + 1,
      sceneId,
      sceneName,
      scene: sceneName,
      duration: Math.max(2, Math.min(12, Number.isFinite(dur) ? dur : 4)),
      shotType: upgradeShotType(rawShotType),
      camera: upgradeCamera(rawCamera),
      visual,
      dialogue: dialogue || '——',
      keyInfo,
      audio,
      emotion: EMOTIONS.includes(rawEmotion) ? rawEmotion : 'rising',
      intensity,
      scriptRef: cleanStr(sh.scriptRef),
      characters,
    };
  });

  // 过滤掉完全空白的镜头（visual + dialogue 都没有）
  shotsArr = shotsArr.filter(sh => sh.visual || (sh.dialogue && sh.dialogue !== '——'));
  // 重新排 idx，避免过滤后跳号
  shotsArr = shotsArr.map((sh, i) => ({ ...sh, idx: i + 1 }));

  if (!shotsArr.length) {
    throw new Error('AI 返回的镜头都没有内容，请稍后重试或换个剧本');
  }

  ctx.progress({ stage: 'assembling', percent: 95, hint: '正在保存镜头表…' });

  // 写回项目：shots + 重置下游审批/分镜
  patchProjectForUser(ctx.projectId, ctx.user.id, () => ({
    shots: shotsArr,
    shotsApproved: false,
    storyboards: [],
    currentStep: 3,
  }));

  return {
    patch: { type: 'shots', value: shotsArr },
    extra: { count: shotsArr.length },
  };
});

/* ============================================================
   6. video_prompts executor —— 给一个分镜组生成视频生成模型用的英文 prompt
   ============================================================
   前端 generateAllVideoPrompts 启动 batchType: 'video_prompts'，
   targets 里每条带 { groupIdx, shotIndices, totalGroups }。
   返回到前端的 extra：{ groupIdx, videoPrompt, narrationsUsed }
   ============================================================ */
registerExecutor('video_prompts', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const totalGroups: number = ctx.target.totalGroups || 1;
  const shots = (proj as any).shots || [];

  // 优先用 target.shotIndices（前端按情绪段切组后传过来）
  let shotIndices: number[] = Array.isArray(ctx.target.shotIndices) && ctx.target.shotIndices.length
    ? ctx.target.shotIndices.filter((i: any) => typeof i === 'number')
    : [];
  shotIndices = shotIndices.filter((i) => i >= 0 && i < shots.length);
		  if (!shotIndices.length) {
		    // fallback：把 groupIdx 当镜头索引（兼容老调用）
		    if (groupIdx < shots.length) shotIndices = [groupIdx];
		    else throw new Error(`分组 #${groupIdx} 没有对应的镜头`);
		  }
		  const promptGate = validateCharacterConsistencyForGroup(proj as any, {
		    groupIdx,
		    shotIndices,
		    target: 'videoPrompt',
		  });
		  if (!promptGate.allowed) {
		    throw new Error(
		      `片段 ${groupIdx + 1} 角色一致性未通过：${promptGate.blockers.map((b) => b.message).join('；')}`,
		    );
		  }
		  const promptRunId = ctx.batchId;
	  const promptStartedAt = nowIso();
	  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
	    if (!fresh) return null;
	    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
	    while (storyboards.length <= groupIdx) storyboards.push({});
	    const prev = storyboards[groupIdx] || {};
	    storyboards[groupIdx] = {
	      ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', promptStartedAt),
	      videoPromptStatus: 'generating',
	      videoPromptRunId: promptRunId,
	      videoPromptStartedAt: promptStartedAt,
	      videoPromptLastError: undefined,
	      videoPromptFailedAt: undefined,
	    };
	    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
	    if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
	      videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration', promptStartedAt);
	    }
	    return { storyboards, videoTasks };
	  });

		  const groupShots = shotIndices.map((i) => shots[i]);
	  const promptGroupShots = sanitizePromptObject(groupShots);
	  const styleBible = (proj as any).styleBible || {};
	  const assets = (proj as any).assets || {};
	  const promptStyleBible = sanitizePromptObject(styleBible);
	  const promptAssets = sanitizePromptObject(assets);
	  const narrations: any[] = Array.isArray((proj as any).narrations) ? (proj as any).narrations : [];

  ctx.progress({ stage: 'preparing', percent: 10, hint: '准备镜头与资产上下文…' });

	  const messages = buildVideoPromptMessages({
	    shots: promptGroupShots,
	    styleBible: promptStyleBible,
	    assets: promptAssets,
	    narrations,
    groupIdx,
    totalGroups,
  });

  ctx.progress({ stage: 'calling_llm', percent: 35, hint: 'AI 正在写视频提示词…' });

  // 检测 LLM 是否偷懒输出了老格式 / 含禁止词
  const looksLikeOldFormat = (text: string): boolean => {
    const t = text || '';
    if (/\[(CAMERA|STYLE|CONSTRAINTS|AUDIO)\]/i.test(t)) return true;
    if (/\bshot\s*\d+\s*:/i.test(t)) return true;
    // "参考图X" 引用是用户明确不要的
    if (/参考图\s*\d+/.test(t)) return true;
    // 看起来 80% 以上是英文
    const cnChars = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enChars = (t.match(/[a-zA-Z]/g) || []).length;
    if (cnChars + enChars > 100 && cnChars / (cnChars + enChars) < 0.4) return true;
    return false;
  };

  // 兜底清洗：把 "（参考图N）" / "(参考图N)" / "参考图N" 直接擦掉
  const stripRefMarkers = (text: string): string =>
    text
      .replace(/[（(]\s*参考图\s*\d+\s*[)）]/g, '')
      .replace(/参考图\s*\d+/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*([，。；：])[ \t]*/g, '$1');

	  let prompt = '';
	  let attempt = 0;
	  const NETWORK_MAX_ATTEMPTS = envInt('VIDEO_PROMPT_NETWORK_MAX_ATTEMPTS', 4, 1, 8);
	  const MAX_ATTEMPTS = Math.max(VIDEO_PROMPT_MAX_ATTEMPTS, NETWORK_MAX_ATTEMPTS);
	  const RETRY_DEADLINE_MS = envInt('VIDEO_PROMPT_RETRY_DEADLINE_MS', 90_000, 10_000, 600_000);
	  const retryDeadlineAt = Date.now() + RETRY_DEADLINE_MS;

	  while (attempt < MAX_ATTEMPTS) {
	    attempt++;
	    try {
	      const remaining = retryDeadlineAt - Date.now();
	      if (remaining <= 0) {
	        throw new Error('retry_deadline_exceeded：视频提示词网络/模型重试超过总预算');
	      }
	      // 第二次重试时压低 temperature 并在 user message 末尾追加强提示
	      const retryMessages = buildVideoPromptAttemptMessages(messages, attempt);
	      const temp = videoPromptTemperatureForAttempt(attempt);
      prompt = await chatComplete(
        ctx.user,
        retryMessages,
        {
          temperature: temp,
          modelRole: 'structured',
	          traceName: 'video-prompts',
	          traceAttempt: attempt,
	          traceMaxAttempts: MAX_ATTEMPTS,
	          requestTimeoutMs: Math.min(remaining, 600_000),
	        },
	      );
	      if (!looksLikeOldFormat(prompt)) break;
	      console.warn(`[video_prompts] attempt ${attempt} produced old format, retrying…`);
	    } catch (e: any) {
	      const isNetwork = isTransientNetworkError(e);
	      const maxAttemptsForThisError = isNetwork ? NETWORK_MAX_ATTEMPTS : VIDEO_PROMPT_MAX_ATTEMPTS;
	      if (attempt >= maxAttemptsForThisError) {
	        throw new Error('视频提示词生成失败：' + (e?.message || String(e)));
	      }
	      const delay = isNetwork
	        ? Math.min(60_000, 10_000 * Math.pow(2, attempt - 1))
	        : 1500 * attempt;
	      if (Date.now() + delay > retryDeadlineAt) {
	        throw new Error('视频提示词生成失败：retry_deadline_exceeded；最后错误：' + (e?.message || String(e)));
	      }
	      console.warn(
	        `[video_prompts] attempt ${attempt}/${maxAttemptsForThisError} failed, ` +
	          `retrying in ${Math.round(delay / 1000)}s: ${e?.message || String(e)}`,
	      );
	      await sleep(delay);
	    }
	  }

  let cleaned = prompt.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!cleaned) throw new Error('AI 没有返回提示词');
	  // 即使 LLM 漏写了"参考图X"，最后再做一次纯文本清洗（不破坏其他内容）
	  cleaned = stripRefMarkers(cleaned);
	  cleaned = sanitizeFillLightPositiveMentions(cleaned);
  if (looksLikeOldFormat(cleaned)) {
    // 两次都失败：抛错让前端显示"重试"按钮，比保存一份乱码好
    throw new Error('AI 输出格式不符（旧英文格式或仍含参考图编号），请点击重新生成（已自动重试 2 次仍失败）');
  }
  let assetConstraintText = '';
  try {
    assetConstraintText = JSON.stringify({ assets, styleBible }).slice(0, 14000);
  } catch {}
  cleaned = enforceHardVisualConstraints(
    cleaned,
    [
      prompt,
      assetConstraintText,
      ...groupShots.map((sh: any) => [
        sh?.visual,
        sh?.description,
        sh?.desc,
        sh?.dialogue,
        sh?.scriptRef,
        sh?.keyInfo,
      ].filter(Boolean).join(' ')),
    ].join('\n'),
  );

  ctx.progress({ stage: 'saving', percent: 92, hint: '正在保存…' });

  // 写回 storyboards[groupIdx].videoPrompt
  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    while (storyboards.length <= groupIdx) storyboards.push({});
	    const prev = storyboards[groupIdx] || {};
	    if (prev.videoPromptRunId && prev.videoPromptRunId !== promptRunId) {
	      console.warn(
	        `[video_prompts] ignored stale write project=${ctx.projectId} group=${groupIdx} ` +
	          `run=${promptRunId} currentRun=${prev.videoPromptRunId}`,
	      );
	      return null;
	    }
		    storyboards[groupIdx] = {
		      ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration'),
		      videoPrompt: cleaned,
		      videoPromptStatus: 'ready',
		      videoPromptRunId: promptRunId,
		      videoPromptUpdatedAt: nowIso(),
		      videoPromptLastError: undefined,
		      videoPromptFailedAt: undefined,
		      narrationsUsed: narrations,
		      shotIndices,
		      consistency: {
		        ...(prev.consistency || {}),
		        videoPrompt: {
		          characterUsages: promptGate.characterUsages,
		          score: promptGate.score,
		          level: promptGate.level,
		          warnings: promptGate.warnings,
		        },
		      },
		    };
	    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
	    if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
	      videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration');
	    }
	    return { storyboards, videoTasks };
	  });

  return {
    patch: { type: 'video_prompt', idx: groupIdx, value: cleaned },
    extra: {
      groupIdx,
	      videoPrompt: cleaned,
	      videoPromptStatus: 'ready',
	      videoPromptRunId: promptRunId,
	      narrationsUsed: narrations,
	      shotIndices,
	      invalidateVideo: true,
    },
  };
});

/* ============================================================
   batchType 别名：前端 videoTasks.js 提交 batchType="videos"，
   reattach 时也用这个名字过滤 → 复用 video_segments executor
   ============================================================ */
aliasExecutor('video_segments', 'videos');
