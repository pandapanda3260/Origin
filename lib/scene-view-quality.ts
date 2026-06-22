import { existsSync, readFileSync } from 'node:fs';
import type { UserRow } from './db';
import { applyTokenBudget, observeTextModelCall, parseJsonLoose, type ChatMessage } from './llm';
import {
  resolveTextModelConfig,
  type ResolvedModelConfig,
} from './model-routing';
import { postJsonWithProxySupport } from './proxy-fetch';
import { getExternalEnvValue } from './env';
import type { SceneViewRole } from './scene-views';
import type { TokenUsageContext } from './token-usage';
import { listSystemAndUserCards } from './knowledge/cards-db';
import type { KnowledgeCard } from './knowledge/types';

export type SceneViewQualityRole = Exclude<SceneViewRole, 'establishing'>;
export type SceneViewQualityStatus = 'checked' | 'skipped' | 'error';
export type SceneViewQualityDecision = 'accept' | 'retry';

export type SceneViewQualityCheckResult = {
  status: SceneViewQualityStatus;
  decision: SceneViewQualityDecision;
  viewRole: SceneViewQualityRole;
  score: number | null;
  threshold: number;
  sceneIdentityScore?: number | null;
  spatialLayoutScore?: number | null;
  viewRoleScore?: number | null;
  visualContinuityScore?: number | null;
  promptComplianceScore?: number | null;
  reasons: string[];
  retryPromptHint?: string;
  model?: string;
  provider?: string;
  checkedAt: string;
  raw?: any;
};

export const SCENE_VIEW_QUALITY_PASS_SCORE = 75;
export const SCENE_VIEW_QUALITY_MAX_RETRIES = 1;
export const SCENE_VIEW_QUALITY_ROLES: SceneViewQualityRole[] = ['reverse', 'alt', 'topdown'];
export const SCENE_VIEW_QUALITY_RUBRIC_MODULE = 'scene_view_quality';

const CHECK_TIMEOUT_MS = 120_000;
const DEFAULT_SCENE_VIEW_QUALITY_RUBRIC = [
  'Treat the establishing image as the authoritative spatial anchor.',
  'A candidate can pass only if it preserves the same physical location identity and enough stable spatial anchors to support later video reference use.',
  'Same color palette or same fantasy theme is not enough; central objects, entrances/exits, floor zones, large props, stairs/walls, and main orientation must remain mappable.',
  'For reverse views, allow camera-facing elements to change because the camera moved, but reject a new plaza/room that merely shares the same style.',
  'For alternate views, accept side/detail framing only when the major anchors still identify the same place.',
  'For topdown views, prioritize readable relative layout and orientation over beauty; reject eye-level images or decorative concept art that is not a layout anchor.',
].join('\n');

type EvaluateDeps = {
  resolveTextModelConfigImpl?: typeof resolveTextModelConfig;
  applyTokenBudgetImpl?: typeof applyTokenBudget;
  postJsonImpl?: typeof postJsonWithProxySupport;
  observeTextModelCallImpl?: typeof observeTextModelCall;
};

function cleanText(value: unknown, max = 500): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clampScore(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
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
    getExternalEnvValue('SCENE_VIEW_QUALITY_CHECK_TIMEOUT_MS') ||
    process.env.SCENE_VIEW_QUALITY_CHECK_TIMEOUT_MS ||
    getExternalEnvValue('FRAME_CONSISTENCY_CHECK_TIMEOUT_MS') ||
    process.env.FRAME_CONSISTENCY_CHECK_TIMEOUT_MS ||
    getExternalEnvValue('IMAGE_CAPTION_TIMEOUT_MS') ||
    process.env.IMAGE_CAPTION_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : CHECK_TIMEOUT_MS;
}

export function formatSceneViewQualityRubricCards(cards: Array<Pick<KnowledgeCard, 'title' | 'data'>>): string {
  const parts: string[] = [];
  for (const card of cards) {
    const data = card?.data || {};
    const cardParts: string[] = [];
    if (typeof data.content === 'string' && data.content.trim()) cardParts.push(data.content.trim());
    if (Array.isArray(data.hardRules)) {
      for (const rule of data.hardRules) {
        const text = cleanText(rule, 500);
        if (text) cardParts.push(`- ${text}`);
      }
    }
    if (Array.isArray(data.scoreFields)) {
      for (const rule of data.scoreFields) {
        const text = cleanText(rule, 500);
        if (text) cardParts.push(`- ${text}`);
      }
    }
    if (typeof data.outputSchema === 'string' && data.outputSchema.trim()) {
      cardParts.push(`Output schema: ${data.outputSchema.trim()}`);
    }
    if (cardParts.length) {
      parts.push([card.title ? `Knowledge card: ${card.title}` : 'Knowledge card:', ...cardParts].join('\n'));
    }
  }
  return parts.join('\n\n').trim();
}

export function loadSceneViewQualityRubric(ownerId: number): string {
  try {
    const cards = listSystemAndUserCards(ownerId, SCENE_VIEW_QUALITY_RUBRIC_MODULE, { limit: 4 });
    const formatted = formatSceneViewQualityRubricCards(cards);
    return formatted || DEFAULT_SCENE_VIEW_QUALITY_RUBRIC;
  } catch (err: any) {
    console.warn('[scene-view-quality] failed to load rubric cards, using built-in rubric:', String(err?.message || err).slice(0, 200));
    return DEFAULT_SCENE_VIEW_QUALITY_RUBRIC;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function shouldEvaluateSceneViewQuality(type: unknown, viewRole: unknown): viewRole is SceneViewQualityRole {
  return type === 'scene' && SCENE_VIEW_QUALITY_ROLES.includes(viewRole as SceneViewQualityRole);
}

export function skippedSceneViewQualityResult(
  viewRole: SceneViewQualityRole,
  reason: string,
  cfg?: ResolvedModelConfig,
): SceneViewQualityCheckResult {
  return {
    status: 'skipped',
    decision: 'accept',
    viewRole,
    score: null,
    threshold: SCENE_VIEW_QUALITY_PASS_SCORE,
    reasons: [reason],
    model: cfg?.model,
    provider: cfg?.provider,
    checkedAt: nowIso(),
  };
}

export function errorSceneViewQualityResult(
  viewRole: SceneViewQualityRole,
  err: any,
  cfg?: ResolvedModelConfig,
): SceneViewQualityCheckResult {
  return {
    status: 'error',
    decision: 'accept',
    viewRole,
    score: null,
    threshold: SCENE_VIEW_QUALITY_PASS_SCORE,
    reasons: [`场景副视图一致性评分失败：${cleanText(err?.message || err, 220)}`],
    model: cfg?.model,
    provider: cfg?.provider,
    checkedAt: nowIso(),
  };
}

export function normalizeSceneViewQualityResult(args: {
  raw: any;
  viewRole: SceneViewQualityRole;
  attempt: number;
  maxRetries?: number;
  model?: string;
  provider?: string;
}): SceneViewQualityCheckResult {
  const score = clampScore(args.raw?.score ?? args.raw?.overallScore ?? args.raw?.overall_score);
  const maxRetries = Number.isFinite(Number(args.maxRetries)) ? Number(args.maxRetries) : SCENE_VIEW_QUALITY_MAX_RETRIES;
  const decision: SceneViewQualityDecision =
    score != null && score < SCENE_VIEW_QUALITY_PASS_SCORE && args.attempt < maxRetries
      ? 'retry'
      : 'accept';
  const reasons = normalizeReasons(args.raw?.reasons || args.raw?.reason || args.raw?.issues);
  return {
    status: 'checked',
    decision,
    viewRole: args.viewRole,
    score,
    threshold: SCENE_VIEW_QUALITY_PASS_SCORE,
    sceneIdentityScore: clampScore(args.raw?.sceneIdentityScore ?? args.raw?.scene_identity_score),
    spatialLayoutScore: clampScore(args.raw?.spatialLayoutScore ?? args.raw?.spatial_layout_score),
    viewRoleScore: clampScore(args.raw?.viewRoleScore ?? args.raw?.view_role_score),
    visualContinuityScore: clampScore(args.raw?.visualContinuityScore ?? args.raw?.visual_continuity_score),
    promptComplianceScore: clampScore(args.raw?.promptComplianceScore ?? args.raw?.prompt_compliance_score),
    reasons,
    retryPromptHint: cleanText(args.raw?.retryPromptHint || args.raw?.retry_prompt_hint || args.raw?.fixHint, 500),
    model: args.model,
    provider: args.provider,
    checkedAt: nowIso(),
    raw: args.raw,
  };
}

function normalizeReasons(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, 8);
}

function viewRoleInstruction(role: SceneViewQualityRole): string {
  if (role === 'reverse') {
    return 'Candidate must be a reverse / 180-degree counter-view of the same physical space, not a new location with similar styling.';
  }
  if (role === 'alt') {
    return 'Candidate must be a side-angle or detail-friendly alternate view of the same physical space, preserving major anchors and layout.';
  }
  return 'Candidate must be a top-down / high-overhead layout anchor for the same physical space, with relative positions and orientation readable.';
}

export function buildSceneViewQualityPrompt(args: {
  viewRole: SceneViewQualityRole;
  sceneName?: string;
  scenePrompt?: string;
  sceneMetadata?: string;
  rubric?: string;
}): string {
  return [
    'You are a strict scene multi-view consistency evaluator. Compare Image 1 (establishing anchor) and Image 2 (candidate scene view).',
    'Only judge whether Image 2 can be used as another view of the SAME physical location as Image 1. Do not reward general beauty, fantasy detail, or similar style if the space is different.',
    '',
    `View role under review: ${args.viewRole}.`,
    viewRoleInstruction(args.viewRole),
    args.sceneName ? `Scene name: ${cleanText(args.sceneName, 160)}` : '',
    args.sceneMetadata ? `Scene metadata: ${cleanText(args.sceneMetadata, 800)}` : '',
    args.scenePrompt ? `Original scene prompt: ${cleanText(args.scenePrompt, 1200)}` : '',
    args.rubric ? `\nAdditional rubric:\n${args.rubric}` : '',
    '',
    'Score fields from 0 to 100:',
    '- sceneIdentityScore: same location identity and same world-space, not merely same theme.',
    '- spatialLayoutScore: stable anchors such as central object, entrance, stair, walls, floor zones, large props, and main axis can be mapped across views.',
    '- viewRoleScore: candidate fulfills the requested camera/layout role.',
    '- visualContinuityScore: material, lighting family, weather, palette, era, and atmosphere remain compatible.',
    '- promptComplianceScore: candidate follows the scene metadata and original prompt.',
    '',
    'Hard caps for the overall score:',
    '- If Image 2 is clearly a different place, score must be at most 45.',
    '- If fewer than two stable spatial anchors can be matched, score must be at most 60.',
    '- If topdown is not an overhead/top-down layout anchor, score must be at most 50.',
    '',
    'Output JSON only:',
    '{"score":0-100,"sceneIdentityScore":0-100,"spatialLayoutScore":0-100,"viewRoleScore":0-100,"visualContinuityScore":0-100,"promptComplianceScore":0-100,"reasons":["..."],"retryPromptHint":"A concise English correction instruction for regenerating Image 2 if needed."}',
  ].filter(Boolean).join('\n');
}

export function buildSceneViewQualityRetryPrompt(basePrompt: string, check: SceneViewQualityCheckResult): string {
  if (check.decision !== 'retry') return basePrompt;
  const reasons = check.reasons.length ? check.reasons.join('; ') : 'the candidate view did not preserve the same physical scene layout';
  const hint = check.retryPromptHint || 'Regenerate the same scene view while preserving the establishing image spatial anchors, object positions, entrances, floor layout, orientation, materials, and lighting family.';
  return [
    basePrompt,
    '',
    '=== SCENE VIEW CONSISTENCY RETRY LOCK ===',
    `The previous ${check.viewRole} view was rejected by visual consistency scoring: ${reasons}.`,
    hint,
    'This retry must depict the SAME physical location as the establishing reference. Preserve major spatial anchors and relative layout; do not invent a different place with similar style.',
  ].join('\n');
}

export async function evaluateSceneViewQuality(args: {
  user: UserRow;
  viewRole: SceneViewQualityRole;
  establishingImagePath?: string | null;
  candidateImagePath?: string | null;
  sceneName?: string;
  scenePrompt?: string;
  sceneMetadata?: string;
  attempt?: number;
  tokenContext?: TokenUsageContext | null;
  rubric?: string;
}, deps: EvaluateDeps = {}): Promise<SceneViewQualityCheckResult> {
  let cfg: ResolvedModelConfig | undefined;
  try {
    const resolveCfg = deps.resolveTextModelConfigImpl || resolveTextModelConfig;
    const modelCfg = resolveCfg(args.user, 'frameConsistencyCheck');
    cfg = modelCfg;
    const responsesProvider = modelCfg.provider === 'openai_responses' || modelCfg.provider === 'packy_responses' || modelCfg.provider === 'zerail_responses';
    const chatVisionProvider = modelCfg.provider === 'openai_chat' || modelCfg.provider === 'volcengine_chat';
    if (modelCfg.mode === 'fake') {
      return skippedSceneViewQualityResult(args.viewRole, 'FRAME_CONSISTENCY_CHECK 模型未配置，跳过场景副视图一致性评分。', modelCfg);
    }
    if (!responsesProvider && !chatVisionProvider) {
      return skippedSceneViewQualityResult(args.viewRole, `当前文本模型不支持图片识别：${modelCfg.provider}`, modelCfg);
    }
    const establishingPath = String(args.establishingImagePath || '').trim();
    const candidatePath = String(args.candidateImagePath || '').trim();
    if (!establishingPath || !existsSync(establishingPath)) {
      return skippedSceneViewQualityResult(args.viewRole, '主视角参考图文件不可解析，跳过场景副视图一致性评分。', modelCfg);
    }
    if (!candidatePath || !existsSync(candidatePath)) {
      return skippedSceneViewQualityResult(args.viewRole, '候选副视图文件不可解析，跳过场景副视图一致性评分。', modelCfg);
    }

    const rubric = args.rubric === undefined ? loadSceneViewQualityRubric(args.user.id) : args.rubric;
    const prompt = buildSceneViewQualityPrompt({
      viewRole: args.viewRole,
      sceneName: args.sceneName,
      scenePrompt: args.scenePrompt,
      sceneMetadata: args.sceneMetadata,
      rubric,
    });
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const usageOpts = {
      maxTokens: 1400,
      traceName: 'scene-view-quality-check',
      modelRole: 'frameConsistencyCheck' as const,
      responseFormat: 'json_object' as const,
      tokenContext: {
        ownerId: args.user.id,
        usernameSnapshot: args.user.phone || args.user.display_name || args.user.username || null,
        moduleKey: 'image',
        moduleLabel: '图片生成',
        featureKey: 'scene_view_quality_check',
        featureLabel: '场景副视图一致性评分',
        operationKey: args.tokenContext?.operationKey || args.tokenContext?.callItemId || undefined,
        operationLabel: args.tokenContext?.operationLabel || '场景副视图一致性评分',
        ...(args.tokenContext || {}),
        meta: {
          ...(args.tokenContext?.meta || {}),
          viewRole: args.viewRole,
          attempt: args.attempt || 0,
          referenceCount: 2,
        },
      },
    };
    const applyBudget = deps.applyTokenBudgetImpl || applyTokenBudget;
    const budgeted = applyBudget(modelCfg, messages, usageOpts, 'complete');
    const maxOutputTokens = budgeted.maxTokens ?? 1400;
    const requestTimeoutMs = timeoutMs();
    const postJson = deps.postJsonImpl || postJsonWithProxySupport;
    const observe = deps.observeTextModelCallImpl || observeTextModelCall;
    const imageUrls = [establishingPath, candidatePath].map(imagePathToDataUrl);
    let text = '';
    if (responsesProvider) {
      const body: any = {
        model: modelCfg.model,
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
      if (modelCfg.reasoningEffort) body.reasoning = { effort: modelCfg.reasoningEffort };
      const json = await observe(
        modelCfg,
        budgeted,
        () => postJson(
          `${modelCfg.baseUrl}${modelCfg.endpoint || '/responses'}`,
          modelCfg.apiKey,
          body,
          requestTimeoutMs,
          `场景副视图一致性评分超时（>${Math.round(requestTimeoutMs / 1000)}s 未返回）`,
        ),
      );
      text = extractResponsesText(json);
    } else {
      const json = await observe(
        modelCfg,
        budgeted,
        () => postJson(
          `${modelCfg.baseUrl}${modelCfg.endpoint || '/chat/completions'}`,
          modelCfg.apiKey,
          {
            model: modelCfg.model,
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
          `场景副视图一致性评分超时（>${Math.round(requestTimeoutMs / 1000)}s 未返回）`,
        ),
      );
      text = extractChatText(json);
    }
    const raw = parseJsonLoose<any>(text);
    return normalizeSceneViewQualityResult({
      raw,
      viewRole: args.viewRole,
      attempt: args.attempt || 0,
      model: modelCfg.model,
      provider: modelCfg.provider,
    });
  } catch (err: any) {
    return errorSceneViewQualityResult(args.viewRole, err, cfg);
  }
}
