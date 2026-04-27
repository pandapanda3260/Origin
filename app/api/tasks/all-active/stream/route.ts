import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 任务中心实时推送：客户端建立 EventSource 后，服务器周期性查 DB 推差量。
 *
 * 帧格式（保持与 /api/batch/[id]/stream 一致：单层包装）：
 *   event: snapshot
 *   data: {"data":{...}, "ts":<ms>}
 *
 * 事件类型：
 *   - snapshot：当前所有活跃任务的全景
 *   - tasks_changed：列表有变化（新建 / 状态变 / 完成）
 *
 * 简单实现：每 1.5s 轮询一次 DB，diff 后再推 snapshot。
 * 上线规模大时可改 EventEmitter 推送（这里点到为止）。
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return new Response('unauthorized', { status: 401 });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, payload: any) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ data: payload, ts: Date.now() })}\n\n`));
        } catch { closed = true; }
      };

      const fetchSnapshot = () => {
        const db = getDb();
        const items: any[] = [];

        const videos = db
          .prepare<{ uid: number }, any>(
            `SELECT id, project_id, group_idx, status, progress, created_at FROM video_tasks
             WHERE owner_id = @uid AND status IN ('queued','running')
             ORDER BY created_at DESC`,
          )
          .all({ uid: user.id });
        for (const v of videos) {
          items.push({
            taskId: v.id, type: 'video_segment', status: v.status, progress: v.progress,
            title: `视频片段 ${v.group_idx ?? ''}`, projectId: v.project_id,
          });
        }

        const batches = db
          .prepare<{ uid: number }, any>(
            `SELECT id, batch_type, status, total, succeeded, failed, project_id, created_at FROM batches
             WHERE owner_id = @uid AND status IN ('queued','running')
             ORDER BY created_at DESC`,
          )
          .all({ uid: user.id });
        for (const b of batches) {
          const pct = b.total > 0 ? Math.round((b.succeeded * 100) / b.total) : 0;
          items.push({
            taskId: b.id, type: b.batch_type, status: b.status, progress: pct,
            title: `批量 ${b.succeeded}/${b.total}`, projectId: b.project_id,
          });
        }

        const exps = db
          .prepare<{ uid: number }, any>(
            `SELECT id, project_id, status, progress, created_at FROM exports
             WHERE owner_id = @uid AND status IN ('queued','running')
             ORDER BY created_at DESC`,
          )
          .all({ uid: user.id });
        for (const e of exps) {
          items.push({
            taskId: e.id, type: 'video_export', status: e.status, progress: e.progress,
            title: '导出成片', projectId: e.project_id,
          });
        }

        return items;
      };

      const initial = fetchSnapshot();
      send('snapshot', { items: initial, total: initial.length });
      let lastSig = JSON.stringify(initial);

      const tick = setInterval(() => {
        if (closed) { clearInterval(tick); return; }
        try {
          const cur = fetchSnapshot();
          const sig = JSON.stringify(cur);
          if (sig !== lastSig) {
            lastSig = sig;
            send('tasks_changed', { items: cur, total: cur.length });
          } else {
            // 心跳（前端不必处理）
            try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { closed = true; clearInterval(tick); }
          }
        } catch { /* swallow */ }
      }, 1500);

      const onAbort = () => {
        if (!closed) {
          closed = true;
          clearInterval(tick);
          try { controller.close(); } catch (_) {}
        }
      };
      try { (req as any).signal?.addEventListener?.('abort', onAbort); } catch (_) {}
    },
    cancel() { closed = true; },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
