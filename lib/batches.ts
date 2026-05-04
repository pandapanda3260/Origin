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

/**
 * 不同 batchType 用不同的并发上限：
 *   - 图像 / 分镜：3（gpt-image-1 单张 30-60s，并发 2 时用户感觉"卡住"，
 *     3 在多数中转上仍稳定，速度提升 ~50%）
 *   - 视频：1（视频生成更慢、计费更高，避免触发限流和大额并发预扣）
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
  // 资产图可能有 10+ 张，concurrency 太高反而触发中转限流
  if (batchType === 'asset_images') return 3;
  return 3;
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

/**
 * 入口：新建 batch，把每个 target 写进 batch_tasks，然后在后台异步开干。
 */
export function createBatch(opts: {
  user: UserRow;
  batchType: string;
  projectId: string;
  targets: BatchTaskTarget[];
  options?: any;
}): { batchId: string; total: number } {
  const db = getDb();
  const batchId = randomUUID();
  const total = opts.targets.length;
  const optsJson = JSON.stringify(opts.options || {});

  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total, options_json)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(batchId, opts.user.id, opts.projectId, opts.batchType, total, optsJson);

  const insertTask = db.prepare(
    `INSERT INTO batch_tasks (id, batch_id, seq, target_json, status)
     VALUES (?, ?, ?, ?, 'queued')`,
  );
  const taskIds: string[] = [];
  for (let i = 0; i < opts.targets.length; i++) {
    const tid = randomUUID();
    taskIds.push(tid);
    insertTask.run(tid, batchId, i, JSON.stringify(opts.targets[i]));
  }

  // 后台启动（不 await，立即返回 batchId）
  setImmediate(() => {
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

  return { batchId, total };
}

/**
 * 启动时调用一次：把上次进程退出时仍处于 queued/running 的 batch 全部标 failed，
 * 并把它们还在 running 的 task 做一次退款尝试，避免用户积分被永久吞掉。
 *
 * 注意：这是一次"兜底清理"，不尝试续跑——续跑需要重建 setImmediate 上下文、
 * 重新订阅 SSE，比本 app 的范围大得多；标 failed + 退款让用户手动重试更稳。
 */
export function reapOrphanBatches() {
  const db = getDb();
  try {
    const orphanBatches = db
      .prepare<[], any>(
        "SELECT id, owner_id, batch_type FROM batches WHERE status IN ('queued','running')",
      )
      .all();
    if (!orphanBatches.length) return;
    console.warn(`[batch] reap: 发现 ${orphanBatches.length} 个孤儿 batch，标记 failed 并退款`);
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
      db.prepare(
        "UPDATE batch_tasks SET status='failed', error_msg='orphaned by server restart', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id=? AND status IN ('queued','running')",
      ).run(b.id);
      db.prepare(
        "UPDATE batches SET status='failed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      ).run(b.id);
    }
  } catch (e) {
    console.error('[batch] reap orphan failed:', e);
  }
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

  db.prepare(`UPDATE batches SET status='running', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(opts.batchId);

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

        db.prepare(`UPDATE batch_tasks SET status='completed', result_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
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
        db.prepare(`UPDATE batch_tasks SET status='failed', error_msg=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(msg.slice(0, 1000), t.id);
        failed++;
        db.prepare(`UPDATE batches SET failed=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(failed, opts.batchId);
        _emit(opts.batchId, 'task_failed', { taskId: t.id, targetSeq: t.seq, target, errorMsg: msg, reason: msg });
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
