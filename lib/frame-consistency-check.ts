import { existsSync, readFileSync } from 'node:fs';
import type { UserRow } from './db';
import { applyTokenBudget, observeTextModelCall, parseJsonLoose, type ChatMessage } from './llm';
import {
  resolveTextModelConfig,
  type ResolvedModelConfig,
} from './model-routing';
import { postJsonWithProxySupport } from './proxy-fetch';
import { getExternalEnvValue } from './env';
import type { FrameImageGenerationPlan, FrameReference, FrameType } from './frame-image-plan';
import { isPrimarySceneRef, isTopdownSceneRef } from './scene-views';
import type { TokenUsageContext } from './token-usage';

export type FrameConsistencyGrade = 'pass' | 'warn' | 'fail';
export type FrameConsistencyStatus = 'checked' | 'skipped' | 'error';

export type FrameConsistencyCheckResult = {
  status: FrameConsistencyStatus;
  grade: FrameConsistencyGrade;
  frameType: FrameType;
  characterScore?: number | null;
  sceneScore?: number | null;
  propScore?: number | null;
  severe?: boolean;
  reasons: string[];
  retryPromptHint?: string;
  model?: string;
  provider?: string;
  checkedAt: string;
  raw?: any;
};

export type FrameConsistencyRetryDecision = {
  shouldRetry: boolean;
  nextPrompt: string;
};

const CHECK_TIMEOUT_MS = 120_000;
const MAX_CONSISTENCY_REFERENCE_IMAGES = 6;

function cleanText(value: unknown, max = 500): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function imagePathToDataUrl(imagePath: string): string {
  const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
}

function extractResponsesText(json: any): string {
  if (typeof json?.output_text === 'string') return json.output_text.trim();
  const parts: string[] = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      const text = part?.text || part?.output_text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

function extractChatText(json: any): string {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part: any) => part?.text || '').filter(Boolean).join('\n').trim();
  }
  return '';
}

function timeoutMs(): number {
  const raw =
    getExternalEnvValue('FRAME_CONSISTENCY_CHECK_TIMEOUT_MS') ||
    process.env.FRAME_CONSISTENCY_CHECK_TIMEOUT_MS ||
    getExternalEnvValue('IMAGE_CAPTION_TIMEOUT_MS') ||
    process.env.IMAGE_CAPTION_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : CHECK_TIMEOUT_MS;
}

function score(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function hasRole(refs: FrameReference[], role: FrameReference['role']): boolean {
  return refs.some((ref) => ref.role === role && ref.delivery === 'image');
}

function refIdentity(ref: FrameReference): string {
  return [
    ref.assetId ? `id:${ref.assetId}` : '',
    ref.assetName ? `name:${ref.assetName}` : '',
    ref.role ? `role:${ref.role}` : '',
  ].filter(Boolean).join('|').toLowerCase();
}

function panelRank(ref: FrameReference): number {
  if (ref.panel === 'sheet') return 0;
  if (ref.panel === 'headshot') return 1;
  if (ref.panel === 'front') return 2;
  if (ref.panel === 'side') return 3;
  if (ref.panel === 'back') return 4;
  return 10;
}

export function selectFrameConsistencyReferences(plan: FrameImageGenerationPlan): FrameReference[] {
  const refs = plan.referenceManifest
    .filter((ref) => ref.delivery === 'image' && ref.localPath && !isTopdownSceneRef(ref))
    .sort((a, b) => (a.imageNo || 999) - (b.imageNo || 999));
  const selected: FrameReference[] = [];
  const usedKeys = new Set<string>();
  const add = (ref: FrameReference | undefined | null) => {
    if (!ref || selected.length >= MAX_CONSISTENCY_REFERENCE_IMAGES) return;
    const key = ref.localPath || ref.remoteUrl || `${ref.role}:${ref.assetName}:${ref.panel}:${ref.imageNo}`;
    if (!key || usedKeys.has(key)) return;
    usedKeys.add(key);
    selected.push(ref);
  };

  add(refs.find((ref) => ref.role === 'self_first_frame'));

  const characterRefs = refs.filter((ref) => ref.role === 'character');
  const primaryCharacterKey = characterRefs[0] ? refIdentity(characterRefs[0]) : '';
  const primaryCharacterRefs = characterRefs
    .filter((ref) => refIdentity(ref) === primaryCharacterKey)
    .sort((a, b) => panelRank(a) - panelRank(b) || (a.imageNo || 999) - (b.imageNo || 999));
  primaryCharacterRefs.slice(0, 3).forEach(add);

  const nonHumanPrimary = primaryCharacterRefs.find((ref) => ref.entityType === 'non-human');
  if (nonHumanPrimary && !selected.some((ref) => ref.role === 'character' && ref.panel === 'side')) {
    add(primaryCharacterRefs.find((ref) => ref.panel === 'side' || ref.panel === 'back'));
  }

  add(refs.find((ref) => isPrimarySceneRef(ref)));
  add(refs.find((ref) => ref.role === 'prop'));
  add(refs.find((ref) => ref.role === 'crowd'));

  for (const ref of refs) add(ref);
  return selected;
}

function normalizeReasons(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, 8);
}

export function normalizeFrameConsistencyCheckResult(args: {
  raw: any;
  frameType: FrameType;
  referenceManifest: FrameReference[];
  model?: string;
  provider?: string;
}): FrameConsistencyCheckResult {
  const refs = args.referenceManifest || [];
  const hasCharacter = hasRole(refs, 'character');
  const hasScene = hasRole(refs, 'scene');
  const hasProp = hasRole(refs, 'prop');
  const characterScore = score(args.raw?.characterScore ?? args.raw?.character_score ?? args.raw?.identityScore ?? args.raw?.identity_score);
  const sceneScore = score(args.raw?.sceneScore ?? args.raw?.scene_score);
  const propScore = score(args.raw?.propScore ?? args.raw?.prop_score);
  const rawGrade = cleanText(args.raw?.grade || args.raw?.result, 20).toLowerCase();
  const severe = !!(
    args.raw?.severe ||
    args.raw?.severeMismatch ||
    args.raw?.missingPrimaryCharacter ||
    args.raw?.wrongIdentity ||
    args.raw?.wrongSpecies ||
    args.raw?.nonHumanBecameHuman
  );

  let grade: FrameConsistencyGrade = 'pass';
  if (
    severe ||
    rawGrade === 'fail' ||
    (hasCharacter && characterScore != null && characterScore < 60) ||
    (hasScene && sceneScore != null && sceneScore < 50) ||
    (hasProp && propScore != null && propScore < 50)
  ) {
    grade = 'fail';
  } else if (
    rawGrade === 'warn' ||
    rawGrade === 'warning' ||
    (hasCharacter && characterScore != null && characterScore < 75) ||
    (hasScene && sceneScore != null && sceneScore < 70) ||
    (hasProp && propScore != null && propScore < 70)
  ) {
    grade = 'warn';
  }

  return {
    status: 'checked',
    grade,
    frameType: args.frameType,
    characterScore,
    sceneScore,
    propScore,
    severe,
    reasons: normalizeReasons(args.raw?.reasons || args.raw?.reason || args.raw?.issues),
    retryPromptHint: cleanText(args.raw?.retryPromptHint || args.raw?.retry_prompt_hint || args.raw?.fixHint, 500),
    model: args.model,
    provider: args.provider,
    checkedAt: new Date().toISOString(),
    raw: args.raw,
  };
}

function skippedResult(frameType: FrameType, reason: string, cfg?: ResolvedModelConfig): FrameConsistencyCheckResult {
  return {
    status: 'skipped',
    grade: 'warn',
    frameType,
    reasons: [reason],
    model: cfg?.model,
    provider: cfg?.provider,
    checkedAt: new Date().toISOString(),
  };
}

function errorResult(frameType: FrameType, err: any, cfg?: ResolvedModelConfig): FrameConsistencyCheckResult {
  return {
    status: 'error',
    grade: 'warn',
    frameType,
    reasons: [`视觉一致性校验失败：${cleanText(err?.message || err, 220)}`],
    model: cfg?.model,
    provider: cfg?.provider,
    checkedAt: new Date().toISOString(),
  };
}

function referenceLine(ref: FrameReference): string {
  const panel = ref.panel ? `/${ref.panel}` : '';
  const entity = ref.entityType === 'non-human'
    ? ' entityType=non-human，非人/拟人角色，不能画成人类或普通人脸。'
    : ref.entityType === 'human'
      ? ' entityType=human。'
      : '';
  return `${ref.role}${panel} ${ref.assetName || ''}${entity} - ${ref.referencePurpose || ref.textFallback || ''}`.trim();
}

function buildCheckPrompt(plan: FrameImageGenerationPlan, refs: FrameReference[]): string {
  return [
    '你是视频首尾帧视觉一致性检查器。请比较第 1 张“生成结果”和后续参考图，输出 JSON，不要输出解释性正文。',
    '评分对象：角色一致性、场景一致性、道具一致性。只检查生成结果是否能用作当前首帧/尾帧，不评价美术好不好看。',
    '',
    '图片顺序：',
    'Image 1: generated frame under review',
    ...refs.map((ref, idx) => `Image ${idx + 2}: ${referenceLine(ref)}`),
    '',
    '三档规则：',
    '- pass：主角色身份/服装/物种正确，场景和关键道具正确，只有轻微姿态或光影差异。',
    '- warn：可用但有小风险，例如脸部略偏、服装细节少量偏差、场景/道具局部不完整。',
    '- fail：不能用，例如主角色长相或服装明显不像参考、非人角色被人类化、主角色缺失、地点明显错误、关键道具缺失或形态严重错误。',
    '',
    '输出 JSON schema：',
    '{"grade":"pass|warn|fail","characterScore":0-100或null,"sceneScore":0-100或null,"propScore":0-100或null,"severe":boolean,"reasons":["..."],"retryPromptHint":"如果 fail，给一段给生图模型的修正提示"}',
  ].join('\n');
}

export async function checkFrameVisualConsistency(args: {
  user: UserRow;
  plan: FrameImageGenerationPlan;
  generatedImagePath?: string | null;
  tokenContext?: TokenUsageContext | null;
}): Promise<FrameConsistencyCheckResult> {
  const cfg = resolveTextModelConfig(args.user, 'frameConsistencyCheck');
  const responsesProvider = cfg.provider === 'openai_responses' || cfg.provider === 'packy_responses' || cfg.provider === 'zerail_responses';
  const chatVisionProvider = cfg.provider === 'openai_chat' || cfg.provider === 'volcengine_chat';
  if (cfg.mode === 'fake') {
    return skippedResult(args.plan.frameType, 'FRAME_CONSISTENCY_CHECK 模型未配置，跳过自动视觉校验。', cfg);
  }
  if (!responsesProvider && !chatVisionProvider) {
    return skippedResult(args.plan.frameType, `当前文本模型不支持图片识别：${cfg.provider}`, cfg);
  }
  const generatedPath = String(args.generatedImagePath || '').trim();
  if (!generatedPath || !existsSync(generatedPath)) {
    return skippedResult(args.plan.frameType, '生成结果图片文件不可解析，跳过自动视觉校验。', cfg);
  }
  const selectedReferences = selectFrameConsistencyReferences(args.plan)
    .filter((ref) => ref.localPath && existsSync(ref.localPath));
  const referencePaths = selectedReferences.map((ref) => ref.localPath as string);
  if (!referencePaths.length) {
    return skippedResult(args.plan.frameType, '没有可用参考图，跳过自动视觉校验。', cfg);
  }

  const prompt = buildCheckPrompt(args.plan, selectedReferences);
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  const usageOpts = {
    maxTokens: 1600,
    traceName: 'frame-consistency-check',
    modelRole: 'frameConsistencyCheck' as const,
    responseFormat: 'json_object' as const,
    tokenContext: {
      ownerId: args.user.id,
      usernameSnapshot: args.user.phone || args.user.display_name || args.user.username || null,
      moduleKey: 'image',
      moduleLabel: '图片生成',
      featureKey: 'frame_consistency_check',
      featureLabel: '首尾帧一致性校验',
      operationKey: args.tokenContext?.operationKey || args.tokenContext?.callItemId || undefined,
      operationLabel: args.tokenContext?.operationLabel || '首尾帧一致性校验',
      ...(args.tokenContext || {}),
      meta: {
        ...(args.tokenContext?.meta || {}),
        frameType: args.plan.frameType,
        referenceCount: selectedReferences.length,
      },
    },
  };
  const budgeted = applyTokenBudget(
    cfg,
    messages,
    usageOpts,
    'complete',
  );
  const maxOutputTokens = budgeted.maxTokens ?? 1600;
  const requestTimeoutMs = timeoutMs();

  try {
    const imageUrls = [generatedPath, ...referencePaths].map(imagePathToDataUrl);
    let text = '';
    if (responsesProvider) {
      const body: any = {
        model: cfg.model,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            ...imageUrls.map((image_url) => ({ type: 'input_image', image_url })),
          ],
        }],
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'json_object' } },
      };
      if (cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort };
      const json = await observeTextModelCall(
        cfg,
        budgeted,
        () => postJsonWithProxySupport(
          `${cfg.baseUrl}${cfg.endpoint || '/responses'}`,
          cfg.apiKey,
          body,
          requestTimeoutMs,
          `首尾帧视觉一致性校验超时（>${Math.round(requestTimeoutMs / 1000)}s 未返回）`,
        ),
      );
      text = extractResponsesText(json);
    } else {
      const json = await observeTextModelCall(
        cfg,
        budgeted,
        () => postJsonWithProxySupport(
          `${cfg.baseUrl}${cfg.endpoint || '/chat/completions'}`,
          cfg.apiKey,
          {
            model: cfg.model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            }],
            max_tokens: maxOutputTokens,
            temperature: 0,
            response_format: { type: 'json_object' },
          },
          requestTimeoutMs,
          `首尾帧视觉一致性校验超时（>${Math.round(requestTimeoutMs / 1000)}s 未返回）`,
        ),
      );
      text = extractChatText(json);
    }
    const raw = parseJsonLoose<any>(text);
    const normalized = normalizeFrameConsistencyCheckResult({
      raw,
      frameType: args.plan.frameType,
      referenceManifest: selectedReferences,
      model: cfg.model,
      provider: cfg.provider,
    });
    return normalized;
  } catch (err: any) {
    return errorResult(args.plan.frameType, err, cfg);
  }
}

export function buildFrameConsistencyRetryDecision(args: {
  basePrompt: string;
  check: FrameConsistencyCheckResult;
  attempt: number;
  maxRetries: number;
}): FrameConsistencyRetryDecision {
  const shouldRetry = args.check.status === 'checked' && args.check.grade === 'fail' && args.attempt <= args.maxRetries;
  if (!shouldRetry) return { shouldRetry: false, nextPrompt: args.basePrompt };
  const reasons = args.check.reasons.length ? args.check.reasons.join('；') : '生成结果与参考图偏差明显';
  const hint = args.check.retryPromptHint || '重新生成时优先修正主角色长相、服装、物种结构、场景和关键道具，不要改变镜头目标。';
  return {
    shouldRetry: true,
    nextPrompt: [
      args.basePrompt,
      '',
      '【一致性重试修正】',
      `上一张生成结果未通过视觉一致性检查：${reasons}`,
      hint,
      '本次必须优先贴合参考图中的角色身份、服装、场景和关键道具；不要为了构图好看而改掉这些锁定项。',
    ].join('\n'),
  };
}
