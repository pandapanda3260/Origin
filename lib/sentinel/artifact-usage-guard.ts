import {
  computeShotPlanSourceHash,
  computeShotPlanSourceSnapshot,
  diffShotPlanSourceSnapshots,
  effectiveShotPlanStatus,
  type ShotPlanSourceSnapshot,
  type ShotPlanStaleReason,
} from '../project-dependency-state';
import { storyboardShotIndices } from '../frame-workflow-state';
import { deriveFirstFrameReadiness, deriveVideoPromptReadiness } from '../video-prompt-state';
import {
  validateCharacterConsistencyForGroup,
  type CharacterConsistencyGateResult,
} from '../character-consistency-gate';

export type TargetArtifact =
  | 'shot_plan'
  | 'storyboard_prompt'
  | 'storyboard_image_generation'
  | 'storyboard_image'
  | 'video_prompt'
  | 'video_segment';

export type ArtifactFreshness =
  | 'fresh'
  | 'stale'
  | 'legacy_unknown'
  | 'fresh_but_hash_mismatch';

export type ArtifactGeneration = 'idle' | 'generating' | 'failed' | 'missing';

export type ArtifactUsability = 'USABLE' | 'BLOCKED';

export type ArtifactUsageReason =
  | 'shot_plan_stale'
  | 'shot_plan_legacy_unknown'
  | 'shot_plan_generating'
  | 'shot_plan_failed'
  | 'shot_plan_fresh_but_hash_mismatch'
  | 'upstream_changed_during_generation'
  | 'storyboard_stale'
  | 'shot_prompt_stale'
  | 'first_frame_missing'
  | 'first_frame_failed'
  | 'video_prompt_stale'
  | 'video_prompt_generating'
  | 'video_prompt_failed'
  | 'missing_video_prompt'
  | 'video_task_outdated'
  | 'video_task_stale'
  | 'storyboard_video_not_current'
  | 'character_consistency_blocked'
  | 'nonhuman_species_missing'
  | 'critical_reference_missing'
  | 'propagated_from_shot_plan';

export type ArtifactUsageInput = {
  projectId: string;
  targetArtifact: TargetArtifact;
  groupIdx?: number;
  shotIndices?: number[];
  batchType?: string;
  consumerOperation?: string;
  includeSnapshots?: boolean;
};

export type RepairAction = {
  kind:
    | 'regenerate_shot_plan'
    | 'confirm_still_valid'
    | 'regenerate_storyboard_prompts'
    | 'regenerate_storyboard_images'
    | 'regenerate_video_prompts'
    | 'regenerate_video_segments';
  batchType?: string;
  groupIdx?: number;
  autoStartAllowed: boolean;
};

export type ShotPlanSubDecision = {
  usable: boolean;
  freshness: ArtifactFreshness;
  generation: ArtifactGeneration;
  reasons: ArtifactUsageReason[];
  storedSourceHash?: string | null;
  currentSourceHash?: string | null;
  storedSourceSnapshot?: ShotPlanSourceSnapshot | null;
  currentSourceSnapshot?: ShotPlanSourceSnapshot | null;
  upstreamStaleReasons?: string[];
};

export type ArtifactUsageDecision = {
  targetArtifact: TargetArtifact;
  projectId: string;
  groupIdx?: number;
  batchType?: string;
  consumerOperation?: string;
  usability: ArtifactUsability;
  freshness: ArtifactFreshness;
  generation: ArtifactGeneration;
  reasons: string[];
  blockingReasons: string[];
  staleFlagKeys: string[];
  upstreamStaleReasons?: string[];
  storedSourceHash?: string | null;
  currentSourceHash?: string | null;
  storedSourceSnapshot?: ShotPlanSourceSnapshot | null;
  currentSourceSnapshot?: ShotPlanSourceSnapshot | null;
  consistency?: Pick<CharacterConsistencyGateResult, 'allowed' | 'score' | 'level' | 'blockers' | 'warnings' | 'characterUsages'>;
  repairActions: RepairAction[];
};

export class ArtifactUsageBlockedError extends Error {
  code = 'artifact_usage_blocked';
  decision: ArtifactUsageDecision;
  status = 409;

  constructor(decision: ArtifactUsageDecision) {
    super(`artifact usage blocked: ${decision.targetArtifact}`);
    this.name = 'ArtifactUsageBlockedError';
    this.decision = decision;
  }
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function asStaleFlags(project: any): Record<string, any> {
  return project?._staleFlags && typeof project._staleFlags === 'object'
    ? project._staleFlags
    : {};
}

function hasUsableShotPlan(project: any) {
  return Array.isArray(project?.shots) && project.shots.length > 0;
}

function safeCurrentSnapshot(project: any): ShotPlanSourceSnapshot | null {
  try {
    return computeShotPlanSourceSnapshot(project);
  } catch {
    return null;
  }
}

function safeCurrentHash(project: any, snapshot: ShotPlanSourceSnapshot | null): string | null {
  try {
    return snapshot ? computeShotPlanSourceHash(project) : null;
  } catch {
    return null;
  }
}

function snapshotDiffReasons(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  try {
    return diffShotPlanSourceSnapshots(before as ShotPlanSourceSnapshot, after as ShotPlanSourceSnapshot);
  } catch {
    return [];
  }
}

function normalizeShotPlanReasons(project: any): string[] {
  const raw = project?.shotPlanStaleReasons || project?.shotPlanStaleReason;
  if (!raw) return [];
  return unique((Array.isArray(raw) ? raw : [raw]).map((item) => String(item || '').trim()).filter(Boolean));
}

export function evaluateShotPlanDimension(project: any): ShotPlanSubDecision {
  const status = effectiveShotPlanStatus(project);
  const staleFlags = asStaleFlags(project);
  const hasFlag = staleFlags.shotPlan === true;
  const currentSourceSnapshot = safeCurrentSnapshot(project);
  const currentSourceHash = safeCurrentHash(project, currentSourceSnapshot);
  const hasShotPlan = hasUsableShotPlan(project);
  const storedSourceSnapshot = status === 'generating'
    ? (project?.shotPlanGenerationSourceSnapshot || null)
    : (project?.shotPlanSourceSnapshot || null);
  const storedSourceHash = status === 'generating'
    ? (project?.shotPlanGenerationSourceHash || null)
    : (project?.shotPlanSourceHash || null);
  const storedHash = typeof storedSourceHash === 'string' && storedSourceHash ? storedSourceHash : null;
  const hashMismatch = !!storedHash && !!currentSourceHash && storedHash !== currentSourceHash;
  const upstreamStaleReasons = unique([
    ...normalizeShotPlanReasons(project),
    ...snapshotDiffReasons(storedSourceSnapshot, currentSourceSnapshot),
  ]);
  const reasons: ArtifactUsageReason[] = [];
  let freshness: ArtifactFreshness = 'fresh';
  let generation: ArtifactGeneration = 'idle';

  if (!status && !hasFlag && !storedHash && !hasShotPlan) {
    return {
      usable: true,
      freshness,
      generation,
      reasons,
      storedSourceHash: storedHash,
      currentSourceHash,
      storedSourceSnapshot,
      currentSourceSnapshot,
      upstreamStaleReasons,
    };
  }

  if (status === 'generating') {
    generation = 'generating';
    reasons.push('shot_plan_generating');
    if (hashMismatch) {
      freshness = 'stale';
      reasons.push('upstream_changed_during_generation');
    } else {
      freshness = hasFlag ? 'stale' : 'fresh';
      if (hasFlag) reasons.push('shot_plan_stale');
    }
  } else if (status === 'failed') {
    generation = 'failed';
    reasons.push('shot_plan_failed');
    if (!storedHash && hasShotPlan) {
      freshness = 'legacy_unknown';
      reasons.push('shot_plan_legacy_unknown');
    } else if (hashMismatch) {
      freshness = 'fresh_but_hash_mismatch';
      reasons.push('shot_plan_fresh_but_hash_mismatch');
    } else {
      freshness = hasFlag ? 'stale' : 'fresh';
      if (hasFlag) reasons.push('shot_plan_stale');
    }
  } else if (status === 'legacy_unknown') {
    freshness = 'legacy_unknown';
    reasons.push('shot_plan_legacy_unknown');
  } else if (status === 'stale') {
    freshness = 'stale';
    reasons.push('shot_plan_stale');
  } else if (status === 'ready') {
    if (!storedHash && hasShotPlan) {
      freshness = 'legacy_unknown';
      reasons.push('shot_plan_legacy_unknown');
    } else if (hashMismatch) {
      freshness = 'fresh_but_hash_mismatch';
      reasons.push('shot_plan_fresh_but_hash_mismatch');
    } else if (hasFlag) {
      freshness = 'stale';
      reasons.push('shot_plan_stale');
    }
  } else if (hasShotPlan) {
    freshness = 'legacy_unknown';
    reasons.push('shot_plan_legacy_unknown');
  }

  if (hasFlag && !reasons.includes('shot_plan_stale')) reasons.push('shot_plan_stale');

  const usable = reasons.length === 0;
  return {
    usable,
    freshness,
    generation,
    reasons: unique(reasons),
    storedSourceHash: storedHash,
    currentSourceHash,
    storedSourceSnapshot,
    currentSourceSnapshot,
    upstreamStaleReasons,
  };
}

function finiteIndex(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function groupShotIdxs(project: any, groupIdx: number | null, explicit?: number[]): number[] {
  if (Array.isArray(explicit) && explicit.length) {
    return unique(explicit.map((idx) => Number(idx)).filter((idx) => Number.isInteger(idx) && idx >= 0));
  }
  if (groupIdx == null) return [];
  try {
    const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
    return storyboardShotIndices(project, groupIdx, storyboards[groupIdx], { mode: 'single-shot-strict' });
  } catch {
    return [];
  }
}

function pushFlagDecision(
  opts: {
    staleFlags: Record<string, any>;
    key: string;
    reason: ArtifactUsageReason;
    reasons: string[];
    blockingReasons: string[];
    staleFlagKeys: string[];
  },
) {
  if (opts.staleFlags[opts.key] !== true) return;
  opts.reasons.push(opts.reason);
  opts.blockingReasons.push(opts.reason);
  opts.staleFlagKeys.push(opts.key);
}

function repairActionsFor(target: TargetArtifact, groupIdx: number | null, shotPlan: ShotPlanSubDecision): RepairAction[] {
  const actions: RepairAction[] = [];
  if (!shotPlan.usable) {
    actions.push({ kind: 'regenerate_shot_plan', batchType: 'shots', autoStartAllowed: false });
    if (shotPlan.freshness === 'stale' || shotPlan.freshness === 'legacy_unknown') {
      actions.push({ kind: 'confirm_still_valid', autoStartAllowed: false });
    }
  }
  if (target === 'storyboard_prompt') {
    actions.push({ kind: 'regenerate_storyboard_prompts', batchType: 'storyboard_prompts', groupIdx: groupIdx ?? undefined, autoStartAllowed: false });
  } else if (target === 'storyboard_image_generation' || target === 'storyboard_image') {
    actions.push({ kind: 'regenerate_storyboard_images', batchType: 'storyboard_images', groupIdx: groupIdx ?? undefined, autoStartAllowed: false });
  } else if (target === 'video_prompt') {
    actions.push({ kind: 'regenerate_video_prompts', batchType: 'video_prompts', groupIdx: groupIdx ?? undefined, autoStartAllowed: false });
  } else if (target === 'video_segment') {
    actions.push({ kind: 'regenerate_video_segments', batchType: 'video_segments', groupIdx: groupIdx ?? undefined, autoStartAllowed: false });
  }
  return actions;
}

export function describeArtifactStatus(project: any, input: ArtifactUsageInput): ArtifactUsageDecision {
  const target = input.targetArtifact;
  const groupIdx = finiteIndex(input.groupIdx);
  const staleFlags = asStaleFlags(project);
  const shotPlan = evaluateShotPlanDimension(project);
  const reasons: string[] = [...shotPlan.reasons];
  const blockingReasons: string[] = shotPlan.usable ? [] : [...shotPlan.reasons];
  const staleFlagKeys: string[] = staleFlags.shotPlan === true ? ['shotPlan'] : [];
  let generation = shotPlan.generation;
  let consistency: ArtifactUsageDecision['consistency'];

  const checkShotPromptFlags = () => {
    for (const shotIdx of groupShotIdxs(project, groupIdx, input.shotIndices)) {
      pushFlagDecision({
        staleFlags,
        key: `shot_prompt_${shotIdx}`,
        reason: 'shot_prompt_stale',
        reasons,
        blockingReasons,
        staleFlagKeys,
      });
    }
  };

  if (target === 'storyboard_prompt') {
    checkShotPromptFlags();
  }

  if (target === 'storyboard_image_generation' && groupIdx != null) {
    pushFlagDecision({ staleFlags, key: `storyboard_${groupIdx}`, reason: 'storyboard_stale', reasons, blockingReasons, staleFlagKeys });
    checkShotPromptFlags();
  }

  if (target === 'storyboard_image' && groupIdx != null) {
    pushFlagDecision({ staleFlags, key: `storyboard_${groupIdx}`, reason: 'storyboard_stale', reasons, blockingReasons, staleFlagKeys });
    checkShotPromptFlags();
    const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
    const firstFrame = deriveFirstFrameReadiness(storyboards[groupIdx], groupIdx);
    if (!firstFrame.canStart) {
      const reason: ArtifactUsageReason = firstFrame.status === 'failed'
        ? 'first_frame_failed'
        : 'first_frame_missing';
      reasons.push(reason);
      blockingReasons.push(reason);
    }
  }

  if ((target === 'video_prompt' || target === 'video_segment') && groupIdx != null) {
    pushFlagDecision({ staleFlags, key: `storyboard_${groupIdx}`, reason: 'storyboard_stale', reasons, blockingReasons, staleFlagKeys });
    pushFlagDecision({ staleFlags, key: `video_prompt_${groupIdx}`, reason: 'video_prompt_stale', reasons, blockingReasons, staleFlagKeys });
    checkShotPromptFlags();

    const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
    const readiness = deriveVideoPromptReadiness(storyboards[groupIdx], groupIdx);
    if (!readiness.canStart) {
      generation = readiness.status === 'generating'
        ? 'generating'
        : readiness.status === 'failed'
          ? 'failed'
          : readiness.status === 'missing'
            ? 'missing'
            : generation;
      const reason: ArtifactUsageReason = readiness.reason === 'video_prompt_generating'
        ? 'video_prompt_generating'
        : readiness.reason === 'video_prompt_failed'
          ? 'video_prompt_failed'
          : 'missing_video_prompt';
      reasons.push(reason);
      blockingReasons.push(reason);
    }

    let gate: CharacterConsistencyGateResult;
    try {
      gate = validateCharacterConsistencyForGroup(project, {
        groupIdx,
        shotIndices: input.shotIndices,
        target: target === 'video_segment' ? 'videoSegment' : 'videoPrompt',
      });
    } catch (error: any) {
      gate = {
        target: target === 'video_segment' ? 'videoSegment' : 'videoPrompt',
        groupIdx,
        allowed: false,
        score: 0,
        level: 'red',
        blockers: [{
          code: 'critical_reference_missing',
          subReason: 'consistency_gate_error',
          message: error?.message || String(error),
        }],
        warnings: [],
        characterUsages: [],
      };
    }
    consistency = {
      allowed: gate.allowed,
      score: gate.score,
      level: gate.level,
      blockers: gate.blockers,
      warnings: gate.warnings,
      characterUsages: gate.characterUsages,
    };
    if (!gate.allowed) {
      reasons.push('character_consistency_blocked');
      blockingReasons.push('character_consistency_blocked');
      gate.blockers.forEach((blocker) => {
        if (blocker.code === 'nonhuman_species_missing') {
          reasons.push('nonhuman_species_missing');
          blockingReasons.push('nonhuman_species_missing');
        }
        if (blocker.code === 'critical_reference_missing') {
          reasons.push('critical_reference_missing');
          blockingReasons.push('critical_reference_missing');
        }
      });
    }

    if (target === 'video_segment') {
      const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
      const task = videoTasks[groupIdx] || {};
      if (task?.outdated === true) {
        reasons.push('video_task_outdated');
        blockingReasons.push('video_task_outdated');
      }
      if (task?.isCurrent === false) {
        reasons.push('video_task_stale');
        blockingReasons.push('video_task_stale');
      }
      if (storyboards[groupIdx]?.videoIsCurrent === false) {
        reasons.push('storyboard_video_not_current');
        blockingReasons.push('storyboard_video_not_current');
      }
    }
  }

  const uniqueReasons = unique(reasons);
  const uniqueBlockingReasons = unique(blockingReasons);
  const upstreamStaleReasons = unique([
    ...(shotPlan.upstreamStaleReasons || []),
    ...((groupIdx != null && Array.isArray(project?.storyboards?.[groupIdx]?.staleSourceReasons))
      ? project.storyboards[groupIdx].staleSourceReasons.map((item: any) => String(item || '')).filter(Boolean)
      : []),
  ]);
  if (upstreamStaleReasons.length && !uniqueReasons.includes('propagated_from_shot_plan')) {
    uniqueReasons.push('propagated_from_shot_plan');
  }

  return {
    targetArtifact: target,
    projectId: input.projectId,
    groupIdx: groupIdx ?? undefined,
    batchType: input.batchType,
    consumerOperation: input.consumerOperation,
    usability: uniqueBlockingReasons.length ? 'BLOCKED' : 'USABLE',
    freshness: shotPlan.freshness,
    generation,
    reasons: uniqueReasons,
    blockingReasons: uniqueBlockingReasons,
    staleFlagKeys: unique(staleFlagKeys),
    upstreamStaleReasons,
    storedSourceHash: shotPlan.storedSourceHash,
    currentSourceHash: shotPlan.currentSourceHash,
    storedSourceSnapshot: input.includeSnapshots ? shotPlan.storedSourceSnapshot : undefined,
    currentSourceSnapshot: input.includeSnapshots ? shotPlan.currentSourceSnapshot : undefined,
    consistency,
    repairActions: repairActionsFor(target, groupIdx, shotPlan),
  };
}

export function guardArtifactUsage(project: any, input: ArtifactUsageInput): ArtifactUsageDecision {
  const decision = describeArtifactStatus(project, input);
  if (decision.usability === 'BLOCKED') throw new ArtifactUsageBlockedError(decision);
  return decision;
}

export function artifactUsageBlockedPayload(decision: ArtifactUsageDecision) {
  return {
    code: 'artifact_usage_blocked',
    ...decision,
  };
}
