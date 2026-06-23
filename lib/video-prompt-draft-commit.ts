import { validateCharacterConsistencyForGroup } from './character-consistency-gate';
import { storyboardShotIndices } from './frame-workflow-state';
import {
  applyVideoPromptWrite,
  computeVideoPromptSourceHash,
  normalizeVideoPromptContent,
} from './video-prompt-lifecycle';
import type { VideoPromptFailureStage } from './video-prompt-state';

function errorWithFailureStage(message: string, failureStage: VideoPromptFailureStage): Error & { failureStage: VideoPromptFailureStage } {
  const err = new Error(message) as Error & { failureStage: VideoPromptFailureStage };
  err.failureStage = failureStage;
  return err;
}

function videoPromptGateMessage(gate: any) {
  return gate?.blockers?.map((b: any) => b?.message).filter(Boolean).join('；') ||
    gate?.warnings?.map((w: any) => w?.message).filter(Boolean).join('；') ||
    '角色一致性检查未通过';
}

export function commitVideoPromptDraftForSegment(args: {
  project: any;
  projectId: string;
  userId: number;
  groupIdx: number;
  explicitShotIndices?: number[];
}) {
  const storyboards = Array.isArray(args.project?.storyboards) ? [...args.project.storyboards] : [];
  const sb = storyboards[args.groupIdx] || {};
  const draft = sb.videoPromptEditDraft || null;
  if (!draft || typeof draft.content !== 'string') return { project: args.project, committed: false };
  const content = normalizeVideoPromptContent(draft.content);
  if (!content) {
    const err = errorWithFailureStage(
      `片段 ${args.groupIdx + 1} 视频提示词草稿为空，已阻止视频生成。`,
      'preflight_video_prompt_not_ready',
    ) as Error & { errorCode?: string };
    err.errorCode = 'VIDEO_PROMPT_DRAFT_COMMIT_FAILED';
    throw err;
  }

  const shotIndices = storyboardShotIndices(args.project, args.groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices: args.explicitShotIndices,
  });
  const currentSourceHash = computeVideoPromptSourceHash({
    project: args.project,
    groupIdx: args.groupIdx,
    ownerId: args.userId,
  });
  const gateStoryboards = [...storyboards];
  gateStoryboards[args.groupIdx] = { ...sb, videoPrompt: content };
  const gate = validateCharacterConsistencyForGroup(
    { ...args.project, storyboards: gateStoryboards },
    { groupIdx: args.groupIdx, shotIndices, target: 'videoPrompt' },
  );
  if (gate.blockers?.length) {
    const err = errorWithFailureStage(
      `片段 ${args.groupIdx + 1} 视频提示词草稿提交失败：${videoPromptGateMessage(gate)}`,
      'preflight_video_prompt_not_ready',
    ) as Error & { errorCode?: string; gate?: any };
    err.errorCode = 'VIDEO_PROMPT_DRAFT_COMMIT_FAILED';
    err.gate = gate;
    throw err;
  }

  const result = applyVideoPromptWrite({
    projectId: args.projectId,
    userId: args.userId,
    groupIdx: args.groupIdx,
    prompt: content,
    sourceHash: currentSourceHash,
    ownership: 'takeover',
    writeKind: 'commit_draft',
    shotIndices,
    consistency: {
      characterUsages: gate.characterUsages,
      score: gate.score,
      level: gate.level,
      warnings: gate.warnings,
    },
  });
  if (!result.applied) {
    const err = errorWithFailureStage(
      `片段 ${args.groupIdx + 1} 视频提示词草稿提交失败：${result.skippedReason || 'write_not_applied'}`,
      'preflight_video_prompt_not_ready',
    ) as Error & { errorCode?: string; skippedReason?: string };
    err.errorCode = 'VIDEO_PROMPT_DRAFT_COMMIT_FAILED';
    err.skippedReason = result.skippedReason;
    throw err;
  }
  return { project: result.project || args.project, committed: true };
}
