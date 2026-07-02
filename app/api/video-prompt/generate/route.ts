import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream, resolveLLMConfig } from '@/lib/llm';
import { buildVideoPromptMessages } from '@/lib/prompts';
import { projectWorldContextForStage } from '@/lib/world-template-context';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  plannedTimelineGroupsFromProject,
  plannedTimelineStartFromGroups,
  VIDEO_REFERENCE_IMAGE_BUDGET,
  type ReferenceManifestItem,
  type VideoReferenceRole,
} from '@/lib/video-reference-manifest';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from '@/lib/video-prompt-state';
import { maybeAssertStoryboardsAlignedWithShots, storyboardShotIndices } from '@/lib/frame-workflow-state';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { maybeInjectKnowledgePromptBlock } from '@/lib/knowledge/inject-messages';
import type { KnowledgeContextForStage } from '@/lib/knowledge/types';
import { logVideoPromptTrace, summarizePromptForTrace } from '@/lib/video-prompt-observability';
import { describeArtifactStatus, type ArtifactUsageDecision } from '@/lib/sentinel';
import { applyBlockerFilterWithWarnings } from '@/lib/batch-preflight';
import { applyVideoPromptWrite } from '@/lib/video-prompt-lifecycle';
import type { SSEWriter } from '@/lib/sse';
import {
  validateCharacterConsistencyForGroup,
  type CharacterConsistencyGateResult,
} from '@/lib/character-consistency-gate';
import { buildVideoReferenceManifest } from '@/lib/reference-matcher';
import { resolveStoryboardFirstFrameUrl } from '@/lib/visual-reference-state';
import { normalizeSceneViewRole } from '@/lib/scene-views';
import { resolveVideoModelCapability } from '@/lib/video-provider-capabilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function compactText(value: unknown): string {
  return String(value || '').trim();
}

function roleDefaults(role: VideoReferenceRole, viewRole?: unknown): Pick<ReferenceManifestItem, 'useFor' | 'immutable' | 'promptHint'> {
  if (role === 'first_frame') {
    return {
      useFor: ['锁定第 0 帧开场构图', '光照', '主体位置', '画面比例', '色调基准'],
      immutable: ['构图', '光照方向', '主体站位', '画面比例'],
      promptHint: '角色身份由 character reference 锁定，场景细节由 scene reference 锁定。',
    };
  }
  if (role === 'scene') {
    const sceneViewRole = normalizeSceneViewRole(viewRole);
    if (sceneViewRole === 'topdown') {
      return {
        useFor: ['锁定俯视空间布局', '入口/家具/大物件相对位置', '场景朝向'],
        immutable: ['主要空间关系', '入口/家具/大物件相对方位', '场景布局'],
        promptHint: '俯视空间锚只用于保持布局、方位和相对位置，不要求最终镜头变成俯视图。',
      };
    }
    if (sceneViewRole && sceneViewRole !== 'establishing') {
      return {
        useFor: ['锁定同一场景对应机位', '空间结构', '材质', '氛围'],
        immutable: ['场景类型', '主空间关系', '材质和主色调', '对应视角环境特征'],
        promptHint: '这是同一场景的视角参考；锁定环境和机位下的空间关系，不锁人物外貌。',
      };
    }
    return {
      useFor: ['锁定环境布局', '空间结构', '材质', '氛围'],
      immutable: ['场景类型', '道路/地形结构', '主色调', '主要空间关系'],
    };
  }
  if (role === 'character') {
    return {
      useFor: ['锁定角色脸部', '体型', '服装', '物种特征'],
      immutable: ['脸型', '毛发/发色', '服装颜色', '身体类型'],
    };
  }
  return {
    useFor: ['锁定道具材质', '颜色', '尺度', '识别特征'],
    immutable: ['核心形状', '主色', '材质', '用途'],
  };
}

function normalizeRole(value: unknown): VideoReferenceRole | null {
  const role = compactText(value);
  if (role === 'first_frame' || role === 'scene' || role === 'character' || role === 'prop') return role;
  return null;
}

function preflightReasonMessage(reason: string) {
  if (reason === 'first_frame_missing' || reason === 'missing_first_frame') return '缺少可用首帧，请先生成首帧图';
  if (reason === 'first_frame_failed') return '首帧生成失败，请先重新生成首帧图';
  if (reason === 'legacy_sketch_only') return '只有旧版黑白分镜，缺少可用于下游生成的彩色首帧';
  return reason;
}

function sentinelBlockMessage(decision: Pick<ArtifactUsageDecision, 'consistency' | 'blockingReasons'>) {
  return decision.consistency?.blockers?.map((b) => b.message).filter(Boolean).join('；') ||
    decision.blockingReasons.map(preflightReasonMessage).join('、') ||
    'artifact_usage_blocked';
}

type SinglePromptFailureMeta = {
  errorCode: string;
  failureStage: string;
  reason?: string;
};

type MarkVideoPromptFailedArgs = {
  projectId: string;
  userId: number;
  groupIdx: number;
  promptRunId: string;
  errorMessage: string;
  errorCode: string;
  failureStage: string;
  reason: string;
  shotIndices?: number[];
};

type VideoPromptStateWriteResult = {
  applied: boolean;
  skippedReason?: string;
  storedRunId?: string | null;
  storedStatus?: string | null;
  previousRunId?: string | null;
  previousStatus?: string | null;
  project?: any | null;
  shotIndices?: number[];
  sourceHash?: string | null;
};

type MarkVideoPromptGeneratingArgs = {
  projectId: string;
  userId: number;
  groupIdx: number;
  promptRunId: string;
  shotIndices: number[];
};

type WriteVideoPromptReadyArgs = {
  projectId: string;
  userId: number;
  groupIdx: number;
  promptRunId: string;
  prompt: string;
  shotIndices: number[];
  gate: CharacterConsistencyGateResult;
  referenceManifest: ReferenceManifestItem[];
  droppedReferences: any[];
};

function failSingleVideoPrompt(writer: SSEWriter, error: string, meta: SinglePromptFailureMeta) {
  writer.fail({
    error,
    errorCode: meta.errorCode,
    failureStage: meta.failureStage,
    reason: meta.reason,
  });
}

function readStoredVideoPromptState(project: any, groupIdx: number) {
  const sb = Array.isArray(project?.storyboards) ? project.storyboards[groupIdx] || null : null;
  return {
    storedRunId: sb?.videoPromptRunId || null,
    storedStatus: sb?.videoPromptStatus || null,
  };
}

function markVideoPromptGeneratingSameTx(args: MarkVideoPromptGeneratingArgs): VideoPromptStateWriteResult {
  const { projectId, userId, groupIdx, promptRunId } = args;
  let previousRunId: string | null = null;
  let previousStatus: string | null = null;
  let resolvedShotIndices = Array.isArray(args.shotIndices) ? [...args.shotIndices] : [];
  try {
    const markedProject = patchProjectForUser(projectId, userId, (fresh) => {
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx] || {};
      previousRunId = prev?.videoPromptRunId || null;
      previousStatus = prev?.videoPromptStatus || null;
      resolvedShotIndices = storyboardShotIndices(fresh as any, groupIdx, prev, {
        mode: 'single-shot-strict',
        explicitShotIndices: resolvedShotIndices,
      });
      const now = new Date().toISOString();
      storyboards[groupIdx] = {
        ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', now),
        idx: groupIdx,
        shotIdx: groupIdx + 1,
        shotIndices: resolvedShotIndices,
        videoPromptStatus: 'generating',
        videoPromptRunId: promptRunId,
        videoPromptStartedAt: now,
        videoPromptLastError: undefined,
        videoPromptFailedAt: undefined,
      };
      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
      if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
        videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration', now);
      }
      maybeAssertStoryboardsAlignedWithShots({ ...(fresh as any), storyboards, videoTasks }, 'video-prompt-generating');
      return { storyboards, videoTasks };
    });
    if (!markedProject) {
      logVideoPromptTrace('single_prompt_status_marked', {
        projectId,
        groupIdx,
        previousStatus,
        previousRunId,
        newRunId: promptRunId,
        applied: false,
        reason: 'project_missing',
        storedStatus: null,
        storedRunId: null,
      }, 'warn');
      return {
        applied: false,
        skippedReason: 'project_missing',
        storedRunId: null,
        storedStatus: null,
        previousRunId,
        previousStatus,
        project: null,
        shotIndices: resolvedShotIndices,
      };
    }
    const markedSb = Array.isArray((markedProject as any)?.storyboards)
      ? (markedProject as any).storyboards[groupIdx] || {}
      : {};
    const applied = markedSb.videoPromptStatus === 'generating' && markedSb.videoPromptRunId === promptRunId;
    logVideoPromptTrace('single_prompt_status_marked', {
      projectId,
      groupIdx,
      previousStatus,
      previousRunId,
      newRunId: promptRunId,
      applied,
      storedStatus: markedSb.videoPromptStatus || null,
      storedRunId: markedSb.videoPromptRunId || null,
    }, applied ? 'info' : 'warn');
    return {
      applied,
      skippedReason: applied ? undefined : 'write_not_applied',
      storedRunId: markedSb.videoPromptRunId || null,
      storedStatus: markedSb.videoPromptStatus || null,
      previousRunId,
      previousStatus,
      project: markedProject,
      shotIndices: resolvedShotIndices,
    };
  } catch (error: any) {
    logVideoPromptTrace('single_prompt_status_marked', {
      projectId,
      groupIdx,
      previousStatus,
      previousRunId,
      newRunId: promptRunId,
      applied: false,
      reason: 'mark_exception',
      error: (error?.message || String(error)).slice(0, 500),
    }, 'error');
    return {
      applied: false,
      skippedReason: 'mark_exception',
      previousRunId,
      previousStatus,
      shotIndices: resolvedShotIndices,
    };
  }
}

function maybeMarkVideoPromptFailedSameRun(args: MarkVideoPromptFailedArgs): VideoPromptStateWriteResult & { marked: boolean } {
  try {
    return markVideoPromptFailedSameRunUnsafe(args);
  } catch (error: any) {
    logVideoPromptTrace('single_prompt_failure_mark_skipped', {
      projectId: args.projectId,
      groupIdx: args.groupIdx,
      incomingRunId: args.promptRunId,
      storedRunId: null,
      reason: 'mark_exception',
      errorCode: args.errorCode,
      failureStage: args.failureStage,
      failedMarked: false,
      error: (error?.message || String(error)).slice(0, 500),
    }, 'error');
    return {
      applied: false,
      marked: false,
      skippedReason: 'mark_exception',
      storedRunId: null,
      storedStatus: null,
      project: null,
    };
  }
}

function markVideoPromptFailedSameRunUnsafe(args: MarkVideoPromptFailedArgs): VideoPromptStateWriteResult & { marked: boolean } {
  const { projectId, userId, groupIdx, promptRunId, errorMessage, errorCode, failureStage, reason } = args;
  let decision: VideoPromptStateWriteResult & { marked: boolean } = {
    applied: false,
    marked: false,
    skippedReason: 'project_missing',
    storedRunId: null,
    storedStatus: null,
  };
  const failedProject = patchProjectForUser(projectId, userId, (fresh) => {
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const prev = storyboards[groupIdx];
    if (!prev) {
      decision = {
        applied: false,
        marked: false,
        skippedReason: 'slot_missing',
        storedRunId: null,
        storedStatus: null,
      };
      return {};
    }

    if (prev.videoPromptRunId && prev.videoPromptRunId !== promptRunId) {
      decision = {
        applied: false,
        marked: false,
        skippedReason: 'run_taken_by_other',
        storedRunId: prev.videoPromptRunId || null,
        storedStatus: prev.videoPromptStatus || null,
      };
      return {};
    }

    const failedShotIndices = storyboardShotIndices(fresh as any, groupIdx, prev, {
      mode: 'single-shot-strict',
      explicitShotIndices: args.shotIndices,
    });
    const now = new Date().toISOString();
    storyboards[groupIdx] = {
      ...markStoryboardVideoOutdated(prev, 'video_prompt_failed', now),
      idx: groupIdx,
      shotIdx: groupIdx + 1,
      shotIndices: failedShotIndices,
      videoPromptStatus: 'failed',
      videoPromptRunId: promptRunId,
      videoPromptFailedAt: now,
      videoPromptLastError: errorMessage.slice(0, 500),
    };
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
      videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_failed', now);
    }
    maybeAssertStoryboardsAlignedWithShots({ ...(fresh as any), storyboards, videoTasks }, 'video-prompt-failed');
    decision = {
      applied: true,
      marked: true,
      storedRunId: promptRunId,
      storedStatus: 'failed',
      shotIndices: failedShotIndices,
    };
    return { storyboards, videoTasks };
  });
  if (!failedProject) {
    logVideoPromptTrace('single_prompt_failure_mark_skipped', {
      projectId,
      groupIdx,
      incomingRunId: promptRunId,
      storedRunId: null,
      reason: 'project_missing',
      errorCode,
      failureStage,
      failedMarked: false,
    }, 'warn');
    return decision;
  }
  const failedSb = Array.isArray((failedProject as any)?.storyboards)
    ? (failedProject as any).storyboards[groupIdx] || {}
    : {};
  const applied = failedSb.videoPromptStatus === 'failed' && failedSb.videoPromptRunId === promptRunId;
  if (!applied && decision.skippedReason) {
    logVideoPromptTrace('single_prompt_failure_mark_skipped', {
      projectId,
      groupIdx,
      incomingRunId: promptRunId,
      storedRunId: failedSb.videoPromptRunId || decision.storedRunId || null,
      storedStatus: failedSb.videoPromptStatus || decision.storedStatus || null,
      reason: decision.skippedReason,
      errorCode,
      failureStage,
      failedMarked: false,
    }, decision.skippedReason === 'run_taken_by_other' ? 'warn' : 'error');
    return {
      ...decision,
      applied: false,
      marked: false,
      storedRunId: failedSb.videoPromptRunId || decision.storedRunId || null,
      storedStatus: failedSb.videoPromptStatus || decision.storedStatus || null,
      project: failedProject,
    };
  }
  logVideoPromptTrace('single_prompt_failure_marked', {
    projectId,
    groupIdx,
    runId: promptRunId,
    incomingRunId: promptRunId,
    storedRunId: failedSb.videoPromptRunId || null,
    storedStatus: failedSb.videoPromptStatus || null,
    reason,
    errorCode,
    failureStage,
    failedMarked: applied,
    applied,
    error: errorMessage.slice(0, 500),
  }, applied ? 'warn' : 'error');
  return {
    ...decision,
    applied,
    marked: applied,
    skippedReason: applied ? undefined : 'write_not_applied',
    storedRunId: failedSb.videoPromptRunId || null,
    storedStatus: failedSb.videoPromptStatus || null,
    project: failedProject,
  };
}

function writeVideoPromptReadySameRun(args: WriteVideoPromptReadyArgs): VideoPromptStateWriteResult {
  return {
    ...applyVideoPromptWrite({
      projectId: args.projectId,
      userId: args.userId,
      groupIdx: args.groupIdx,
      prompt: args.prompt,
      runId: args.promptRunId,
      ownership: 'same-run',
      writeKind: 'system_generated',
      referenceManifest: args.referenceManifest,
      droppedReferences: args.droppedReferences,
      shotIndices: args.shotIndices,
      consistency: {
        characterUsages: args.gate.characterUsages,
        score: args.gate.score,
        level: args.gate.level,
        warnings: args.gate.warnings,
      },
    }),
  };
}

function videoPromptGateMessage(gate: Pick<CharacterConsistencyGateResult, 'blockers' | 'warnings'>) {
  return gate.blockers?.map((b) => b.message).filter(Boolean).join('；') ||
    gate.warnings?.map((w) => w.message).filter(Boolean).join('；') ||
    '角色一致性检查未通过';
}

function evaluateVideoPromptConsistencyGate(project: any, groupIdx: number, shotIndices: number[]): CharacterConsistencyGateResult {
  try {
    return validateCharacterConsistencyForGroup(project, {
      groupIdx,
      shotIndices,
      target: 'videoPrompt',
    });
  } catch (error: any) {
    const errMessage = error?.message || String(error);
    try {
      console.error('[consistency_gate_error]', JSON.stringify({ groupIdx, target: 'videoPrompt', message: errMessage }));
    } catch {
      console.error('[consistency_gate_error]', { groupIdx, target: 'videoPrompt', message: errMessage });
    }
    if (process.env.RELAX_VIDEO_PROMPT_BLOCKERS !== '0') {
      try {
        console.warn('[relaxed_block]', JSON.stringify({
          target: 'video_prompt_generation',
          reason: 'critical_reference_missing',
          groupIdx,
          key: 'consistency_gate_error',
        }));
      } catch {
        console.warn('[relaxed_block]', {
          target: 'video_prompt_generation',
          reason: 'critical_reference_missing',
          groupIdx,
          key: 'consistency_gate_error',
        });
      }
      return {
        target: 'videoPrompt',
        groupIdx,
        allowed: true,
        score: 60,
        level: 'yellow',
        blockers: [],
        warnings: [{
          code: 'reference_missing',
          subReason: 'consistency_gate_error',
          message: `[已放行] 角色一致性检查异常：${errMessage}`,
        }],
        characterUsages: [],
      };
    }
    return {
      target: 'videoPrompt',
      groupIdx,
      allowed: false,
      score: 0,
      level: 'red',
      blockers: [{
        code: 'critical_reference_missing',
        subReason: 'consistency_gate_error',
        message: errMessage,
      }],
      warnings: [],
      characterUsages: [],
    };
  }
}

function normalizeReferenceBudget(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : VIDEO_REFERENCE_IMAGE_BUDGET;
}

function buildReferenceManifestFromRequest(body: any, groupIdx: number, budget = VIDEO_REFERENCE_IMAGE_BUDGET): ReferenceManifestItem[] {
  const referenceBudget = normalizeReferenceBudget(budget);
  if (Array.isArray(body?.referenceManifest) && body.referenceManifest.length) {
    return body.referenceManifest
      .slice(0, referenceBudget)
      .map((item: any, idx: number) => {
        const role = normalizeRole(item?.role) || 'prop';
        const viewRole = normalizeSceneViewRole(item?.viewRole) || undefined;
        const defaults = roleDefaults(role, viewRole);
        return {
          imageNo: idx + 1,
          role,
          viewRole,
          assetId: compactText(item?.assetId) || undefined,
          assetName: compactText(item?.assetName) || undefined,
          label: compactText(item?.label || item?.assetName || `reference image ${idx + 1}`),
          url: compactText(item?.url),
          useFor: Array.isArray(item?.useFor) ? item.useFor.map(compactText).filter(Boolean) : defaults.useFor,
          immutable: Array.isArray(item?.immutable) ? item.immutable.map(compactText).filter(Boolean) : defaults.immutable,
          promptHint: compactText(item?.promptHint) || defaults.promptHint,
        };
      })
      .filter((item: ReferenceManifestItem) => item.url);
  }

  const assetRefs = Array.isArray(body?.assetRefs) ? body.assetRefs : [];
  if (assetRefs.length) {
    return assetRefs
      .slice(0, referenceBudget)
      .map((ref: any, idx: number) => {
        const role = normalizeRole(ref?.role || ref?.type) || 'prop';
        const viewRole = normalizeSceneViewRole(ref?.viewRole) || undefined;
        const defaults = roleDefaults(role, viewRole);
        return {
          imageNo: idx + 1,
          role,
          viewRole,
          assetId: compactText(ref?.assetId) || undefined,
          assetName: compactText(ref?.assetName || ref?.name) || undefined,
          label: compactText(ref?.label || ref?.assetName || ref?.name || `${role} reference`),
          url: compactText(ref?.url),
          localPath: compactText(ref?.localPath) || undefined,
          useFor: Array.isArray(ref?.useFor) ? ref.useFor.map(compactText).filter(Boolean) : defaults.useFor,
          immutable: Array.isArray(ref?.immutable) ? ref.immutable.map(compactText).filter(Boolean) : defaults.immutable,
          promptHint: compactText(ref?.promptHint) || defaults.promptHint,
          priority: Number.isFinite(Number(ref?.priority)) ? Number(ref.priority) : undefined,
          matchReason: compactText(ref?.matchReason) || undefined,
          score: Number.isFinite(Number(ref?.score)) ? Number(ref.score) : undefined,
          panelInfo: ref?.panelInfo && typeof ref.panelInfo === 'object'
            ? {
                panel: compactText(ref.panelInfo.panel),
                intent: compactText(ref.panelInfo.intent),
              }
            : undefined,
        };
      })
      .filter((item: ReferenceManifestItem) => item.url);
  }

  const manifest: ReferenceManifestItem[] = [];
  const storyboardImageUrl = compactText(body?.storyboardImageUrl);
  if (storyboardImageUrl) {
    manifest.push({
      imageNo: 1,
      role: 'first_frame',
      label: `segment ${groupIdx + 1} first frame`,
      url: storyboardImageUrl,
      ...roleDefaults('first_frame'),
    });
  }

  for (const ref of assetRefs) {
    if (manifest.length >= referenceBudget) break;
    const role = normalizeRole(ref?.role || ref?.type);
    if (!role || role === 'first_frame') continue;
    const url = compactText(ref?.url);
    if (!url || manifest.some((item) => item.url === url)) continue;
    const viewRole = normalizeSceneViewRole(ref?.viewRole) || undefined;
    const defaults = roleDefaults(role, viewRole);
    manifest.push({
      imageNo: manifest.length + 1,
      role,
      viewRole,
      assetId: compactText(ref?.assetId) || undefined,
      assetName: compactText(ref?.assetName || ref?.name) || undefined,
      label: compactText(ref?.label || ref?.assetName || ref?.name || `${role} reference`),
      url,
      useFor: defaults.useFor,
      immutable: defaults.immutable,
      promptHint: compactText(ref?.promptHint) || defaults.promptHint,
    });
  }

  return manifest.map((item, idx) => ({ ...item, imageNo: idx + 1 }));
}

/**
 * 按 group（多个连贯镜头）流式生成视频提示词。
 * 入参对齐原站前端 modules/videoPrompts.js 的 generateGroupVideoPrompt：
 *   { shots, shotIndices, styleBible, assets, narrations, allGroupsShots, allGroupsShotIndices,
 *     groupIdx, totalGroups, storyboardImageUrl, imageUrls, projectId? }
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const videoCfg = resolveLLMConfig(user, 'video');
  const videoCapability = resolveVideoModelCapability(videoCfg.model);
  const referenceBudget = videoCapability.referenceBudget || VIDEO_REFERENCE_IMAGE_BUDGET;
  const projectId: string | undefined = body.projectId;
  const shots: any[] = Array.isArray(body.shots) ? body.shots : [];
  const styleBible: any = body.styleBible || {};
  const assets: any = body.assets || {};
  const narrations: any[] = Array.isArray(body.narrations) ? body.narrations : [];
  const allGroupsShots: any[][] = Array.isArray(body.allGroupsShots)
    ? body.allGroupsShots.map((group: any) => (Array.isArray(group) ? group : []))
    : [];
  const groupIdx: number = Number.isInteger(body.groupIdx) ? body.groupIdx : 0;
  const totalGroups: number = Number.isInteger(body.totalGroups) ? body.totalGroups : 1;
  let timelineStartSec = plannedTimelineStartFromGroups(allGroupsShots, groupIdx);
  let referenceManifest = buildReferenceManifestFromRequest(body, groupIdx, referenceBudget);
	  let droppedReferences = Array.isArray(body.droppedReferences) ? body.droppedReferences : [];
	  const promptRunId = compactText(body.videoPromptRunId) || randomUUID();
	  let planMeta = body.planMeta || null;
  // 用户反馈：videoPrompt 的内容跟 storyboards[i].shotIndices 对不上→视频段
  // 阶段抓不准本组对应的 shot.dialogue。这里把前端传过来的 shotIndices 和
  // 实际入参的 shots 一并落库，video_segments executor 才能拿到正确映射。
  let shotIndices: number[] = Array.isArray(body.shotIndices)
    ? body.shotIndices.filter((x: any) => Number.isInteger(x))
    : [];

  if (!shots.length) {
    return new Response(JSON.stringify({ detail: '本组没有镜头' }), { status: 400 });
  }

  return sseResponse(async (writer) => {
    writer.step(`正在生成第 ${groupIdx + 1}/${totalGroups} 组提示词…`);
    let projectForKnowledge: any = null;
    let markedGenerating = false;
	    if (projectId) {
	      const proj = getProjectByIdForUser(projectId, user.id);
	      if (proj) {
	        planMeta = (proj as any).planMeta || planMeta;
	        timelineStartSec = plannedTimelineStartFromGroups(plannedTimelineGroupsFromProject(proj), groupIdx);
        const sb = Array.isArray((proj as any).storyboards) ? ((proj as any).storyboards[groupIdx] || {}) : {};
        shotIndices = storyboardShotIndices(proj as any, groupIdx, sb, {
          mode: 'single-shot-strict',
          explicitShotIndices: shotIndices,
        });
        const canonicalReferenceBuild = buildVideoReferenceManifest({
          project: proj,
          assets: (proj as any).assets || assets,
          shots: Array.isArray((proj as any).shots) ? (proj as any).shots : shots,
          groupShotIndices: shotIndices,
          groupIdx,
          ownerId: user.id,
          storyboardImageUrl: resolveStoryboardFirstFrameUrl(sb) || null,
          budget: referenceBudget,
        });
        referenceManifest = canonicalReferenceBuild.manifest;
        droppedReferences = canonicalReferenceBuild.droppedReferences;
        const sentinel = describeArtifactStatus(proj as any, {
          projectId,
          targetArtifact: 'video_prompt_generation',
          groupIdx,
          shotIndices,
          consumerOperation: 'video_prompt_generate',
        });
        const filteredSentinel = applyBlockerFilterWithWarnings(sentinel);
        if (filteredSentinel.decision.usability === 'BLOCKED') {
          failSingleVideoPrompt(writer, `视频提示词生成前检查未通过：${sentinelBlockMessage(filteredSentinel.decision)}`, {
            errorCode: 'VIDEO_PROMPT_PREFLIGHT_BLOCKED',
            failureStage: 'preflight',
            reason: 'sentinel_blocked',
          });
          return;
        }
        const markResult = markVideoPromptGeneratingSameTx({
          projectId,
          userId: user.id,
          groupIdx,
          promptRunId,
          shotIndices,
        });
        if (!markResult.applied) {
          failSingleVideoPrompt(writer, '视频提示词生成任务没有成功写入项目，请重试。', {
            errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
            failureStage: 'persist',
            reason: markResult.skippedReason || 'generating_mark_not_applied',
          });
          return;
        }
        markedGenerating = true;
        shotIndices = markResult.shotIndices || shotIndices;
        projectForKnowledge = markResult.project || proj;
      } else {
        failSingleVideoPrompt(writer, '视频提示词生成失败：项目不存在', {
          errorCode: 'VIDEO_PROMPT_PROJECT_NOT_FOUND',
          failureStage: 'preflight',
          reason: 'project_missing',
        });
        return;
      }
    }

    let originalMessages: ReturnType<typeof buildVideoPromptMessages>;
    try {
      const worldContext = projectWorldContextForStage('video_prompt', (projectForKnowledge as any)?.worldTemplateSnapshot, {
        project: projectForKnowledge,
        target: { groupIdx, shotIndices },
      });
		      originalMessages = buildVideoPromptMessages({ shots, styleBible, assets, narrations, referenceManifest, groupIdx, totalGroups, timelineStartSec, planMeta, worldContext });
    } catch (e: any) {
      if (projectId && markedGenerating) {
        maybeMarkVideoPromptFailedSameRun({
          projectId,
          userId: user.id,
          groupIdx,
          promptRunId,
          errorMessage: e?.message || String(e),
          errorCode: 'VIDEO_PROMPT_PROMPT_BUILD_FAILED',
          failureStage: 'prompt_build',
          reason: 'prompt_build_failed',
          shotIndices,
        });
      }
      failSingleVideoPrompt(writer, '视频提示词生成准备失败：' + (e?.message || String(e)), {
        errorCode: 'VIDEO_PROMPT_PROMPT_BUILD_FAILED',
        failureStage: 'prompt_build',
        reason: 'prompt_build_failed',
      });
      return;
    }
    let finalMessages = originalMessages;
    let knowledgeContext: KnowledgeContextForStage | null = null;
    if (projectId && projectForKnowledge) {
      try {
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(projectForKnowledge as any),
            id: projectId,
          },
          stage: 'video_prompt',
          stageTarget: {
            groupIdx,
            totalGroups,
            shotIndices,
            shotCount: shots.length,
            referenceImages: referenceManifest.map((item) => ({
              imageNo: item.imageNo,
              role: item.role,
              viewRole: item.viewRole || null,
              assetId: item.assetId || null,
              label: item.label || null,
            })),
            droppedReferenceCount: droppedReferences.length,
          },
          runId: promptRunId,
        });
        const injected = maybeInjectKnowledgePromptBlock({ messages: originalMessages, context });
        finalMessages = injected.messages;
        knowledgeContext = injected.context;
      } catch (error) {
        console.warn('[video-prompt/generate] knowledge context injection skipped:', error);
      }
    }

    let prompt = '';
    // 单镜头路由历史上把 maxTokens 硬编码成 1800，且没传 traceName，导致它绕过了
    // lib/llm.ts 里 'video-prompts' 这条 task policy（baseMaxTokens=8000、retryMaxTokens=12000）。
    // 中文长 prompt（~1000 字 + 推理 token）跑这个流式接口非常容易在中途撞 max_output_tokens。
    // 这里把 traceName 加上让 policy 接管 maxTokens，并在 output_incomplete 错误时做一次更大
    // 预算的兜底重试——和 chatComplete 内置的 output_incomplete 重试（lib/llm.ts:150-171）对齐。
    const MAX_VIDEO_PROMPT_OUTPUT_INCOMPLETE_RETRIES = 1;
    let streamAttempt = 1;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          prompt = '';
          await chatStream(
            user,
            finalMessages,
            {
              temperature: 0.7,
              modelRole: 'structured',
              traceName: 'video-prompts',
              traceAttempt: streamAttempt,
              tokenContext: {
                projectId: projectId || null,
                projectTitleSnapshot: (projectForKnowledge as any)?.title || null,
                requestPath: req.nextUrl.pathname,
                routeName: 'video-prompt.generate',
                moduleKey: 'video_prompt',
                moduleLabel: '视频提示词',
                featureKey: 'video_prompt_generate',
                featureLabel: '视频提示词生成',
                callItemType: 'storyboard_group',
                callItemId: groupIdx == null ? null : String(groupIdx),
                callItemLabel: `分镜组 ${groupIdx + 1}`,
                runId: promptRunId,
              },
            },
            (delta) => {
              prompt += delta;
              writer.chunk(delta);
            },
          );
          break;
        } catch (streamErr: any) {
          const incompleteReason = String(streamErr?.incompleteReason || '').toLowerCase();
          const isOutputIncomplete =
            String(streamErr?.llmStatus || '').toLowerCase() === 'incomplete'
            && (
              incompleteReason.includes('max_output_tokens')
              || incompleteReason.includes('max_tokens')
              || incompleteReason === 'length'
            );
          if (!isOutputIncomplete || streamAttempt > MAX_VIDEO_PROMPT_OUTPUT_INCOMPLETE_RETRIES) {
            throw streamErr;
          }
          console.warn(
            `[video-prompt/generate] project=${projectId || '?'} group=${groupIdx} ` +
              `attempt=${streamAttempt} output_incomplete (${streamErr.incompleteReason}); ` +
              'retrying once with higher token budget',
          );
          logVideoPromptTrace('single_prompt_output_incomplete_retry', {
            projectId: projectId || null,
            groupIdx,
            runId: promptRunId,
            attempt: streamAttempt,
            incompleteReason: String(streamErr.incompleteReason || 'unknown'),
          }, 'warn');
          // step 是 <step>…</step> 包装的 UI 提示，前端 consumeStreamStepTags 会把它当
          // loading 文案显示，不会污染 prompt 正文。
          writer.step('上次输出未完成，正在以更大预算重试…');
          streamAttempt++;
        }
      }
    } catch (e: any) {
      if (projectId && markedGenerating) {
        maybeMarkVideoPromptFailedSameRun({
          projectId,
          userId: user.id,
          groupIdx,
          promptRunId,
          errorMessage: e?.message || String(e),
          errorCode: 'VIDEO_PROMPT_LLM_FAILED',
          failureStage: 'llm',
          reason: 'llm_failed',
          shotIndices,
        });
      }
      failSingleVideoPrompt(writer, '视频提示词生成失败：' + (e?.message || String(e)), {
        errorCode: 'VIDEO_PROMPT_LLM_FAILED',
        failureStage: 'llm',
        reason: 'llm_failed',
      });
      return;
    }

    const cleanedPrompt = prompt.trim();
    if (!cleanedPrompt) {
      const emptyMessage = 'AI 没有返回提示词';
      if (projectId && markedGenerating) {
        maybeMarkVideoPromptFailedSameRun({
          projectId,
          userId: user.id,
          groupIdx,
          promptRunId,
          errorMessage: emptyMessage,
	          errorCode: 'VIDEO_PROMPT_EMPTY_RESULT',
	          failureStage: 'llm',
	          shotIndices,
          reason: 'empty_result',
        });
      }
      failSingleVideoPrompt(writer, '视频提示词生成失败：' + emptyMessage, {
        errorCode: 'VIDEO_PROMPT_EMPTY_RESULT',
        failureStage: 'llm',
        reason: 'empty_result',
      });
      return;
    }

    let readySourceHash: string | null = null;
    // 写回到对应 storyboard group 的 videoPrompt + shotIndices
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (!proj) {
        logVideoPromptTrace('single_prompt_writeback_rejected', {
          projectId,
          groupIdx,
          incomingRunId: promptRunId,
          storedRunId: null,
          storedStatus: null,
          reason: 'project_missing',
          errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
          failureStage: 'persist',
          failedMarked: false,
        }, 'warn');
        failSingleVideoPrompt(writer, '视频提示词生成结果无法写回：项目不存在', {
          errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
          failureStage: 'persist',
          reason: 'project_missing',
        });
        return;
      }

      const storyboards = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards : [];
      const currentSb = storyboards[groupIdx];
      if (!currentSb) {
        logVideoPromptTrace('single_prompt_writeback_rejected', {
          projectId,
          groupIdx,
          incomingRunId: promptRunId,
          storedRunId: null,
          storedStatus: null,
          reason: 'slot_missing',
          errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
          failureStage: 'persist',
          failedMarked: false,
        }, 'warn');
        failSingleVideoPrompt(writer, '视频提示词生成结果无法写回：当前槽位不存在', {
          errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
          failureStage: 'persist',
          reason: 'slot_missing',
        });
        return;
      }

      shotIndices = storyboardShotIndices(proj as any, groupIdx, currentSb, {
        mode: 'single-shot-strict',
        explicitShotIndices: shotIndices,
      });
      if (currentSb.videoPromptRunId && currentSb.videoPromptRunId !== promptRunId) {
        logVideoPromptTrace('single_prompt_writeback_rejected', {
          projectId,
          groupIdx,
          incomingRunId: promptRunId,
          storedRunId: currentSb.videoPromptRunId || null,
          storedStatus: currentSb.videoPromptStatus || null,
          reason: 'run_taken_by_other',
          errorCode: 'VIDEO_PROMPT_RUN_MISMATCH',
          failureStage: 'persist',
          failedMarked: false,
        }, 'warn');
        failSingleVideoPrompt(writer, '视频提示词生成结果已过期：该片段已有更新的生成任务', {
          errorCode: 'VIDEO_PROMPT_RUN_MISMATCH',
          failureStage: 'persist',
          reason: 'run_taken_by_other',
        });
        return;
      }

      const gate = evaluateVideoPromptConsistencyGate(proj as any, groupIdx, shotIndices);
      if (!gate.allowed) {
        const gateMessage = videoPromptGateMessage(gate);
        const failureMark = maybeMarkVideoPromptFailedSameRun({
          projectId,
          userId: user.id,
          groupIdx,
          promptRunId,
          errorMessage: gateMessage,
	          errorCode: 'VIDEO_PROMPT_CONSISTENCY_GATE_FAILED',
	          failureStage: 'consistency',
	          reason: 'consistency_gate_failed',
	          shotIndices,
	        });
        const stored = readStoredVideoPromptState(failureMark.project || proj, groupIdx);
        logVideoPromptTrace('single_prompt_writeback_rejected', {
          projectId,
          groupIdx,
          incomingRunId: promptRunId,
          storedRunId: stored.storedRunId,
          storedStatus: stored.storedStatus,
          reason: 'consistency_gate_failed',
          errorCode: 'VIDEO_PROMPT_CONSISTENCY_GATE_FAILED',
          failureStage: 'consistency',
          failedMarked: failureMark.marked,
          gateAllowed: false,
          blockingReasons: gate.blockers.map((b) => b.message),
        }, 'warn');
        failSingleVideoPrompt(writer, `视频提示词生成结果未通过角色一致性检查：${gateMessage}`, {
          errorCode: 'VIDEO_PROMPT_CONSISTENCY_GATE_FAILED',
          failureStage: 'consistency',
          reason: 'consistency_gate_failed',
        });
        return;
      }

      let readyResult: VideoPromptStateWriteResult | null = null;
      try {
        readyResult = writeVideoPromptReadySameRun({
          projectId,
          userId: user.id,
          groupIdx,
          promptRunId,
          prompt: cleanedPrompt,
          shotIndices,
          gate,
          referenceManifest,
          droppedReferences,
        });
        logVideoPromptTrace('single_prompt_writeback_result', {
          projectId,
          groupIdx,
          incomingRunId: promptRunId,
          applied: readyResult.applied,
          storedStatus: readyResult.storedStatus || null,
          storedRunId: readyResult.storedRunId || null,
          reason: readyResult.skippedReason || null,
          promptSummary: summarizePromptForTrace(cleanedPrompt),
          gateAllowed: gate.allowed,
          blockingReasons: gate.blockers.map((b) => b.message),
        }, readyResult.applied ? 'info' : 'warn');
        if (!readyResult.applied) {
          if (readyResult.skippedReason === 'run_taken_by_other') {
            logVideoPromptTrace('single_prompt_writeback_rejected', {
              projectId,
              groupIdx,
              incomingRunId: promptRunId,
              storedRunId: readyResult.storedRunId || null,
              storedStatus: readyResult.storedStatus || null,
              reason: 'run_taken_by_other',
              errorCode: 'VIDEO_PROMPT_RUN_MISMATCH',
              failureStage: 'persist',
              failedMarked: false,
              gateAllowed: gate.allowed,
              blockingReasons: gate.blockers.map((b) => b.message),
            }, 'warn');
            failSingleVideoPrompt(writer, '视频提示词生成结果已过期：该片段已有更新的生成任务', {
              errorCode: 'VIDEO_PROMPT_RUN_MISMATCH',
              failureStage: 'persist',
              reason: 'run_taken_by_other',
            });
            return;
          }
          const failureMark = maybeMarkVideoPromptFailedSameRun({
            projectId,
            userId: user.id,
            groupIdx,
            promptRunId,
            errorMessage: '视频提示词生成完成，但结果没有成功写回项目，请重试。',
	            errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
	            failureStage: 'persist',
	            reason: readyResult.skippedReason || 'writeback_not_applied',
	            shotIndices,
	          });
          logVideoPromptTrace('single_prompt_writeback_rejected', {
            projectId,
            groupIdx,
            incomingRunId: promptRunId,
            storedRunId: readyResult.storedRunId || null,
            storedStatus: readyResult.storedStatus || null,
            reason: readyResult.skippedReason || 'writeback_not_applied',
            errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
            failureStage: 'persist',
            failedMarked: failureMark.marked,
            gateAllowed: gate.allowed,
            blockingReasons: gate.blockers.map((b) => b.message),
          }, 'warn');
          failSingleVideoPrompt(writer, '视频提示词生成完成，但结果没有成功写回项目，请重试。', {
            errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
            failureStage: 'persist',
            reason: readyResult.skippedReason || 'writeback_not_applied',
          });
          return;
        }
        shotIndices = readyResult.shotIndices || shotIndices;
        readySourceHash = readyResult.sourceHash || null;
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        const failureMark = maybeMarkVideoPromptFailedSameRun({
          projectId,
          userId: user.id,
          groupIdx,
          promptRunId,
          errorMessage,
	          errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
	          failureStage: 'persist',
	          reason: 'writeback_exception',
	          shotIndices,
	        });
        logVideoPromptTrace('single_prompt_writeback_result', {
          projectId,
          groupIdx,
          incomingRunId: promptRunId,
          applied: false,
          reason: 'writeback_exception',
          errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
          failureStage: 'persist',
          failedMarked: failureMark.marked,
          gateAllowed: gate.allowed,
          blockingReasons: gate.blockers.map((b) => b.message),
          error: errorMessage.slice(0, 500),
        }, 'error');
        failSingleVideoPrompt(writer, '视频提示词生成完成，但保存失败，请重试。', {
          errorCode: 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED',
          failureStage: 'persist',
          reason: 'writeback_exception',
        });
        return;
      }
      try {
        if (knowledgeContext) recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: knowledgeContext, runId: promptRunId });
      } catch (error) {
        console.warn('[video-prompt/generate] knowledge context audit skipped:', error);
      }
    }

    writer.done({
      videoPrompt: cleanedPrompt,
      narrationsUsed: narrations,
      referenceManifest,
	      droppedReferences,
	      groupIdx,
      videoPromptStatus: 'ready',
      videoPromptRunId: promptRunId,
      videoPromptSourceHash: readySourceHash,
    });
  });
}
