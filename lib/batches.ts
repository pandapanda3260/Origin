/**
 * 批量任务调度（内存 + SQLite 混合）
 *
 * 设计：
 *   - 每个 batch 有 id、type、targets 列表
 *   - 在 batches/batch_tasks 表里持久化（重启后能查到状态，但不会自动重跑）
 *   - 进程内有一个 EventEmitter（每 batch 一个），路由层订阅它来推送 SSE
 *   - 真正干活的是注册的 executor（按 batchType 路由）
 *   - 并发度 = 2（避免触怒图像 API 限流）
 *
 * 不是分布式队列，但对单机本地 dev / 单台部署足够了。
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import type { UserRow } from './db';
import { assertCanStartPaidOperation } from './usage-billing';
import { finalizeBatchFromTasks } from './batch-task-accounting';
import {
  TASK_STATUS_TRANSITIONS,
  batchHeartbeat as heartbeatDurableTasks,
  claimNextTask,
  releaseExpiredTaskLeases,
  requestTaskCancel,
  transitionTaskStatus,
} from './durable-tasks';
import { getProjectByIdForUser, patchProjectForUser } from './projects-db';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from './video-prompt-state';
import { markFirstFrameFailed, markTailFrameFailed } from './visual-reference-state';
import { maybeAssertStoryboardsAlignedWithShots, storyboardShotIndices } from './frame-workflow-state';
import { failShotPlanGenerationPatch } from './project-dependency-state';
import { recordTextFlagIfSensitive } from './content-flags';
import { extractImageModerationError } from './content-sanitize';
import {
  DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT,
  DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT,
  getGlobalImageConcurrencyLimit,
  getGlobalVideoConcurrencyLimit,
} from './system-config';

export type BatchEventName =
  | 'snapshot'
  | 'task_started'
  | 'task_progress'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled'
  | 'batch_completed'
  | 'batch_cancelled';

export type BatchTaskTarget = Record<string, any> & { idx?: number; groupIdx?: number };

export type BatchExecCtx = {
  user: UserRow;
  projectId: string;
  options: any;
  batchId: string;
  taskId: string;
  idempotencyKey: string;
  seq: number;
  target: BatchTaskTarget;
  /** 用来主动推送进度（前端会转成 task_progress 事件）*/
  progress: (payload: any) => void;
  isCancelled: () => boolean;
  throwIfCancelled: () => void;
};

export type BatchExecutor = (ctx: BatchExecCtx) => Promise<{
  /** 给前端的 patch（它会自动写到 project 上） */
  patch?: any;
  /** 主要可视化资源（如生成图 URL）— 进入 task_completed 的 resultUrl */
  resultUrl?: string;
  /** 任意附加数据 */
  extra?: any;
}>;

const _executors = new Map<string, BatchExecutor>();
const _emitters = new Map<string, EventEmitter>();
const BATCH_RUNNER_ID = `${process.pid || 'pid'}:${randomUUID()}`;
const BATCH_HEARTBEAT_INTERVAL_MS = 15_000;
const BATCH_HEARTBEAT_TIMEOUT_MS = 2 * 60_000;
const BATCH_TASK_LEASE_MS = 60_000;
const LEGACY_ORPHAN_GRACE_MS = 60 * 60_000;
const BATCH_RECOVERY_LOOP_KEY = '__qd_batch_recovery_loop_timer__';

class BatchTaskCancelledError extends Error {
  constructor(message = 'task cancelled') {
    super(message);
    this.name = 'BatchTaskCancelledError';
  }
}

export class ActiveVideoBatchConflictError extends Error {
  groupIdxs: number[];
  batchIds: string[];

  constructor(groupIdxs: number[], batchIds: string[], label = '视频生成') {
    super(
      groupIdxs.length
        ? `片段 ${groupIdxs.map((n) => n + 1).join('、')} 已有${label}任务正在运行，请等待完成后再重试`
        : `已有${label}任务正在运行，请等待完成后再重试`,
    );
    this.name = 'ActiveVideoBatchConflictError';
    this.groupIdxs = groupIdxs;
    this.batchIds = batchIds;
  }
}

function _targetGroupIdx(target: BatchTaskTarget): number | null {
  const raw = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function _targetShotIndices(target: BatchTaskTarget, groupIdx: number): number[] {
  const raw = Array.isArray(target?.shotIndices) ? target.shotIndices : [];
  const normalized = raw
    .map((idx: any) => Number(idx))
    .filter((idx: number) => Number.isInteger(idx) && idx >= 0);
  return normalized.length ? normalized : [groupIdx];
}

/**
 * 图像生成失败信息转人话: 若是内容安全审核拦截 (moderation_blocked / content_filter 等),
 * 把展示给用户的报错换成一句明确、可操作的中文; 原始报错仍保留在 imageSafetyAudit 里供排查。
 * 非审核类失败 (网络/限流/参数/鉴权等) 原样返回。检测复用 extractImageModerationError,
 * 它对参数/账户类错误有排除, 不会误判。
 */
function _imageSafetyAuditHint(imageSafetyAudit?: any): string {
  const diagnostics = imageSafetyAudit?.safetyDiagnostics || {};
  const fragments = Array.isArray(diagnostics.likelySensitiveFragments)
    ? diagnostics.likelySensitiveFragments
    : [];
  const uniqueTexts = Array.from(new Set(
    fragments
      .map((item: any) => String(item?.text || '').trim())
      .filter(Boolean),
  )).slice(0, 4);
  if (uniqueTexts.length) {
    return `图像服务未返回具体拦截词，系统推测可先弱化：${uniqueTexts.join('、')}。`;
  }
  const attempts = Array.isArray(imageSafetyAudit?.attempts) ? imageSafetyAudit.attempts : [];
  const hadRewrite = attempts.some((attempt: any) => Array.isArray(attempt?.rewriteDiff) && attempt.rewriteDiff.length);
  if (hadRewrite) {
    return '系统已自动改写并重试，仍被拦截；请进一步弱化惊恐、压迫、爆发、人群挤压等描写，或减少参考图后重试。';
  }
  return '图像服务未返回具体拦截词；建议先弱化惊恐/压迫/爆发/人群挤压等描述，或更换、减少参考图后重试。';
}

function _userFacingImageFailureMessage(rawMessage: string, frameLabel: '首帧' | '尾帧', imageSafetyAudit?: any): string {
  const raw = String(rawMessage || '生成失败');
  const info = extractImageModerationError(raw);
  if (!info.blocked) return raw;
  const code = info.errorCode ? `（${info.errorCode}）` : '';
  return `${frameLabel}未通过内容安全审核${code}：提示词或参考图被图像服务判定为敏感/违规内容。${_imageSafetyAuditHint(imageSafetyAudit)}`;
}

function _clearFailedStoryboardImageState(opts: {
  batchType: string;
  projectId: string;
  user: UserRow;
  target: BatchTaskTarget;
  message: string;
  imageSafetyAudit?: any;
}): null | { groupIdx: number; firstFrameLastError: string; invalidateVideo: true; firstFrameCleared: false } {
  if (opts.batchType !== 'storyboard_images') return null;
  const groupIdx = _targetGroupIdx(opts.target);
  if (groupIdx == null || !opts.projectId) return null;
  const firstFrameLastError = _userFacingImageFailureMessage(opts.message, '首帧', opts.imageSafetyAudit).slice(0, 500);

  try {
    patchProjectForUser(opts.projectId, opts.user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
      if (groupIdx >= shots.length) return null;
      const prev = storyboards[groupIdx] || {};
      const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
        mode: 'single-shot-strict',
        explicitShotIndices: _targetShotIndices(opts.target, groupIdx),
      });
      const error = {
        message: firstFrameLastError,
        failedAt: new Date().toISOString(),
        batchType: opts.batchType,
        imageSafetyAudit: opts.imageSafetyAudit,
      };
      storyboards[groupIdx] = {
        ...prev,
        idx: groupIdx,
        shotIdx: groupIdx + 1,
        shotIndices,
        firstFrame: markFirstFrameFailed(prev, error),
        firstFrameLastError,
        firstFrameFailedAt: error.failedAt,
        firstFrameSafetyAudit: opts.imageSafetyAudit || prev.firstFrameSafetyAudit,
      };
      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'storyboard-image-failure-cleanup');
      return { storyboards };
    });
  } catch (cleanupErr) {
    console.error('[batch] failed to clear storyboard first-frame/video state:', opts.projectId, groupIdx, cleanupErr);
  }

  return { groupIdx, firstFrameLastError, invalidateVideo: true, firstFrameCleared: false };
}

function _clearFailedTailFrameImageState(opts: {
  batchType: string;
  projectId: string;
  user: UserRow;
  target: BatchTaskTarget;
  message: string;
  errorCode?: string;
  recoveryHint?: string;
  imageSafetyAudit?: any;
}): null | {
  groupIdx: number;
  tailFrameLastError: string;
  tailFrameErrorCode?: string;
  tailFrameRecoveryHint?: string;
  tailFrameCleared: false;
  frames?: { tail: any };
} {
  if (opts.batchType !== 'tail_frame_images') return null;
  const groupIdx = _targetGroupIdx(opts.target);
  if (groupIdx == null || !opts.projectId) return null;
  const tailFrameLastError = _userFacingImageFailureMessage(opts.message, '尾帧', opts.imageSafetyAudit).slice(0, 500);
  const errorCode = typeof opts.errorCode === 'string' && opts.errorCode.trim()
    ? opts.errorCode.trim()
    : undefined;
  const recoveryHint = typeof opts.recoveryHint === 'string' && opts.recoveryHint.trim()
    ? opts.recoveryHint.trim()
    : undefined;
  let emittedTail: any = null;

  try {
    patchProjectForUser(opts.projectId, opts.user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
      if (groupIdx >= shots.length) return null;
      const prev = storyboards[groupIdx] || {};
      const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
        mode: 'single-shot-strict',
        explicitShotIndices: _targetShotIndices(opts.target, groupIdx),
      });
      const failedAt = new Date().toISOString();
      const errorRec = {
        message: tailFrameLastError,
        failedAt,
        at: failedAt,
        batchType: opts.batchType,
        errorCode,
        recoveryHint,
        imageSafetyAudit: opts.imageSafetyAudit,
      };
      // 复用 markTailFrameFailed 的 degraded/failed 判定: 有旧图 → degraded + 保留
      // lastKnownGoodUrl; 无旧图 → failed。前后端语义对齐, 前端 _clearFailedTailFrameLocally
      // 和这里写出同一个结果, 刷新拿回 server snapshot 也不会变化。
      const prevTail = (prev.frames && typeof prev.frames === 'object' ? prev.frames.tail : null) || null;
      const nextTailState = markTailFrameFailed(prev, errorRec);
      const nextTail = {
        ...(prevTail || {}),
        url: nextTailState.currentUrl,
        lastKnownGoodUrl: nextTailState.lastKnownGoodUrl,
        status: nextTailState.status,
        source: nextTailState.source,
        lastError: nextTailState.lastError,
        shotIndices,
      };
      emittedTail = nextTail;
      storyboards[groupIdx] = {
        ...prev,
        idx: groupIdx,
        shotIdx: groupIdx + 1,
        shotIndices,
        tailFrameLastError,
        tailFrameFailedAt: failedAt,
        frames: { ...(prev.frames || {}), tail: nextTail },
      };
      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'tail-frame-failure-cleanup');
      return { storyboards };
    });
  } catch (cleanupErr) {
    console.error('[batch] failed to clear storyboard tail-frame state:', opts.projectId, groupIdx, cleanupErr);
  }

  return {
    groupIdx,
    tailFrameLastError,
    tailFrameErrorCode: errorCode,
    tailFrameRecoveryHint: recoveryHint,
    tailFrameCleared: false,
    frames: emittedTail ? { tail: emittedTail } : undefined,
  };
}

function _markFailedAssetImageState(opts: {
  batchType: string;
  projectId: string;
  user: UserRow;
  target: BatchTaskTarget;
  message: string;
  imageSafetyAudit?: any;
}): null | {
  cat: string;
  idx: number;
  referenceStatus: 'degraded' | 'failed';
  imageSafetyAudit?: any;
} {
  if (opts.batchType !== 'asset_images') return null;
  const type = String(opts.target?.type || '');
  const idx = Number(opts.target?.idx);
  if (!Number.isFinite(idx) || idx < 0) return null;
  const cat = type === 'char' ? 'characters' : type === 'scene' ? 'scenes' : type === 'prop' ? 'props' : '';
  if (!cat) return null;
  const topKey = cat === 'characters' ? 'characters' : cat === 'scenes' ? 'environments' : 'props';
  let referenceStatus: 'degraded' | 'failed' = 'failed';
  const failedAt = new Date().toISOString();

  try {
    patchProjectForUser(opts.projectId, opts.user.id, (fresh) => {
      if (!fresh) return null;
      const assets = (fresh as any).assets || { characters: [], scenes: [], props: [] };
      if (!Array.isArray(assets[cat])) assets[cat] = [];
      const currentAsset = assets[cat][idx] || {};
      const existingUrl =
        currentAsset?.reference?.currentUrl ||
        currentAsset?.reference?.lastKnownGoodUrl ||
        currentAsset?.imageUrl ||
        currentAsset?.rawUrl ||
        currentAsset?.realPhotoUrl ||
        currentAsset?.pencilUrl ||
        '';
      referenceStatus = existingUrl ? 'degraded' : 'failed';
      const lastError = {
        message: (opts.message || '生成失败').slice(0, 1000),
        failedAt,
        batchType: opts.batchType,
        imageSafetyAudit: opts.imageSafetyAudit,
      };
      const nextAsset = {
        ...currentAsset,
        reference: {
          ...(currentAsset.reference || {}),
          currentUrl: currentAsset?.reference?.currentUrl || currentAsset?.imageUrl || currentAsset?.rawUrl || undefined,
          lastKnownGoodUrl: currentAsset?.reference?.lastKnownGoodUrl || existingUrl || undefined,
          status: referenceStatus,
          lastError,
        },
        imageLastError: lastError.message,
        imageFailedAt: failedAt,
        imageSafetyAudit: opts.imageSafetyAudit || currentAsset.imageSafetyAudit,
      };
      assets[cat][idx] = nextAsset;

      const top = Array.isArray((fresh as any)[topKey]) ? [...(fresh as any)[topKey]] : [];
      if (top[idx]) {
        top[idx] = {
          ...top[idx],
          reference: nextAsset.reference,
          imageLastError: nextAsset.imageLastError,
          imageFailedAt: failedAt,
          imageSafetyAudit: nextAsset.imageSafetyAudit,
        };
      }
      return { assets, [topKey]: top };
    });
  } catch (cleanupErr) {
    console.error('[batch] failed to mark asset image failure state:', opts.projectId, cat, idx, cleanupErr);
  }

  return {
    cat,
    idx,
    referenceStatus,
    imageSafetyAudit: opts.imageSafetyAudit,
  };
}

type VideoPromptFailureCleanupExtra = {
  groupIdx: number;
  videoPromptRunId: string;
  failureApplied: boolean;
  skippedReason?: string;
  storedRunId?: string | null;
  storedStatus?: string | null;
  videoPromptStatus?: 'failed';
  videoPromptLastError?: string;
  invalidateVideo?: true;
};

function _markFailedVideoPromptState(opts: {
  batchType: string;
  batchId: string;
  projectId: string;
  user: UserRow;
  target: BatchTaskTarget;
  message: string;
}): null | VideoPromptFailureCleanupExtra {
  if (opts.batchType !== 'video_prompts') return null;
  const groupIdx = _targetGroupIdx(opts.target);
  if (groupIdx == null || !opts.projectId) return null;
  const videoPromptLastError = (opts.message || '生成失败').slice(0, 500);
  const now = _nowIso();
  let decision: VideoPromptFailureCleanupExtra = {
    groupIdx,
    videoPromptRunId: opts.batchId,
    failureApplied: false,
    skippedReason: 'project_missing',
    storedRunId: null,
    storedStatus: null,
  };

  try {
    const patchedProject = patchProjectForUser(opts.projectId, opts.user.id, (fresh) => {
      if (!fresh) return {};
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
      if (groupIdx >= shots.length) {
        decision = {
          groupIdx,
          videoPromptRunId: opts.batchId,
          failureApplied: false,
          skippedReason: 'slot_missing',
          storedRunId: null,
          storedStatus: null,
        };
        return {};
      }
      const prev = storyboards[groupIdx] || {};
      const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
        mode: 'single-shot-strict',
        explicitShotIndices: _targetShotIndices(opts.target, groupIdx),
      });
      if (prev.videoPromptRunId && prev.videoPromptRunId !== opts.batchId) {
        console.warn(
          `[batch] ignored stale video_prompt failure project=${opts.projectId} group=${groupIdx} ` +
            `batch=${opts.batchId} currentRun=${prev.videoPromptRunId}`,
        );
        decision = {
          groupIdx,
          videoPromptRunId: opts.batchId,
          failureApplied: false,
          skippedReason: 'run_taken_by_other',
          storedRunId: prev.videoPromptRunId || null,
          storedStatus: prev.videoPromptStatus || null,
        };
        return {};
      }
      storyboards[groupIdx] = {
        ...markStoryboardVideoOutdated(prev, 'video_prompt_failed', now),
        idx: groupIdx,
        shotIdx: groupIdx + 1,
        shotIndices,
        videoPromptStatus: 'failed',
        videoPromptRunId: opts.batchId,
        videoPromptFailedAt: now,
        videoPromptLastError,
      };

      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
      if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
        videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_failed', now);
      }
      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards, videoTasks }, 'video-prompt-failure-cleanup');
      decision = {
        groupIdx,
        videoPromptRunId: opts.batchId,
        failureApplied: true,
        videoPromptStatus: 'failed',
        videoPromptLastError,
        invalidateVideo: true,
        storedRunId: opts.batchId,
        storedStatus: 'failed',
      };
      return { storyboards, videoTasks };
    });
    const sb = Array.isArray((patchedProject as any)?.storyboards)
      ? (patchedProject as any).storyboards[groupIdx] || null
      : null;
    if (sb) {
      const applied = sb.videoPromptStatus === 'failed' && sb.videoPromptRunId === opts.batchId;
      decision = {
        ...decision,
        failureApplied: applied,
        skippedReason: applied ? undefined : (decision.skippedReason || 'write_not_applied'),
        storedRunId: sb.videoPromptRunId || decision.storedRunId || null,
        storedStatus: sb.videoPromptStatus || decision.storedStatus || null,
        videoPromptStatus: applied ? 'failed' : decision.videoPromptStatus,
        videoPromptLastError: applied ? videoPromptLastError : decision.videoPromptLastError,
        invalidateVideo: applied ? true : decision.invalidateVideo,
      };
    }
  } catch (cleanupErr) {
    console.error('[batch] failed to mark video prompt failure state:', opts.projectId, groupIdx, cleanupErr);
    decision = {
      ...decision,
      failureApplied: false,
      skippedReason: 'cleanup_exception',
    };
  }

  return decision;
}

function _markFailedShotPlanState(opts: {
  batchType: string;
  batchId: string;
  projectId: string;
  user: UserRow;
  message: string;
}): null | { shotPlanStatus: 'failed'; shotPlanLastError: string } {
  if (opts.batchType !== 'shots') return null;
  const shotPlanLastError = (opts.message || '镜头计划生成失败').slice(0, 500);
  let applied = false;
  try {
    patchProjectForUser(opts.projectId, opts.user.id, (fresh) => {
      if (!fresh) return null;
      const failure = failShotPlanGenerationPatch(fresh, {
        batchId: opts.batchId,
        error: shotPlanLastError,
      });
      if (!failure.ok) return null;
      applied = true;
      return failure.patch;
    });
  } catch (cleanupErr) {
    console.error('[batch] failed to mark shot-plan failure state:', opts.projectId, cleanupErr);
  }
  return applied ? { shotPlanStatus: 'failed', shotPlanLastError } : null;
}

function _activeGroupBatchLabel(batchType: string): string | null {
  if (batchType === 'video_segments' || batchType === 'videos') return '视频生成';
  if (batchType === 'storyboard_images') return '首帧生成';
  if (batchType === 'tail_frame_images') return '尾帧生成';
  return null;
}

function _findActiveGroupBatchOverlap(db: any, opts: {
  user: UserRow;
  batchType: string;
  projectId: string;
  targets: BatchTaskTarget[];
}): null | {
  batchId: string;
  total: number;
  overlapGroupIdxs: number[];
  batchIds: string[];
  canReuse: boolean;
  label: string;
} {
  const label = _activeGroupBatchLabel(opts.batchType);
  if (!label) return null;
  const requested = Array.from(
    new Set(opts.targets.map(_targetGroupIdx).filter((n): n is number => n != null)),
  );
  if (!requested.length) return null;

  const placeholders = requested.map(() => '?').join(',');
  const groupExpr =
    "COALESCE(json_extract(bt.target_json,'$.groupIdx'), json_extract(bt.target_json,'$.storyboardIdx'), json_extract(bt.target_json,'$.idx'))";
  const rows = db
    .prepare(
      `SELECT b.id AS batchId, b.total AS total, CAST(${groupExpr} AS INTEGER) AS groupIdx
       FROM batches b
       JOIN batch_tasks bt ON bt.batch_id = b.id
       WHERE b.owner_id = ?
         AND b.project_id = ?
         AND b.batch_type = ?
         AND b.status IN ('queued', 'running')
         AND bt.status IN ('queued', 'running', 'retry_pending', 'upstream_pending')
         AND CAST(${groupExpr} AS INTEGER) IN (${placeholders})
       ORDER BY b.created_at DESC, bt.seq ASC`,
    )
    .all(opts.user.id, opts.projectId, opts.batchType, ...requested) as Array<{
      batchId: string;
      total: number;
      groupIdx: number;
    }>;

  if (!rows.length) return null;
  const overlapGroupIdxs: number[] = Array.from(
    new Set<number>(rows.map((row) => Number(row.groupIdx)).filter((n) => Number.isFinite(n))),
  ).sort((a, b) => a - b);
  const batchIds: string[] = Array.from(new Set<string>(rows.map((row) => String(row.batchId))));
  const allRequestedCovered = requested.every((g) => overlapGroupIdxs.includes(g));
  return {
    batchId: String(rows[0].batchId),
    total: Number(rows[0].total) || requested.length,
    overlapGroupIdxs,
    batchIds,
    canReuse: allRequestedCovered && batchIds.length === 1,
    label,
  };
}

/**
 * P1 内测期并发规则：
 *   - 图片/视频类 batch 读取 system_config 的进程级全局上限，默认 3。
 *   - 这个上限由当前 Next.js/worker 进程内所有用户共享，不是单用户额度。
 *   - 大规模用户下的跨进程公平队列留到后续调度层处理。
 *   - 其它（纯文本类）：3。
 */
function _concurrencyFor(batchType: string): number {
  // 视频生成：grok 中转端是异步的（提交后轮询），所以可以并行多个
  // 5 个片段并行 → 总时间约 = 单个片段时间 (1~2 分钟) 而非 5 倍
  if (batchType === 'video_segments' || batchType === 'videos') {
    return getGlobalVideoConcurrencyLimit(DEFAULT_GLOBAL_VIDEO_CONCURRENCY_LIMIT);
  }
  // 分镜图通常 ≤ 6 张：concurrency 6 会把中转站打到排队 → 后面的请求超时；
  // 3 比 4 慢一点点（5-6 张时差 1-2 张的并行位），但能显著降低中转 429 限流概率。
  // 中转站每分钟总配额是固定的，并发越高越容易撞限流，4 多次实测会触发 bad_response。
  if (batchType === 'storyboard_images') return getGlobalImageConcurrencyLimit(DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT);
  if (batchType === 'tail_frame_images') return getGlobalImageConcurrencyLimit(DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT);
  // 资产图也先跟随全局图片上限；后续如需按任务类型细分，再单独加调度策略。
  if (batchType === 'asset_images') {
    return getGlobalImageConcurrencyLimit(DEFAULT_GLOBAL_IMAGE_CONCURRENCY_LIMIT);
  }
  return 3;
}

function _envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function _envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function shouldStartInlineBatchRunner() {
  return _envFlag('BATCH_INLINE_RUNNER', true);
}

export function registerExecutor(batchType: string, fn: BatchExecutor) {
  _executors.set(batchType, fn);
}

/** 给已注册的 batchType 加一个别名（共享同一个 executor） */
export function aliasExecutor(existing: string, alias: string) {
  const fn = _executors.get(existing);
  if (!fn) throw new Error(`aliasExecutor: '${existing}' 尚未注册`);
  _executors.set(alias, fn);
}

function _getEmitter(batchId: string): EventEmitter {
  let e = _emitters.get(batchId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(64);
    _emitters.set(batchId, e);
  }
  return e;
}

export function subscribeBatchEvents(batchId: string, listener: (eventName: BatchEventName, data: any) => void) {
  const e = _getEmitter(batchId);
  const handler = (eventName: BatchEventName) => (data: any) => listener(eventName, data);
  const handlers: Array<[string, any]> = [];
  const events: BatchEventName[] = [
    'snapshot', 'task_started', 'task_progress', 'task_completed',
    'task_failed', 'task_cancelled', 'batch_completed', 'batch_cancelled',
  ];
  for (const ev of events) {
    const h = handler(ev);
    e.on(ev, h);
    handlers.push([ev, h]);
  }
  return () => { for (const [ev, h] of handlers) e.off(ev, h); };
}

function _emit(batchId: string, eventName: BatchEventName, data: any) {
  const e = _getEmitter(batchId);
  e.emit(eventName, data);
}

function _nowIso() {
  return new Date().toISOString();
}

function _isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function _touchBatchHeartbeat(batchId: string) {
  try {
    getDb()
      .prepare(
        "UPDATE batches SET runner_id=?, runner_heartbeat_at=? WHERE id=? AND status IN ('queued','running')",
      )
      .run(BATCH_RUNNER_ID, _nowIso(), batchId);
    heartbeatDurableTasks({ runnerId: BATCH_RUNNER_ID, leaseMs: BATCH_TASK_LEASE_MS });
  } catch (e) {
    console.warn('[batch] heartbeat update failed:', batchId, e);
  }
}

function _startBatchHeartbeat(batchId: string) {
  _touchBatchHeartbeat(batchId);
  const timer = setInterval(() => _touchBatchHeartbeat(batchId), BATCH_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 入口：新建 batch，把每个 target 写进 batch_tasks，然后在后台异步开干。
 */
export function createBatch(opts: {
  user: UserRow;
  batchType: string;
  projectId: string;
  targets: BatchTaskTarget[];
  options?: any;
  beforeStart?: (batchId: string) => void;
}): { batchId: string; total: number; reused?: boolean; duplicateGroupIdxs?: number[] } {
  const db = getDb();
  const total = opts.targets.length;
  assertCanStartPaidOperation(opts.user.id);
  const batchId = randomUUID();
  const optsJson = JSON.stringify(opts.options || {});
  const leaseAt = _nowIso();

  let shouldStartRunner = false;
  let result: { batchId: string; total: number; reused?: boolean; duplicateGroupIdxs?: number[] } | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const active = _findActiveGroupBatchOverlap(db, opts);
    if (active) {
      if (active.canReuse) {
        result = {
          batchId: active.batchId,
          total: active.total,
          reused: true,
          duplicateGroupIdxs: active.overlapGroupIdxs,
        };
        db.exec('COMMIT');
        return result;
      }
      throw new ActiveVideoBatchConflictError(active.overlapGroupIdxs, active.batchIds, active.label);
    }

    const inlineRunner = shouldStartInlineBatchRunner();
    db.prepare(
      `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total, options_json, runner_id, runner_heartbeat_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(
      batchId,
      opts.user.id,
      opts.projectId,
      opts.batchType,
      total,
      optsJson,
      inlineRunner ? BATCH_RUNNER_ID : null,
      inlineRunner ? leaseAt : null,
    );

    const insertTask = db.prepare(
      `INSERT INTO batch_tasks (id, batch_id, seq, task_type, target_json, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
    );
    for (let i = 0; i < opts.targets.length; i++) {
      const tid = randomUUID();
      insertTask.run(tid, batchId, i, opts.batchType, JSON.stringify(opts.targets[i]));
    }
    shouldStartRunner = inlineRunner;
    result = { batchId, total };
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  if (opts.beforeStart && result && !result.reused) {
    try {
      opts.beforeStart(batchId);
    } catch (e: any) {
      const msg = e?.message || String(e);
      try {
        db.prepare(
          `UPDATE batch_tasks
             SET status='failed',
                 error_msg=?,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE batch_id=? AND status IN ('queued','running')`,
        ).run(`batch pre-start failed: ${msg.slice(0, 500)}`, batchId);
        db.prepare(
          `UPDATE batches
             SET status='failed',
                 failed=total,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=?`,
        ).run(batchId);
        _emit(batchId, 'batch_completed', {
          batchId,
          status: 'failed',
          reason: 'pre-start failed',
        });
      } catch (cleanupError) {
        console.error('[batch]', batchId, 'pre-start cleanup failed:', cleanupError);
      }
      throw e;
    }
  }

  // 后台启动（不 await，立即返回 batchId）
  if (shouldStartRunner) setImmediate(() => {
    runBatch({ user: opts.user, batchId, batchType: opts.batchType, projectId: opts.projectId, options: opts.options || {} })
      .catch((e) => {
        console.error('[batch]', batchId, 'fatal:', e);
        // 致命错误：把 batch 标 failed，退还还没消费的 running task 的预扣，避免永久卡 running
        try {
          const tasks = db
            .prepare<{ bid: string }, any>(
              "SELECT id FROM batch_tasks WHERE batch_id = @bid AND status IN ('queued','running')",
            )
            .all({ bid: batchId });
          db.prepare(
            "UPDATE batch_tasks SET status='failed', error_msg=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id=? AND status IN ('queued','running')",
          ).run(`batch fatal: ${String(e?.message || e).slice(0, 500)}`, batchId);
          db.prepare(
            "UPDATE batches SET status='failed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          ).run(batchId);
          _emit(batchId, 'batch_completed', {
            batchId, status: 'failed', reason: 'fatal error',
            failedTaskIds: tasks.map((t: any) => t.id),
          });
        } catch (e2) {
          console.error('[batch]', batchId, 'fatal cleanup also failed:', e2);
        }
      });
  });

  return result || { batchId, total };
}

/**
 * 启动时调用一次：把上次进程退出时仍处于 queued/running 的 batch 全部标 failed，
 * 并把它们还在 running 的 task 做一次退款尝试，避免用户积分被永久吞掉。
 *
 * 注意：这是旧兜底清理路径，只处理没有 runner heartbeat 的历史遗留数据。
 * 生产环境优先使用 recovery worker 的 lease 回收路径。
 * 已进入 running 的任务不自动失败/退款，而是进入 needs_review，避免上游已执行但本地误退。
 *
 * 旧数据没有 runner_heartbeat_at 时走 1 小时保守宽限，避免和 recovery worker 抢占同一批任务。
 */
export function reapOrphanBatches() {
  const db = getDb();
  try {
    const legacyCreatedBefore = _isoAgo(LEGACY_ORPHAN_GRACE_MS);
    const orphanBatches = db
      .prepare<[string], any>(
        `SELECT id, owner_id, project_id, batch_type, created_at
         FROM batches
         WHERE status IN ('queued','running')
           AND (runner_heartbeat_at IS NULL OR runner_heartbeat_at = '')
           AND created_at < ?`,
      )
      .all(legacyCreatedBefore);
    if (!orphanBatches.length) return;
    console.warn(`[batch] reap: 发现 ${orphanBatches.length} 个 heartbeat 过期的孤儿 batch，转入可审计恢复状态`);
    for (const b of orphanBatches) {
      const runningTasks = db
        .prepare<{ bid: string }, any>(
          "SELECT id, provider, provider_task_id FROM batch_tasks WHERE batch_id = @bid AND status = 'running'",
        )
        .all({ bid: b.id });
      const providerHandoffTasks = runningTasks.filter(canResumeByProviderPolling);
      const needsReviewTasks = runningTasks.filter((task: any) => !canResumeByProviderPolling(task));
      const queuedTasks = db
        .prepare<{ bid: string }, any>(
          "SELECT id FROM batch_tasks WHERE batch_id = @bid AND status = 'queued'",
        )
        .all({ bid: b.id });

      if ((b.batch_type === 'video_segments' || b.batch_type === 'videos') && b.project_id) {
        const staleVideoTasks = db
          .prepare<{ bid: string }, any>(
            "SELECT target_json FROM batch_tasks WHERE batch_id = @bid AND status IN ('queued','running')",
          )
          .all({ bid: b.id });
        for (const t of staleVideoTasks) {
          let target: any = {};
          try { target = JSON.parse(t.target_json || '{}'); } catch (_) {}
          const groupIdx = target.storyboardIdx ?? target.groupIdx ?? target.idx;
          if (groupIdx == null) continue;
          db.prepare(
            `UPDATE video_tasks
             SET status='failed',
                 error_msg='orphaned by server restart before remote submit',
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE owner_id=?
               AND project_id=?
               AND group_idx=?
               AND status IN ('queued','running')
               AND (provider_task IS NULL OR provider_task='')
               AND created_at >= ?`,
          ).run(b.owner_id, b.project_id, Number(groupIdx), b.created_at);
        }
      }

      for (const t of queuedTasks) {
        try {
          transitionTaskStatus({
            taskId: String(t.id),
            from: 'queued',
            to: 'cancelled',
            reason: 'orphaned before worker claim',
            actor: 'worker',
            runnerId: BATCH_RUNNER_ID,
          });
        } catch (e) {
          console.error('[batch] reap queued cancel transition failed:', b.id, t.id, e);
        }
      }
      db.prepare(
        `UPDATE batch_tasks
            SET runner_id=NULL,
                lease_expires_at=NULL,
                heartbeat_at=NULL,
                updated_at=?
          WHERE batch_id=? AND status='running'`,
      ).run(_nowIso(), b.id);
      for (const t of providerHandoffTasks) {
        try {
          db.prepare(
            `UPDATE batch_tasks
                SET error_msg=NULL,
                    next_retry_at=NULL,
                    updated_at=?
              WHERE id=? AND status='running'`,
          ).run(_nowIso(), String(t.id));
          transitionTaskStatus({
            taskId: String(t.id),
            from: 'running',
            to: 'upstream_pending',
            reason: `orphaned by server restart; provider polling resumed:${b.batch_type}`,
            actor: 'worker',
            runnerId: BATCH_RUNNER_ID,
          });
        } catch (e) {
          console.error('[batch] reap running upstream_pending transition failed:', b.id, t.id, e);
        }
      }
      for (const t of needsReviewTasks) {
        try {
          db.prepare(
            `UPDATE batch_tasks
                SET error_msg='orphaned by server restart; provider state requires review',
                    updated_at=?
              WHERE id=? AND status='running'`,
          ).run(_nowIso(), String(t.id));
          transitionTaskStatus({
            taskId: String(t.id),
            from: 'running',
            to: 'needs_review',
            reason: `orphaned by server restart:${b.batch_type}`,
            actor: 'worker',
            runnerId: BATCH_RUNNER_ID,
          });
        } catch (e) {
          console.error('[batch] reap running needs_review transition failed:', b.id, t.id, e);
        }
      }
      db.prepare(
        `UPDATE batches
         SET status=?,
             succeeded=(SELECT COUNT(*) FROM batch_tasks WHERE batch_id=? AND status='completed'),
             failed=(SELECT COUNT(*) FROM batch_tasks WHERE batch_id=? AND status='failed'),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?`,
      ).run(runningTasks.length ? 'running' : 'cancelled', b.id, b.id, b.id);
    }
  } catch (e) {
    console.error('[batch] reap orphan failed:', e);
  }
}

const recoveringBatchIds = new Set<string>();

function isBatchLeaseStale(row: any, staleHeartbeatBefore: string, legacyCreatedBefore: string) {
  const heartbeat = String(row?.runner_heartbeat_at || '');
  if (heartbeat) return heartbeat < staleHeartbeatBefore;
  const runnerId = String(row?.runner_id || '');
  if (!runnerId) return true;
  const createdAt = String(row?.created_at || '');
  return !createdAt || createdAt < legacyCreatedBefore;
}

const PROVIDER_POLLABLE_TASK_PROVIDERS = new Set(['volcengine_seedance_video']);

function canResumeByProviderPolling(row: any) {
  const provider = String(row?.provider || '').trim();
  const providerTaskId = String(row?.provider_task_id || '').trim();
  return PROVIDER_POLLABLE_TASK_PROVIDERS.has(provider) && !!providerTaskId;
}

function claimBatchForRecovery(batchId: string) {
  const db = getDb();
  const staleHeartbeatBefore = _isoAgo(BATCH_HEARTBEAT_TIMEOUT_MS);
  const legacyCreatedBefore = _isoAgo(LEGACY_ORPHAN_GRACE_MS);
  const now = _nowIso();
  let claimed: any | null = null;
  let providerHandoffTaskIds: string[] = [];
  let needsReviewTaskIds: string[] = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare<{ id: string }, any>('SELECT * FROM batches WHERE id = @id').get({ id: batchId });
    if (!row || !['queued', 'running'].includes(String(row.status || ''))) {
      db.exec('COMMIT');
      return null;
    }
    if (!isBatchLeaseStale(row, staleHeartbeatBefore, legacyCreatedBefore)) {
      db.exec('COMMIT');
      return null;
    }

    const pendingOnly = db
      .prepare<{ bid: string }, any>(
        `SELECT
           SUM(CASE WHEN status IN ('queued','running','retry_pending') THEN 1 ELSE 0 END) AS runner_owned,
           SUM(CASE WHEN status='upstream_pending' THEN 1 ELSE 0 END) AS upstream_pending
         FROM batch_tasks
         WHERE batch_id = @bid`,
      )
      .get({ bid: batchId }) || {};
    if (Number(pendingOnly.runner_owned || 0) === 0 && Number(pendingOnly.upstream_pending || 0) > 0) {
      db.exec('COMMIT');
      return null;
    }

    const runningTasks = db
      .prepare<{ bid: string }, any>(
        "SELECT id, provider, provider_task_id FROM batch_tasks WHERE batch_id = @bid AND status = 'running'",
      )
      .all({ bid: batchId });
    providerHandoffTaskIds = runningTasks
      .filter(canResumeByProviderPolling)
      .map((task: any) => String(task.id))
      .filter(Boolean);
    needsReviewTaskIds = runningTasks
      .filter((task: any) => !canResumeByProviderPolling(task))
      .map((task: any) => String(task.id))
      .filter(Boolean);
    if (runningTasks.length) {
      db.prepare(
        `UPDATE batch_tasks
            SET runner_id=NULL,
                lease_expires_at=NULL,
                heartbeat_at=NULL,
                updated_at=?
          WHERE batch_id=? AND status='running'`,
      ).run(now, batchId);
    }
    for (const taskId of providerHandoffTaskIds) {
      db.prepare(
        `UPDATE batch_tasks
            SET error_msg=NULL,
                next_retry_at=NULL,
                updated_at=?
          WHERE id=? AND status='running'`,
      ).run(now, taskId);
    }
    for (const taskId of needsReviewTaskIds) {
      db.prepare(
        `UPDATE batch_tasks
            SET error_msg='interrupted by worker recovery; provider state requires review',
                updated_at=?
          WHERE id=? AND status='running'`,
      ).run(now, taskId);
    }

    const counters = db
      .prepare<{ bid: string }, any>(
        `SELECT
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
         FROM batch_tasks
         WHERE batch_id = @bid`,
      )
      .get({ bid: batchId }) || { succeeded: 0, failed: 0 };

    db.prepare(
      `UPDATE batches
          SET status='queued',
              runner_id=?,
              runner_heartbeat_at=?,
              succeeded=?,
              failed=?,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?`,
    ).run(
      BATCH_RUNNER_ID,
      now,
      Number(counters.succeeded || 0),
      Number(counters.failed || 0),
      batchId,
    );

    claimed = { ...row, providerHandoffTaskIds, needsReviewTaskIds };
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  for (const taskId of providerHandoffTaskIds) {
    try {
      transitionTaskStatus({
        taskId,
        from: 'running',
        to: 'upstream_pending',
        reason: `worker recovery resumed provider polling:${claimed.batch_type}`,
        actor: 'worker',
        runnerId: BATCH_RUNNER_ID,
        meta: { batchId },
      });
    } catch (e) {
      console.error('[batch] recovery upstream_pending transition failed:', batchId, taskId, e);
    }
  }

  for (const taskId of needsReviewTaskIds) {
    try {
      transitionTaskStatus({
        taskId,
        from: 'running',
        to: 'needs_review',
        reason: `worker recovery requires provider reconciliation:${claimed.batch_type}`,
        actor: 'worker',
        runnerId: BATCH_RUNNER_ID,
        meta: { batchId },
      });
    } catch (e) {
      console.error('[batch] recovery needs_review transition failed:', batchId, taskId, e);
    }
  }

  return claimed;
}

export function recoverStaleBatches(limit = 8) {
  const db = getDb();
  try {
    releaseExpiredTaskLeases();
    moveReleasedExpiredTasksToRecoverableState();
  } catch (e) {
    console.error('[batch] task lease recovery failed:', e);
  }
  const staleHeartbeatBefore = _isoAgo(BATCH_HEARTBEAT_TIMEOUT_MS);
  const legacyCreatedBefore = _isoAgo(LEGACY_ORPHAN_GRACE_MS);
  const rows = db
    .prepare<{ stale: string; legacy: string; limit: number }, any>(
      `SELECT *
         FROM batches
        WHERE status IN ('queued','running')
          AND (
            runner_id IS NULL
            OR runner_id = ''
            OR (runner_heartbeat_at IS NOT NULL AND runner_heartbeat_at <> '' AND runner_heartbeat_at < @stale)
            OR ((runner_heartbeat_at IS NULL OR runner_heartbeat_at = '') AND created_at < @legacy)
          )
        ORDER BY created_at ASC
        LIMIT @limit`,
    )
    .all({
      stale: staleHeartbeatBefore,
      legacy: legacyCreatedBefore,
      limit: Math.max(1, Math.min(50, Math.floor(limit || 8))),
    });

  let started = 0;
  for (const row of rows) {
    const batchId = String(row.id || '');
    if (!batchId || recoveringBatchIds.has(batchId)) continue;

    let claimed: any | null = null;
    try {
      claimed = claimBatchForRecovery(batchId);
    } catch (e) {
      console.error('[batch] recovery claim failed:', batchId, e);
      continue;
    }
    if (!claimed) continue;

    const user = db
      .prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id')
      .get({ id: Number(claimed.owner_id) });
    if (!user) {
      console.warn('[batch] recovery skipped, missing user:', batchId, claimed.owner_id);
      continue;
    }

    let options: any = {};
    try { options = JSON.parse(String(claimed.options_json || '{}')); } catch {}
    recoveringBatchIds.add(batchId);
    started++;
    setImmediate(() => {
      runBatch({
        user,
        batchId,
        batchType: String(claimed.batch_type || ''),
        projectId: String(claimed.project_id || ''),
        options,
      })
        .catch((e) => console.error('[batch] recovered runner fatal:', batchId, e))
        .finally(() => recoveringBatchIds.delete(batchId));
    });
  }

  if (started) console.warn(`[batch] recovery: claimed ${started} stale/queued batch(es)`);
  return started;
}

function moveReleasedExpiredTasksToRecoverableState(limit = 100) {
  const db = getDb();
  const now = _nowIso();
  const rows = db
    .prepare<{ now: string; limit: number }, any>(
      `SELECT bt.id, bt.status, bt.batch_id, bt.provider, bt.provider_task_id, b.batch_type
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE bt.status = 'running'
          AND (bt.runner_id IS NULL OR bt.runner_id = '')
          AND bt.lease_expires_at IS NOT NULL
          AND bt.lease_expires_at < @now
        ORDER BY bt.lease_expires_at ASC
        LIMIT @limit`,
    )
    .all({ now, limit: Math.max(1, Math.min(500, Math.floor(limit || 100))) });

  for (const row of rows) {
    try {
      if (canResumeByProviderPolling(row)) {
        db.prepare(
          `UPDATE batch_tasks
              SET error_msg=NULL,
                  next_retry_at=NULL,
                  updated_at=?
            WHERE id=? AND status='running'`,
        ).run(now, row.id);
        transitionTaskStatus({
          taskId: String(row.id),
          from: String(row.status) as any,
          to: 'upstream_pending',
          reason: `lease expired; provider polling resumed:${row.batch_type || 'batch'}`,
          actor: 'worker',
          runnerId: BATCH_RUNNER_ID,
          meta: { batchId: row.batch_id, previousStatus: row.status },
        });
      } else {
        transitionTaskStatus({
          taskId: String(row.id),
          from: String(row.status) as any,
          to: 'needs_review',
          reason: `lease expired; provider state requires review:${row.batch_type || 'batch'}`,
          actor: 'worker',
          runnerId: BATCH_RUNNER_ID,
          meta: { batchId: row.batch_id, previousStatus: row.status },
        });
      }
      db.prepare("UPDATE batches SET status='running', updated_at=? WHERE id=? AND status IN ('queued','running')")
        .run(_nowIso(), row.batch_id);
    } catch (e) {
      console.error('[batch] expired task recovery transition failed:', row.id, e);
    }
  }
  return rows.length;
}

export function cancelBatchForUser(opts: {
  batchId: string;
  ownerId: number;
  reason?: string;
}): { cancelled: number; requested: number; ignored: number; snapshot: any | null } {
  const db = getDb();
  const batch = db
    .prepare<{ id: string; ownerId: number }, any>(
      'SELECT id FROM batches WHERE id = @id AND owner_id = @ownerId',
    )
    .get({ id: opts.batchId, ownerId: opts.ownerId });
  if (!batch) {
    const err = new Error('batch not found');
    (err as any).status = 404;
    throw err;
  }

  const tasks = db
    .prepare<{ bid: string }, any>(
      `SELECT id FROM batch_tasks
       WHERE batch_id = @bid
         AND status IN ('queued', 'retry_pending', 'running', 'upstream_pending')`,
    )
    .all({ bid: opts.batchId });
  let cancelled = 0;
  let requested = 0;
  let ignored = 0;
  for (const task of tasks) {
    const result = requestTaskCancel({
      taskId: String(task.id),
      actor: 'user',
      reason: opts.reason || 'batch cancel requested',
    });
    if (result.mode === 'cancelled') cancelled++;
    else if (result.mode === 'requested') requested++;
    else ignored++;
  }

  const final = finalizeBatchFromTasks(opts.batchId);
  if (final.status === 'cancelled') {
    _emit(opts.batchId, 'batch_cancelled', {
      batchId: opts.batchId,
      status: 'cancelled',
      cancelled: final.cancelled,
      total: final.total,
    });
  } else {
    emitSnapshot(opts.batchId);
  }
  return {
    cancelled,
    requested,
    ignored,
    snapshot: getBatchSnapshot(opts.batchId, opts.ownerId),
  };
}

export function startBatchRecoveryLoop() {
  const globalScope = globalThis as any;
  if (globalScope[BATCH_RECOVERY_LOOP_KEY]) return globalScope[BATCH_RECOVERY_LOOP_KEY] as NodeJS.Timeout;

  const intervalMs = _envInt('BATCH_RECOVERY_INTERVAL_MS', 10_000, 2_000, 10 * 60_000);
  try { recoverStaleBatches(); } catch (e) { console.error('[batch] initial recovery failed:', e); }
  const timer = setInterval(() => {
    try {
      recoverStaleBatches();
    } catch (e) {
      console.error('[batch] periodic recovery failed:', e);
    }
  }, intervalMs);
  timer.unref?.();
  globalScope[BATCH_RECOVERY_LOOP_KEY] = timer;
  console.log(`[batch] recovery loop started interval=${intervalMs}ms`);
  return timer;
}

export function startBatchOrphanReaper() {
  const key = '__qd_batch_orphan_reaper_timer__';
  const globalScope = globalThis as any;
  if (globalScope[key]) return globalScope[key] as NodeJS.Timeout;

  const intervalMs = _envInt('BATCH_ORPHAN_REAPER_INTERVAL_MS', 30_000, 5_000, 10 * 60_000);
  const timer = setInterval(() => {
    try {
      reapOrphanBatches();
    } catch (e) {
      console.error('[batch] periodic orphan reap failed:', e);
    }
  }, intervalMs);
  timer.unref?.();
  globalScope[key] = timer;
  console.log(`[batch] periodic orphan reaper started interval=${intervalMs}ms`);
  return timer;
}

function isTaskCancelRequested(taskId: string) {
  const row = getDb()
    .prepare<{ id: string }, { cancel_requested_at: string | null; status: string }>(
      'SELECT cancel_requested_at, status FROM batch_tasks WHERE id = @id',
    )
    .get({ id: taskId });
  return Boolean(row?.cancel_requested_at) || row?.status === 'cancelled';
}

function throwIfTaskCancelRequested(taskId: string) {
  if (isTaskCancelRequested(taskId)) {
    throw new BatchTaskCancelledError('task cancelled by request');
  }
}

export function resolveTaskStartTransitionConflict(opts: {
  taskId: string;
  runnerId: string;
  batchId?: string;
  targetSeq?: number;
  target?: BatchTaskTarget;
}) {
  const db = getDb();
  let row: { status: string; runner_id: string | null } | undefined;
  try {
    row = db
      .prepare<{ id: string }, { status: string; runner_id: string | null }>(
        'SELECT status, runner_id FROM batch_tasks WHERE id = @id',
      )
      .get({ id: opts.taskId });
  } catch (e: any) {
    throw new Error(`task start conflict unreadable: ${opts.taskId}: ${e?.message || String(e)}`);
  }
  if (!row) {
    throw new Error(`task start conflict unreadable: ${opts.taskId}: task not found`);
  }

  const status = String(row.status || '');
  if (!Object.prototype.hasOwnProperty.call(TASK_STATUS_TRANSITIONS, status)) {
    throw new Error(`task start conflict unknown status: ${opts.taskId}: ${status || '(empty)'}`);
  }

  if (status === 'cancelled') {
    db.prepare(
      `UPDATE batch_tasks
          SET runner_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = ?
        WHERE id = ? AND status = 'cancelled'`,
    ).run(_nowIso(), opts.taskId);
    if (opts.batchId) {
      _emit(opts.batchId, 'task_cancelled', {
        taskId: opts.taskId,
        targetSeq: opts.targetSeq,
        target: opts.target || {},
        reason: 'cancelled before start transition',
      });
    }
    return { handled: true as const, mode: 'cancelled' as const };
  }

  if (
    ['running', 'upstream_pending', 'completed', 'failed', 'needs_review'].includes(status) &&
    String(row.runner_id || '') !== opts.runnerId
  ) {
    return { handled: true as const, mode: 'lost_race' as const };
  }

  throw new Error(
    `task start transition conflict: ${opts.taskId} status=${status} runner_id=${row.runner_id || ''}`,
  );
}

/**
 * 真正的执行循环。
 */
export async function runBatch(opts: {
  user: UserRow;
  batchId: string;
  batchType: string;
  projectId: string;
  options: any;
}) {
  const db = getDb();
  const exec = _executors.get(opts.batchType);
  if (!exec) {
    const reason = '未知 batchType: ' + opts.batchType;
    db.prepare(
      `UPDATE batch_tasks
          SET status='failed',
              error_msg=?,
              error_message=?,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE batch_id=?
          AND status IN ('queued','running','retry_pending')`,
    ).run(reason, reason, opts.batchId);
    const final = finalizeBatchFromTasks(opts.batchId);
    _emit(opts.batchId, 'batch_completed', { batchId: opts.batchId, status: final.status, reason });
    if (final.status !== 'failed') emitSnapshot(opts.batchId);
    return;
  }

  const stopHeartbeat = _startBatchHeartbeat(opts.batchId);
  try {
  db.prepare(`UPDATE batches SET status='running', runner_id=?, runner_heartbeat_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(BATCH_RUNNER_ID, _nowIso(), opts.batchId);

  const counters = db
    .prepare<{ bid: string }, { succeeded: number; failed: number }>(
      `SELECT
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
       FROM batch_tasks
       WHERE batch_id = @bid`,
    )
    .get({ bid: opts.batchId }) || { succeeded: 0, failed: 0 };

  // 先发 snapshot 给晚订阅的订阅者
  setImmediate(() => emitSnapshot(opts.batchId));

  let succeeded = Number(counters.succeeded || 0);
  let failed = Number(counters.failed || 0);
  let running = 0;
  const concurrency = _concurrencyFor(opts.batchType);

  await new Promise<void>((resolveAll) => {
    const tryNext = () => {
      while (running < concurrency) {
        const t = claimNextTask({
          runnerId: BATCH_RUNNER_ID,
          batchId: opts.batchId,
          taskTypes: [opts.batchType],
          statuses: ['queued'],
          leaseMs: BATCH_TASK_LEASE_MS,
        });
        if (!t) break;
        running++;
        runOne(t).finally(() => {
          running--;
          tryNext();
        });
      }
      if (running === 0) resolveAll();
    };

    const runOne = async (t: any) => {
      const target: BatchTaskTarget = (() => {
        try { return JSON.parse(t.target_json || '{}'); } catch { return {}; }
      })();

      try {
        transitionTaskStatus({
          taskId: t.id,
          from: 'queued',
          to: 'running',
          reason: `batch:${opts.batchType}:start`,
          actor: 'worker',
          runnerId: BATCH_RUNNER_ID,
        });
      } catch (e: any) {
        try {
          const resolved = resolveTaskStartTransitionConflict({
            taskId: t.id,
            runnerId: BATCH_RUNNER_ID,
            batchId: opts.batchId,
            targetSeq: t.seq,
            target,
          });
          if (resolved.handled) return;
        } catch (resolutionErr) {
          throw resolutionErr;
        }
        throw e;
      }
      _emit(opts.batchId, 'task_started', { taskId: t.id, targetSeq: t.seq, target });

      if (isTaskCancelRequested(t.id)) {
        transitionTaskStatus({
          taskId: t.id,
          from: 'running',
          to: 'cancelled',
          reason: 'cancelled before execution',
          actor: 'worker',
          runnerId: BATCH_RUNNER_ID,
        });
        _emit(opts.batchId, 'task_cancelled', { taskId: t.id, targetSeq: t.seq, target });
        return;
      }

      try {
        throwIfTaskCancelRequested(t.id);
        const result = await exec({
          user: opts.user,
          projectId: opts.projectId,
          options: opts.options,
          batchId: opts.batchId,
          taskId: t.id,
          idempotencyKey: String(t.idempotency_key || `task:${t.id}`),
          seq: t.seq,
          target,
          progress: (payload) => _emit(opts.batchId, 'task_progress', { taskId: t.id, targetSeq: t.seq, ...payload }),
          isCancelled: () => isTaskCancelRequested(t.id),
          throwIfCancelled: () => throwIfTaskCancelRequested(t.id),
        });

        const afterExec = db
          .prepare<{ id: string }, { status: string }>('SELECT status FROM batch_tasks WHERE id = @id')
          .get({ id: t.id });
        if (afterExec?.status === 'upstream_pending') {
          _emit(opts.batchId, 'task_progress', {
            taskId: t.id,
            targetSeq: t.seq,
            target,
            stage: 'upstream_pending',
            hint: '上游任务已提交，等待后台轮询完成',
            extra: result?.extra,
          });
          return;
        }

        if (opts.batchType === 'storyboard_prompts' || opts.batchType === 'video_prompts') {
          try {
            recordTextFlagIfSensitive({
              ownerId: opts.user.id,
              projectId: opts.projectId,
              sourceId: t.id,
              text: JSON.stringify(result || {}),
              reasonPrefix: `batch:${opts.batchType}`,
            });
          } catch (flagError) {
            console.warn('[batch] failed to persist content flag:', flagError);
          }
        }

        const serverVersion = Number(getProjectByIdForUser(opts.projectId, opts.user.id)?.version) || undefined;
        const resultForStore = serverVersion
          ? { ...(result || {}), serverVersion }
          : (result || {});
        db.prepare(`UPDATE batch_tasks SET result_json=?, error_msg=NULL, updated_at=? WHERE id=?`)
          .run(JSON.stringify(resultForStore), _nowIso(), t.id);
        transitionTaskStatus({
          taskId: t.id,
          from: 'running',
          to: 'completed',
          reason: `batch:${opts.batchType}:completed`,
          actor: 'worker',
          runnerId: BATCH_RUNNER_ID,
        });
        succeeded++;
        db.prepare(`UPDATE batches SET succeeded=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(succeeded, opts.batchId);

        _emit(opts.batchId, 'task_completed', {
          taskId: t.id,
          targetSeq: t.seq,
          target,
          resultUrl: resultForStore?.resultUrl,
          patch: resultForStore?.patch,
          extra: resultForStore?.extra,
          serverVersion,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const wasCancelled = e instanceof BatchTaskCancelledError;
        if (wasCancelled) {
          db.prepare(`UPDATE batch_tasks SET error_msg=?, result_json='{}', updated_at=? WHERE id=?`)
            .run(msg.slice(0, 1000), _nowIso(), t.id);
          transitionTaskStatus({
            taskId: t.id,
            from: 'running',
            to: 'cancelled',
            reason: msg.slice(0, 500),
            actor: 'worker',
            runnerId: BATCH_RUNNER_ID,
          });
          _emit(opts.batchId, 'task_cancelled', { taskId: t.id, targetSeq: t.seq, target, reason: msg });
          return;
        }
        const failureStage = typeof e?.failureStage === 'string' ? e.failureStage : undefined;
        const errorCode = typeof e?.errorCode === 'string' ? e.errorCode : undefined;
        const cleanupExtra = _clearFailedStoryboardImageState({
          batchType: opts.batchType,
          projectId: opts.projectId,
          user: opts.user,
          target,
          message: msg,
          imageSafetyAudit: e?.imageSafetyAudit,
        });
        const tailCleanupExtra = _clearFailedTailFrameImageState({
          batchType: opts.batchType,
          projectId: opts.projectId,
          user: opts.user,
          target,
          message: msg,
          errorCode: typeof e?.errorCode === 'string' ? e.errorCode : undefined,
          recoveryHint: typeof e?.recoveryHint === 'string' ? e.recoveryHint : undefined,
          imageSafetyAudit: e?.imageSafetyAudit,
        });
        const assetCleanupExtra = _markFailedAssetImageState({
          batchType: opts.batchType,
          projectId: opts.projectId,
          user: opts.user,
          target,
          message: msg,
          imageSafetyAudit: e?.imageSafetyAudit,
        });
        const promptCleanupExtra = _markFailedVideoPromptState({
          batchType: opts.batchType,
          batchId: opts.batchId,
          projectId: opts.projectId,
          user: opts.user,
          target,
          message: msg,
        });
        const shotPlanCleanupExtra = _markFailedShotPlanState({
          batchType: opts.batchType,
          batchId: opts.batchId,
          projectId: opts.projectId,
          user: opts.user,
          message: msg,
        });
	        const extra = cleanupExtra || tailCleanupExtra || assetCleanupExtra || promptCleanupExtra || shotPlanCleanupExtra || (failureStage || e?.imageSafetyAudit ? {} : undefined);
	        if (extra && failureStage) (extra as any).failureStage = failureStage;
	        if (extra && errorCode) (extra as any).errorCode = errorCode;
	        if (extra && e?.imageSafetyAudit) (extra as any).imageSafetyAudit = e.imageSafetyAudit;
	        if (extra && Array.isArray(e?.videoWarnings)) (extra as any).videoWarnings = e.videoWarnings;
	        if (extra && e?.groupIdx != null) (extra as any).groupIdx = e.groupIdx;
	        const failureResultPayload: Record<string, any> = {};
        if (failureStage) failureResultPayload.failureStage = failureStage;
        if (errorCode) failureResultPayload.errorCode = errorCode;
        if (e?.imageSafetyAudit) failureResultPayload.imageSafetyAudit = e.imageSafetyAudit;
        if (extra) {
          failureResultPayload.extra = extra;
          for (const key of ['groupIdx', 'videoPromptRunId', 'failureApplied', 'skippedReason', 'storedRunId', 'storedStatus']) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) {
              failureResultPayload[key] = (extra as any)[key];
            }
          }
        }
        const failureResult = Object.keys(failureResultPayload).length
          ? JSON.stringify(failureResultPayload)
          : '{}';
        db.prepare(`UPDATE batch_tasks SET error_msg=?, result_json=?, updated_at=? WHERE id=?`)
          .run(msg.slice(0, 1000), failureResult, _nowIso(), t.id);
        transitionTaskStatus({
          taskId: t.id,
          from: 'running',
          to: 'failed',
          reason: msg.slice(0, 500),
          actor: 'worker',
          runnerId: BATCH_RUNNER_ID,
          meta: {
            failureStage,
            errorCode,
          },
        });
        failed++;
        db.prepare(`UPDATE batches SET failed=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(failed, opts.batchId);
        _emit(opts.batchId, 'task_failed', {
          taskId: t.id,
          targetSeq: t.seq,
          target,
          errorMsg: msg,
          reason: msg,
          failureStage,
          errorCode,
          extra,
        });
      }
    };

    tryNext();
  });

  const final = finalizeBatchFromTasks(opts.batchId);
  _emit(opts.batchId, 'batch_completed', {
    batchId: opts.batchId,
    status: final.status,
    succeeded: final.completed,
    failed: final.failed,
    cancelled: final.cancelled,
    needsReview: final.needsReview,
    total: Number(getBatchSnapshot(opts.batchId)?.total || final.total),
  });
  // 60 秒后回收 EventEmitter，避免 _emitters map 无限膨胀。
  // 留 60s 是给"stream 路由晚订阅一帧"的用户仍能收到最终事件；超时后即使有订阅也只是静默。
  setTimeout(() => {
    const e = _emitters.get(opts.batchId);
    if (e) {
      try { e.removeAllListeners(); } catch (_) {}
      _emitters.delete(opts.batchId);
    }
  }, 60_000).unref?.();
  } finally {
    stopHeartbeat();
  }
}

/**
 * 给 stream 路由用：晚订阅的订阅者一连接，就需要先收到一帧"全景快照"。
 */
export function emitSnapshot(batchId: string) {
  const snap = getBatchSnapshot(batchId);
  if (snap) _emit(batchId, 'snapshot', snap);
}

export function getBatchSnapshot(batchId: string, ownerId?: number): any | null {
  const db = getDb();
  const batch = ownerId != null
    ? db
        .prepare<{ id: string; oid: number }, any>(
          'SELECT * FROM batches WHERE id = @id AND owner_id = @oid',
        )
        .get({ id: batchId, oid: ownerId })
    : db.prepare<{ id: string }, any>('SELECT * FROM batches WHERE id = @id').get({ id: batchId });
  if (!batch) return null;
  const tasks = db
    .prepare<{ bid: string }, any>('SELECT * FROM batch_tasks WHERE batch_id = @bid ORDER BY seq ASC')
    .all({ bid: batchId });
  return {
    batchId,
    batchType: batch.batch_type,
    status: batch.status,
    // 批次创建时刻（ISO UTC）。前端倒计时用它做"已耗时"锚点：
    // 刷新页面 / reattach 后不至于把倒计时从头再走一遍。纯附加字段，老前端无感。
    createdAt: batch.created_at || null,
    total: batch.total,
    succeeded: batch.succeeded,
    failed: batch.failed,
    running: tasks.filter((t: any) => t.status === 'running').length,
    tasks: tasks.map((t: any) => ({
      taskId: t.id,
      seq: t.seq,
      status: t.status,
      target: safeParse(t.target_json),
      result: safeParse(t.result_json),
      errorMsg: t.error_msg || null,
    })),
  };
}

function safeParse(s: string) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

/**
 * 查询当前用户在某项目下"未完成 + 近期已完成"的批次。
 * 包含两类：
 *   1) 状态 queued / running 的（永远返回）
 *   2) 状态 completed / failed 但最近 RECENT_BATCH_WINDOW_MS 内更新过的
 *      —— 用来让刷新后还能看到刚跑完/失败的 task 卡片，
 *      而不是因为整个 batch 完成了就从 UI 上彻底消失
 *
 * 前端刷新后调 /api/batch/active 用来 reattach SSE 订阅 + 恢复失败卡片。
 */
/**
 * 轻量查询：该用户该项目是否已有指定类型的批次在跑（queued/running）。
 * 用于 /api/batch/start 的同类型防重（如 shots：镜头表生成中用户又点
 * "确认资产"自动触发 generateShots → 直接复用进行中的批次，不再起第二路）。
 */
export function findActiveBatchForType(opts: {
  ownerId: number;
  projectId: string;
  batchType: string;
}): { batchId: string; total: number } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, total FROM batches
       WHERE owner_id = ? AND project_id = ? AND batch_type = ? AND status IN ('queued','running')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(opts.ownerId, opts.projectId, opts.batchType) as any;
  return row ? { batchId: String(row.id), total: Number(row.total) || 1 } : null;
}

export function getActiveBatchesForUser(opts: {
  ownerId: number;
  projectId?: string;
}): Array<{
  batchId: string;
  batchType: string;
  status: string;
  snapshot: any;
  tasks: any[];
}> {
  const db = getDb();
  // 30 分钟窗口：足够让用户回来翻看刚跑完的批次状态，又不会无限累积历史
  const RECENT_BATCH_WINDOW_MS = 30 * 60 * 1000;
  const recentCutoff = new Date(Date.now() - RECENT_BATCH_WINDOW_MS).toISOString();

  let rows: any[];
  if (opts.projectId) {
    rows = db
      .prepare<any[], any>(
        `SELECT id, batch_type, status FROM batches
         WHERE owner_id = ? AND project_id = ?
           AND (
             status IN ('queued', 'running')
             OR (status IN ('completed', 'failed', 'partial') AND updated_at > ?)
           )
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all(opts.ownerId, opts.projectId, recentCutoff);
  } else {
    rows = db
      .prepare<any[], any>(
        `SELECT id, batch_type, status FROM batches
         WHERE owner_id = ?
           AND (
             status IN ('queued', 'running')
             OR (status IN ('completed', 'failed', 'partial') AND updated_at > ?)
           )
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all(opts.ownerId, recentCutoff);
  }

  return rows.map((r: any) => {
    const snap = getBatchSnapshot(r.id);
    return {
      batchId: r.id,
      batchType: r.batch_type,
      status: r.status,
      snapshot: snap || {},
      tasks: snap?.tasks || [],
    };
  });
}
