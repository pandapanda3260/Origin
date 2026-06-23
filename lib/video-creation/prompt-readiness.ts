import {
  assertVideoPromptReadyForGroups,
  deriveVideoPromptReadiness,
} from '@/lib/video-prompt-state';
import type { CharacterConsistencyTarget } from '@/lib/character-consistency-gate';

export function projectVideoPromptReadiness(project: any) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  return storyboards.map((sb: any, groupIdx: number) => deriveVideoPromptReadiness(sb, groupIdx));
}

export function assertVideoCanStart(
  project: any,
  groupIdxs: number[],
  target: CharacterConsistencyTarget = 'videoSegment',
  opts: { skipConsistency?: boolean } = { skipConsistency: true },
) {
  return assertVideoPromptReadyForGroups(project, groupIdxs, target, opts);
}

function nextActionForConsistencyBlocker(blocker: { code?: string; subReason?: string }): string {
  if (blocker.code === 'character_status_not_locked') return 'confirm_character_lock';
  if (blocker.code === 'nonhuman_species_missing') return 'fill_species';
  if (blocker.code === 'critical_reference_missing') {
    const subReason = String(blocker.subReason || '');
    if (subReason.startsWith('prop:')) return 'regenerate_prop_reference';
    if (subReason.startsWith('character:')) return 'regenerate_character_reference';
    if (subReason.startsWith('scene:')) return 'regenerate_scene_reference';
    if (subReason.startsWith('firstFrame:')) return 'regenerate_first_frame';
    return 'review_reference_image';
  }
  return 'review_character_consistency';
}

export function nextActionsForVideoPreflightReason(reason: string): string[] {
  if (reason === 'reference_images_mode') return [];
  if (reason === 'missing_first_frame' || reason === 'first_frame_missing' || reason === 'first_frame_failed' || reason === 'legacy_sketch_only') return ['regenerate_first_frame'];
  if (reason === 'first_frame_degraded') return ['continue_with_last_known_good_reference', 'regenerate_first_frame'];
  if (reason === 'missing_video_prompt' || reason === 'video_prompt_failed') return ['regenerate_video_prompt'];
  if (reason === 'video_prompt_generating') return ['wait_video_prompt'];
  if (reason === 'tail_pending' || reason === 'tail_frame_pending' || reason === 'first_last_frame_tail_pending') return ['wait_tail_frame'];
  if (reason === 'tail_failed' || reason === 'tail_file_missing' || reason === 'tail_missing') return ['regenerate_tail_frame', 'switch_to_strict_first_frame'];
  if (reason === 'capability_unsupported' || reason === 'first_last_frame_capability_unsupported') return ['switch_video_model', 'switch_to_strict_first_frame'];
  if (reason === 'feature_disabled' || reason === 'first_last_frame_feature_disabled') return ['switch_to_strict_first_frame'];
  return ['review_video_readiness'];
}

function videoPreflightMessage(item: any): string {
  const groupLabel = `片段 ${Number(item?.groupIdx ?? 0) + 1}`;
  const reason = String(item?.reason || '');
  if (reason === 'missing_first_frame' || reason === 'first_frame_missing') return `${groupLabel} 缺少彩色首帧，请先重新生成首帧。`;
  if (reason === 'first_frame_failed') return `${groupLabel} 首帧生成失败，请先重新生成首帧。`;
  if (reason === 'legacy_sketch_only') return `${groupLabel} 只有黑白手稿分镜，缺少可用于视频的彩色首帧，请重新生成首帧。`;
  if (reason === 'first_frame_degraded') return `${groupLabel} 正在使用 last known good 首帧，可继续但建议重新生成最新首帧。`;
  if (reason === 'missing_video_prompt') return `${groupLabel} 缺少视频提示词，请先生成视频提示词。`;
  if (reason === 'video_prompt_failed') return `${groupLabel} 视频提示词生成失败，请先重新生成视频提示词。`;
  if (reason === 'video_prompt_generating') return `${groupLabel} 视频提示词仍在生成中，请等待完成。`;
  if (reason === 'tail_pending' || reason === 'tail_frame_pending' || reason === 'first_last_frame_tail_pending') return `${groupLabel} 尾帧仍在生成中，请等待尾帧完成后再生成视频。`;
  if (reason === 'tail_failed') return `${groupLabel} 尾帧生成失败，请重新生成尾帧；若继续生成，将按当前配置改用首帧+多参考图或严格首帧通道。`;
  if (reason === 'tail_file_missing') return `${groupLabel} 尾帧文件不可解析，请重新生成尾帧；若继续生成，将按当前配置改用首帧+多参考图或严格首帧通道。`;
  if (reason === 'tail_missing') return `${groupLabel} 缺少可用尾帧，将按当前配置改用首帧+多参考图或严格首帧通道。`;
  if (reason === 'capability_unsupported' || reason === 'first_last_frame_capability_unsupported') return `${groupLabel} 当前视频模型不支持首尾帧模式，请切换模型或改用仅首帧模式。`;
  if (reason === 'feature_disabled' || reason === 'first_last_frame_feature_disabled') return `${groupLabel} 首尾帧视频模式当前未开启，请改用仅首帧模式。`;
  if (reason === 'reference_images_mode') return `${groupLabel} 当前为多参考图模式，尾帧不会作为 last_frame 参与本次视频生成。`;
  return `${groupLabel} 视频生成前检查未通过：${reason || 'not_ready'}`;
}

export function formatVideoPreflightBlockedItem(item: any) {
  if (item?.consistency) {
    const gate = item.consistency;
    return {
      groupIdx: gate.groupIdx,
      status: item.status,
      reason: item.reason,
      score: gate.score,
      level: gate.level,
      blockers: gate.blockers,
      warnings: gate.warnings,
      nextActions: Array.from(new Set((gate.blockers || []).map(nextActionForConsistencyBlocker))),
    };
  }
  const reason = String(item?.reason || 'not_ready');
  return {
    groupIdx: item.groupIdx,
    status: item.status,
    reason,
    url: item.url,
    blockers: [{
      code: reason,
      subReason: String(item?.status || ''),
      message: videoPreflightMessage(item),
    }],
    warnings: [],
    nextActions: nextActionsForVideoPreflightReason(reason),
  };
}

export function formatVideoPreflightWarningItem(item: any) {
  const reason = String(item?.reason || 'warning');
  return {
    groupIdx: item.groupIdx,
    status: item.status,
    reason,
    url: item.url,
    message: videoPreflightMessage(item),
    nextActions: nextActionsForVideoPreflightReason(reason),
  };
}

export function formatVideoPayloadPreflightItem(item: any) {
  const reason = String(item?.reason || 'video_payload_preflight_failed');
  return {
    groupIdx: item.groupIdx,
    status: item.status || 'blocked',
    reason,
    url: item.url,
    blockers: [{
      code: item.code || reason,
      subReason: item.subReason || reason,
      message: item.message || videoPreflightMessage(item),
    }],
    warnings: [],
    nextActions: nextActionsForVideoPreflightReason(reason),
    submitMode: item.submitMode,
    payloadMode: item.payloadMode,
  };
}

const VIDEO_PROMPT_DRAFT_PREFLIGHT_EXEMPT_REASONS = new Set([
  'missing_video_prompt',
  'video_prompt_failed',
  'video_prompt_stale',
]);

function hasSavedVideoPromptDraft(project: any, groupIdx: number) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const draft = storyboards[groupIdx]?.videoPromptEditDraft;
  return !!(draft && typeof draft.content === 'string' && draft.content.trim());
}

export function canDraftSatisfyVideoPromptBlock(project: any, groupIdx: number, reasons: any[]) {
  if (!hasSavedVideoPromptDraft(project, groupIdx)) return false;
  const blockingReasons = (reasons || []).map((reason) => String(reason || '')).filter(Boolean);
  if (!blockingReasons.length) return false;
  return blockingReasons.every((reason) => VIDEO_PROMPT_DRAFT_PREFLIGHT_EXEMPT_REASONS.has(reason));
}
