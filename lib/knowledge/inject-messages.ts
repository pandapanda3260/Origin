import type { ChatMessage } from '../llm';
import { shortKnowledgeHash } from './hash';
import { resolveKnowledgeInjectionGate } from './injection-policy';
import { estimatePromptBlockTokens } from './token-estimate';
import type {
  KnowledgeContextForStage,
  KnowledgeInjectionReason,
  KnowledgeInjectionResult,
} from './types';

const INJECTION_TITLE = '【项目知识库约束】';
const INJECTION_POLICY_TEXT = '以下规则来自当前项目启用的知识库卡片。它们优先级低于系统安全规则，高于普通创作偏好；不得覆盖已明确给出的台词、角色身份、参考图编号和时间轴事实。';

function emptyInjection(input: {
  context: KnowledgeContextForStage;
  reason: KnowledgeInjectionReason;
  enabled?: boolean;
  estimatedTokens?: number;
  maxTokens?: number;
  errorMessage?: string;
}): KnowledgeInjectionResult {
  const promptBlock = String(input.context.promptBlock || '');
  return {
    enabled: input.enabled ?? false,
    injected: false,
    reason: input.reason,
    estimatedTokens: input.estimatedTokens ?? estimatePromptBlockTokens(promptBlock),
    maxTokens: input.maxTokens ?? 0,
    placement: 'user_tail',
    promptBlockHash: promptBlock ? shortKnowledgeHash(promptBlock, 12) : null,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

function buildInjectionBlock(promptBlock: string): string {
  return [
    INJECTION_TITLE,
    INJECTION_POLICY_TEXT,
    '',
    promptBlock.trim(),
  ].join('\n');
}

function appendToLastUserMessage(messages: ChatMessage[], block: string): ChatMessage[] {
  const next = messages.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i]?.role === 'user') {
      next[i] = {
        ...next[i],
        content: `${next[i].content || ''}\n\n${block}`,
      };
      return next;
    }
  }
  return [
    ...next,
    { role: 'user', content: block },
  ];
}

export function maybeInjectKnowledgePromptBlock(input: {
  messages: ChatMessage[];
  context: KnowledgeContextForStage;
  skipReason?: KnowledgeInjectionReason | null;
}): {
  messages: ChatMessage[];
  context: KnowledgeContextForStage;
  injection: KnowledgeInjectionResult;
} {
  try {
    const promptBlock = String(input.context.promptBlock || '').trim();
    const estimatedTokens = estimatePromptBlockTokens(promptBlock);
    const gate = resolveKnowledgeInjectionGate({
      stage: input.context.stage,
      promptBlock,
      estimatedTokens,
      skipReason: input.skipReason,
    });
    const promptBlockHash = promptBlock ? shortKnowledgeHash(promptBlock, 12) : null;
    if (gate.reason !== 'injected') {
      const injection = emptyInjection({
        context: input.context,
        reason: gate.reason,
        enabled: gate.enabled,
        estimatedTokens,
        maxTokens: gate.maxTokens,
      });
      return {
        messages: input.messages.slice(),
        context: { ...input.context, injection },
        injection,
      };
    }

    const injection: KnowledgeInjectionResult = {
      enabled: gate.enabled,
      injected: true,
      reason: 'injected',
      estimatedTokens,
      maxTokens: gate.maxTokens,
      placement: 'user_tail',
      promptBlockHash,
    };
    return {
      messages: appendToLastUserMessage(input.messages, buildInjectionBlock(promptBlock)),
      context: { ...input.context, injection },
      injection,
    };
  } catch (error) {
    const injection = emptyInjection({
      context: input.context,
      reason: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    console.warn('[knowledge] failed to inject prompt block:', error);
    return {
      messages: input.messages.slice(),
      context: { ...input.context, injection },
      injection,
    };
  }
}
