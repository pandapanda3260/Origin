/**
 * Next.js App Router 下的 SSE 响应帮手
 *
 * 前端 apiPostStream 期望的事件格式（来自 public/modules/utils.js）:
 *   data: {"type":"chunk","content":"..."}\n\n
 *   data: {"type":"done","key1":...,"key2":...}\n\n
 *   data: {"type":"error","error":"..."}\n\n
 *
 * 此外文本块里还可以嵌入 <step>提示词文案</step> 表示进度提示。
 *
 * 用法：
 *   return sseResponse(async (writer) => {
 *     writer.step('正在分析意图…');
 *     await chatStream(user, msgs, {}, (delta) => writer.chunk(delta));
 *     writer.done({ outline, script });
 *   });
 */

export type SSEWriter = {
  chunk: (text: string) => void;
  // 命名分块：前端 script.js / episodes.js 等模块按事件类型分流（剧本流、咨询对话流、风格圣经流……）
  aiChunk: (text: string) => void;
  scriptChunk: (text: string) => void;
  styleBibleChunk: (text: string) => void;
  // 阶段切换提示：phase(name, extra?) → 前端按 evt.name 切状态文案
  phase: (name: string, extra?: Record<string, any>) => void;
  step: (label: string) => void;
  event: (eventName: string, data: any) => void; // 任意自定义事件
  done: (data?: Record<string, any>) => void;
  error: (msg: string) => void;
  isClosed: () => boolean;
};

export function sseResponse(handler: (writer: SSEWriter) => Promise<void> | void): Response {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const writer: SSEWriter = {
        chunk: (text) => send({ type: 'chunk', content: text }),
        aiChunk: (text) => send({ type: 'ai_chunk', content: text }),
        scriptChunk: (text) => send({ type: 'script_chunk', content: text }),
        styleBibleChunk: (text) => send({ type: 'style_bible_chunk', content: text }),
        phase: (name, extra) => send({ type: 'phase', name, ...(extra || {}) }),
        step: (label) => send({ type: 'chunk', content: `<step>${label}</step>` }),
        event: (eventName, data) => send({ type: eventName, ...(data || {}) }),
        done: (data = {}) => {
          send({ type: 'done', ...data });
          if (!closed) {
            closed = true;
            try { controller.close(); } catch (_) {}
          }
        },
        error: (msg) => {
          send({ type: 'error', error: msg });
          if (!closed) {
            closed = true;
            try { controller.close(); } catch (_) {}
          }
        },
        isClosed: () => closed,
      };

      try {
        await handler(writer);
        if (!closed) writer.done({});
      } catch (e: any) {
        const msg = e?.message || String(e);
        try { writer.error(msg); } catch (_) {}
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
