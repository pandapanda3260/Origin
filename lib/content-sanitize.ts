import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd, env } from 'node:process';

export type ViolationCategory = 'sexual' | 'violence' | 'self_harm' | 'hate' | 'unknown';

export type RewriteDiff = {
  type: 'phrase_replace' | 'clause_replace' | 'full_rewrite';
  slot?: string;
  from: string;
  to: string;
  reason: string;
  category: ViolationCategory;
};

export type ImageModerationPreflightHit = {
  category: ViolationCategory;
  pattern: string;
  text: string;
  reason: string;
};

export type ImageModerationPreflight = {
  categories: ViolationCategory[];
  hits: ImageModerationPreflightHit[];
};

export type ImagePromptSafetyHint = {
  text: string;
  reason: string;
  category: ViolationCategory;
  source: 'preflight' | 'heuristic';
};

export type ImagePromptModerationRewrite = {
  originalPrompt: string;
  rewrittenPrompt: string;
  categories: ViolationCategory[];
  rewriteDiff: RewriteDiff[];
  visualAnchorDescription: {
    originalText: string;
    effectiveText: string;
    source: 'original' | 'sanitized';
    rewriteDiff: RewriteDiff[];
  };
};

export type ImageModerationErrorInfo = {
  blocked: boolean;
  status?: number;
  requestId?: string;
  safetyViolations: ViolationCategory[];
  errorCode?: string;
};

type RuleType = RewriteDiff['type'];

type Rule = {
  pattern: string;
  replacement: string;
  type: RuleType;
  reason: string;
  slot?: string;
};

function normalizeImageRuleConfig(raw: any): Record<string, Rule[]> {
  const out: Record<string, Rule[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [category, rules] of Object.entries(raw)) {
    if (!Array.isArray(rules)) continue;
    const normalized = rules.filter((rule: any): rule is Rule => (
      !!rule &&
      typeof rule.pattern === 'string' &&
      typeof rule.replacement === 'string' &&
      (rule.type === 'phrase_replace' || rule.type === 'clause_replace' || rule.type === 'full_rewrite') &&
      typeof rule.reason === 'string'
    ));
    if (normalized.length) out[category] = normalized;
  }
  return out;
}

function loadImageRules(): Record<string, Rule[]> {
  const rulesPath = env.IMAGE_SANITIZE_RULES_PATH || join(cwd(), 'config/image-sanitize-rules.json');
  try {
    return normalizeImageRuleConfig(JSON.parse(readFileSync(rulesPath, 'utf8')));
  } catch (error: any) {
    console.warn(`[content-sanitize] image sanitize rules unavailable: ${error?.message || String(error)}`);
    return {};
  }
}

const IMAGE_RULES = loadImageRules();

const IMAGE_SAFETY_HINT_RULES: Array<{
  category: ViolationCategory;
  pattern: RegExp;
  reason: string;
}> = [
  {
    category: 'unknown',
    pattern: /(脸色发白|惊惧|惊恐|恐惧|骇然|失声|屏住呼吸|窒息|瞪大|嘴微张)/giu,
    reason: '强惊恐、窒息或失声表情，建议改成紧张、震撼、屏息注视等中性反应',
  },
  {
    category: 'unknown',
    pattern: /(喷薄而出|爆出|爆发|炸裂|冲破|引信)/giu,
    reason: '爆炸/冲击意象，建议改成光纹扩散、光芒流动或能量逐渐亮起',
  },
  {
    category: 'unknown',
    pattern: /(被挤出一道缝|被挤出|争相挤入|围堵|压迫|压顶|巨大暗影)/giu,
    reason: '人群挤压或强压迫意象，建议改成自然分开、庄严轮廓或厚重背景',
  },
  {
    category: 'unknown',
    pattern: /((?:十几岁|少年少女|少年)[^。；\n]{0,80}(?:惊惧|惊恐|恐惧|骇然|失声|脸色发白|屏住呼吸|挤|木剑)|(?:惊惧|惊恐|恐惧|骇然|失声|脸色发白|屏住呼吸)[^。；\n]{0,80}(?:十几岁|少年少女|少年))/giu,
    reason: '年轻角色和惊恐/挤压/武器同句出现，建议弱化为旁观者紧张注视、道具改为练习木剑',
  },
  {
    category: 'unknown',
    pattern: /(膜拜|跪伏|审判)/giu,
    reason: '膜拜/审判类仪式化措辞可能偏敏感，建议改成庄严试炼、安静伫立或仪式感场面',
  },
];

function uniqueCategories(categories: Array<ViolationCategory | string | null | undefined>): ViolationCategory[] {
  const out: ViolationCategory[] = [];
  for (const raw of categories || []) {
    const value = String(raw || '').trim().toLowerCase();
    const category: ViolationCategory =
      value === 'sexual' || value === 'violence' || value === 'self_harm' || value === 'hate'
        ? value
        : 'unknown';
    if (!out.includes(category)) out.push(category);
  }
  return out.length ? out : ['unknown'];
}

function compileImageRule(rule: Rule): RegExp | null {
  try {
    return new RegExp(rule.pattern, 'giu');
  } catch {
    return null;
  }
}

type TextSpan = { start: number; end: number };

function collectProtectedImageRewriteSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const source = String(text || '');
  const sectionRe = /CHARACTER LOCK:[\s\S]*?(?=\n(?:SCENE LOCK|PROP LOCK|PROJECT STYLE LOCK|COMPOSITION RULES|OBSERVED DRIFT GUARDRAILS):|$)/gi;
  let section: RegExpExecArray | null;
  while ((section = sectionRe.exec(source)) !== null) {
    spans.push({ start: section.index, end: section.index + section[0].length });
  }

  const bodyFeatureRe =
    /(黑毛猪|黑毛狗|棕金短毛猕猴|全身覆毛|脸颊黑毛|耳后短毛|猪八戒[^。；\n]{0,40}(?:短毛|毛发|黑毛)|孙悟空[^。；\n]{0,40}(?:短毛|毛发|黑毛)|(?:猕猴|猪|狗|动物|非人角色|拟人角色|anthropomorphic|non-human)[^。；\n]{0,50}(?:黑毛|短毛|毛发|覆毛|fur|hair))/giu;
  let match: RegExpExecArray | null;
  while ((match = bodyFeatureRe.exec(source)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans.sort((a, b) => a.start - b.start);
}

function overlapsProtectedSpan(start: number, end: number, spans: TextSpan[]): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

function expandReplacement(template: string, args: any[]): string {
  const hasGroups = args.length > 0 && typeof args[args.length - 1] === 'object';
  const captures = hasGroups ? args.slice(1, -3) : args.slice(1, -2);
  return String(template || '').replace(/\$(\d+)/g, (_m, rawIdx) => {
    const idx = Number(rawIdx) - 1;
    return captures[idx] == null ? '' : String(captures[idx]);
  });
}

function replacementOffset(args: any[]): number {
  const hasGroups = args.length > 0 && typeof args[args.length - 1] === 'object';
  return Number(args[hasGroups ? args.length - 3 : args.length - 2]);
}

export function preflightImageModerationPrompt(prompt: string): ImageModerationPreflight {
  const text = String(prompt || '');
  const protectedSpans = collectProtectedImageRewriteSpans(text);
  const hits: ImageModerationPreflightHit[] = [];
  for (const [categoryKey, rules] of Object.entries(IMAGE_RULES)) {
    const category = uniqueCategories([categoryKey])[0];
    for (const rule of rules || []) {
      const re = compileImageRule(rule);
      if (!re) continue;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        if (overlapsProtectedSpan(match.index, match.index + match[0].length, protectedSpans)) continue;
        hits.push({
          category,
          pattern: rule.pattern,
          text: match[0],
          reason: rule.reason,
        });
        if (!re.global) break;
      }
    }
  }
  return {
    categories: Array.from(new Set(hits.map((hit) => hit.category))),
    hits,
  };
}

function compactSafetyHintText(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-:：\s]+/, '')
    .trim()
    .slice(0, 90);
}

function safetyHintKey(hint: ImagePromptSafetyHint): string {
  return `${hint.source}:${hint.category}:${hint.text}:${hint.reason}`;
}

function extractImageSafetyHintScope(text: string): string {
  const source = String(text || '');
  const sections: string[] = [];
  const sectionRe = /【(主镜头|上下文镜头|用户原文约束)】[\s\S]*?(?=\n【[^】]+】|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(source)) !== null) {
    sections.push(match[0]);
  }
  return sections.length ? sections.join('\n') : source;
}

export function inferImagePromptSafetyHints(prompt: string, maxHints = 8): ImagePromptSafetyHint[] {
  const text = extractImageSafetyHintScope(String(prompt || ''));
  const out: ImagePromptSafetyHint[] = [];
  const seen = new Set<string>();
  const push = (hint: ImagePromptSafetyHint) => {
    const item = {
      ...hint,
      text: compactSafetyHintText(hint.text),
    };
    if (!item.text) return;
    const key = safetyHintKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const hit of preflightImageModerationPrompt(text).hits) {
    push({
      text: hit.text,
      reason: hit.reason,
      category: hit.category,
      source: 'preflight',
    });
  }

  const protectedSpans = collectProtectedImageRewriteSpans(text);
  for (const rule of IMAGE_SAFETY_HINT_RULES) {
    let match: RegExpExecArray | null;
    rule.pattern.lastIndex = 0;
    while ((match = rule.pattern.exec(text)) !== null) {
      if (overlapsProtectedSpan(match.index, match.index + match[0].length, protectedSpans)) continue;
      push({
        text: match[0],
        reason: rule.reason,
        category: rule.category,
        source: 'heuristic',
      });
      if (out.length >= maxHints) return out.slice(0, maxHints);
      if (!rule.pattern.global) break;
    }
  }

  return out.slice(0, maxHints);
}

export function rewriteImagePromptForModeration(
  prompt: string,
  categories: Array<ViolationCategory | string | null | undefined> = ['unknown'],
): ImagePromptModerationRewrite {
  const originalPrompt = String(prompt || '');
  const selectedCategories = uniqueCategories(categories);
  let rewrittenPrompt = originalPrompt;
  const rewriteDiff: RewriteDiff[] = [];
  let protectedSpans = collectProtectedImageRewriteSpans(rewrittenPrompt);

  const applyCategoryRules = (categoriesToApply: ViolationCategory[]) => {
    for (const category of categoriesToApply) {
      const rules = IMAGE_RULES[category] || [];
      for (const rule of rules) {
        const re = compileImageRule(rule);
        if (!re) continue;
        rewrittenPrompt = rewrittenPrompt.replace(re, (...args) => {
          const matched = String(args[0] || '');
          const offset = replacementOffset(args);
          if (overlapsProtectedSpan(offset, offset + matched.length, protectedSpans)) return matched;
          const replacement = expandReplacement(rule.replacement, args);
          if (matched === replacement) return matched;
          rewriteDiff.push({
            type: rule.type,
            slot: rule.slot,
            from: matched,
            to: replacement,
            reason: rule.reason,
            category,
          });
          return replacement;
        });
        protectedSpans = collectProtectedImageRewriteSpans(rewrittenPrompt);
      }
    }
  };

  const explicitCategories = selectedCategories.filter((category) => category !== 'unknown');
  if (explicitCategories.length) {
    applyCategoryRules(explicitCategories);
    if (!rewriteDiff.length) applyCategoryRules(['unknown']);
  } else {
    applyCategoryRules(['unknown']);
  }

  return {
    originalPrompt,
    rewrittenPrompt,
    categories: selectedCategories,
    rewriteDiff,
    visualAnchorDescription: {
      originalText: originalPrompt,
      effectiveText: rewrittenPrompt,
      source: rewriteDiff.length ? 'sanitized' : 'original',
      rewriteDiff,
    },
  };
}

export function extractImageModerationError(
  error: any,
  opts: { preflight?: ImageModerationPreflight } = {},
): ImageModerationErrorInfo {
  const message = String(error?.message || error || '');
  const status = Number(error?.status) || Number(/Image API\s+(\d+)/i.exec(message)?.[1]) || undefined;
  const requestId =
    /(?:request\s*ID|request_id|x-request-id)["']?\s*[:=]?\s*["']?(req_[A-Za-z0-9_-]+|[0-9a-fA-F-]{12,})/i.exec(message)?.[1] ||
    /\b(req_[A-Za-z0-9_-]+)\b/.exec(message)?.[1] ||
    /\b([0-9a-fA-F-]{12,})\b/.exec(message)?.[1];
  const code = (
    /"code"\s*:\s*"([^"]+)"/i.exec(message)?.[1] ||
    /code[=:]\s*([a-z0-9_-]+)/i.exec(message)?.[1] ||
    ''
  ).toLowerCase();
  const rawViolations =
    /safety_violations\s*=\s*\[([^\]]*)\]/i.exec(message)?.[1] ||
    /"safety_violations"\s*:\s*\[([^\]]*)\]/i.exec(message)?.[1] ||
    '';
  const safetyViolations = uniqueCategories(
    rawViolations
      .split(',')
      .map((item) => item.replace(/["']/g, '').trim())
      .filter(Boolean),
  );
  const knownModerationCode =
    /moderation_blocked|content_policy_violation|safety_violation|policy_violation|content_filter/i.test(code);
  const hasSafetyLanguage =
    /safety|policy|moderation|rejected|unsafe content|content[-_\s]?policy|content[-_\s]?filter|内容安全|内容审核|安全政策|违反(?:内容审核|安全政策|规则)|(?:请求|内容)被(?:拒绝|拦截)|不符合安全|未通过(?:安全)?审核/i
      .test(message);
  const isClientSafetyStatus = status === 400 || status === 422;
  const looksLikeParameterOrAccountError =
    /invalid_api_key|unauthorized|forbidden|insufficient_quota|billing|balance|quota|rate[_\s-]?limit|invalid_request_error|invalid\s+(?:parameter|size|model)|unsupported|missing required|required parameter|参数(?:错误|无效|非法)|请求参数|鉴权失败|认证失败|无权限|余额不足|额度不足|限流/i
      .test(message);
  const preflightHasRisk = !!opts.preflight?.hits?.length;
  const blocked =
    knownModerationCode ||
    /safety_violations/i.test(message) ||
    (isClientSafetyStatus && hasSafetyLanguage) ||
    (isClientSafetyStatus && preflightHasRisk && !looksLikeParameterOrAccountError);
  return {
    blocked,
    status,
    requestId,
    safetyViolations: blocked ? safetyViolations : [],
    errorCode: code,
  };
}

export function sanitizePromptObject<T>(value: T): T {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePromptObject(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      out[k] = sanitizePromptObject(v);
    }
    return out as T;
  }
  return value;
}
