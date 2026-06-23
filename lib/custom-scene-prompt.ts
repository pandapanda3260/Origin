import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { UserRow } from './db';
import { buildAssetStyleLock } from './asset-style-lock';
import { applyTokenBudget, chatComplete, observeTextModelCall } from './llm';
import { resolveTextModelConfig } from './model-routing';
import { postJsonWithProxySupport } from './proxy-fetch';
import { getExternalEnvValue } from './env';
import type { TokenUsageContext } from './token-usage';
import type { SceneViewRole } from './scene-views';

export type CustomSceneSourceType = 'prompt' | 'image' | 'image_prompt';

export type CustomSceneParams = {
  timeSetting?: string;
  weather?: string;
  lighting?: string;
  atmosphere?: string;
};

function cleanText(value: any, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanStringArray(value: any, maxItems = 10) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，、/\n]/);
  return list.map((item) => cleanText(item, 32)).filter(Boolean).slice(0, maxItems);
}

export function normalizeCustomSceneParams(raw: any): CustomSceneParams {
  return {
    timeSetting: cleanText(raw?.timeSetting ?? raw?.time_setting, 80),
    weather: cleanText(raw?.weather, 80),
    lighting: cleanText(raw?.lighting, 120),
    atmosphere: cleanText(raw?.atmosphere, 120),
  };
}

export function resolveCustomSceneSourceType(prompt: string, hasImage: boolean): CustomSceneSourceType {
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
    if (!match) throw new Error('没能从描述里整理出有效的场景信息，请把场景描述写得更具体一些再试一次');
    return JSON.parse(match[0]);
  }
}

export function toFriendlySceneError(error: any): string {
  if (error && error.userFacing && error.message) return String(error.message);
  const raw = String(error?.message || error || '').toLowerCase();
  const has = (...keys: string[]) => keys.some((key) => raw.includes(key));
  if (has('moderation', 'safety', 'blocked', 'flagged', 'policy', '敏感', '审核', '违规', '拦截')) {
    return '这次的内容可能触发了安全限制，换个场景描述或参考图再试一次通常就能通过。';
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
  if (has('解析', 'json', 'parse')) return '没能从描述里整理出有效的场景信息，请把场景描述写得更具体一些再试一次。';
  return '这次场景没有生成成功，请稍后再试一次；如果多次失败，可以调整描述或更换参考图。';
}

function fallbackName(prompt: string) {
  const text = cleanText(prompt, 18);
  return text ? text.replace(/[，。,.！!？?].*$/, '').slice(0, 14) : '自定义场景';
}

function fallbackFields(prompt: string, params: CustomSceneParams = {}, imageCaption = '') {
  const subject = cleanText(prompt || imageCaption || '根据输入创建的场景', 220);
  return normalizeCustomSceneFields({
    name: fallbackName(subject),
    location: subject.slice(0, 80) || '未指定地点',
    description: subject || '根据输入生成的场景设定',
    timeSetting: params.timeSetting || '',
    weather: params.weather || '',
    lighting: params.lighting || '',
    atmosphere: params.atmosphere || '',
    elements: [],
    imagePrompt: subject || '清晰完整的影视场景环境参考图，空间结构明确，关键环境元素可识别',
  }, params);
}

const FIELD_SCHEMA_HINT = `
只输出 JSON 对象，不要 Markdown，不要解释：
{
  "name": "场景名",
  "location": "地点/空间类型",
  "description": "整体场景描述，30-100 字，必须输出",
  "timeSetting": "时段，例如 清晨 / 黄昏 / 深夜 / 正午",
  "weather": "天气或环境状态，无则空字符串",
  "lighting": "灯光方向和质感，20-80 字",
  "atmosphere": "氛围关键词，中文逗号分隔",
  "elements": ["关键环境元素"],
  "imagePrompt": "中文 45-120 字，只描述场景空间、构图主体、环境元素和空间关系，不写四视图、不写参考图、不写UI文字"
}`.trim();

export async function buildCustomSceneFields(input: {
  user: UserRow;
  prompt: string;
  imagePath?: string | null;
  params?: CustomSceneParams;
  sourceType?: CustomSceneSourceType;
  tokenContext?: TokenUsageContext | null;
}) {
  const prompt = cleanText(input.prompt, 4000);
  const params = normalizeCustomSceneParams(input.params || {});
  if (!input.imagePath) return structureTextScene(input.user, prompt, params, input.tokenContext || null);
  return structureVisionScene(input.user, input.imagePath, prompt, params, input.sourceType || 'image', input.tokenContext || null);
}

async function structureTextScene(
  user: UserRow,
  prompt: string,
  params: CustomSceneParams,
  tokenContext: TokenUsageContext | null,
) {
  const cfg = resolveTextModelConfig(user, 'structured');
  if (cfg.mode === 'fake') return fallbackFields(prompt, params);
  const text = await chatComplete(user, [
    {
      role: 'system',
      content: '你是影视/短剧场景设定助手。把用户输入整理为可用于生成统一场景参考图的资产字段。',
    },
    {
      role: 'user',
      content: [
        `用户提示词：${prompt || '未填写'}`,
        `显式参数：${JSON.stringify(params)}`,
        FIELD_SCHEMA_HINT,
        '要求：description 必须有值；imagePrompt 不得包含风格、模型名、四视图、俯视图、reference sheet、UI、字幕或文字标识；如果用户给了时段/天气/灯光/氛围，必须反映到字段中。',
      ].join('\n\n'),
    },
  ], {
    responseFormat: 'json_object',
    maxTokens: 1200,
    temperature: 0.2,
    traceName: 'custom-scene-fields',
    tokenContext: {
      ...(tokenContext || {}),
      ownerId: user.id,
      usernameSnapshot: user.phone || user.display_name || user.username || null,
      moduleKey: 'assets',
      moduleLabel: '资产生成',
      featureKey: 'custom_scene_fields',
      featureLabel: '自定义场景字段整理',
      operationKey: tokenContext?.operationKey || tokenContext?.callItemId || undefined,
      operationLabel: '自定义场景字段整理',
    },
  });
  return normalizeCustomSceneFields(parseJsonObject(text), params);
}

async function structureVisionScene(
  user: UserRow,
  imagePath: string,
  prompt: string,
  params: CustomSceneParams,
  sourceType: CustomSceneSourceType,
  tokenContext: TokenUsageContext | null,
) {
  const cfg = resolveTextModelConfig(user, 'visionExtract');
  if (cfg.mode === 'fake') throw new Error('当前结构化文本模型未配置，无法识别参考图场景');
  if (cfg.provider !== 'openai_responses' && cfg.provider !== 'packy_responses' && cfg.provider !== 'zerail_responses' && cfg.provider !== 'openai_chat') {
    throw new Error(`当前文本模型不支持图片识别：${cfg.provider}`);
  }
  const dataUrl = imagePathToDataUrl(imagePath);
  const referencePolicy = sourceType === 'image_prompt'
    ? '参考图是空间结构、主要元素、材质和色调的主基准；用户补充提示词只修改明确提出的内容，未提及部分保持参考图。'
    : '用户未填写补充提示词；请以参考图为唯一主基准，整理图中真实可见的空间、元素、光线和氛围，不主动改造场景。';
  const textPrompt = [
    '请识别参考图中的主要场景，并整理为场景资产字段。只描述可见空间，不编造剧情。',
    referencePolicy,
    `显式参数：${JSON.stringify(params)}`,
    prompt ? `用户补充提示词：${prompt}` : '用户补充提示词：未填写',
    FIELD_SCHEMA_HINT,
    '要求：description 必须有值；imagePrompt 不得包含风格、模型名、四视图、俯视图、reference sheet、UI、字幕或文字标识；优先保留参考图中可见的空间布局、关键元素、材质、色调和光线。',
  ].join('\n\n');
  const timeoutMs = Number(
    getExternalEnvValue('IMAGE_CAPTION_TIMEOUT_MS') ||
      getExternalEnvValue('ORIGIN_IMAGE_CAPTION_TIMEOUT_MS') ||
      process.env.IMAGE_CAPTION_TIMEOUT_MS ||
      process.env.ORIGIN_IMAGE_CAPTION_TIMEOUT_MS ||
      120_000,
  );
  const usageOpts = {
    maxTokens: 1600,
    traceName: 'custom-scene-vision',
    modelRole: 'visionExtract' as const,
    tokenContext: {
      ownerId: user.id,
      usernameSnapshot: user.phone || user.display_name || user.username || null,
      moduleKey: 'assets',
      moduleLabel: '资产生成',
      featureKey: 'custom_scene_vision',
      featureLabel: '自定义场景参考图识别',
      operationKey: tokenContext?.operationKey || tokenContext?.callItemId || undefined,
      operationLabel: tokenContext?.operationLabel || '自定义场景参考图识别',
      ...(tokenContext || {}),
    },
  };
  const budgeted = applyTokenBudget(
    cfg,
    [{ role: 'user' as const, content: textPrompt }],
    usageOpts,
    'complete',
  );
  const maxOutputTokens = budgeted.maxTokens ?? 1600;
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
        `场景图片识别超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
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
        `场景图片识别超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
      ),
    );
    text = extractChatText(json);
  }
  if (!text.trim()) {
    const err: any = new Error('参考图识别这次没返回有效内容，请重试一次，或在提示词里补一句文字描述帮助识别。');
    err.userFacing = true;
    throw err;
  }
  return normalizeCustomSceneFields(parseJsonObject(text), params);
}

export function normalizeCustomSceneFields(raw: any, params: CustomSceneParams = {}) {
  const description = cleanText(raw?.description, 300) || cleanText(raw?.imagePrompt, 220) || cleanText(raw?.location, 120);
  const elements = cleanStringArray(raw?.elements, 10);
  const imagePrompt = cleanText(raw?.imagePrompt, 800) || [
    description,
    raw?.location && `地点：${cleanText(raw.location, 120)}`,
    elements.length ? `关键元素：${elements.join('，')}` : '',
  ].filter(Boolean).join('，');
  return {
    name: cleanText(raw?.name ?? raw?.title, 80) || fallbackName(description || imagePrompt),
    location: cleanText(raw?.location, 120) || '未指定地点',
    description: description || '根据输入生成的场景设定',
    timeSetting: cleanText(raw?.timeSetting ?? raw?.time_setting, 80) || cleanText(params.timeSetting, 80),
    weather: cleanText(raw?.weather, 80) || cleanText(params.weather, 80),
    lighting: cleanText(raw?.lighting, 160) || cleanText(params.lighting, 120),
    atmosphere: cleanText(raw?.atmosphere, 160) || cleanText(params.atmosphere, 120),
    elements,
    imagePrompt,
  };
}

export function rebuildCustomSceneImagePromptFromFields(fields: any) {
  const elements = cleanStringArray(fields?.elements, 10).join('，');
  const parts = [
    cleanText(fields?.name, 80) && `场景：${cleanText(fields?.name, 80)}`,
    cleanText(fields?.location, 120) && `地点：${cleanText(fields?.location, 120)}`,
    cleanText(fields?.description, 300),
    cleanText(fields?.timeSetting, 80) && `时段：${cleanText(fields?.timeSetting, 80)}`,
    cleanText(fields?.weather, 80) && `天气：${cleanText(fields?.weather, 80)}`,
    cleanText(fields?.lighting, 160) && `灯光：${cleanText(fields?.lighting, 160)}`,
    cleanText(fields?.atmosphere, 160) && `氛围：${cleanText(fields?.atmosphere, 160)}`,
    elements && `关键元素：${elements}`,
  ].filter(Boolean);
  return cleanText(parts.join('，'), 800);
}

export function normalizeCustomSceneEditableFields(previous: any, patch: any) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const raw = patch && typeof patch === 'object' ? patch : {};
  const next: any = { ...prev };
  const stringFields: Array<[string, number]> = [
    ['name', 80],
    ['location', 120],
    ['description', 300],
    ['timeSetting', 80],
    ['weather', 80],
    ['lighting', 160],
    ['atmosphere', 160],
  ];
  for (const [key, max] of stringFields) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) next[key] = cleanText(raw[key], max);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'elements')) next.elements = cleanStringArray(raw.elements, 10);
  next.imagePrompt = rebuildCustomSceneImagePromptFromFields(next);
  return next;
}

function sceneMetadata(fields: any) {
  const parts: string[] = [];
  if (fields?.location) parts.push(`Location context: ${fields.location}.`);
  if (fields?.timeSetting) parts.push(`Time of day: ${fields.timeSetting} — lighting and shadows must match this time.`);
  if (fields?.weather) parts.push(`Weather: ${fields.weather}.`);
  if (fields?.lighting) parts.push(`Lighting style: ${fields.lighting}.`);
  if (fields?.atmosphere) parts.push(`Atmosphere / mood keywords (the image must feel like these): ${fields.atmosphere}.`);
  if (Array.isArray(fields?.elements) && fields.elements.length) parts.push(`Key elements that must appear: ${fields.elements.join(', ')}.`);
  return parts;
}

function sceneViewInstruction(role: SceneViewRole) {
  if (role === 'topdown') {
    return [
      '=== SCENE VIEW ROLE: TOPDOWN ===',
      'Generate a clean overhead/top-down spatial layout view of the same scene.',
      'Preserve the same room/site footprint, entrances, major objects, terrain, pathways, and relative positions from the establishing reference.',
      'This is a usable layout anchor, not an abstract map and not a UI diagram.',
    ].join('\n');
  }
  if (role === 'reverse') {
    return [
      '=== SCENE VIEW ROLE: REVERSE ===',
      'Generate the reverse 180-degree view of the same scene.',
      'Use Image 1 as the establishing visual anchor. If Image 2 is provided, use it as the top-down layout anchor.',
      'Preserve scene identity, materials, key objects, lighting logic, weather, and spatial continuity.',
    ].join('\n');
  }
  if (role === 'alt') {
    return [
      '=== SCENE VIEW ROLE: ALT SIDE VIEW ===',
      'Generate an alternate side / diagonal angle of the same scene.',
      'Use Image 1 as the establishing visual anchor. If Image 2 is provided, use it as the top-down layout anchor.',
      'Preserve scene identity, materials, key objects, lighting logic, weather, and spatial continuity.',
    ].join('\n');
  }
  return [
    '=== SCENE VIEW ROLE: ESTABLISHING ===',
    'Generate a wide establishing scene reference image with clear spatial depth and identifiable key elements.',
    'Do not create a collage, UI, text overlay, map, blueprint, or multi-view sheet.',
  ].join('\n');
}

export function buildCustomSceneImagePrompt(input: {
  fields: any;
  styleBible?: any;
  viewRole?: SceneViewRole;
  sourceType?: CustomSceneSourceType;
}) {
  const fields = input.fields || {};
  const viewRole = input.viewRole || 'establishing';
  const hasReference = input.sourceType === 'image' || input.sourceType === 'image_prompt' || viewRole !== 'establishing';
  const styleLockContext = buildAssetStyleLock(input.styleBible || {}, 'scene');
  let prompt = cleanText(fields.imagePrompt, 1600) || rebuildCustomSceneImagePromptFromFields(fields);
  const meta = sceneMetadata(fields);
  if (meta.length) {
    prompt = `${prompt}\n\n=== SCENE METADATA (must reflect in image, override conflicting hints above) ===\n${meta.join('\n')}`;
  }
  if (hasReference && viewRole === 'establishing') {
    prompt = `${prompt}\n\n=== REFERENCE PRESERVATION LOCK ===\nUse the uploaded reference image as the primary spatial, material, color, and atmosphere baseline. Preserve visible architecture, terrain, object layout, weather, lighting direction, and mood unless the user prompt explicitly changes that trait.`;
  }
  prompt = `${prompt}\n\n${sceneViewInstruction(viewRole)}`;
  if (styleLockContext.prompt) prompt = `${prompt}\n\n${styleLockContext.prompt}`;
  return { prompt, styleLockContext };
}

export function sceneQualityMetadata(fields: any): string {
  return sceneMetadata(fields).join('\n');
}

export function fingerprintCustomSceneInput(value: any) {
  return createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}
