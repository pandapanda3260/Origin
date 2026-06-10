/**
 * 剧本生成输出守门：判断 LLM 输出是否真的是五段式剧本，而不是把用户指令
 * 当聊天的客套回应（真实事故："删除当前剧本"指令 → 模型回了句
 * "已删除当前剧本。请提供新的创作需求…" → 被当作新剧本整段落库）。
 *
 * 输出合同见 lib/prompts.ts SP_SCRIPT_REVISE / 五段式生成提示词：必须以
 * "铺垫："开头，含 铺垫/升温/高潮/回落/余韵 段落标记。这里放宽为
 * "≥3 个段落标记 + 长度下限"，容忍模型小越格；纯聊天回应（短、无标记）
 * 一定不过。守门不过 → 调用方不落库、直接 writer.error，当前剧本不动。
 */
export function looksLikeFiveActScript(text: string): boolean {
  const t = String(text || '').trim();
  if (t.length < 120) return false;
  const markers = t.match(/(^|\n)\s*(铺垫|升温|高潮|回落|余韵|收尾|结尾)\s*[：:]/g) || [];
  return markers.length >= 3;
}
