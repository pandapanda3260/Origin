import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { UserRow } from './db';
import { buildAssetStyleLock } from './asset-style-lock';
import { appendCharacterCastingPrompt } from './casting-profile';
import { applyTokenBudget, chatComplete } from './llm';
import { resolveTextModelConfig } from './model-routing';
import { postJsonWithProxySupport } from './proxy-fetch';
import { getExternalEnvValue } from './env';

export type CustomCharacterEntityType = 'auto' | 'human' | 'non-human';
type ResolvedCustomCharacterEntityType = 'human' | 'non-human';
export type CustomCharacterSourceType = 'prompt' | 'image' | 'image_prompt';

export type CustomCharacterParams = {
  entityType: CustomCharacterEntityType;
  gender: 'auto' | 'male' | 'female' | 'unspecified';
  ageRange: 'auto' | 'teen' | 'young' | 'middle' | 'elder' | 'unspecified';
};

const DEFAULT_PARAMS: CustomCharacterParams = {
  entityType: 'auto',
  gender: 'auto',
  ageRange: 'auto',
};

function cleanText(value: any, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEntityType(value: any): CustomCharacterEntityType {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'auto' || text === '自动' || text === '自动识别') return 'auto';
  if (text === 'non-human' || text === 'nonhuman' || text.includes('非人')) return 'non-human';
  return 'human';
}

function normalizeResolvedEntityType(value: any): ResolvedCustomCharacterEntityType {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'non-human' || text === 'nonhuman' || text.includes('非人')) return 'non-human';
  return 'human';
}

function resolveEntityTypeFromFields(raw: any, params: CustomCharacterParams): ResolvedCustomCharacterEntityType {
  if (params.entityType !== 'auto') return params.entityType;
  return normalizeResolvedEntityType(raw?.entityType ?? raw?.entity_type);
}

function normalizeGender(value: any): CustomCharacterParams['gender'] {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'auto' || text === '自动' || text === '自动识别') return 'auto';
  if (text === 'male' || text === '男') return 'male';
  if (text === 'female' || text === '女') return 'female';
  return 'unspecified';
}

function normalizeAgeRange(value: any): CustomCharacterParams['ageRange'] {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'auto' || text === '自动' || text === '自动识别') return 'auto';
  if (text === 'teen' || text === '少年') return 'teen';
  if (text === 'middle' || text === '中年') return 'middle';
  if (text === 'elder' || text === '老年') return 'elder';
  if (text === 'unspecified' || text === '不限定') return 'unspecified';
  return 'young';
}

export function normalizeCustomCharacterParams(raw: any): CustomCharacterParams {
  return {
    entityType: normalizeEntityType(raw?.entityType ?? raw?.entity_type ?? DEFAULT_PARAMS.entityType),
    gender: normalizeGender(raw?.gender ?? DEFAULT_PARAMS.gender),
    ageRange: normalizeAgeRange(raw?.ageRange ?? raw?.age_range ?? DEFAULT_PARAMS.ageRange),
  };
}

export function resolveCustomCharacterSourceType(prompt: string, hasImage: boolean): CustomCharacterSourceType {
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
    if (!match) throw new Error('没能从描述里整理出有效的角色信息，请把角色描述写得更具体一些再试一次');
    return JSON.parse(match[0]);
  }
}

/**
 * 把底层报错（模型 / 网络 / 审核 / 配置等）翻译成普通用户能看懂的提示文案。
 * 已经是面向用户的报错（error.userFacing）直接透传；其余按关键词归类兜底。
 * 注意：原始报错仍应单独保留（日志 / rawMessage）以便排查。
 */
export function toFriendlyCharacterError(error: any): string {
  if (error && error.userFacing && error.message) return String(error.message);
  const raw = String(error?.message || error || '').toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => raw.includes(k));
  if (has('moderation', 'safety', 'blocked', 'flagged', 'policy', '敏感', '审核', '违规', '拦截')) {
    return '这次的内容可能触发了安全限制，换个角色描述或参考图再试一次通常就能通过。';
  }
  if (has('参考图') && has('不存在', '已删除', '已失效', 'not found')) {
    return '参考图好像已经失效了，请重新上传一张参考图后再试。';
  }
  if (has('不支持参考图', '参考图生成')) {
    return '当前所选的图片模型不支持“按参考图生成”，请在设置里切换到 gpt-image、dall-e-2 或 Seedream 这类支持参考图的图片模型后再试；或先不传参考图、改用纯文字描述来生成。';
  }
  if (has('不支持图片', '不支持识别图片', 'vision', 'multimodal')) {
    return '当前所选的文本模型不支持识别图片，请在设置里换成支持图片的模型，或先不传参考图、只用文字描述来生成。';
  }
  if (has('未配置', 'api key', 'apikey', 'api_key', '密钥', 'unauthorized', 'no key')) {
    return '生成服务还没配置好（缺少可用的模型或密钥），请联系管理员或在设置里检查模型配置。';
  }
  if (has('超时', 'timeout', 'timed out', 'etimedout')) {
    return '这次处理超时了，可能是网络或模型比较繁忙，请稍后再试一次。';
  }
  if (has('socket', 'econnreset', 'eai_again', 'fetch failed', 'network', 'tls', 'aborted', '网络', '连接')) {
    return '网络连接不太稳定，请检查网络后再重试。';
  }
  if (has('余额', '额度', 'credit', 'quota', 'insufficient', '欠费', 'balance')) {
    return '账户额度可能不足了，请确认额度后再重试。';
  }
  if (has('解析', 'json', 'parse')) {
    return '没能从描述里整理出有效的角色信息，请把角色描述写得更具体一些再试一次。';
  }
  return '这次角色没有生成成功，请稍后再试一次；如果多次失败，可以调整描述或更换参考图。';
}

function paramsHint(params: CustomCharacterParams) {
  return [
    `实体类型：${params.entityType === 'auto' ? '自动识别' : params.entityType === 'non-human' ? '非人' : '真人'}`,
    `性别呈现：${params.gender === 'auto' ? '自动识别' : params.gender === 'male' ? '男' : params.gender === 'female' ? '女' : '不限定'}`,
    `年龄段：${params.ageRange === 'auto' ? '自动识别' : params.ageRange === 'teen' ? '少年' : params.ageRange === 'middle' ? '中年' : params.ageRange === 'elder' ? '老年' : params.ageRange === 'unspecified' ? '不限定' : '青年'}`,
  ].join('；');
}

function fallbackName(prompt: string, params: CustomCharacterParams) {
  if (params.entityType === 'non-human') return '自定义非人角色';
  const text = cleanText(prompt, 16);
  return text ? text.replace(/[，。,.！!？?].*$/, '').slice(0, 12) : '自定义角色';
}

function fallbackFields(prompt: string, params: CustomCharacterParams, imageCaption = '') {
  const subject = cleanText(prompt || imageCaption || '根据输入创建的角色', 180);
  const genderText = params.gender === 'male' ? '男性' : params.gender === 'female' ? '女性' : '';
  const ageText = params.ageRange === 'teen' ? '少年' : params.ageRange === 'middle' ? '中年' : params.ageRange === 'elder' ? '老年' : '';
  const entityType: ResolvedCustomCharacterEntityType = params.entityType === 'non-human' ? 'non-human' : 'human';
  return normalizeCustomCharacterFields({
    name: fallbackName(prompt || imageCaption, params),
    role: entityType === 'non-human' ? '非人叙事实体' : '自定义角色',
    identity: subject.slice(0, 40) || '可用于项目创作的角色参考',
    entityType,
    appearance: [ageText, genderText, subject].filter(Boolean).join('，').slice(0, 120),
    description: subject || '根据输入生成的角色设定',
    clothing: entityType === 'non-human' ? '' : '服装与整体气质遵循输入描述',
    equipment: '',
    temperament: '稳定, 鲜明, 可识别',
    actionTraits: '中性站姿, 正面凝视',
    tags: params.entityType === 'auto' ? [] : [entityType === 'non-human' ? '非人' : '真人'],
    imagePrompt: subject || '清晰可识别的角色主体，正面中性站姿，外貌和服装细节明确',
  }, params);
}

const FIELD_SCHEMA_HINT = `
只输出 JSON 对象，不要 Markdown，不要解释：
{
  "name": "角色名",
  "role": "在故事或创作中的身份角色",
  "identity": "一句话身份定位",
  "entityType": "human 或 non-human",
  "appearance": "外貌描述，30-80 字",
  "description": "整体角色描述，30-80 字，必须输出",
  "clothing": "服装描述，20-60 字；非人无服装可为空字符串",
  "castingOverride": {},
  "equipment": "随身物品，无则空字符串",
  "temperament": "中文逗号分隔的 3-5 个气质标签",
  "actionTraits": "中文逗号分隔的 2-4 个动作特征",
  "tags": ["标签"],
  "imagePrompt": "中文 35-90 字，只描述主体外貌、服装、姿态，不写风格/光线/背景/三视图/reference sheet"
}`.trim();

export async function buildCustomCharacterFields(input: {
  user: UserRow;
  prompt: string;
  imagePath?: string | null;
  params: CustomCharacterParams;
  sourceType?: CustomCharacterSourceType;
}) {
  const prompt = cleanText(input.prompt, 4000);
  if (!input.imagePath) {
    return structureTextCharacter(input.user, prompt, input.params);
  }
  return structureVisionCharacter(input.user, input.imagePath, prompt, input.params, input.sourceType || 'image');
}

async function structureTextCharacter(user: UserRow, prompt: string, params: CustomCharacterParams) {
  const cfg = resolveTextModelConfig(user, 'structured');
  if (cfg.mode === 'fake') return fallbackFields(prompt, params);
  const text = await chatComplete(user, [
    {
      role: 'system',
      content: '你是影视/短剧角色设定助手。把用户输入整理为角色资产字段，字段要适合生成统一角色 reference sheet。',
    },
    {
      role: 'user',
      content: [
        `基础参数：${paramsHint(params)}`,
        `用户提示词：${prompt || '未填写'}`,
        FIELD_SCHEMA_HINT,
        '要求：基础参数为“自动识别”时，由用户提示词判断；基础参数为明确值时，作为用户显式约束；description 必须有值；imagePrompt 不得包含风格、背景、白底、三视图、四视图等格式规则。',
      ].join('\n\n'),
    },
  ], {
    responseFormat: 'json_object',
    maxTokens: 1200,
    temperature: 0.2,
    traceName: 'custom-character-fields',
  });
  return normalizeCustomCharacterFields(parseJsonObject(text), params);
}

async function structureVisionCharacter(user: UserRow, imagePath: string, prompt: string, params: CustomCharacterParams, sourceType: CustomCharacterSourceType) {
  const cfg = resolveTextModelConfig(user, 'structured');
  if (cfg.mode === 'fake') throw new Error('当前结构化文本模型未配置，无法识别参考图角色');
  if (cfg.provider !== 'openai_responses' && cfg.provider !== 'packy_responses' && cfg.provider !== 'zerail_responses' && cfg.provider !== 'openai_chat') {
    throw new Error(`当前文本模型不支持图片识别：${cfg.provider}`);
  }
  const dataUrl = imagePathToDataUrl(imagePath);
  const referencePolicy = sourceType === 'image_prompt'
    ? '参考图是角色身份、外貌、服装、材质和气质的主基准；用户补充提示词只修改明确提出的内容，未提及部分必须保持参考图。'
    : '用户未填写补充提示词；请以参考图为唯一主基准，高度还原图中角色，不主动改变身份、外貌、服装、颜色、材质和气质。';
  const textPrompt = [
    '请识别参考图中的主要角色，并整理为角色资产字段。只描述可见角色，不编造剧情。',
    referencePolicy,
    `基础参数：${paramsHint(params)}`,
    prompt ? `用户补充提示词：${prompt}` : '用户补充提示词：未填写',
    FIELD_SCHEMA_HINT,
    '要求：基础参数为“自动识别”时，由参考图判断；基础参数为明确值时，作为用户显式约束；description 必须有值；imagePrompt 不得包含风格、背景、白底、三视图、四视图等格式规则。',
  ].join('\n\n');
  const timeoutMs = Number(
    getExternalEnvValue('IMAGE_CAPTION_TIMEOUT_MS') ||
      getExternalEnvValue('ORIGIN_IMAGE_CAPTION_TIMEOUT_MS') ||
      process.env.IMAGE_CAPTION_TIMEOUT_MS ||
      process.env.ORIGIN_IMAGE_CAPTION_TIMEOUT_MS ||
      120_000,
  );
  // 走统一预算层决定输出 token 上限：推理模型会按 reasoning reserve 预留思考额度，
  // 避免“思考占满固定额度 → 正文为空 → JSON 解析失败”这类偶发失败（原来这里硬编码 1400）。
  const budgeted = applyTokenBudget(
    cfg,
    [{ role: 'user' as const, content: textPrompt }],
    { maxTokens: 8192, traceName: 'custom-character-vision', modelRole: 'structured' },
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
    const json = await postJsonWithProxySupport(
      `${cfg.baseUrl}${cfg.endpoint || '/responses'}`,
      cfg.apiKey,
      body,
      timeoutMs,
      `角色图片识别超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
    );
    text = extractResponsesText(json);
  } else {
    const json = await postJsonWithProxySupport(
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
      `角色图片识别超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
    );
    text = extractChatText(json);
  }
  if (!text.trim()) {
    const err: any = new Error('参考图识别这次没返回有效内容，请重试一次，或在提示词里补一句文字描述帮助识别。');
    err.userFacing = true;
    throw err;
  }
  return normalizeCustomCharacterFields(parseJsonObject(text), params);
}

export function normalizeCustomCharacterFields(raw: any, params: CustomCharacterParams) {
  const entityType = resolveEntityTypeFromFields(raw, params);
  const appearance = cleanText(raw?.appearance, 240);
  const description = cleanText(raw?.description, 240) || appearance || cleanText(raw?.imagePrompt, 180);
  const clothing = cleanText(raw?.clothing, 180);
  const equipment = cleanText(raw?.equipment, 160);
  const imagePrompt = cleanText(raw?.imagePrompt, 500) || [appearance, description, clothing, equipment].filter(Boolean).join('，');
  const tags = Array.isArray(raw?.tags)
    ? raw.tags.map((t: any) => cleanText(t, 24)).filter(Boolean).slice(0, 8)
    : [];
  return {
    name: cleanText(raw?.name, 60) || fallbackName(imagePrompt, params),
    role: cleanText(raw?.role, 80) || (entityType === 'non-human' ? '非人叙事实体' : '自定义角色'),
    identity: cleanText(raw?.identity, 100) || description.slice(0, 60) || '可用于项目创作的角色参考',
    entityType,
    appearance,
    description,
    clothing,
    castingOverride: raw?.castingOverride && typeof raw.castingOverride === 'object' ? raw.castingOverride : {},
    equipment,
    temperament: cleanText(raw?.temperament, 120),
    actionTraits: cleanText(raw?.actionTraits, 120),
    tags,
    imagePrompt,
  };
}

function cleanStringArray(value: any, maxItems = 8) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，、/\n]/);
  return list.map((item) => cleanText(item, 24)).filter(Boolean).slice(0, maxItems);
}

export function rebuildCustomCharacterImagePromptFromFields(fields: any) {
  const tags = cleanStringArray(fields?.tags, 8).join('，');
  const parts = [
    cleanText(fields?.name, 60) && `角色：${cleanText(fields?.name, 60)}`,
    cleanText(fields?.appearance, 240),
    cleanText(fields?.description, 240),
    cleanText(fields?.clothing, 180) && `服装：${cleanText(fields?.clothing, 180)}`,
    cleanText(fields?.equipment, 160) && `携带/穿戴：${cleanText(fields?.equipment, 160)}`,
    tags && `标签：${tags}`,
    cleanText(fields?.temperament, 120) && `气质：${cleanText(fields?.temperament, 120)}`,
    cleanText(fields?.actionTraits, 120) && `动作特征：${cleanText(fields?.actionTraits, 120)}`,
  ].filter(Boolean);
  return cleanText(parts.join('，'), 500);
}

export function normalizeCustomCharacterEditableFields(previous: any, patch: any) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const raw = patch && typeof patch === 'object' ? patch : {};
  const next: any = { ...prev };
  const stringFields: Array<[string, number]> = [
    ['name', 60],
    ['role', 80],
    ['identity', 100],
    ['appearance', 240],
    ['description', 240],
    ['clothing', 180],
    ['equipment', 160],
    ['temperament', 120],
    ['actionTraits', 120],
    ['via', 80],
    ['crowdSize', 40],
  ];
  for (const [key, max] of stringFields) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) next[key] = cleanText(raw[key], max);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'entityType')) {
    next.entityType = normalizeResolvedEntityType(raw.entityType);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'appearanceMode')) {
    const mode = cleanText(raw.appearanceMode, 24);
    next.appearanceMode = mode === 'referenced' ? 'referenced' : 'main';
    if (next.appearanceMode !== 'referenced') delete next.via;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'isCrowd')) {
    next.isCrowd = !!raw.isCrowd;
    if (!next.isCrowd) delete next.crowdSize;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'tags')) {
    next.tags = cleanStringArray(raw.tags);
  }
  next.imagePrompt = rebuildCustomCharacterImagePromptFromFields(next);
  return next;
}

export function buildCustomCharacterImagePrompt(input: {
  fields: any;
  styleBible: any;
  script?: any;
  sourceType?: CustomCharacterSourceType;
}) {
  const fields = input.fields || {};
  const hasReference = input.sourceType === 'image' || input.sourceType === 'image_prompt';
  const styleLockContext = buildAssetStyleLock(input.styleBible || {}, 'char');
  let prompt = cleanText(fields.imagePrompt, 1200) || [
    fields.name && `Subject: ${fields.name}.`,
    fields.appearance && `Appearance: ${fields.appearance}.`,
    fields.clothing && `Clothing: ${fields.clothing}.`,
  ].filter(Boolean).join('\n');
  const charMeta: string[] = [];
  if (fields.appearance) charMeta.push(`Current appearance (authoritative override): ${fields.appearance}.`);
  if (fields.clothing) charMeta.push(`Current clothing (authoritative override): ${fields.clothing}.`);
  if (fields.equipment) charMeta.push(`Holding / wearing: ${fields.equipment}.`);
  if (fields.temperament) charMeta.push(`Temperament keywords (must show in face/posture): ${fields.temperament}.`);
  if (fields.actionTraits) charMeta.push(`Signature gestures (pose hints for the front view): ${fields.actionTraits}.`);
  if (charMeta.length) {
    prompt = `${prompt}\n\n=== CHARACTER METADATA (must reflect in image, override conflicting hints above) ===\n${charMeta.join('\n')}`;
  }
  if (hasReference) {
    prompt = `${prompt}\n\n=== REFERENCE PRESERVATION LOCK (authoritative uploaded character baseline) ===\nUse the uploaded reference image as the primary identity and visual baseline. Preserve the visible face structure, species/body plan, hairstyle, clothing silhouette, colors, materials, accessories, and overall temperament unless the user prompt explicitly changes that trait.`;
  }
  const castingFields = hasReference && fields.entityType === 'human'
    ? { ...fields, castingOverride: { ethnicityType: 'unspecified' } }
    : fields;
  prompt = appendCharacterCastingPrompt(prompt, castingFields, input.styleBible || {}, { script: input.script || '' });
  if (styleLockContext.prompt) {
    prompt = `${prompt}\n\n${styleLockContext.prompt}`;
  }
  return { prompt, styleLockContext };
}

export function fingerprintCustomCharacterInput(value: any) {
  return createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}
