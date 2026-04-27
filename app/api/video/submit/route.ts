import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    ok: true,
    taskId: 'mock-vid-' + Date.now(),
    status: 'queued',
    message: '[mock] 已加入队列（本地未连视频模型）',
  });
}
