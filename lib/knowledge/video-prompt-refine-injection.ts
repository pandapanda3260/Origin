import { buildRefineMessages } from '../prompts';
import type { ChatMessage } from '../llm';
import { buildKnowledgeContextForStage } from './compile-context';
import { maybeInjectKnowledgePromptBlock } from './inject-messages';
import {
  buildImmutableFactsSnapshot,
  factsForRefineGuardMode,
  formatImmutableFactsForPrompt,
  normalizeRefineGuardMode,
} from './refine-output-guard';
import type { KnowledgeContextForStage } from './types';
import { formatWorldContextForPrompt, projectWorldContextForStage } from '../world-template-context';

export function prepareVideoPromptRefineMessagesWithKnowledge(input: {
  ownerId: number;
  projectId?: string | null;
  project?: Record<string, unknown> | null;
  groupIdx?: number | null;
  currentPrompt: string;
  instruction: string;
  referenceManifest?: unknown;
  guardMode?: unknown;
}): {
  messages: ChatMessage[];
  originalMessages: ChatMessage[];
  knowledgeContext: KnowledgeContextForStage | null;
  immutableFacts: ReturnType<typeof buildImmutableFactsSnapshot>;
  guardFacts: ReturnType<typeof factsForRefineGuardMode>;
  guardMode: ReturnType<typeof normalizeRefineGuardMode>;
} {
  const guardMode = normalizeRefineGuardMode(input.guardMode);
  const immutableFacts = buildImmutableFactsSnapshot({
    currentPrompt: input.currentPrompt,
    project: input.project,
    groupIdx: input.groupIdx ?? null,
    referenceManifest: input.referenceManifest,
  });
  const guardFacts = factsForRefineGuardMode(immutableFacts, guardMode);
  const worldContext = guardMode === 'off'
    ? undefined
    : projectWorldContextForStage('video_prompt_refine', (input.project as any)?.worldTemplateSnapshot, {
        project: input.project,
        target: { groupIdx: input.groupIdx ?? null },
      });
  const worldFactsBlock = formatWorldContextForPrompt(worldContext, { includeSoft: false });
  const immutableFactsBlock = guardMode === 'off'
    ? ''
    : [
        formatImmutableFactsForPrompt(guardFacts),
        worldFactsBlock ? `世界观硬事实（精修时不得改写、删除或反向描述）：\n${worldFactsBlock}` : '',
      ].filter(Boolean).join('\n\n');
  const originalMessages = buildRefineMessages(input.currentPrompt, input.instruction, immutableFactsBlock, { guardMode });

  if (!input.projectId || !input.project) {
    return {
      messages: originalMessages,
      originalMessages,
      knowledgeContext: null,
      immutableFacts,
      guardFacts,
      guardMode,
    };
  }

  const context = buildKnowledgeContextForStage({
    ownerId: input.ownerId,
    project: {
      ...(input.project as any),
      id: input.projectId,
    },
    stage: 'video_prompt_refine',
    stageTarget: {
      groupIdx: input.groupIdx ?? null,
      factCounts: {
        dialogues: immutableFacts.dialogueTexts.length,
        timeRanges: immutableFacts.timeRangeTitles.length,
        imageNumbers: immutableFacts.imageNumbers.length,
        characters: immutableFacts.characterNamesOrIds.length,
        referenceLabels: immutableFacts.referenceLabels.length,
      },
      guardMode,
    },
  });
  const injected = maybeInjectKnowledgePromptBlock({
    messages: originalMessages,
    context,
    skipReason: guardMode === 'strict' ? null : 'guard_mode_off',
  });
  return {
    messages: injected.messages,
    originalMessages,
    knowledgeContext: injected.context,
    immutableFacts,
    guardFacts,
    guardMode,
  };
}
