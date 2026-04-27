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
const CONCURRENCY = 2;

export function registerExecutor(batchType: string, fn: BatchExecutor) {
  _executors.set(batchType, fn);
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
      .catch((e) => console.error('[batch]', batchId, 'fatal:', e));
  });

  return { batchId, total };
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

  await new Promise<void>((resolveAll) => {
    const tryNext = () => {
      while (running < CONCURRENCY && queue.length) {
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
          try { refundCredits({ userId: opts.user.id, amount: cost, reason: `refund:${opts.batchType}`, refId: t.id }); } catch (_) {}
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
      if (batchType === 'video_segments') return CREDIT_PRICES.video;
      if (batchType === 'storyboard_prompts') return CREDIT_PRICES.text;
      return 0;
    }

    tryNext();
  });

  const finalStatus = failed === 0 ? 'completed' : (succeeded === 0 ? 'failed' : 'completed');
  db.prepare(`UPDATE batches SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(finalStatus, opts.batchId);
  _emit(opts.batchId, 'batch_completed', {
    batchId: opts.batchId,
    status: finalStatus,
    succeeded,
    failed,
    total: succeeded + failed,
  });
}

/**
 * 给 stream 路由用：晚订阅的订阅者一连接，就需要先收到一帧"全景快照"。
 */
export function emitSnapshot(batchId: string) {
  const snap = getBatchSnapshot(batchId);
  if (snap) _emit(batchId, 'snapshot', snap);
}

export function getBatchSnapshot(batchId: string): any | null {
  const db = getDb();
  const batch = db.prepare<{ id: string }, any>('SELECT * FROM batches WHERE id = @id').get({ id: batchId });
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
