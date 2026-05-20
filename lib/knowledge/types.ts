export type KnowledgeScope = 'system' | 'user';

export type KnowledgeModule =
  | 'narrative_structure'
  | 'style_bible'
  | 'asset_extraction'
  | 'identity_consistency'
  | 'shot_design'
  | 'storyboard_prompt'
  | 'frame_image'
  | 'video_prompt'
  | 'video_prompt_refine'
  | 'provider_runtime'
  | 'edit_strategy'
  | 'audio_subtitle_export';

export type KnowledgeStage =
  | 'script_create'
  | 'style_bible'
  | 'assets_extract'
  | 'shots_generate'
  | 'storyboard_sketch_prompt'
  | 'first_frame_image'
  | 'tail_frame_image'
  | 'video_prompt'
  | 'video_prompt_refine'
  | 'video_submit'
  | 'edit_analyze'
  | 'edit_edl'
  | 'export';

export type KnowledgeCardStatus = 'active' | 'inactive' | 'archived';
export type KnowledgeCardLifecycle = 'draft' | 'published' | 'archived';

export type KnowledgeCard = {
  id: string;
  ownerId: number | null;
  scope: KnowledgeScope;
  module: KnowledgeModule | string;
  cardType: string;
  title: string;
  status: KnowledgeCardStatus | string;
  lifecycle: KnowledgeCardLifecycle | string;
  priority: number;
  tags: string[];
  data: Record<string, unknown>;
  sourceRef: Record<string, unknown>;
  schemaVersion: number;
  version: number;
  publishedAt: string | null;
  publishedBy: number | null;
  previousVersionId: string | null;
  seededAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeCardInput = {
  id?: string;
  module: KnowledgeModule | string;
  cardType: string;
  title: string;
  status?: KnowledgeCardStatus | string;
  lifecycle?: KnowledgeCardLifecycle | string;
  priority?: number;
  tags?: string[];
  data?: Record<string, unknown>;
  sourceRef?: Record<string, unknown>;
  schemaVersion?: number;
  version?: number;
};

export type KnowledgeCardQueryOptions = {
  includeInactive?: boolean;
  limit?: number;
};

export type KnowledgeStageTarget = Record<string, unknown>;

export type KnowledgeStructuredCard = {
  id: string;
  module: string;
  title: string;
  version: number;
  priority: number;
  tags: string[];
  data: Record<string, unknown>;
};

export type KnowledgeInjectionReason =
  | 'flag_off'
  | 'empty_prompt_block'
  | 'token_limit_exceeded'
  | 'guard_mode_off'
  | 'injected'
  | 'error';

export type KnowledgeInjectionResult = {
  enabled: boolean;
  injected: boolean;
  reason: KnowledgeInjectionReason;
  estimatedTokens: number;
  maxTokens: number;
  placement: 'user_tail';
  promptBlockHash: string | null;
  errorMessage?: string;
};

export type BuildKnowledgeContextInput = {
  ownerId: number;
  project: Record<string, unknown>;
  stage: KnowledgeStage;
  stageTarget?: KnowledgeStageTarget;
  provider?: string | null;
  runId?: string | null;
};

export type KnowledgeContextStructured = {
  stage: KnowledgeStage;
  projectSnapshot: Record<string, unknown>;
  stageTarget: KnowledgeStageTarget;
  cards: KnowledgeStructuredCard[];
  injectedCards: KnowledgeStructuredCard[];
  auditOnlyCards: KnowledgeStructuredCard[];
  featureFlagsSnapshot?: Record<string, unknown>;
};

export type KnowledgeContextForStage = {
  stage: KnowledgeStage;
  stageTarget: KnowledgeStageTarget;
  structured: KnowledgeContextStructured;
  promptBlocks: string[];
  promptBlock: string;
  injection?: KnowledgeInjectionResult;
  sourceHashes: string[];
  ruleCardIds: string[];
  inputHash: string;
  contextHash: string;
};

export type ProjectKnowledgeContextRow = {
  id: string;
  ownerId: number;
  projectId: string;
  stage: KnowledgeStage | string;
  provider: string | null;
  stageTarget: KnowledgeStageTarget;
  inputHash: string;
  contextHash: string;
  context: KnowledgeContextForStage;
  promptBlock: string | null;
  sourceHashes: string[];
  ruleCardIds: string[];
  createdByRunId: string | null;
  createdAt: string;
  updatedAt: string;
};
