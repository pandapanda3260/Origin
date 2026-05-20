import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { generateVideo } from '@/lib/video-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { resolveLLMConfig } from '@/lib/llm';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { shortKnowledgeHash } from '@/lib/knowledge/hash';
import { isVideoGenerationEnabled } from '@/lib/system-config';
import { getVideoSubmitMode, isFirstLastFrameVideoModeEnabled } from '@/lib/feature-flags';
import { resolveLocalImagePath } from '@/lib/image-gen';
import {
  computeFirstLastFeatureEnabled,
  normalizeVideoSubmitMode,
  resolveVideoPayloadDecision,
  warnIfFirstLastConfigIgnored,
} from '@/lib/video-payload-decision';
import { resolveStoryboardFirstFrameUrl } from '@/lib/visual-reference-state';
import { resolveVideoModelCapability } from '@/lib/video-provider-capabilities';
import { artifactUsageBlockedPayload, describeArtifactStatus } from '@/lib/sentinel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function codedError(code: string, detail: string, status = 400) {
  return NextResponse.json({ code, detail }, { status });
}

/**
 * 单视频同步生成（不走 batch）。
 * 接口契约 1:1：返回 { ok, taskId, status, url, coverUrl, durationSec, mode }
 */
export async function POST(req: NextRequest) {
  if (!isVideoGenerationEnabled()) {
    return jsonError('视频生成暂时关闭，请稍后再试', 503);
  }

  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = body.projectId ? String(body.projectId) : '';
  const groupIdxRaw = body.groupIdx;
  const hasGroupIdx = groupIdxRaw !== undefined && groupIdxRaw !== null && groupIdxRaw !== '';
  const groupIdx = Number(groupIdxRaw);
  const submitMode = normalizeVideoSubmitMode(body.submitMode, getVideoSubmitMode());
  const hasProjectContext = !!projectId || hasGroupIdx;

  if (hasProjectContext && (!projectId || !Number.isInteger(groupIdx) || groupIdx < 0)) {
    return codedError(
      'project_context_requires_group_idx',
      '项目上下文视频提交必须同时提供 projectId + groupIdx。',
      400,
    );
  }

  if (!hasProjectContext && submitMode === 'first_last_frame') {
    return codedError(
      'submit_mode_requires_project_context',
      '首尾帧模式必须搭配 projectId + groupIdx 提交。',
      400,
    );
  }

  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  if (projectId && !project) return jsonError('项目不存在', 404);

  let prompt: string = (body.prompt || body.videoPrompt || '').toString().trim();
  let firstLastFrameMode: any;
  let referenceImagePath: string | undefined;
  let referenceImageRole: 'first_frame' | 'storyboard_sketch' | undefined;
  let seedanceImageMode: 'strict_first_frame' | 'reference_images' = submitMode === 'reference_images' ? 'reference_images' : 'strict_first_frame';
  let payloadModeReason: string | undefined;

  if (hasProjectContext) {
    const sentinel = describeArtifactStatus(project as any, {
      projectId,
      targetArtifact: 'video_segment',
      groupIdx,
      consumerOperation: 'video_submit',
    });
    if (sentinel.usability === 'BLOCKED') {
      return Response.json(artifactUsageBlockedPayload(sentinel), { status: 409 });
    }
    if ((body.prompt || body.videoPrompt) && String(body.prompt || body.videoPrompt).trim()) {
      return codedError(
        'project_context_prompt_override_not_allowed',
        '项目上下文视频提交使用已保存的视频提示词，不允许在请求体覆盖 prompt。',
        400,
      );
    }
    const storyboards = Array.isArray((project as any)?.storyboards) ? (project as any).storyboards : [];
    const sb = storyboards[groupIdx];
    if (!sb) return codedError('storyboard_not_found', `找不到片段 ${groupIdx + 1}。`, 404);
    prompt = String(sb.videoPrompt || '').trim();
    if (!prompt) return codedError('missing_video_prompt', '缺少视频提示词，请先生成视频提示词。', 400);

    const firstFrameUrl = resolveStoryboardFirstFrameUrl(sb);
    referenceImagePath = resolveLocalImagePath(firstFrameUrl, user.id) || undefined;
    referenceImageRole = referenceImagePath ? 'first_frame' : undefined;
    const tailFrameUrl = String(sb?.frames?.tail?.url || sb?.tailFrameUrl || '').trim();
    const tailFramePath = tailFrameUrl ? (resolveLocalImagePath(tailFrameUrl, user.id) || undefined) : undefined;
    const cfg = resolveLLMConfig(user, 'video');
    const capability = resolveVideoModelCapability(cfg.model);
    const configuredSubmitMode = getVideoSubmitMode();
    const adminAllowsFirstLast = isFirstLastFrameVideoModeEnabled();
    warnIfFirstLastConfigIgnored({ configuredSubmitMode, adminAllowsFirstLast });
    const featureEnabled = computeFirstLastFeatureEnabled({
      submitMode,
      configuredSubmitMode,
      adminAllowsFirstLast,
    });
    const decision = resolveVideoPayloadDecision({
      submitMode,
      firstLastFeatureEnabled: featureEnabled,
      capabilityFirstLastSupported: capability.firstLastFrameMode === 'supported',
      firstFramePath: referenceImagePath,
      tailFramePath,
      tailFrameUrl,
      tailReferenceStatus: sb?.tailFrameReferenceStatus || sb?.frames?.tail?.referenceStatus,
      tailIntentRequested: sb?.tailFrameIntent === 'requested',
    });
    if (decision.hardFail) {
      return codedError(
        decision.failureCode || 'video_preflight_failed',
        decision.failureMessage || '视频生成前置条件不满足。',
        400,
      );
    }
    firstLastFrameMode = decision.firstLastFrameMode;
    payloadModeReason = decision.reason;
    seedanceImageMode = submitMode === 'reference_images' ? 'reference_images' : 'strict_first_frame';
  } else {
    if (!prompt) return jsonError('缺 prompt', 400);
  }

  try {
    if (projectId && project) {
      try {
        const cfg = resolveLLMConfig(user, 'video');
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(project as any),
            id: projectId,
          },
          stage: 'video_submit',
          provider: cfg.provider || cfg.mode,
          stageTarget: {
            groupIdx: Number.isInteger(groupIdx) ? groupIdx : null,
            durationSec: body.durationSec || 4,
            size: body.size || '1080x1920',
            resolution: body.resolution || body.quality || null,
            promptHash: shortKnowledgeHash(prompt),
            submitMode,
            payloadModeReason,
            requestPath: 'api_video_submit',
          },
        });
        recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context });
      } catch (error) {
        console.warn('[video/submit] knowledge context audit skipped:', error);
      }
    }
    const result = await generateVideo(user, {
      prompt,
      size: body.size || '1080x1920',
      resolution: body.resolution || body.quality,
      durationSec: body.durationSec || 4,
      projectId: projectId || undefined,
      groupIdx: hasProjectContext ? groupIdx : undefined,
      referenceImagePath,
      referenceImageRole,
      seedanceImageMode,
      payloadModeReason,
      firstLastFrameMode,
    });
    if (result.status === 'upstream_pending') {
      return jsonOk({
        ok: true,
        taskId: result.taskId,
        status: result.status,
        provider: result.provider,
        providerTaskId: result.providerTaskId,
        durationSec: result.durationSec,
        mode: result.mode,
      });
    }
    return jsonOk({
      ok: true,
      taskId: result.taskId,
      status: result.status,
      url: result.url,
      coverUrl: result.coverUrl,
      durationSec: result.durationSec,
      mode: result.mode,
    });
  } catch (e: any) {
    const status = Number(e?.status || e?.statusCode || 502);
    return jsonError('视频生成失败：' + (e?.message || String(e)), Number.isFinite(status) ? status : 502);
  }
}
