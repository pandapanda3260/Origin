export const dynamic = 'force-dynamic';

// Server-Sent Events: 本地 mock 只发一次「空状态」心跳就保持空闲，
// 与原站语义一致（前端会持续监听，不到来事件不会更新 UI）。
export async function GET() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: hello\ndata: {"ok":true}\n\n`));
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`event: ping\ndata: ${Date.now()}\n\n`));
        } catch (_) {
          clearInterval(ping);
        }
      }, 30000);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
