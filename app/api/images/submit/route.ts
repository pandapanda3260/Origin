import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    ok: true,
    taskId: 'mock-img-' + Date.now(),
    url: '/showcase-asset-3.png',
    message: '[mock] 已用占位图返回（本地未连图片模型）',
  });
}
