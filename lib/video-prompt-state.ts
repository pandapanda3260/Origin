import { validateCharacterConsistencyForGroup, type CharacterConsistencyTarget } from './character-consistency-gate';
import { normalizeFirstFrameState, resolveStoryboardFirstFrameUrl } from './visual-reference-state';

export type VideoPromptStatus = 'ready' | 'generating' | 'failed';

export type VideoPromptReadiness = {
  groupIdx: number;
  status: VideoPromptStatus | 'missing';
  canStart: boolean;
  reason: string;
};

export type FirstFrameReadiness = {
  groupIdx: number;
  status: 'ready' | 'degraded' | 'missing' | 'failed' | 'legacy_sketch_only';
  canStart: boolean;
  reason: string;
  url?: string;
};

export type VideoPromptFailureStage =
  | 'preflight_video_prompt_not_ready'
  | 'preflight_missing_first_frame'
  | 'submit_network'
  | 'submit_rate_limited'
  | 'submit_auth'
  | 'submit_upstream_reject'
  | 'post_submit_poll'
  | 'download'
  | 'persist'
  | 'unknown';

export function isVideoPromptStatus(value: unknown): value is VideoPromptStatus {
  return value === 'ready' || value === 'generating' || value === 'failed';
}

export function deriveVideoPromptReadiness(sb: any, groupIdx: number): VideoPromptReadiness {
  const prompt = typeof sb?.videoPrompt === 'string' ? sb.videoPrompt.trim() : '';
  const storedStatus = isVideoPromptStatus(sb?.videoPromptStatus) ? sb.videoPromptStatus : null;
  if (!prompt) {
    return {
      groupIdx,
      status: storedStatus || 'missing',
      canStart: false,
      reason: 'missing_video_prompt',
    };
  }
  if (!storedStatus) {
    return {
      groupIdx,
      status: 'ready',
      canStart: true,
      reason: 'legacy_ready',
    };
  }
  if (storedStatus !== 'ready') {
    return {
      groupIdx,
      status: storedStatus,
      canStart: false,
      reason: storedStatus === 'generating' ? 'video_prompt_generating' : 'video_prompt_failed',
    };
  }
  return {
    groupIdx,
    status: 'ready',
    canStart: true,
    reason: 'ready',
  };
}

export function buildVideoPromptReadiness(project: any): VideoPromptReadiness[] {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  return storyboards.map((sb: any, groupIdx: number) => deriveVideoPromptReadiness(sb, groupIdx));
}

export function deriveFirstFrameReadiness(sb: any, groupIdx: number): FirstFrameReadiness {
  const state = normalizeFirstFrameState(sb || {});
  const url = resolveStoryboardFirstFrameUrl(sb || {});
  if (state.status === 'ready' && url) {
    return { groupIdx, status: 'ready', canStart: true, reason: 'first_frame_ready', url };
  }
  if (state.status === 'degraded' && url) {
    return { groupIdx, status: 'degraded', canStart: true, reason: 'first_frame_degraded', url };
  }
  if (state.status === 'legacy_sketch_only') {
    return { groupIdx, status: 'legacy_sketch_only', canStart: false, reason: 'legacy_sketch_only', url: url || undefined };
  }
  const status = state.status === 'failed' ? 'failed' : 'missing';
  return {
    groupIdx,
    status,
    canStart: false,
    reason: status === 'failed' ? 'first_frame_failed' : 'missing_first_frame',
    url: url || undefined,
  };
}

export function attachVideoPromptReadiness<T extends Record<string, any>>(project: T): T & { videoPromptReadiness: VideoPromptReadiness[] } {
  return {
    ...project,
    videoPromptReadiness: buildVideoPromptReadiness(project),
  };
}

export function assertVideoPromptReadyForGroups(
  project: any,
  groupIdxs: number[],
  target: CharacterConsistencyTarget = 'videoSegment',
) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const readinessBlocked = groupIdxs
    .map((groupIdx) => deriveVideoPromptReadiness(storyboards[groupIdx], groupIdx))
    .filter((item) => !item.canStart);
  const firstFrameReadiness = target === 'videoSegment'
    ? groupIdxs.map((groupIdx) => deriveFirstFrameReadiness(storyboards[groupIdx], groupIdx))
    : [];
  const firstFrameBlocked = firstFrameReadiness.filter((item) => !item.canStart);
  const firstFrameWarnings = firstFrameReadiness.filter((item) => item.canStart && item.status === 'degraded');
  const consistencyBlocked = groupIdxs
    .map((groupIdx) => validateCharacterConsistencyForGroup(project, { groupIdx, target }))
    .filter((gate) => !gate.allowed)
    .map((gate) => ({
      groupIdx: gate.groupIdx,
      status: 'ready' as const,
      canStart: false,
      reason: gate.blockers[0]?.code || 'character_consistency_blocked',
      consistency: gate,
    }));
  const blocked = [...readinessBlocked, ...firstFrameBlocked, ...consistencyBlocked];
  if (!blocked.length) return { ok: true as const, blocked, warnings: firstFrameWarnings };
  return { ok: false as const, blocked, warnings: firstFrameWarnings };
}

export function markStoryboardVideoOutdated<T extends Record<string, any>>(
  storyboard: T,
  reason: 'video_prompt_regeneration' | 'video_prompt_failed',
  at = new Date().toISOString(),
): T {
  if (!storyboard || typeof storyboard !== 'object') return storyboard;
  return {
    ...storyboard,
    videoIsCurrent: false,
    videoInvalidatedAt: at,
    videoInvalidatedReason: reason,
  };
}

export function markVideoTaskOutdated<T extends Record<string, any>>(
  videoTask: T,
  reason: 'video_prompt_regeneration' | 'video_prompt_failed',
  at = new Date().toISOString(),
): T {
  if (!videoTask || typeof videoTask !== 'object') return videoTask;
  return {
    ...videoTask,
    isCurrent: false,
    invalidatedAt: at,
    invalidatedReason: reason,
  };
}

export function isCurrentVideoRecord(videoTask: any, storyboard: any): boolean {
  if (videoTask && videoTask.isCurrent === false) return false;
  if (storyboard && storyboard.videoIsCurrent === false) return false;
  return true;
}
