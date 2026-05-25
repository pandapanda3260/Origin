import {
  artifactUsageBlockedPayload,
  describeArtifactStatus,
  type ArtifactUsageDecision,
  type TargetArtifact,
} from './sentinel';

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

export function sentinelPreflightForBatch(project: any, projectId: string, batchType: string, targets: any[]) {
  const targetArtifact = targetArtifactForBatch(batchType);
  if (!targetArtifact) return [] as ArtifactUsageDecision[];
  return targets
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
        consumerOperation: 'batch_preflight',
      });
    })
    .filter((decision) => decision.usability === 'BLOCKED');
}

export function batchPreflightPayload(project: any, projectId: string, batchType: string, targets: any[]) {
  const blockedDecisions = isShotPlanDependentBatchType(batchType)
    ? sentinelPreflightForBatch(project, projectId, batchType, targets)
    : [];
  const blocked = blockedDecisions.map(formatBatchPreflightBlockedDecision);
  const first = blockedDecisions[0] || null;
  return {
    ok: true,
    allowed: blocked.length === 0,
    preflight: {
      allowed: blocked.length === 0,
      blocked,
      warnings: [],
    },
    sentinel: first ? artifactUsageBlockedPayload(first) : null,
  };
}
