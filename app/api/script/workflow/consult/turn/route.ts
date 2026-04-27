import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    reply: '[mock] 我是剧本顾问。你可以告诉我你的目标观众、平台、时长偏好。',
    suggestions: ['30 秒美妆种草', '悬疑短剧开篇', '竖屏开箱测评'],
  });
}
