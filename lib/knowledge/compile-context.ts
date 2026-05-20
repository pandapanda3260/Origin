import { listCardsByModuleAndTag, listSystemAndUserCards } from './cards-db';
import { isAuditOnlyKnowledgeModule } from './audit-only-modules';
import { formatKnowledgeCardsPromptBlock } from './format-prompt-blocks';
import { sha256Hex, shortKnowledgeHash, stableKnowledgeValue } from './hash';
import { getKnowledgeSelectiveInjectionStages, isKnowledgeSelectiveInjectionEnabledForStage } from '../feature-flags';
import type {
  BuildKnowledgeContextInput,
  KnowledgeCard,
  KnowledgeContextForStage,
  KnowledgeModule,
  KnowledgeStructuredCard,
  KnowledgeStage,
} from './types';

type StageCardRule = {
  modules: KnowledgeModule[];
  maxCards: number;
  providerRuntime?: boolean;
};

const STAGE_CARD_RULES: Record<KnowledgeStage, StageCardRule> = {
  script_create: { modules: ['narrative_structure'], maxCards: 6 },
  style_bible: { modules: ['style_bible'], maxCards: 4 },
  assets_extract: { modules: ['asset_extraction', 'identity_consistency'], maxCards: 6 },
  shots_generate: { modules: ['shot_design', 'narrative_structure'], maxCards: 8 },
  storyboard_sketch_prompt: { modules: ['storyboard_prompt'], maxCards: 6 },
  first_frame_image: { modules: ['frame_image', 'provider_runtime'], maxCards: 6 },
  tail_frame_image: { modules: ['frame_image', 'provider_runtime'], maxCards: 6 },
  video_prompt: { modules: ['video_prompt', 'provider_runtime'], maxCards: 6 },
  video_prompt_refine: { modules: ['video_prompt_refine', 'video_prompt', 'identity_consistency'], maxCards: 6 },
  video_submit: { modules: ['provider_runtime'], maxCards: 6, providerRuntime: true },
  edit_analyze: { modules: ['edit_strategy', 'narrative_structure'], maxCards: 6 },
  edit_edl: { modules: ['edit_strategy', 'narrative_structure'], maxCards: 6 },
  export: { modules: ['audio_subtitle_export'], maxCards: 6 },
};

function projectIdOf(project: Record<string, unknown>): string {
  const id = project.id;
  return typeof id === 'string' && id ? id : 'unknown-project';
}

function pickProjectSnapshot(project: Record<string, unknown>): Record<string, unknown> {
  return {
    id: project.id,
    title: project.title,
    styleTemplateId: project.styleTemplateId,
    worldTemplateId: project.worldTemplateId,
    styleTemplateSnapshot: project.styleTemplateSnapshot,
    worldTemplateSnapshot: project.worldTemplateSnapshot,
    styleBibleHash: project.styleBible ? shortKnowledgeHash(project.styleBible) : null,
    consistencyHash: project.consistency ? shortKnowledgeHash(project.consistency) : null,
  };
}

function buildFeatureFlagsSnapshot(stage: KnowledgeStage, provider?: string | null): Record<string, unknown> {
  return {
    stage,
    provider: provider || null,
    knowledgeSelectiveInjection: {
      enabledForStage: isKnowledgeSelectiveInjectionEnabledForStage(stage),
      stages: getKnowledgeSelectiveInjectionStages(),
    },
    workflowMode: 'single-shot-strict',
    referenceBudgets: {
      frameImage: 4,
      videoReference: 7,
    },
  };
}

function providerTagsFor(provider?: string | null): string[] {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!normalized) return ['provider:generic'];
  return [`provider:${normalized}`, 'provider:generic'];
}

function listCardsForStage(ownerId: number, stage: KnowledgeStage, provider?: string | null): KnowledgeCard[] {
  const rule = STAGE_CARD_RULES[stage];
  const cards: KnowledgeCard[] = [];
  for (const module of rule.modules) {
    if (module === 'provider_runtime') {
      const tags = providerTagsFor(provider);
      for (const tag of tags) {
        cards.push(...listCardsByModuleAndTag(ownerId, module, tag, { limit: rule.maxCards }));
      }
    } else {
      cards.push(...listSystemAndUserCards(ownerId, module, { limit: rule.maxCards }));
    }
  }
  const byId = new Map<string, KnowledgeCard>();
  for (const card of cards.sort((a, b) => a.priority - b.priority || b.version - a.version)) {
    if (!byId.has(card.id)) byId.set(card.id, card);
  }
  return Array.from(byId.values()).slice(0, rule.maxCards);
}

function toStructuredCard(card: KnowledgeCard): KnowledgeStructuredCard {
  return {
    id: card.id,
    module: card.module,
    title: card.title,
    version: card.version,
    priority: card.priority,
    tags: card.tags,
    data: card.data,
  };
}

export function buildKnowledgeContextForStage(input: BuildKnowledgeContextInput): KnowledgeContextForStage {
  const stageTarget = stableKnowledgeValue(input.stageTarget || {}) as Record<string, unknown>;
  const cards = listCardsForStage(input.ownerId, input.stage, input.provider);
  const projectSnapshot = pickProjectSnapshot(input.project);
  const ruleCardIds = cards.map((card) => card.id);
  const featureFlagsSnapshot = buildFeatureFlagsSnapshot(input.stage, input.provider);
  const cardVersions = cards.map((card) => ({
    id: card.id,
    module: card.module,
    version: card.version,
    updatedAt: card.updatedAt,
  }));
  const sourceHashes = [
    `project:${projectIdOf(input.project)}`,
    `project_snapshot:${shortKnowledgeHash(projectSnapshot)}`,
    `stage_target:${shortKnowledgeHash(stageTarget)}`,
    `feature_flags:${shortKnowledgeHash(featureFlagsSnapshot)}`,
    ...cardVersions.map((card) => `card:${card.id}:v${card.version}:${shortKnowledgeHash(card)}`),
  ];
  const inputHash = sha256Hex({
    ownerId: input.ownerId,
    projectId: projectIdOf(input.project),
    stage: input.stage,
    stageTarget,
    provider: input.provider || null,
    featureFlagsSnapshot,
    projectSnapshot,
    cardVersions,
  });
  const promptBlock = formatKnowledgeCardsPromptBlock(cards);
  const promptBlocks = promptBlock ? [promptBlock] : [];
  const structuredCards = cards.map(toStructuredCard);
  const injectedCards = structuredCards.filter((card) => !isAuditOnlyKnowledgeModule(card.module));
  const auditOnlyCards = structuredCards.filter((card) => isAuditOnlyKnowledgeModule(card.module));
  const structured = {
    stage: input.stage,
    projectSnapshot,
    stageTarget,
    cards: structuredCards,
    injectedCards,
    auditOnlyCards,
    featureFlagsSnapshot,
  };
  const contextHash = sha256Hex({
    inputHash,
    structured,
    promptBlocks,
    sourceHashes,
    ruleCardIds,
  });
  return {
    stage: input.stage,
    stageTarget,
    structured,
    promptBlocks,
    promptBlock,
    sourceHashes,
    ruleCardIds,
    inputHash,
    contextHash,
  };
}
