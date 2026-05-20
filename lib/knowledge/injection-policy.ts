import { isKnowledgeSelectiveInjectionEnabledForStage } from '../feature-flags';
import type { KnowledgeInjectionReason, KnowledgeStage } from './types';

const DEFAULT_MAX_TOKENS: Partial<Record<KnowledgeStage, number>> = {
  style_bible: 600,
  video_prompt_refine: 400,
  video_prompt: 500,
  assets_extract: 500,
  shots_generate: 600,
  edit_analyze: 400,
  edit_edl: 400,
  export: 400,
};

export function getKnowledgeInjectionMaxTokens(stage: string): number {
  return DEFAULT_MAX_TOKENS[stage as KnowledgeStage] || 0;
}

export function isKnowledgeInjectionStageSupported(stage: string): boolean {
  return getKnowledgeInjectionMaxTokens(stage) > 0;
}

export function resolveKnowledgeInjectionGate(input: {
  stage: string;
  promptBlock: string;
  estimatedTokens: number;
  skipReason?: KnowledgeInjectionReason | null;
}): { enabled: boolean; maxTokens: number; reason: KnowledgeInjectionReason } {
  const maxTokens = getKnowledgeInjectionMaxTokens(input.stage);
  const enabled = isKnowledgeSelectiveInjectionEnabledForStage(input.stage);
  if (input.skipReason) return { enabled, maxTokens, reason: input.skipReason };
  if (!enabled) return { enabled, maxTokens, reason: 'flag_off' };
  if (!String(input.promptBlock || '').trim()) return { enabled, maxTokens, reason: 'empty_prompt_block' };
  if (!maxTokens || input.estimatedTokens > maxTokens) {
    return { enabled, maxTokens, reason: 'token_limit_exceeded' };
  }
  return { enabled, maxTokens, reason: 'injected' };
}
