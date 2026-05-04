import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单任务 SSE：剪辑页 _attachExportStream 走 backend_stream.subscribeTask，
 * 期望 /api/tasks/<id>/stream 持续推 task_progress / task_completed / task_failed。
 *
 * 这里不走"事件总线"——直接 setInterval 轮询 exports 表（导出任务）和
 * video_tasks 表（视频片段任务），把状态变化翻译成 SSE 帧。简单可靠，
 * 不依赖具体执行器内部的事件回调。
 *
 * 帧结构与 batch/[id]/stream 一致：外层 `{ data: <真实 payload>, ts }`，
 * 前端 backend_stream._openStream 会自动剥外层。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return new Response('unauthorized', { status: 401 });
  const taskId = params.id;
  if (!taskId) return new Response('bad id', { status: 400 });

  const db = getDb();

  // 先确定任务类型：exports 表 vs video_tasks 表
  type Kind = 'export' | 'video' | null;
  const exp = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM exports WHERE id = @id AND owner_id = @uid')
    .get({ id: taskId, uid: user.id });
  let kind: Kind = exp ? 'export' : null;
  if (!kind) {
    const v = db
      .prepare<{ id: string; uid: number }, any>('SELECT * FROM video_tasks WHERE id = @id AND owner_id = @uid')
      .get({ id: taskId, uid: user.id });
    if (v) kind = 'video';
  }
  if (!kind) return new Response('not found', { status: 404 });

  const encoder = new TextEncoder();
  let closed = false;
  let lastStatus = '';
  let lastProgress = -1;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, payload: any) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify({ data: payload, ts: Date.now() })}\n\n`,
            ),
          );
        } catch {
          closed = true;
        }
      };

      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch (_) {}
      };

      // 心跳，避免代理空闲断线
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch { closed = true; }
      }, 15_000);

      const tick = () => {
        if (closed) return;
        try {
          const row = kind === 'export'
            ? db.prepare<{ id: string; uid: number }, any>('SELECT * FROM exports WHERE id = @id AND owner_id = @uid').get({ id: taskId, uid: user.id })
            : db.prepare<{ id: string; uid: number }, any>('SELECT * FROM video_tasks WHERE id = @id AND owner_id = @uid').get({ id: taskId, uid: user.id });
          if (!row) {
            send('task_failed', { taskId, reason: '任务记录消失' });
            cleanup();
            return;
          }

          const status: string = String(row.status || '');
          const progress: number = Number(row.progress || 0);

          if (progress !== lastProgress && status !== 'completed' && status !== 'failed') {
            lastProgress = progress;
            send('task_progress', { taskId, progress });
          }

          if (status !== lastStatus) {
            lastStatus = status;
            if (status === 'completed') {
              if (kind === 'export') {
                send('task_completed', {
                  taskId,
                  progress: 100,
                  downloadUrl: `/api/edit/export-file/${row.id}`,
                  resultUrl: `/api/edit/export-file/${row.id}`,
                });
              } else {
                send('task_completed', {
                  taskId,
                  progress: 100,
                  resultUrl: row.filename ? `/api/videos/file/${row.id}` : '',
                });
              }
              cleanup();
              return;
            }
            if (status === 'failed' || status === 'timeout' || status === 'cancelled') {
              send('task_failed', { taskId, reason: row.error_msg || status });
              cleanup();
              return;
            }
          }
        } catch (e) {
          // 单次轮询出错不致命，下一拍继续
          console.warn('[tasks/stream] tick error:', e);
        }
      };

      const poll = setInterval(tick, 1500);

      function cleanup() {
        clearInterval(poll);
        clearInterval(heartbeat);
        closeOnce();
      }

      const onAbort = () => {
        cleanup();
      };
      try {
        (req as any).signal?.addEventListener?.('abort', onAbort);
      } catch (_) {}

      // 立即推一帧当前状态；即使首次 tick 抛异常也保证定时器被清理，不然会永远泄漏
      try {
        tick();
      } catch (e) {
        console.warn('[tasks/stream] initial tick error:', e);
        try { send('task_failed', { taskId, reason: 'stream init error' }); } catch (_) {}
        cleanup();
      }
    },
    cancel() {
      closed = true;
    },
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
