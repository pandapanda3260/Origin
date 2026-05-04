import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getBatchSnapshot, subscribeBatchEvents } from '@/lib/batches';
import '@/lib/init-executors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * EventSource 流：发送命名事件给前端 backend_stream.js。
 *
 * 帧格式（每条事件）：
 *   event: snapshot|task_started|task_progress|task_completed|task_failed|batch_completed
 *   data: {"data": <真实 payload>, "ts": <ms>}\n\n
 *
 * 前端 backend_stream.js _openStream 会解出 data.data。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return new Response('unauthorized', { status: 401 });
  const batchId = params.id;
  if (!batchId) return new Response('bad id', { status: 400 });

  const snapshot = getBatchSnapshot(batchId, user.id);
  if (!snapshot) return new Response('not found', { status: 404 });

  const encoder = new TextEncoder();
  let closed = false;

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

      // 先推一帧 snapshot
      send('snapshot', snapshot);

      // 如果 batch 已经结束，推一帧 batch_completed 然后关闭
      if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        send(snapshot.status === 'cancelled' ? 'batch_cancelled' : 'batch_completed', {
          batchId, status: snapshot.status, succeeded: snapshot.succeeded, failed: snapshot.failed, total: snapshot.total,
        });
        if (!closed) {
          closed = true;
          try { controller.close(); } catch (_) {}
        }
        return;
      }

      // 订阅后续事件
      const unsub = subscribeBatchEvents(batchId, (eventName, data) => {
        send(eventName, data);
        if (eventName === 'batch_completed' || eventName === 'batch_cancelled') {
          if (!closed) {
            closed = true;
            try { unsub(); controller.close(); } catch (_) {}
          }
        }
      });

      // 客户端断开
      const onAbort = () => {
        if (!closed) {
          closed = true;
          try { unsub(); controller.close(); } catch (_) {}
        }
      };
      try {
        (req as any).signal?.addEventListener?.('abort', onAbort);
      } catch (_) {}

      // 心跳（每 25s 发一次注释，防止网关砍连接）
      const ping = setInterval(() => {
        if (closed) { clearInterval(ping); return; }
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { closed = true; clearInterval(ping); }
      }, 25000);
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
