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
import { CREDIT_PRICES, chargeCredits, refundCredits, InsufficientCreditsError } from './credits';
import { patchProjectForUser } from './projects-db';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from './video-prompt-state';
import { markFirstFrameFailed } from './visual-reference-state';

export type BatchEventName =
  | 'snapshot'
  | 'task_started'
  | 'task_progress'
  | 'task_completed'
  | 'task_failed'
  | 'batch_completed'
  | 'batch_cancelled';

export type BatchTaskTarget = Record<string, any> & { idx?: number; groupIdx?: number };

export type BatchExecCtx = {
  user: UserRow;
  projectId: string;
  options: any;
  batchId: string;
  taskId: string;
  seq: number;
  target: BatchTaskTarget;
  /** 用来主动推送进度（前端会转成 task_progress 事件）*/
  progress: (payload: any) => void;
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
const LEGACY_ORPHAN_GRACE_MS = 30 * 60_000;

export class ActiveVideoBatchConflictError extends Error {
  groupIdxs: number[];
  batchIds: string[];

  constructor(groupIdxs: number[], batchIds: string[]) {
    super(
      groupIdxs.length
        ? `片段 ${groupIdxs.map((n) => n + 1).join('、')} 已有视频生成任务正在运行，请等待完成后再重试`
        : '已有视频生成任务正在运行，请等待完成后再重试',
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
  const firstFrameLastError = (opts.message || '生成失败').slice(0, 500);

  try {
    patchProjectForUser(opts.projectId, opts.user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      while (storyboards.length <= groupIdx) storyboards.push({});
      const prev = storyboards[groupIdx] || {};
      const error = {
        message: firstFrameLastError,
        failedAt: new Date().toISOString(),
        batchType: opts.batchType,
        imageSafetyAudit: opts.imageSafetyAudit,
      };
      storyboards[groupIdx] = {
        ...prev,
        firstFrame: markFirstFrameFailed(prev, error),
        firstFrameLastError,
        firstFrameFailedAt: error.failedAt,
      };
      return { storyboards };
    });
  } catch (cleanupErr) {
    console.error('[batch] failed to clear storyboard first-frame/video state:', opts.projectId, groupIdx, cleanupErr);
  }

  return { groupIdx, firstFrameLastError, invalidateVideo: true, firstFrameCleared: false };
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

function _markFailedVideoPromptState(opts: {
  batchType: string;
  batchId: string;
  projectId: string;
  user: UserRow;
  target: BatchTaskTarget;
  message: string;
}): null | { groupIdx: number; videoPromptStatus: 'failed'; videoPromptLastError: string; invalidateVideo: true } {
  if (opts.batchType !== 'video_prompts') return null;
  const groupIdx = _targetGroupIdx(opts.target);
  if (groupIdx == null || !opts.projectId) return null;
  const videoPromptLastError = (opts.message || '生成失败').slice(0, 500);
  const now = _nowIso();

  try {
    patchProjectForUser(opts.projectId, opts.user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      while (storyboards.length <= groupIdx) storyboards.push({});
      const prev = storyboards[groupIdx] || {};
      if (prev.videoPromptRunId && prev.videoPromptRunId !== opts.batchId) {
        console.warn(
          `[batch] ignored stale video_prompt failure project=${opts.projectId} group=${groupIdx} ` +
            `batch=${opts.batchId} currentRun=${prev.videoPromptRunId}`,
        );
        return null;
      }
      storyboards[groupIdx] = {
        ...markStoryboardVideoOutdated(prev, 'video_prompt_failed', now),
        videoPromptStatus: 'failed',
        videoPromptRunId: opts.batchId,
        videoPromptFailedAt: now,
        videoPromptLastError,
      };

      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
      if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
        videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_failed', now);
      }
      return { storyboards, videoTasks };
    });
  } catch (cleanupErr) {
    console.error('[batch] failed to mark video prompt failure state:', opts.projectId, groupIdx, cleanupErr);
  }

  return { groupIdx, videoPromptStatus: 'failed', videoPromptLastError, invalidateVideo: true };
}

function _findActiveVideoBatchOverlap(db: any, opts: {
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
} {
  if (opts.batchType !== 'videos') return null;
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
         AND bt.status IN ('queued', 'running')
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
  };
}

/**
 * 不同 batchType 用不同的并发上限：
 *   - 分镜：3（gpt-image-1 单张 30-60s，3 在多数中转上仍稳定）
 *   - 资产图：默认 2，避免 10+ 张资产同时打到中转限流
 *   - 视频：3（准备阶段可并行；真正 submit 由 lib/video-gen.ts 的 semaphore 限速）
 *   - 其它（纯文本类）：3
 */
function _concurrencyFor(batchType: string): number {
  // 视频生成：grok 中转端是异步的（提交后轮询），所以可以并行多个
  // 5 个片段并行 → 总时间约 = 单个片段时间 (1~2 分钟) 而非 5 倍
  if (batchType === 'video_segments' || batchType === 'videos') return 3;
  // 分镜图通常 ≤ 6 张：concurrency 6 会把中转站打到排队 → 后面的请求超时；
  // 3 比 4 慢一点点（5-6 张时差 1-2 张的并行位），但能显著降低中转 429 限流概率。
  // 中转站每分钟总配额是固定的，并发越高越容易撞限流，4 多次实测会触发 bad_response。
  if (batchType === 'storyboard_images') return 3;
  // 资产图可能有 10+ 张，并发 3 在实测里容易触发中转 429。
  if (batchType === 'asset_images') {
    return _envInt('ASSET_IMAGE_BATCH_CONCURRENCY', 2, 1, 6);
  }
  return 3;
}

function _envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
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
    'task_failed', 'batch_completed', 'batch_cancelled',
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
}): { batchId: string; total: number; reused?: boolean; duplicateGroupIdxs?: number[] } {
  const db = getDb();
  const total = opts.targets.length;
  const batchId = randomUUID();
  const optsJson = JSON.stringify(opts.options || {});
  const leaseAt = _nowIso();

  let shouldStartRunner = false;
  let result: { batchId: string; total: number; reused?: boolean; duplicateGroupIdxs?: number[] } | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const active = _findActiveVideoBatchOverlap(db, opts);
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
      throw new ActiveVideoBatchConflictError(active.overlapGroupIdxs, active.batchIds);
    }

    db.prepare(
      `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total, options_json, runner_id, runner_heartbeat_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(batchId, opts.user.id, opts.projectId, opts.batchType, total, optsJson, BATCH_RUNNER_ID, leaseAt);

    const insertTask = db.prepare(
      `INSERT INTO batch_tasks (id, batch_id, seq, target_json, status)
       VALUES (?, ?, ?, ?, 'queued')`,
    );
    for (let i = 0; i < opts.targets.length; i++) {
      const tid = randomUUID();
      insertTask.run(tid, batchId, i, JSON.stringify(opts.targets[i]));
    }
    shouldStartRunner = true;
    result = { batchId, total };
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
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
 * 注意：这是一次"兜底清理"，不尝试续跑——续跑需要重建 setImmediate 上下文、
 * 重新订阅 SSE，比本 app 的范围大得多；标 failed + 退款让用户手动重试更稳。
 *
 * 租约窗口：只回收 heartbeat 已过期的 batch。Next dev 下不同 route 可能有
 * 独立 globalThis，不能用"本 route 启动时间"判断孤儿；runner_heartbeat_at
 * 是跨 route / 跨进程共享在 DB 里的权威依据。
 *
 * 旧数据没有 runner_heartbeat_at 时走保守宽限，只清理创建时间已经明显过旧的
 * queued/running batch，避免迁移瞬间误杀正在跑的任务。
 */
export function reapOrphanBatches() {
  const db = getDb();
  try {
    const staleHeartbeatBefore = _isoAgo(BATCH_HEARTBEAT_TIMEOUT_MS);
    const legacyCreatedBefore = _isoAgo(LEGACY_ORPHAN_GRACE_MS);
    const orphanBatches = db
      .prepare<[string, string], any>(
        `SELECT id, owner_id, project_id, batch_type, created_at
         FROM batches
         WHERE status IN ('queued','running')
           AND (
             (runner_heartbeat_at IS NOT NULL AND runner_heartbeat_at <> '' AND runner_heartbeat_at < ?)
             OR ((runner_heartbeat_at IS NULL OR runner_heartbeat_at = '') AND created_at < ?)
           )`,
      )
      .all(staleHeartbeatBefore, legacyCreatedBefore);
    if (!orphanBatches.length) return;
    console.warn(`[batch] reap: 发现 ${orphanBatches.length} 个 heartbeat 过期的孤儿 batch，标记 failed 并退款`);
    for (const b of orphanBatches) {
      // 退款还在 running 的 task
      const runningTasks = db
        .prepare<{ bid: string }, any>(
          "SELECT id FROM batch_tasks WHERE batch_id = @bid AND status = 'running'",
        )
        .all({ bid: b.id });
      const cost = costForBatchType(b.batch_type);
      if (cost > 0 && runningTasks.length) {
        for (const t of runningTasks) {
          try {
            refundCredits({
              userId: b.owner_id,
              amount: cost,
              reason: `orphan batch reap:${b.batch_type}`,
              refId: t.id,
            });
          } catch (e) {
            console.error('[batch] reap refund failed for task', t.id, e);
          }
        }
      }

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

      db.prepare(
        "UPDATE batch_tasks SET status='failed', error_msg='orphaned by server restart', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id=? AND status IN ('queued','running')",
      ).run(b.id);
      db.prepare(
        `UPDATE batches
         SET status='failed',
             succeeded=(SELECT COUNT(*) FROM batch_tasks WHERE batch_id=? AND status='completed'),
             failed=(SELECT COUNT(*) FROM batch_tasks WHERE batch_id=? AND status='failed'),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?`,
      ).run(b.id, b.id, b.id);
    }
  } catch (e) {
    console.error('[batch] reap orphan failed:', e);
  }
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

function costForBatchType(batchType: string): number {
  if (batchType === 'asset_images' || batchType === 'storyboard_images') return CREDIT_PRICES.image;
  if (batchType === 'video_segments' || batchType === 'videos') return CREDIT_PRICES.video;
  if (batchType === 'storyboard_prompts' || batchType === 'video_prompts') return CREDIT_PRICES.text;
  return 0;
}

/**
 * 真正的执行循环。
 */
async function runBatch(opts: {
  user: UserRow;
  batchId: string;
  batchType: string;
  projectId: string;
  options: any;
}) {
  const db = getDb();
  const exec = _executors.get(opts.batchType);
  if (!exec) {
    db.prepare(`UPDATE batches SET status='failed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(opts.batchId);
    _emit(opts.batchId, 'batch_completed', { batchId: opts.batchId, status: 'failed', reason: '未知 batchType: ' + opts.batchType });
    return;
  }

  const stopHeartbeat = _startBatchHeartbeat(opts.batchId);
  try {
  db.prepare(`UPDATE batches SET status='running', runner_id=?, runner_heartbeat_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(BATCH_RUNNER_ID, _nowIso(), opts.batchId);

  // 取所有任务
  const tasks = db
    .prepare<{ bid: string }, any>('SELECT * FROM batch_tasks WHERE batch_id = @bid ORDER BY seq ASC')
    .all({ bid: opts.batchId });

  // 先发 snapshot 给晚订阅的订阅者
  setImmediate(() => emitSnapshot(opts.batchId));

  // 简单 worker pool
  const queue = [...tasks];
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  const concurrency = _concurrencyFor(opts.batchType);

  await new Promise<void>((resolveAll) => {
    const tryNext = () => {
      while (running < concurrency && queue.length) {
        const t = queue.shift();
        if (!t) break;
        running++;
        runOne(t).finally(() => {
          running--;
          if (queue.length === 0 && running === 0) resolveAll();
          else tryNext();
        });
      }
      if (queue.length === 0 && running === 0) resolveAll();
    };

    const runOne = async (t: any) => {
      const target: BatchTaskTarget = (() => {
        try { return JSON.parse(t.target_json || '{}'); } catch { return {}; }
      })();

      db.prepare(`UPDATE batch_tasks SET status='running', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(t.id);
      _emit(opts.batchId, 'task_started', { taskId: t.id, targetSeq: t.seq, target });

      // 单任务计费（图片/视频每条扣一份）
      const cost = costPerTask(opts.batchType);
      let chargeId: string | null = null;
      if (cost > 0) {
        try {
          const r = chargeCredits({
            userId: opts.user.id,
            amount: cost,
            kind: cost === CREDIT_PRICES.video ? 'video' : 'image',
            reason: `batch:${opts.batchType}`,
            refId: t.id,
          });
          chargeId = r.ledgerId;
        } catch (e: any) {
          const msg = e?.message || String(e);
          db.prepare(`UPDATE batch_tasks SET status='failed', error_msg=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(msg.slice(0, 1000), t.id);
          failed++;
          db.prepare(`UPDATE batches SET failed=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(failed, opts.batchId);
          _emit(opts.batchId, 'task_failed', {
            taskId: t.id, targetSeq: t.seq, target, errorMsg: msg, reason: msg,
            errorCode: e instanceof InsufficientCreditsError ? 'INSUFFICIENT_CREDITS' : undefined,
          });
          return;
        }
      }

      try {
        const result = await exec({
          user: opts.user,
          projectId: opts.projectId,
          options: opts.options,
          batchId: opts.batchId,
          taskId: t.id,
          seq: t.seq,
          target,
          progress: (payload) => _emit(opts.batchId, 'task_progress', { taskId: t.id, targetSeq: t.seq, ...payload }),
        });

        db.prepare(`UPDATE batch_tasks SET status='completed', result_json=?, error_msg=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(JSON.stringify(result || {}), t.id);
        succeeded++;
        db.prepare(`UPDATE batches SET succeeded=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(succeeded, opts.batchId);

        _emit(opts.batchId, 'task_completed', {
          taskId: t.id,
          targetSeq: t.seq,
          target,
          resultUrl: result?.resultUrl,
          patch: result?.patch,
          extra: result?.extra,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        // 任务失败：把刚预扣的积分退还
        if (cost > 0) {
          try { refundCredits({ userId: opts.user.id, amount: cost, reason: `refund:${opts.batchType}`, refId: t.id }); }
          catch (refundErr) { console.error('[batch] refund failed:', opts.batchId, t.id, refundErr); }
        }
        const cleanupExtra = _clearFailedStoryboardImageState({
          batchType: opts.batchType,
          projectId: opts.projectId,
          user: opts.user,
          target,
          message: msg,
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
        const failureResult = e?.imageSafetyAudit
          ? JSON.stringify({ imageSafetyAudit: e.imageSafetyAudit })
          : null;
        db.prepare(`UPDATE batch_tasks SET status='failed', error_msg=?, result_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(msg.slice(0, 1000), failureResult, t.id);
        failed++;
        db.prepare(`UPDATE batches SET failed=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(failed, opts.batchId);
        const failureStage = typeof e?.failureStage === 'string' ? e.failureStage : undefined;
        const extra = cleanupExtra || assetCleanupExtra || promptCleanupExtra || (failureStage || e?.imageSafetyAudit ? {} : undefined);
        if (extra && failureStage) (extra as any).failureStage = failureStage;
        if (extra && e?.imageSafetyAudit) (extra as any).imageSafetyAudit = e.imageSafetyAudit;
        _emit(opts.batchId, 'task_failed', {
          taskId: t.id,
          targetSeq: t.seq,
          target,
          errorMsg: msg,
          reason: msg,
          failureStage,
          extra,
        });
      }
    };

    function costPerTask(batchType: string): number {
      if (batchType === 'asset_images' || batchType === 'storyboard_images') return CREDIT_PRICES.image;
      if (batchType === 'video_segments' || batchType === 'videos') return CREDIT_PRICES.video;
      if (batchType === 'storyboard_prompts' || batchType === 'video_prompts') return CREDIT_PRICES.text;
      return 0;
    }

    tryNext();
  });

  const finalStatus = failed === 0
    ? 'completed'
    : succeeded === 0
      ? 'failed'
      : failed > succeeded
        ? 'failed'
        : 'partial';
  db.prepare(`UPDATE batches SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(finalStatus, opts.batchId);
  _emit(opts.batchId, 'batch_completed', {
    batchId: opts.batchId,
    status: finalStatus,
    succeeded,
    failed,
    total: succeeded + failed,
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
