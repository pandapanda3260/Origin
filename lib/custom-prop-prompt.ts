import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { UserRow } from './db';
import { buildAssetStyleLock } from './asset-style-lock';
import { applyTokenBudget, chatComplete, observeTextModelCall } from './llm';
import { resolveTextModelConfig } from './model-routing';
import { postJsonWithProxySupport } from './proxy-fetch';
import { getExternalEnvValue } from './env';
import { normalizePropDimensionality, type PropDimensionality } from './prop-views';
import type { TokenUsageContext } from './token-usage';

export type CustomPropSourceType = 'prompt' | 'image' | 'image_prompt';

export type CustomPropParams = {
  dimensionality?: 'auto' | PropDimensionality;
  propType?: string;
  material?: string;
};

function cleanText(value: any, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanStringArray(value: any, maxItems = 8) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，、/\n]/);
  return list.map((item) => cleanText(item, 24)).filter(Boolean).slice(0, maxItems);
}

export function normalizeCustomPropParams(raw: any): CustomPropParams {
  const dimensionalityRaw = String(raw?.dimensionality || raw?.dimension || 'auto').trim().toLowerCase();
  const dimensionality = dimensionalityRaw === 'flat' || dimensionalityRaw === 'volumetric' ? dimensionalityRaw : 'auto';
  return {
    dimensionality,
    propType: cleanText(raw?.propType ?? raw?.prop_type, 80),
    material: cleanText(raw?.material, 120),
  };
}

export function resolveCustomPropSourceType(prompt: string, hasImage: boolean): CustomPropSourceType {
  if (hasImage && prompt.trim()) return 'image_prompt';
  if (hasImage) return 'image';
  return 'prompt';
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

function parseJsonObject(text: string) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('没能从描述里整理出有效的道具信息，请把道具描述写得更具体一些再试一次');
    return JSON.parse(match[0]);
  }
}

export function toFriendlyPropError(error: any): string {
  if (error && error.userFacing && error.message) return String(error.message);
  const raw = String(error?.message || error || '').toLowerCase();
  const has = (...keys: string[]) => keys.some((key) => raw.includes(key));
  if (has('moderation', 'safety', 'blocked', 'flagged', 'policy', '敏感', '审核', '违规', '拦截')) {
    return '这次的内容可能触发了安全限制，换个道具描述或参考图再试一次通常就能通过。';
  }
  if (has('参考图') && has('不存在', '已删除', '已失效', 'not found')) {
    return '参考图好像已经失效了，请重新上传一张参考图后再试。';
  }
  if (has('不支持参考图', '参考图生成')) {
    return '当前所选的图片模型不支持“按参考图生成”，请在设置里切换到 gpt-image、dall-e-2 或 Seedream 图片模型后重试；或先不传参考图、改用纯文字描述来生成。';
  }
  if (has('不支持图片', '不支持识别图片', 'vision', 'multimodal')) {
    return '当前所选的文本模型不支持识别图片，请在设置里换成支持图片的模型，或先不传参考图、只用文字描述来生成。';
  }
  if (has('未配置', 'api key', 'apikey', 'api_key', '密钥', 'unauthorized', 'no key')) {
    return '生成服务还没配置好（缺少可用的模型或密钥），请联系管理员或在设置里检查模型配置。';
  }
  if (has('超时', 'timeout', 'timed out', 'etimedout')) return '这次处理超时了，可能是网络或模型比较繁忙，请稍后再试一次。';
  if (has('socket', 'econnreset', 'eai_again', 'fetch failed', 'network', 'tls', 'aborted', '网络', '连接')) return '网络连接不太稳定，请检查网络后再重试。';
  if (has('余额', '额度', 'credit', 'quota', 'insufficient', '欠费', 'balance')) return '账户额度可能不足了，请确认额度后再重试。';
  if (has('解析', 'json', 'parse')) return '没能从描述里整理出有效的道具信息，请把道具描述写得更具体一些再试一次。';
  return '这次道具没有生成成功，请稍后再试一次；如果多次失败，可以调整描述或更换参考图。';
}

function fallbackName(prompt: string) {
  const text = cleanText(prompt, 18);
  return text ? text.replace(/[，。,.！!？?].*$/, '').slice(0, 14) : '自定义道具';
}

function fallbackFields(prompt: string, params: CustomPropParams = {}, imageCaption = '') {
  const subject = cleanText(prompt || imageCaption || '根据输入创建的道具', 220);
  return normalizeCustomPropFields({
    name: fallbackName(subject),
    propType: params.propType || '道具',
    function: subject.slice(0, 120),
    features: subject,
    material: params.material || '',
    visualFeatures: subject,
    ownership: '',
    dimensionality: params.dimensionality || 'auto',
    description: subject || '根据输入生成的道具设定',
    tags: [],
    imagePrompt: subject || '清晰完整的道具参考图，主体完整，材质和结构细节明确',
  }, params);
}

const FIELD_SCHEMA_HINT = `
只输出 JSON 对象，不要 Markdown，不要解释：
{
  "name": "道具名",
  "propType": "道具类型",
  "function": "用途/功能，20-80 字",
  "features": "结构与关键特征，30-120 字",
  "material": "主要材质",
  "visualFeatures": "颜色、纹理、磨损、装饰等视觉特征，30-120 字",
  "ownership": "归属角色或组织，无则空字符串",
  "dimensionality": "flat 或 volumetric",
  "description": "整体道具描述，30-120 字，必须输出",
  "tags": ["标签"],
  "imagePrompt": "中文 45-140 字，只描述道具主体、形体、材质、颜色和细节，不写风格/背景/白底/六视图/reference sheet"
}`.trim();

export async function buildCustomPropFields(input: {
  user: UserRow;
  prompt: string;
  imagePath?: string | null;
  params?: CustomPropParams;
  sourceType?: CustomPropSourceType;
  tokenContext?: TokenUsageContext | null;
}) {
  const prompt = cleanText(input.prompt, 4000);
  const params = normalizeCustomPropParams(input.params || {});
  if (!input.imagePath) return structureTextProp(input.user, prompt, params, input.tokenContext || null);
  return structureVisionProp(input.user, input.imagePath, prompt, params, input.sourceType || 'image', input.tokenContext || null);
}

async function structureTextProp(
  user: UserRow,
  prompt: string,
  params: CustomPropParams,
  tokenContext: TokenUsageContext | null,
) {
  const cfg = resolveTextModelConfig(user, 'structured');
  if (cfg.mode === 'fake') return fallbackFields(prompt, params);
  const text = await chatComplete(user, [
    {
      role: 'system',
      content: '你是影视/短剧道具设定助手。把用户输入整理为可用于生成统一道具参考图的资产字段。',
    },
    {
      role: 'user',
      content: [
        `用户提示词：${prompt || '未填写'}`,
        `显式参数：${JSON.stringify(params)}`,
        FIELD_SCHEMA_HINT,
        '要求：description 必须有值；dimensionality 根据道具是否需要多角度一致性判断，立体物体用 volumetric，纯平面标志/贴纸/图案用 flat；imagePrompt 不得包含风格、背景、白底、六视图、reference sheet、UI、字幕或文字标识。',
      ].join('\n\n'),
    },
  ], {
    responseFormat: 'json_object',
    maxTokens: 1200,
    temperature: 0.2,
    traceName: 'custom-prop-fields',
    tokenContext: {
      ...(tokenContext || {}),
      ownerId: user.id,
      usernameSnapshot: user.phone || user.display_name || user.username || null,
      moduleKey: 'assets',
      moduleLabel: '资产生成',
      featureKey: 'custom_prop_fields',
      featureLabel: '自定义道具字段整理',
      operationKey: tokenContext?.operationKey || tokenContext?.callItemId || undefined,
      operationLabel: '自定义道具字段整理',
    },
  });
  return normalizeCustomPropFields(parseJsonObject(text), params);
}

async function structureVisionProp(
  user: UserRow,
  imagePath: string,
  prompt: string,
  params: CustomPropParams,
  sourceType: CustomPropSourceType,
  tokenContext: TokenUsageContext | null,
) {
  const cfg = resolveTextModelConfig(user, 'structured');
  if (cfg.mode === 'fake') throw new Error('当前结构化文本模型未配置，无法识别参考图道具');
  if (cfg.provider !== 'openai_responses' && cfg.provider !== 'packy_responses' && cfg.provider !== 'zerail_responses' && cfg.provider !== 'openai_chat') {
    throw new Error(`当前文本模型不支持图片识别：${cfg.provider}`);
  }
  const dataUrl = imagePathToDataUrl(imagePath);
  const referencePolicy = sourceType === 'image_prompt'
    ? '参考图是道具形体、结构、颜色、材质和装饰的主基准；用户补充提示词只修改明确提出的内容，未提及部分保持参考图。'
    : '用户未填写补充提示词；请以参考图为唯一主基准，整理图中真实可见的道具结构、材质、颜色和用途，不主动改造道具。';
  const textPrompt = [
    '请识别参考图中的主要道具，并整理为道具资产字段。只描述可见道具，不编造剧情。',
    referencePolicy,
    `显式参数：${JSON.stringify(params)}`,
    prompt ? `用户补充提示词：${prompt}` : '用户补充提示词：未填写',
    FIELD_SCHEMA_HINT,
    '要求：description 必须有值；dimensionality 根据参考图判断，立体物体用 volumetric，纯平面标志/贴纸/图案用 flat；imagePrompt 不得包含风格、背景、白底、六视图、reference sheet、UI、字幕或文字标识。',
  ].join('\n\n');
  const timeoutMs = Number(
    getExternalEnvValue('IMAGE_CAPTION_TIMEOUT_MS') ||
      getExternalEnvValue('ORIGIN_IMAGE_CAPTION_TIMEOUT_MS') ||
      process.env.IMAGE_CAPTION_TIMEOUT_MS ||
      process.env.ORIGIN_IMAGE_CAPTION_TIMEOUT_MS ||
      120_000,
  );
  const usageOpts = {
    maxTokens: 8192,
    traceName: 'custom-prop-vision',
    modelRole: 'structured' as const,
    tokenContext: {
      ownerId: user.id,
      usernameSnapshot: user.phone || user.display_name || user.username || null,
      moduleKey: 'assets',
      moduleLabel: '资产生成',
      featureKey: 'custom_prop_vision',
      featureLabel: '自定义道具参考图识别',
      operationKey: tokenContext?.operationKey || tokenContext?.callItemId || undefined,
      operationLabel: tokenContext?.operationLabel || '自定义道具参考图识别',
      ...(tokenContext || {}),
    },
  };
  const budgeted = applyTokenBudget(
    cfg,
    [{ role: 'user' as const, content: textPrompt }],
    usageOpts,
    'complete',
  );
  const maxOutputTokens = budgeted.maxTokens ?? 8192;
  let text = '';
  if (cfg.provider === 'openai_responses' || cfg.provider === 'packy_responses' || cfg.provider === 'zerail_responses') {
    const body: any = {
      model: cfg.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: textPrompt },
          { type: 'input_image', image_url: dataUrl },
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
        timeoutMs,
        `道具图片识别超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
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
              { type: 'text', text: textPrompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
          max_tokens: maxOutputTokens,
          temperature: 0.2,
          response_format: { type: 'json_object' },
        },
        timeoutMs,
        `道具图片识别超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
      ),
    );
    text = extractChatText(json);
  }
  if (!text.trim()) {
    const err: any = new Error('参考图识别这次没返回有效内容，请重试一次，或在提示词里补一句文字描述帮助识别。');
    err.userFacing = true;
    throw err;
  }
  return normalizeCustomPropFields(parseJsonObject(text), params);
}

export function normalizeCustomPropFields(raw: any, params: CustomPropParams = {}) {
  const description = cleanText(raw?.description, 300) || cleanText(raw?.imagePrompt, 220) || cleanText(raw?.features, 160);
  const tags = cleanStringArray(raw?.tags, 8);
  const dimensionalityParam = params.dimensionality === 'flat' || params.dimensionality === 'volumetric' ? params.dimensionality : undefined;
  const dimensionality = dimensionalityParam || normalizePropDimensionality(raw?.dimensionality ?? raw?.dimension, raw);
  const propType = cleanText(raw?.propType ?? raw?.prop_type, 80) || cleanText(params.propType, 80) || '道具';
  const material = cleanText(raw?.material, 120) || cleanText(params.material, 120);
  const imagePrompt = cleanText(raw?.imagePrompt, 1000) || [
    description,
    propType && `类型：${propType}`,
    material && `材质：${material}`,
    raw?.visualFeatures && `视觉细节：${cleanText(raw.visualFeatures, 160)}`,
  ].filter(Boolean).join('，');
  return {
    name: cleanText(raw?.name ?? raw?.title, 80) || fallbackName(description || imagePrompt),
    propType,
    function: cleanText(raw?.function ?? raw?.usage, 160),
    features: cleanText(raw?.features, 260) || description,
    material,
    visualFeatures: cleanText(raw?.visualFeatures ?? raw?.visual_features, 260),
    ownership: cleanText(raw?.ownership ?? raw?.owner, 100),
    dimensionality,
    description: description || '根据输入生成的道具设定',
    tags,
    imagePrompt,
  };
}

export function rebuildCustomPropImagePromptFromFields(fields: any) {
  const tags = cleanStringArray(fields?.tags, 8).join('，');
  const parts = [
    cleanText(fields?.name, 80) && `道具：${cleanText(fields?.name, 80)}`,
    cleanText(fields?.propType, 80) && `类型：${cleanText(fields?.propType, 80)}`,
    cleanText(fields?.description, 300),
    cleanText(fields?.function, 160) && `用途：${cleanText(fields?.function, 160)}`,
    cleanText(fields?.features, 260) && `结构特征：${cleanText(fields?.features, 260)}`,
    cleanText(fields?.material, 120) && `材质：${cleanText(fields?.material, 120)}`,
    cleanText(fields?.visualFeatures, 260) && `视觉细节：${cleanText(fields?.visualFeatures, 260)}`,
    tags && `标签：${tags}`,
  ].filter(Boolean);
  return cleanText(parts.join('，'), 1000);
}

export function normalizeCustomPropEditableFields(previous: any, patch: any) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const raw = patch && typeof patch === 'object' ? patch : {};
  const next: any = { ...prev };
  const stringFields: Array<[string, number]> = [
    ['name', 80],
    ['propType', 80],
    ['function', 160],
    ['features', 260],
    ['material', 120],
    ['visualFeatures', 260],
    ['ownership', 100],
    ['description', 300],
  ];
  for (const [key, max] of stringFields) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) next[key] = cleanText(raw[key], max);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'dimensionality')) {
    next.dimensionality = normalizePropDimensionality(raw.dimensionality, next);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'tags')) next.tags = cleanStringArray(raw.tags, 8);
  next.imagePrompt = rebuildCustomPropImagePromptFromFields(next);
  return next;
}

function propMetadata(fields: any): string[] {
  const parts: string[] = [];
  if (fields?.propType) parts.push(`Prop type: ${fields.propType}.`);
  if (fields?.function) parts.push(`Function / usage: ${fields.function}.`);
  if (fields?.features) parts.push(`Structural features: ${fields.features}.`);
  if (fields?.material) parts.push(`Materials: ${fields.material}.`);
  if (fields?.visualFeatures) parts.push(`Visual details: ${fields.visualFeatures}.`);
  if (fields?.ownership) parts.push(`Ownership / association: ${fields.ownership}.`);
  return parts;
}

export function buildCustomPropImagePrompt(input: {
  fields: any;
  styleBible?: any;
  sourceType?: CustomPropSourceType;
}) {
  const fields = input.fields || {};
  const hasReference = input.sourceType === 'image' || input.sourceType === 'image_prompt';
  const dimensionality = normalizePropDimensionality(fields?.dimensionality, fields);
  const styleLockContext = buildAssetStyleLock(input.styleBible || {}, 'prop');
  let prompt = cleanText(fields.imagePrompt, 1600) || rebuildCustomPropImagePromptFromFields(fields);
  const meta = propMetadata(fields);
  if (meta.length) {
    prompt = `${prompt}\n\n=== PROP METADATA (must reflect in image, override conflicting hints above) ===\n${meta.join('\n')}`;
  }
  if (hasReference) {
    prompt = `${prompt}\n\n=== REFERENCE PRESERVATION LOCK ===\nUse the uploaded reference image as the primary prop identity baseline. Preserve visible silhouette, construction, colors, materials, markings, wear, and functional details unless the user prompt explicitly changes that trait.`;
  }
  if (dimensionality === 'volumetric') {
    prompt = `${prompt}\n\n=== PROP SHEET FORMAT ===\nGenerate one clean 3x2 prop reference sheet for the same single prop, with six separated views: 3/4 hero, front, back, left side, right side, and top. Keep the prop identity, proportions, colors, material, markings, and wear consistent across every cell. No labels, no UI, no text, no extra objects.`;
  } else {
    prompt = `${prompt}\n\n=== PROP IMAGE FORMAT ===\nGenerate one clean single-image prop reference. Show the complete prop clearly. Do not create a multi-view sheet, collage, labels, UI, or text overlay.`;
  }
  if (styleLockContext.prompt) prompt = `${prompt}\n\n${styleLockContext.prompt}`;
  return { prompt, styleLockContext, dimensionality };
}

export function fingerprintCustomPropInput(value: any) {
  return createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}
