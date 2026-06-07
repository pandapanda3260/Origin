import {
  artifactUsageBlockedPayload,
  describeArtifactStatus,
  type ArtifactUsageDecision,
  type TargetArtifact,
} from './sentinel';

export const CONSISTENCY_AGGREGATE_WARNING = {
  kind: 'consistency_aggregate',
  message: '角色一致性仍有待优化，已继续生成。',
};

const NON_BLOCKING_REASONS = new Set([
  'shot_plan_stale',
  'shot_plan_legacy_unknown',
  'shot_plan_fresh_but_hash_mismatch',
  'storyboard_stale',
  'shot_prompt_stale',
  'video_prompt_stale',
  'video_task_outdated',
  'video_task_stale',
  'storyboard_video_not_current',
  'character_consistency_blocked',
  'character_status_not_locked',
  'nonhuman_species_missing',
  'critical_reference_missing',
]);

const CONSISTENCY_REASONS = new Set([
  'character_consistency_blocked',
  'character_status_not_locked',
  'nonhuman_species_missing',
  'critical_reference_missing',
]);

function uniqueWarnings(warnings: Array<typeof CONSISTENCY_AGGREGATE_WARNING>) {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = warning.kind;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasConsistencyBlock(decision: ArtifactUsageDecision) {
  return (decision.blockingReasons || []).some((reason) => CONSISTENCY_REASONS.has(reason))
    || !!decision.consistency?.blockers?.length;
}

function scrubFilteredConsistency(decision: ArtifactUsageDecision, hadConsistencyBlock: boolean) {
  if (!decision.consistency) return decision.consistency;
  const hadConsistencyWarnings = !!decision.consistency.warnings?.length;
  if (!hadConsistencyBlock && !hadConsistencyWarnings) return decision.consistency;
  return {
    ...decision.consistency,
    blockers: hadConsistencyBlock ? [] : decision.consistency.blockers,
    warnings: [],
  };
}

export function applyBlockerFilterWithWarnings(decision: ArtifactUsageDecision) {
  const blockingReasons = (decision.blockingReasons || []).filter((reason) => !NON_BLOCKING_REASONS.has(reason));
  const reasons = (decision.reasons || []).filter((reason) => !NON_BLOCKING_REASONS.has(reason));
  const hadConsistencyBlock = hasConsistencyBlock(decision);
  const filtered: ArtifactUsageDecision = {
    ...decision,
    usability: blockingReasons.length ? 'BLOCKED' : 'USABLE',
    reasons,
    blockingReasons,
    staleFlagKeys: blockingReasons.length ? decision.staleFlagKeys : [],
    consistency: scrubFilteredConsistency(decision, hadConsistencyBlock),
  };
  return {
    decision: filtered,
    warnings: hadConsistencyBlock && filtered.usability === 'USABLE' ? [CONSISTENCY_AGGREGATE_WARNING] : [],
  };
}

export function applyBlockerFilter(decision: ArtifactUsageDecision): ArtifactUsageDecision {
  return applyBlockerFilterWithWarnings(decision).decision;
}

export function targetArtifactForBatch(batchType: string): TargetArtifact | null {
  if (batchType === 'storyboard_prompts') return 'storyboard_prompt';
  if (batchType === 'storyboard_images') return 'storyboard_image_generation';
  if (batchType === 'tail_frame_images') return 'storyboard_image';
  if (batchType === 'video_prompts') return 'video_prompt_generation';
  if (batchType === 'video_segments' || batchType === 'videos') return 'video_segment';
  return null;
}

export function isShotPlanDependentBatchType(batchType: string) {
  return [
    'storyboard_prompts',
    'storyboard_images',
    'tail_frame_images',
    'video_prompts',
    'video_segments',
    'videos',
  ].includes(batchType);
}

export function sentinelMessage(decision: ArtifactUsageDecision) {
  const groupLabel = decision.groupIdx == null ? '当前项目' : `片段 ${decision.groupIdx + 1}`;
  const reason = decision.blockingReasons[0] || decision.reasons[0] || 'artifact_usage_blocked';
  if (reason === 'shot_plan_generating') return '镜头计划仍在生成中，请等待完成后再进入下游生成。';
  if (reason === 'shot_plan_failed') return '镜头计划生成失败，请先重新生成镜头计划。';
  if (reason === 'shot_plan_stale' || reason === 'shot_plan_fresh_but_hash_mismatch') {
    return '镜头计划所依赖的剧本/风格/资产已变化，请先确认旧镜头仍可用或重新生成。';
  }
  if (reason === 'shot_plan_legacy_unknown') return '当前镜头计划来自旧版本，请先确认旧镜头仍可用或重新生成。';
  if (reason === 'storyboard_stale') return `${groupLabel} 分镜图已过期，请先重新生成分镜图。`;
  if (reason === 'first_frame_missing' || reason === 'missing_first_frame') return `${groupLabel} 缺少可用首帧，请先生成首帧图。`;
  if (reason === 'first_frame_failed') return `${groupLabel} 首帧生成失败，请先重新生成首帧图。`;
  if (reason === 'legacy_sketch_only') return `${groupLabel} 只有旧版黑白分镜，缺少可用于下游生成的彩色首帧。`;
  if (reason === 'shot_prompt_stale') return `${groupLabel} 分镜提示词已过期，请先重新生成提示词。`;
  if (reason === 'video_prompt_stale') return `${groupLabel} 视频提示词已过期，请先重新生成视频提示词。`;
  if (reason === 'video_task_outdated' || reason === 'video_task_stale' || reason === 'storyboard_video_not_current') {
    return `${groupLabel} 已有视频片段与当前上游不一致，请重新生成视频。`;
  }
  if (reason === 'character_consistency_blocked') {
    const first = decision.consistency?.blockers?.[0]?.message;
    return first ? `${groupLabel} 角色一致性未通过：${first}` : `${groupLabel} 角色一致性未通过。`;
  }
  return `${groupLabel} 产物一致性检查未通过：${reason}`;
}

export function formatBatchPreflightBlockedDecision(decision: ArtifactUsageDecision) {
  const reason = decision.blockingReasons[0] || decision.reasons[0] || 'artifact_usage_blocked';
  return {
    groupIdx: decision.groupIdx ?? 0,
    status: decision.generation || 'blocked',
    reason,
    blockers: decision.consistency?.blockers?.length ? decision.consistency.blockers : [{
      code: reason,
      subReason: decision.upstreamStaleReasons?.join(',') || '',
      message: sentinelMessage(decision),
    }],
    warnings: decision.consistency?.warnings || [],
    nextActions: decision.repairActions.map((action) => action.kind),
    decision,
  };
}

export function collectBatchPreflight(project: any, projectId: string, batchType: string, targets: any[], opts: { consumerOperation?: string } = {}) {
  const targetArtifact = targetArtifactForBatch(batchType);
  if (!targetArtifact) return { blockedDecisions: [] as ArtifactUsageDecision[], warnings: [] as Array<typeof CONSISTENCY_AGGREGATE_WARNING> };
  const warnings: Array<typeof CONSISTENCY_AGGREGATE_WARNING> = [];
  const blockedDecisions = targets
    .map((target: any, seq: number) => {
      const rawGroupIdx = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
      const groupIdx = Number(rawGroupIdx);
      const shotIndices = Array.isArray(target?.shotIndices)
        ? target.shotIndices.filter((idx: any) => Number.isInteger(idx) && idx >= 0)
        : targetArtifact === 'storyboard_prompt'
          ? [Number.isFinite(groupIdx) ? Math.floor(groupIdx) : seq]
          : undefined;
      return describeArtifactStatus(project, {
        projectId,
        targetArtifact,
        groupIdx: Number.isFinite(groupIdx) && groupIdx >= 0 ? Math.floor(groupIdx) : undefined,
        shotIndices,
        batchType,
        consumerOperation: opts.consumerOperation || 'batch_preflight',
      });
    })
    .map((decision) => {
      const filtered = applyBlockerFilterWithWarnings(decision);
      warnings.push(...filtered.warnings);
      return filtered.decision;
    })
    .filter((decision) => decision.usability === 'BLOCKED');
  return {
    blockedDecisions,
    warnings: uniqueWarnings(warnings),
  };
}

export function sentinelPreflightForBatch(project: any, projectId: string, batchType: string, targets: any[], opts: { consumerOperation?: string } = {}) {
  return collectBatchPreflight(project, projectId, batchType, targets, opts).blockedDecisions;
}

export function batchPreflightPayload(project: any, projectId: string, batchType: string, targets: any[], opts: { consumerOperation?: string } = {}) {
  const result = isShotPlanDependentBatchType(batchType)
    ? collectBatchPreflight(project, projectId, batchType, targets, opts)
    : { blockedDecisions: [] as ArtifactUsageDecision[], warnings: [] as Array<typeof CONSISTENCY_AGGREGATE_WARNING> };
  const blockedDecisions = result.blockedDecisions;
  const blocked = blockedDecisions.map(formatBatchPreflightBlockedDecision);
  const first = blockedDecisions[0] || null;
  return {
    ok: true,
    allowed: blocked.length === 0,
    preflight: {
      allowed: blocked.length === 0,
      blocked,
      warnings: result.warnings,
    },
    sentinel: first ? artifactUsageBlockedPayload(first) : null,
  };
}
