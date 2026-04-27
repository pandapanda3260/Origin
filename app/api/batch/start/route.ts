import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    ok: true,
    batchId: 'mock-batch-' + Date.now(),
    submitted: 0,
    message: '[mock] 已模拟批量任务（本地不会真实生成视频）',
  });
}
