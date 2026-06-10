import { chatComplete } from './llm';
import type { UserRow } from './db';
import type { RewriteDiff } from './content-sanitize';

/**
 * 图像审核拦截的 LLM 中性化改写(方向 B)。
 *
 * 现有关键词改写 (rewriteImagePromptForModeration) 对图像审核基本空转:图像服务返回的
 * moderation_blocked 不带类别 → 归 unknown → 命中 0 条规则 → 0 改动。本函数用 LLM 把
 * 提示词软化后重试,是 safe-image-gen 自动救回的"真正能动"的一层。
 *
 * 约束:
 *   - 全部小节内容均可改写(含【角色/场景/道具/项目风格锁定】【参考图】),敏感意象藏在锁定区时也能救回;
 *     仅要求保留【...】小节结构,并尽量少动锁定区的一致性锚点(身份/外观/配色/参考图映射);
 *   - 不得新增原文没有的小节(上下文镜头/用户原文约束/世界观硬事实等是上游有意裁剪的);
 *   - 模型走 modelRole='structured'(治理:不硬编码 model/provider/effort)。
 */

const IMAGE_SAFETY_REWRITE_SYSTEM = [
  '你是图像生成提示词的"内容安全改写"助手。给你的是一段【已被图像内容安全审核拒绝】的提示词,',
  '请改写它,使其更可能通过审核,同时尽量保留原本的视觉意图(场景、角色、构图、情绪、镜头语言)。',
  '',
  '严格要求:',
  '1. 保留所有以【】包裹的小节标题和整体结构顺序。',
  '2. 所有小节的内容都可以改写,包括【参考图】【角色锁定】【场景锁定】【道具锁定】【项目风格锁定】:',
  '   敏感措辞无论出现在哪个小节,都要软化;没有敏感措辞的句子尽量原样保留。',
  '3. 严禁新增或恢复原文中不存在的小节,如【上下文镜头】【用户原文约束】【世界观硬事实】或 OBSERVED DRIFT GUARDRAILS。',
  '4. 只软化可能触发内容安全审核的描述性文字(尤其【主镜头】里"- 画面："那一行的自由描写):',
  '   弱化血腥、暴力、武器、尸体、群体跪拜/宗教膜拜、裸露、性、自残等敏感意象,',
  '   改写成中性、克制、具体、可拍的电影化镜头描述。',
  '5. 改写锁定类小节时,尽量保住一致性锚点:人物身份与外观要点、配色、场景标识、',
  '   参考图编号与角色/场景的对应关系(如 Image 1 = 某角色)不要无故改动,只替换其中的敏感措辞。',
  '6. 不改变人物身份、所在场景与核心动作要义;不要新增旁白或文字内容。',
  '7. 直接输出改写后的【完整提示词文本】,不要加任何解释、前后缀、引号或代码块。',
].join('\n');

export type ImageSafetyRewriteInvalidReason =
  | 'empty'
  | 'too_short'
  | 'no_change'
  | 'llm_error'
  | 'forbidden_section_added';

export type ImageSafetyLLMRewrite = {
  rewrittenPrompt: string;
  /** true = LLM 给出了与原文不同的改写;false = 空/异常/与原文相同,视为没救回。 */
  changed: boolean;
  invalidReason?: ImageSafetyRewriteInvalidReason;
  invalidDetail?: string;
  rewriteDiff: RewriteDiff[];
  visualAnchorDescription: {
    originalText: string;
    effectiveText: string;
    source: 'original' | 'sanitized';
    rewriteDiff: RewriteDiff[];
  };
};

const FORBIDDEN_SECTION_RE = /【(?:上下文镜头|用户原文约束|世界观硬事实)】|OBSERVED DRIFT GUARDRAILS/g;

function hasForbiddenSection(text: string): boolean {
  FORBIDDEN_SECTION_RE.lastIndex = 0;
  return FORBIDDEN_SECTION_RE.test(String(text || ''));
}

function extractLLMErrorDetail(err: any): string | undefined {
  const directReason = String(err?.incompleteReason || err?.incompleteDetails?.reason || '').trim();
  if (directReason) return directReason.slice(0, 120);
  const message = String(err?.message || err || '').trim();
  const match = message.match(/reason=([A-Za-z0-9_-]+)/i) || message.match(/reason[:：]\s*([A-Za-z0-9_-]+)/i);
  if (match?.[1]) return match[1].slice(0, 120);
  return message ? message.slice(0, 160) : undefined;
}

export async function rewriteImagePromptForModerationLLM(
  user: UserRow | null,
  prompt: string,
  opts: { traceName?: string; chatImpl?: typeof chatComplete } = {},
): Promise<ImageSafetyLLMRewrite> {
  const original = String(prompt || '');
  const noChange = (invalidReason?: ImageSafetyRewriteInvalidReason, invalidDetail?: string): ImageSafetyLLMRewrite => ({
    rewrittenPrompt: original,
    changed: false,
    invalidReason,
    invalidDetail,
    rewriteDiff: [],
    visualAnchorDescription: {
      originalText: original,
      effectiveText: original,
      source: 'original',
      rewriteDiff: [],
    },
  });
  if (!original.trim()) return noChange('empty');

  let raw = '';
  try {
    const chat = opts.chatImpl || chatComplete;
    raw = await chat(
      user,
      [
        { role: 'system', content: IMAGE_SAFETY_REWRITE_SYSTEM },
        { role: 'user', content: original },
      ],
      {
        modelRole: 'structured',
        reasoningEffort: 'none',
        temperature: 0.3,
        // maxTokens 是期望产出预算,最终由统一预算层按模型上限夹取。改写后长度≈原文。
        maxTokens: Math.min(4096, Math.max(1024, Math.ceil(original.length * 1.6))),
        traceName: opts.traceName || 'image-moderation-rewrite',
      },
    );
  } catch (err: any) {
    console.warn('[image-safety-rewrite] LLM rewrite failed:', (err && err.message) || err);
    return noChange('llm_error', extractLLMErrorDetail(err));
  }

  const rewritten = String(raw || '').trim();
  // 兜底:空 / 过短 / 与原文一致 → 视为没救回,交给上层回落到明确提示。
  if (!rewritten) return noChange('empty');
  if (rewritten.length < 20) return noChange('too_short');
  if (rewritten === original) return noChange('no_change');
  if (hasForbiddenSection(rewritten)) return noChange('forbidden_section_added');

  const rewriteDiff: RewriteDiff[] = [
    {
      type: 'full_rewrite',
      from: original,
      to: rewritten,
      reason: 'llm_safety_rewrite',
      category: 'unknown',
    },
  ];
  return {
    rewrittenPrompt: rewritten,
    changed: true,
    rewriteDiff,
    visualAnchorDescription: {
      originalText: original,
      effectiveText: rewritten,
      source: 'sanitized',
      rewriteDiff,
    },
  };
}
