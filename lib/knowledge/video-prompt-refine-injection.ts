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
  const immutableFactsBlock = guardMode === 'off' ? '' : formatImmutableFactsForPrompt(guardFacts);
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
