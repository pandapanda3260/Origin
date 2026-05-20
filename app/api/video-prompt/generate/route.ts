import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import { chatStream } from '@/lib/llm';
import { buildVideoPromptMessages } from '@/lib/prompts';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import {
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
import { describeArtifactStatus } from '@/lib/sentinel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function compactText(value: unknown): string {
  return String(value || '').trim();
}

function roleDefaults(role: VideoReferenceRole): Pick<ReferenceManifestItem, 'useFor' | 'immutable' | 'promptHint'> {
  if (role === 'first_frame') {
    return {
      useFor: ['锁定第 0 帧开场构图', '光照', '主体位置', '画面比例', '色调基准'],
      immutable: ['构图', '光照方向', '主体站位', '画面比例'],
      promptHint: '角色身份由 character reference 锁定，场景细节由 scene reference 锁定。',
    };
  }
  if (role === 'scene') {
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

function sentinelBlockMessage(decision: ReturnType<typeof describeArtifactStatus>) {
  return decision.consistency?.blockers?.map((b) => b.message).filter(Boolean).join('；') ||
    decision.blockingReasons.join('、') ||
    'artifact_usage_blocked';
}

function buildReferenceManifestFromRequest(body: any, groupIdx: number): ReferenceManifestItem[] {
  if (Array.isArray(body?.referenceManifest) && body.referenceManifest.length) {
    return body.referenceManifest
      .slice(0, VIDEO_REFERENCE_IMAGE_BUDGET)
      .map((item: any, idx: number) => ({
        imageNo: idx + 1,
        role: normalizeRole(item?.role) || 'prop',
        assetId: compactText(item?.assetId) || undefined,
        assetName: compactText(item?.assetName) || undefined,
        label: compactText(item?.label || item?.assetName || `reference image ${idx + 1}`),
        url: compactText(item?.url),
        useFor: Array.isArray(item?.useFor) ? item.useFor.map(compactText).filter(Boolean) : roleDefaults(normalizeRole(item?.role) || 'prop').useFor,
        immutable: Array.isArray(item?.immutable) ? item.immutable.map(compactText).filter(Boolean) : roleDefaults(normalizeRole(item?.role) || 'prop').immutable,
        promptHint: compactText(item?.promptHint) || roleDefaults(normalizeRole(item?.role) || 'prop').promptHint,
      }))
      .filter((item: ReferenceManifestItem) => item.url);
  }

  const assetRefs = Array.isArray(body?.assetRefs) ? body.assetRefs : [];
  if (assetRefs.length) {
    return assetRefs
      .slice(0, VIDEO_REFERENCE_IMAGE_BUDGET)
      .map((ref: any, idx: number) => {
        const role = normalizeRole(ref?.role || ref?.type) || 'prop';
        const defaults = roleDefaults(role);
        return {
          imageNo: idx + 1,
          role,
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
    if (manifest.length >= VIDEO_REFERENCE_IMAGE_BUDGET) break;
    const role = normalizeRole(ref?.role || ref?.type);
    if (!role || role === 'first_frame') continue;
    const url = compactText(ref?.url);
    if (!url || manifest.some((item) => item.url === url)) continue;
    const defaults = roleDefaults(role);
    manifest.push({
      imageNo: manifest.length + 1,
      role,
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
  const projectId: string | undefined = body.projectId;
  const shots: any[] = Array.isArray(body.shots) ? body.shots : [];
  const styleBible: any = body.styleBible || {};
  const assets: any = body.assets || {};
  const narrations: any[] = Array.isArray(body.narrations) ? body.narrations : [];
  const groupIdx: number = Number.isInteger(body.groupIdx) ? body.groupIdx : 0;
  const totalGroups: number = Number.isInteger(body.totalGroups) ? body.totalGroups : 1;
  const referenceManifest = buildReferenceManifestFromRequest(body, groupIdx);
  const droppedReferences = Array.isArray(body.droppedReferences) ? body.droppedReferences : [];
  const promptRunId = compactText(body.videoPromptRunId) || randomUUID();
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
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (proj) {
        projectForKnowledge = proj;
        const storyboards = Array.isArray((proj as any).storyboards) ? [...(proj as any).storyboards] : [];
        const sb = storyboards[groupIdx] || {};
        shotIndices = storyboardShotIndices(proj as any, groupIdx, sb, {
          mode: 'single-shot-strict',
          explicitShotIndices: shotIndices,
        });
        const sentinel = describeArtifactStatus(proj as any, {
          projectId,
          targetArtifact: 'video_prompt',
          groupIdx,
          shotIndices,
          consumerOperation: 'video_prompt_generate',
        });
        if (sentinel.usability === 'BLOCKED') {
          writer.error(`视频提示词生成前检查未通过：${sentinelBlockMessage(sentinel)}`);
          return;
        }
        const now = new Date().toISOString();
        const previousStatus = sb?.videoPromptStatus || null;
        const previousRunId = sb?.videoPromptRunId || null;
        storyboards[groupIdx] = {
          ...markStoryboardVideoOutdated(storyboards[groupIdx] || {}, 'video_prompt_regeneration', now),
          idx: groupIdx,
          shotIdx: groupIdx + 1,
          shotIndices,
          videoPromptStatus: 'generating',
          videoPromptRunId: promptRunId,
          videoPromptStartedAt: now,
          videoPromptLastError: undefined,
          videoPromptFailedAt: undefined,
        };
        const videoTasks = Array.isArray((proj as any).videoTasks) ? [...(proj as any).videoTasks] : [];
        if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
          videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration', now);
        }
        maybeAssertStoryboardsAlignedWithShots({ ...(proj as any), storyboards, videoTasks }, 'video-prompt-generating');
        const markedProject = updateProjectForUser(projectId, user.id, { storyboards, videoTasks });
        const markedSb = Array.isArray((markedProject as any)?.storyboards)
          ? (markedProject as any).storyboards[groupIdx] || {}
          : {};
        logVideoPromptTrace('single_prompt_status_marked', {
          projectId,
          groupIdx,
          previousStatus,
          previousRunId,
          newRunId: promptRunId,
          applied: markedSb.videoPromptStatus === 'generating' && markedSb.videoPromptRunId === promptRunId,
          storedStatus: markedSb.videoPromptStatus || null,
          storedRunId: markedSb.videoPromptRunId || null,
        });
      }
    }

    const originalMessages = buildVideoPromptMessages({ shots, styleBible, assets, narrations, referenceManifest, groupIdx, totalGroups });
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
      if (projectId) {
        const proj = getProjectByIdForUser(projectId, user.id);
        if (proj) {
          const storyboards = Array.isArray((proj as any).storyboards) ? [...(proj as any).storyboards] : [];
          const prev = storyboards[groupIdx] || {};
          const failedShotIndices = storyboardShotIndices(proj as any, groupIdx, prev, { mode: 'single-shot-strict' });
          if (!prev.videoPromptRunId || prev.videoPromptRunId === promptRunId) {
            const now = new Date().toISOString();
            storyboards[groupIdx] = {
              ...markStoryboardVideoOutdated(prev, 'video_prompt_failed', now),
              idx: groupIdx,
              shotIdx: groupIdx + 1,
              shotIndices: failedShotIndices,
              videoPromptStatus: 'failed',
              videoPromptRunId: promptRunId,
              videoPromptFailedAt: now,
              videoPromptLastError: (e?.message || String(e)).slice(0, 500),
            };
            const videoTasks = Array.isArray((proj as any).videoTasks) ? [...(proj as any).videoTasks] : [];
            if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
              videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_failed', now);
            }
            maybeAssertStoryboardsAlignedWithShots({ ...(proj as any), storyboards, videoTasks }, 'video-prompt-failed');
            const failedProject = updateProjectForUser(projectId, user.id, { storyboards, videoTasks });
            const failedSb = Array.isArray((failedProject as any)?.storyboards)
              ? (failedProject as any).storyboards[groupIdx] || {}
              : {};
            logVideoPromptTrace('single_prompt_failure_marked', {
              projectId,
              groupIdx,
              runId: promptRunId,
              applied: failedSb.videoPromptStatus === 'failed' && failedSb.videoPromptRunId === promptRunId,
              storedStatus: failedSb.videoPromptStatus || null,
              storedRunId: failedSb.videoPromptRunId || null,
              error: (e?.message || String(e)).slice(0, 500),
            }, 'warn');
          }
        }
      }
      writer.error('视频提示词生成失败：' + (e?.message || String(e)));
      return;
    }

    // 写回到对应 storyboard group 的 videoPrompt + shotIndices
    if (projectId) {
      const proj = getProjectByIdForUser(projectId, user.id);
      if (proj) {
        const storyboards = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards : [];
        const sb = storyboards[groupIdx] || {};
        shotIndices = storyboardShotIndices(proj as any, groupIdx, sb, {
          mode: 'single-shot-strict',
          explicitShotIndices: shotIndices,
        });
        const sentinel = describeArtifactStatus(proj as any, {
          projectId,
          targetArtifact: 'video_prompt',
          groupIdx,
          shotIndices,
          consumerOperation: 'video_prompt_generate_writeback',
        });
        if (sentinel.usability === 'BLOCKED') {
          writer.error(`视频提示词生成结果已过期：${sentinelBlockMessage(sentinel)}`);
          return;
        }
        const gate = sentinel.consistency;
        if (!gate) {
          writer.error('视频提示词生成结果无法写回：角色一致性检查结果缺失');
          return;
        }
        const patch: any = {
          idx: groupIdx,
          shotIdx: groupIdx + 1,
          shotIndices,
          videoPrompt: prompt,
          videoPromptStatus: 'ready',
          videoPromptRunId: promptRunId,
          videoPromptUpdatedAt: new Date().toISOString(),
          videoPromptLastError: undefined,
          videoPromptFailedAt: undefined,
          _vpCache: null,
          videoReferenceManifest: referenceManifest,
          videoReferenceDropped: droppedReferences,
          consistency: {
            ...((storyboards[groupIdx] || {}).consistency || {}),
            videoPrompt: {
              characterUsages: gate.characterUsages,
              score: gate.score,
              level: gate.level,
              warnings: gate.warnings,
            },
          },
        };
        if (storyboards[groupIdx]) {
          if (storyboards[groupIdx].videoPromptRunId && storyboards[groupIdx].videoPromptRunId !== promptRunId) {
            logVideoPromptTrace('single_prompt_writeback_rejected', {
              projectId,
              groupIdx,
              incomingRunId: promptRunId,
              currentRunId: storyboards[groupIdx].videoPromptRunId,
              currentStatus: storyboards[groupIdx].videoPromptStatus || null,
              reason: 'run_mismatch',
            }, 'warn');
            writer.error('视频提示词生成结果已过期：该片段已有更新的生成任务');
            return;
          }
          storyboards[groupIdx] = {
            ...markStoryboardVideoOutdated(storyboards[groupIdx], 'video_prompt_regeneration'),
            ...patch,
          };
        } else {
          writer.error('视频提示词生成结果无法写回：当前槽位不存在');
          return;
        }
        const videoTasks = Array.isArray((proj as any).videoTasks) ? [...(proj as any).videoTasks] : [];
        if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
          videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration');
        }
        maybeAssertStoryboardsAlignedWithShots({ ...(proj as any), storyboards, videoTasks }, 'video-prompt-ready');
        const readyProject = updateProjectForUser(projectId, user.id, { storyboards, videoTasks });
        const readySb = Array.isArray((readyProject as any)?.storyboards)
          ? (readyProject as any).storyboards[groupIdx] || {}
          : {};
        const readyApplied =
          readySb.videoPromptStatus === 'ready' &&
          readySb.videoPromptRunId === promptRunId &&
          String(readySb.videoPrompt || '').trim() === prompt;
        logVideoPromptTrace('single_prompt_writeback_result', {
          projectId,
          groupIdx,
          incomingRunId: promptRunId,
          applied: readyApplied,
          storedStatus: readySb.videoPromptStatus || null,
          storedRunId: readySb.videoPromptRunId || null,
          promptSummary: summarizePromptForTrace(prompt),
        }, readyApplied ? 'info' : 'warn');
        if (!readyApplied) {
          writer.error('视频提示词生成完成，但结果没有成功写回项目，请重试。');
          return;
        }
        try {
          if (knowledgeContext) recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: knowledgeContext, runId: promptRunId });
        } catch (error) {
          console.warn('[video-prompt/generate] knowledge context audit skipped:', error);
        }
      }
    }

    writer.done({
      videoPrompt: prompt,
      narrationsUsed: narrations,
      referenceManifest,
      droppedReferences,
      groupIdx,
      videoPromptStatus: 'ready',
      videoPromptRunId: promptRunId,
    });
  });
}
