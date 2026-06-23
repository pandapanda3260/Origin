import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { ActiveVideoBatchConflictError, createBatch, findActiveBatchForType } from '@/lib/batches';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  isMultiShotSegmentEnabled,
} from '@/lib/feature-flags';
import { InsufficientCreditsError } from '@/lib/credits';
import {
  beginShotPlanGeneration,
  computeShotPlanSourceHash,
  computeShotPlanSourceSnapshot,
  type ShotPlanSourceSnapshot,
} from '@/lib/project-dependency-state';
import { artifactUsageBlockedPayload } from '@/lib/sentinel';
import {
  collectBatchPreflight,
  formatBatchPreflightBlockedDecision,
  isShotPlanDependentBatchType,
  sentinelMessage,
} from '@/lib/batch-preflight';
import '@/lib/init-executors'; // 副作用：注册所有 executor
import {
  startVideoPromptRun,
  startVideoSegmentRun,
  type VideoCreationStartOutcome,
} from '@/lib/video-creation/start-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function videoCreationStartResponse(outcome: VideoCreationStartOutcome) {
  if (outcome.status === 200) return jsonOk(outcome.body);
  return Response.json(outcome.body, { status: outcome.status });
}

function markShotPlanBatchStarted(opts: {
  projectId: string;
  userId: number;
  batchId: string;
  sourceHash: string;
  sourceSnapshot: ShotPlanSourceSnapshot;
}) {
  patchProjectForUser(opts.projectId, opts.userId, (fresh) => {
    if (!fresh) return null;
    return beginShotPlanGeneration(fresh, {
      batchId: opts.batchId,
      sourceHash: opts.sourceHash,
      sourceSnapshot: opts.sourceSnapshot,
      archive: true,
    });
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const batchType: string = (body.batchType || '').toString();
  const projectId: string = (body.projectId || '').toString();
  const options: any = body.options || {};
  let batchOptions: any = options;
  const applyEditDraft = body.applyEditDraft === true || options?.applyEditDraft === true;
  let batchPreflightWarnings: any[] = [];
  let shotPlanStartContext: null | { sourceHash: string; sourceSnapshot: ShotPlanSourceSnapshot } = null;

  if (!batchType) return jsonError('缺 batchType', 400);
  if (!projectId) return jsonError('缺 projectId', 400);

  // targets 兼容：
  //   1. 标准：body.targets = [{...}, ...]
  //   2. videoTasks.js 老协议：body.storyboardIndices = [0, 2, 3]
  //      → 自动展开成 [{ groupIdx, idx, storyboardIdx }]
  let targets: any[] = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length && Array.isArray(body.storyboardIndices)) {
    targets = body.storyboardIndices
      .map((v: any) => Number(v))
      .filter((n: number) => Number.isFinite(n) && n >= 0)
      .map((n: number) => ({ groupIdx: n, idx: n, storyboardIdx: n }));
  }

  if (!targets.length) return jsonError('targets 不能为空', 400);

  if (batchType === 'video_prompts') {
    return videoCreationStartResponse(startVideoPromptRun({
      user,
      projectId,
      targets,
      options: batchOptions,
    }));
  }

  if (batchType === 'video_segments' || batchType === 'videos') {
    return videoCreationStartResponse(startVideoSegmentRun({
      user,
      projectId,
      batchType: batchType as 'video_segments' | 'videos',
      targets,
      options: batchOptions,
    }));
  }

  // 合并段（多镜头一段）走参考模式、无尾锚点 → 不为其生成尾帧。过滤掉合并段的尾帧 target（flag-gated；现网 OFF 不触发）。
  if (batchType === 'tail_frame_images' && isMultiShotSegmentEnabled()) {
    const projForTail = getProjectByIdForUser(projectId, user.id);
    const sbsForTail = projForTail && Array.isArray((projForTail as any).storyboards) ? (projForTail as any).storyboards : [];
    const beforeCount = targets.length;
    targets = targets.filter((t: any) => {
      const g = Number(t?.groupIdx ?? t?.storyboardIdx ?? t?.idx);
      if (!Number.isFinite(g)) return true;
      const sb = sbsForTail[Math.floor(g)];
      const idxs = sb && Array.isArray(sb.shotIndices) ? sb.shotIndices : [];
      return idxs.length <= 1; // 仅 solo 段保留尾帧
    });
    if (targets.length < beforeCount) {
      console.log(`[batch] tail_frame_images 跳过 ${beforeCount - targets.length} 个合并段（参考模式无尾帧）`);
    }
    if (!targets.length) {
      return jsonOk({ batchId: null, total: 0, skipped: 'merged_no_tail', message: '所选片段均为合并段，参考模式不生成尾帧。' });
    }
  }

  if (isShotPlanDependentBatchType(batchType)) {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    const preflight = collectBatchPreflight(proj as any, projectId, batchType, targets, { consumerOperation: 'batch_start' });
    let blockedDecisions = preflight.blockedDecisions;
    batchPreflightWarnings = preflight.warnings;
    if (blockedDecisions.length) {
      const blockedItems = blockedDecisions.map(formatBatchPreflightBlockedDecision);
      const first = blockedDecisions[0];
      return Response.json(
        {
          error: sentinelMessage(first),
          code: 'artifact_usage_blocked',
          detail: sentinelMessage(first),
          preflight: {
            allowed: false,
            blocked: blockedItems,
            warnings: [],
          },
          sentinel: artifactUsageBlockedPayload(first),
        },
        { status: 409 },
      );
    }
  }

  if ((batchType === 'storyboard_images' || batchType === 'tail_frame_images') && applyEditDraft) {
    batchOptions = {
      ...(batchOptions || {}),
      applyEditDraft: true,
    };
  }

  if (batchType === 'shots') {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    // 防重：同项目已有镜头计划批次在跑 → 直接复用，前端订阅同一批次续显进度，
    // 不再起第二路（双扣积分 + 双写 project.shots）。典型触发场景：镜头表
    // 生成中用户回资产页再点"确认资产，进入下一步"，自动 generateShots 重入。
    const activeShots = findActiveBatchForType({ ownerId: user.id, projectId, batchType: 'shots' });
    if (activeShots) {
      return jsonOk({
        batchId: activeShots.batchId,
        total: activeShots.total,
        status: 'running',
        reused: true,
        duplicateGroupIdxs: [],
      });
    }
    const sourceSnapshot = computeShotPlanSourceSnapshot(proj as any);
    const sourceHash = computeShotPlanSourceHash(proj as any);
    shotPlanStartContext = { sourceHash, sourceSnapshot };
    batchOptions = {
      ...(options || {}),
      shotPlanSourceHash: sourceHash,
      shotPlanSourceSnapshot: sourceSnapshot,
    };
  }

  try {
    const { batchId, total, reused, duplicateGroupIdxs } = createBatch({
      user,
      batchType,
      projectId,
      targets,
      options: batchOptions,
      beforeStart: batchType === 'shots' && shotPlanStartContext
          ? (createdBatchId) => markShotPlanBatchStarted({
            projectId,
            userId: user.id,
            batchId: createdBatchId,
            sourceHash: shotPlanStartContext!.sourceHash,
            sourceSnapshot: shotPlanStartContext!.sourceSnapshot,
          })
        : undefined,
    });
    return jsonOk({
      batchId,
      total,
      status: reused ? 'running' : 'queued',
      reused: !!reused,
      duplicateGroupIdxs: duplicateGroupIdxs || [],
      preflight: batchPreflightWarnings.length
        ? { allowed: true, blocked: [], warnings: batchPreflightWarnings }
        : undefined,
    });
	  } catch (e: any) {
	    if (e instanceof ActiveVideoBatchConflictError) {
	      return jsonError(e.message, 409);
	    }
    if (e instanceof InsufficientCreditsError) {
      return jsonError(e.message, 402);
    }
	    return jsonError('创建 batch 失败：' + (e?.message || String(e)), 500);
	  }
}
