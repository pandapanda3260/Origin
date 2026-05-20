import type { UserRow } from './db';
import { resolveLLMConfig } from './llm';
import { resolveTextModelConfig } from './model-routing';
import { buildVideoPromptMessages } from './prompts';
import { buildSeedancePromptParts, type VideoReferenceImage } from './video-prompt-runtime';
import { ensureProjectConsistency, renderCharacterLockRosterLine } from './character-consistency';
import { plannedDurationFromShots, resolveGenerationDurationSec } from './video-reference-manifest';
import { resolveStoryboardFirstFrameUrl } from './visual-reference-state';
import { buildVideoReferenceManifest } from './reference-matcher';
import {
  buildVideoPromptRetryAudit,
  VIDEO_PROMPT_FIRST_TEMPERATURE,
  VIDEO_PROMPT_MAX_ATTEMPTS,
  VIDEO_PROMPT_RETRY_EXTRA_RULE,
  VIDEO_PROMPT_RETRY_TEMPERATURE,
} from './video-prompt-attempts';
import { dataPath } from './runtime-paths';

type AuditOptions = {
  ratio?: string;
  quality?: string;
  videoModel?: string;
  genAudio?: boolean;
  watermark?: boolean;
  shotIndices?: number[];
};

type AuditBlock = {
  id: string;
  title: string;
  description?: string;
  content: string;
};

function normalizeRatio(ratio?: string): { ratio: string; size: '1080x1920' | '1920x1080' | '1024x1024' } {
  const r = (ratio || '').trim();
  if (r === '16:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '9:16') return { ratio: '9:16', size: '1080x1920' };
  if (r === '1:1') return { ratio: '1:1', size: '1024x1024' };
  if (r === '4:3' || r === '21:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '3:4') return { ratio: '9:16', size: '1080x1920' };
  return { ratio: '9:16', size: '1080x1920' };
}

function resolveAuditRatio(project: any, opts: AuditOptions): string {
  const candidates = [
    opts.ratio,
    project?.styleOptions?.aspectRatio,
    project?.styleBible?.aspectRatio,
    project?.videoAspectRatio,
    '9:16',
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (['16:9', '9:16', '1:1', '21:9', '4:3', '3:4'].includes(value)) return value;
  }
  return '9:16';
}

function parseDialogue(raw: string): Array<{ speaker: string; text: string }> {
  if (!raw) return [];
  const speakerRe = /([^：:\s“”‘’"'「」『』]{1,24})[：:]/g;
  const anchors: Array<{ speaker: string; textStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = speakerRe.exec(raw)) !== null) {
    anchors.push({ speaker: m[1].trim(), textStart: m.index + m[0].length });
  }
  if (!anchors.length) return [{ speaker: '', text: raw.trim() }];

  const pairs: Array<{ speaker: string; text: string }> = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const cur = anchors[i];
    const nextStart = i + 1 < anchors.length
      ? anchors[i + 1].textStart - anchors[i + 1].speaker.length - 1
      : raw.length;
    let text = raw.slice(cur.textStart, nextStart).trim();
    text = text
      .replace(/^[「『""''""''『]+/, '')
      .replace(/[」』""''""''』]+$/, '')
      .trim();
    if (text) pairs.push({ speaker: cur.speaker, text });
  }
  return pairs;
}

function cleanDialogueCharCount(pairs: Array<{ text: string }>) {
  let total = 0;
  for (const p of pairs) {
    total += (p.text || '').replace(/[\s「『""''，。！？]/g, '').length;
  }
  return total;
}

function resolveShotIndices(project: any, groupIdx: number, requested?: number[]) {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] : null;
  const fromRequest = Array.isArray(requested) ? requested.filter((i) => Number.isInteger(i) && i >= 0 && i < shots.length) : [];
  if (fromRequest.length) return fromRequest;
  const fromStoryboard = Array.isArray(sb?.shotIndices) ? sb.shotIndices.filter((i: any) => Number.isInteger(i) && i >= 0 && i < shots.length) : [];
  if (fromStoryboard.length) return fromStoryboard;
  return groupIdx >= 0 && groupIdx < shots.length ? [groupIdx] : [];
}

function summarizeShot(shot: any): string {
  if (!shot) return '';
  const st = shot.shotType ? `【${shot.shotType}】` : '';
  const cm = shot.camera ? `【${shot.camera}】` : '';
  const v = String(shot.visual || shot.description || '').slice(0, 120);
  return `${st}${cm}${v}`.trim();
}

function localImageId(url: string | undefined | null) {
  const m = /\/api\/images\/file\/([0-9a-fA-F-]{36})/.exec(url || '');
  return m ? m[1] : '';
}

function buildVideoInput(project: any, user: UserRow, groupIdx: number, shotIndices: number[], ratio: string) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = storyboards[groupIdx] || {};
  const firstShot = shots[groupIdx] || {};
  const groupShots = shotIndices.map((i: number) => shots[i]).filter(Boolean);
  const firstGroupShot = groupShots[0] || firstShot || {};

  let prompt = sb.videoPrompt ||
    sb.firstFramePrompt ||
    sb.imagePrompt ||
    firstShot.imagePrompt ||
    firstShot.visual ||
    firstShot.description ||
    firstShot.desc ||
    `Video segment for shot ${groupIdx + 1}`;

  if (!sb.videoPrompt) {
    prompt = sb.firstFramePrompt ||
      sb.imagePrompt ||
      firstGroupShot.videoPrompt ||
      firstGroupShot.imagePrompt ||
      firstGroupShot.visual ||
      firstGroupShot.description ||
      firstGroupShot.desc ||
      prompt;
  }

  const dialoguePairs: Array<{ speaker: string; text: string }> = [];
  for (const si of shotIndices) {
    const sh = shots[si];
    if (!sh) continue;
    const raw = String(sh.dialogue || sh.scriptRef || '').trim();
    if (!raw || raw === '——' || raw === '-' || raw === '无') continue;
    dialoguePairs.push(...parseDialogue(raw));
  }

  const dialogueCharSum = cleanDialogueCharCount(dialoguePairs);
  const durationSec = plannedDurationFromShots(groupShots);

  const resolvedFirstFrameUrl = resolveStoryboardFirstFrameUrl(sb);
  const sbImageUrl: string = resolvedFirstFrameUrl
    ? resolvedFirstFrameUrl
    : (sb.rawUrl || sb.url || sb.imageUrl || '');
  const sbImageId = localImageId(sbImageUrl);
  const referenceImagePath = sbImageId ? dataPath('images', String(user.id), `${sbImageId}.png`) : undefined;
  const referenceImageRole: 'first_frame' | 'storyboard_sketch' = resolvedFirstFrameUrl ? 'first_frame' : 'storyboard_sketch';

  let storyboardReferencePath: string | undefined;
  if (referenceImageRole === 'first_frame') {
    const sketchId = localImageId(sb.debugSketchUrl || sb.pencilUrl || '');
    if (sketchId) storyboardReferencePath = dataPath('images', String(user.id), `${sketchId}.png`);
  }

  const charNames = new Set<string>();
  for (const si of shotIndices) {
    const sh = shots[si];
    if (!Array.isArray(sh?.characters)) continue;
    for (const cn of sh.characters) {
      if (typeof cn === 'string' && cn.trim()) charNames.add(cn.trim());
    }
  }

  const canonicalRefs = buildVideoReferenceManifest({
    project,
    assets: (project as any).assets || {},
    shots,
    groupShotIndices: shotIndices,
    groupIdx,
    ownerId: user.id,
    storyboardImageUrl: sbImageUrl || null,
  });
  const manifestInImageOrder = [...canonicalRefs.manifest].sort((a, b) => a.imageNo - b.imageNo);
  const sceneItem = manifestInImageOrder.find((ref) => ref.role === 'scene' && ref.localPath);
  const sceneReferencePath = sceneItem?.localPath;
  const sceneReferenceHint = sceneItem?.promptHint || '';
  const characterReferencePaths = manifestInImageOrder
    .filter((ref) => ref.role === 'character' && ref.localPath)
    .map((ref) => ref.localPath as string);
  const characterReferenceNames = manifestInImageOrder
    .filter((ref) => ref.role === 'character')
    .map((ref) => ref.assetName || ref.label)
    .filter(Boolean);
  const characterReferencePanels = manifestInImageOrder
    .filter((ref) => ref.role === 'character' && ref.localPath && ref.panelInfo)
    .map((ref: any) => ({
      characterName: ref.assetName || ref.label,
      panel: ref.panelInfo.panel,
      path: ref.localPath,
      intent: ref.panelInfo.intent,
      priority: Number(ref.score || ref.priority || 0),
      reason: ref.matchReason || `manifest:${ref.panelInfo.panel}`,
    }));
  const groupTextForProps = shotIndices
    .map((i) => {
      const sh = shots[i];
      return [sh?.visual, sh?.description, sh?.desc, sh?.dialogue, sh?.scriptRef, sh?.keyInfo]
        .filter(Boolean)
        .join(' ');
    })
    .join(' ');
  const propReferencePaths = manifestInImageOrder
    .filter((ref) => ref.role === 'prop' && ref.localPath)
    .map((ref) => ref.localPath as string);
  const propReferenceNames = manifestInImageOrder
    .filter((ref) => ref.role === 'prop')
    .map((ref) => ref.assetName || ref.label)
    .filter(Boolean);

  const characterLockRosterLines: string[] = [];
  const projectWithConsistency = ensureProjectConsistency(project as any, { source: 'migration' });
  const locks = Array.isArray(projectWithConsistency.consistency?.characters) ? projectWithConsistency.consistency.characters : [];
  for (const lock of locks) {
    const names = [lock.canonicalName, ...lock.aliases].filter(Boolean);
    const mentioned = names.some((name) => charNames.has(name) || groupTextForProps.includes(name));
    if (!mentioned) continue;
    characterLockRosterLines.push(renderCharacterLockRosterLine(lock, 'zh'));
  }

  const firstShotIdxOf = (gi: number): number | null => {
    const item = storyboards[gi];
    if (!item) return null;
    if (Array.isArray(item.shotIndices) && item.shotIndices.length) return item.shotIndices[0];
    return gi;
  };
  const lastShotIdxOf = (gi: number): number | null => {
    const item = storyboards[gi];
    if (!item) return null;
    if (Array.isArray(item.shotIndices) && item.shotIndices.length) return item.shotIndices[item.shotIndices.length - 1];
    return gi;
  };

  let prevTailSummary = '';
  let nextHeadSummary = '';
  if (groupIdx > 0) {
    const prevIdx = lastShotIdxOf(groupIdx - 1);
    if (prevIdx != null) prevTailSummary = summarizeShot(shots[prevIdx]);
  }
  if (groupIdx < storyboards.length - 1) {
    const nextIdx = firstShotIdxOf(groupIdx + 1);
    if (nextIdx != null) nextHeadSummary = summarizeShot(shots[nextIdx]);
  }

  const referenceImages: VideoReferenceImage[] = manifestInImageOrder
    .filter((ref) => !!ref.localPath)
    .map((ref) => ({
      role: ref.role,
      path: ref.localPath as string,
      label: ref.label,
      sourceUrl: ref.url,
      assetId: ref.assetId,
      assetName: ref.assetName,
      promptHint: ref.promptHint,
      priority: ref.priority || ref.score,
    }));

  return {
    prompt,
    ratio,
    durationSec,
    projectId: project.id,
    groupIdx,
    dialoguePairs,
    characterLockRoster: characterLockRosterLines.join('\n') || undefined,
    prevTailSummary: prevTailSummary || undefined,
    nextHeadSummary: nextHeadSummary || undefined,
    referenceImagePath,
    referenceImageRole,
    storyboardReferencePath,
    sceneReferencePath,
    characterReferencePaths,
    characterReferencePanels,
    propReferencePaths,
    referenceImages,
    debug: {
      groupShots,
      dialogueCharSum,
      chosenSceneName: sceneItem?.assetName || sceneItem?.label || '',
      characterReferenceNames,
      propReferenceNames,
      referenceImages: referenceImages.map((ref) => ({ role: ref.role, label: ref.label, promptHint: ref.promptHint })),
    },
  };
}

function buildProviderAudit(user: UserRow, input: ReturnType<typeof buildVideoInput>, requestedRatio: string) {
  const cfg = resolveLLMConfig(user, 'video');
  const cfgIsGrok = /^grok-video/i.test(cfg.model || '');
  const isVolcano = /volces\.com|volcengine|ark\.cn-/i.test(cfg.baseUrl) || /seedance|doubao/i.test(cfg.model);
  const dur = resolveGenerationDurationSec({
    plannedDurationSec: input.durationSec,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    minDurationSec: cfg.minDurationSec,
  });
  const { ratio: aspectRatio, size } = normalizeRatio(requestedRatio);

  const blocks: AuditBlock[] = [];
  const negativeNotes: AuditBlock[] = [
    {
      id: 'negative-field',
      title: '独立 negative prompt 字段',
      content: '当前视频生成接口没有单独的 negative_prompt / negativePrompt 参数。负向约束以中文规则块形式内嵌在 system prompt、用户 prompt、最终提交 prompt 的「禁止 / 严禁 / 约束 / 风格强制覆盖」段落中。',
    },
  ];

  if (cfg.mode === 'fake' || !cfg.apiKey) {
    return {
      providerMode: 'fake',
      provider: { model: cfg.model, provider: cfg.provider, source: cfg.source, mode: cfg.mode },
      resolved: { durationSec: dur, aspectRatio, size },
      blocks,
      negativeNotes,
      finalPrompt: input.prompt,
      submitBodyPreview: {
        mode: 'fake',
        note: '本地 fake 模式不会提交外部视频模型；prompt 仅写入 video_tasks.prompt 便于排查。',
        storedPrompt: input.prompt,
      },
    };
  }

  if (cfgIsGrok) {
    const finalPrompt = input.prompt;
    const hasDurationSuffix = /-\d+s$/i.test(cfg.model);
    const submitBodyPreview: any = {
      model: cfg.model,
      prompt: finalPrompt,
      aspect_ratio: aspectRatio,
    };
    if (hasDurationSuffix) submitBodyPreview.duration = dur;
    return {
      providerMode: 'grok',
      provider: { model: cfg.model, provider: cfg.provider, source: cfg.source, mode: cfg.mode },
      resolved: { durationSec: dur, aspectRatio, size },
      blocks,
      negativeNotes,
      finalPrompt,
      submitBodyPreview,
    };
  }

  if (isVolcano) {
    const seedancePrompt = buildSeedancePromptParts({
      ...input,
      ratio: aspectRatio,
      durationSec: dur,
    });
    const submitBodyPreview: any = {
      model: cfg.model || cfg.source || 'unresolved',
      content: [
        { type: 'text', text: seedancePrompt.finalPrompt },
      ],
    };
    if (seedancePrompt.hasIndependentImageRefs) {
      for (const ref of seedancePrompt.independentReferenceImages) {
        submitBodyPreview.content.push({
          type: 'image_url',
          image_url: { url: '[base64 reference image omitted from audit view]' },
          role: 'reference_image',
          auditReference: { role: ref.role, label: ref.label, promptHint: ref.promptHint },
        });
      }
    } else if (seedancePrompt.hasAnyRef) {
      submitBodyPreview.content.push({
        type: 'image_url',
        image_url: { url: '[base64 reference image omitted from audit view]' },
      });
    }
    blocks.push(...seedancePrompt.ruleBlocks);

    return {
      providerMode: 'seedance',
      provider: { model: cfg.model, provider: cfg.provider, source: cfg.source, mode: cfg.mode },
      resolved: { durationSec: dur, aspectRatio, size },
      blocks,
      negativeNotes,
      finalPrompt: seedancePrompt.finalPrompt,
      submitBodyPreview,
      referenceMode: {
        independentMultiImage: seedancePrompt.hasIndependentImageRefs,
        independentReferenceImages: seedancePrompt.independentReferenceImages.map((ref) => ({
          role: ref.role,
          label: ref.label,
          promptHint: ref.promptHint,
        })),
      },
    };
  }

  const finalPrompt = input.prompt;
  return {
    providerMode: 'sora',
    provider: { model: cfg.model, provider: cfg.provider, source: cfg.source, mode: cfg.mode },
    resolved: { durationSec: dur, aspectRatio, size },
    blocks,
    negativeNotes,
    finalPrompt,
    submitBodyPreview: {
      model: cfg.model || cfg.source || 'unresolved',
      prompt: finalPrompt,
      size,
      seconds: String(dur),
    },
  };
}

export function buildVideoPromptAudit(user: UserRow, project: any, groupIdx: number, opts: AuditOptions = {}) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = resolveShotIndices(project, groupIdx, opts.shotIndices);
  if (!storyboards[groupIdx]) throw new Error(`找不到 storyboards[${groupIdx}]`);
  if (!shotIndices.length) throw new Error(`片段 ${groupIdx + 1} 没有可审阅的镜头索引`);

  const groupShots = shotIndices.map((i: number) => shots[i]).filter(Boolean);
  const promptMessages = buildVideoPromptMessages({
    shots: groupShots,
    styleBible: project.styleBible || {},
    assets: project.assets || {},
    narrations: Array.isArray(project.narrations) ? project.narrations : [],
    groupIdx,
    totalGroups: storyboards.length || 1,
  });

  const ratio = resolveAuditRatio(project, opts);
  const videoInput = buildVideoInput(project, user, groupIdx, shotIndices, ratio);
  const providerAudit = buildProviderAudit(user, videoInput, ratio);
  const textCfg = resolveTextModelConfig(user, 'structured');
  const promptAttemptAudit = buildVideoPromptRetryAudit(promptMessages);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      title: project.title || project.name || '未命名项目',
    },
    group: {
      groupIdx,
      label: `片段 ${groupIdx + 1}`,
      shotIndices,
	      shots: groupShots.map((shot: any, i: number) => ({
	        idx: shotIndices[i],
	        duration: shot?.duration ?? shot?.durationSec ?? 4,
	        shotType: shot?.shotType || '',
        camera: shot?.camera || '',
        visual: shot?.visual || shot?.description || '',
        dialogue: shot?.dialogue || shot?.scriptRef || '',
        characters: shot?.characters || [],
      })),
    },
    options: {
      requestedVideoModel: opts.videoModel || '',
      ratio,
      quality: opts.quality || '',
      genAudio: opts.genAudio,
      watermark: opts.watermark,
      note: 'requestedVideoModel 是前端片段页当前选择；实际视频模型由后端 settings.models.video / 环境变量解析。',
    },
    promptGeneration: {
      title: '视频提示词生成阶段（文本大模型）',
      description: '这一步把镜头、资产和风格圣经交给文本大模型，生成 storyboards[groupIdx].videoPrompt。',
      modelRole: 'video-prompts / structured',
      provider: {
        model: textCfg.model,
        provider: textCfg.provider,
        source: textCfg.source,
        mode: textCfg.mode,
        role: textCfg.role || 'structured',
        endpoint: textCfg.endpoint || '',
      },
      retryPolicy: {
        maxAttempts: VIDEO_PROMPT_MAX_ATTEMPTS,
        firstTemperature: VIDEO_PROMPT_FIRST_TEMPERATURE,
        retryTemperature: VIDEO_PROMPT_RETRY_TEMPERATURE,
        retryExtraRule: VIDEO_PROMPT_RETRY_EXTRA_RULE,
      },
      messages: promptMessages,
      attempts: promptAttemptAudit,
    },
    storedVideoPrompt: sb.videoPrompt || '',
    videoSubmission: {
      title: '视频生成提交阶段（后端最终提交给视频模型）',
      sourcePrompt: videoInput.prompt,
      dialoguePairs: videoInput.dialoguePairs,
      dialogueCharSum: videoInput.debug.dialogueCharSum,
      references: {
        storyboardReference: !!videoInput.referenceImagePath,
        storyboardReferenceRole: videoInput.referenceImageRole,
        sceneReference: videoInput.debug.chosenSceneName || '',
        characterReferences: videoInput.debug.characterReferenceNames,
        characterPanels: videoInput.characterReferencePanels.map((p) => ({
          characterName: p.characterName,
          panel: p.panel,
          intent: p.intent,
          reason: p.reason,
        })),
        propReferences: videoInput.debug.propReferenceNames,
        independentReferenceImages: videoInput.debug.referenceImages,
      },
      ...providerAudit,
    },
  };
}
