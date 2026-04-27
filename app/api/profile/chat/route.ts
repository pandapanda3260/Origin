import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    reply: '[mock] 你好，我是本地 mock 的创作偏好助手。后续接入真实模型即可对话。',
    persona: { visualStyle: '极简', narrativeStyle: '温柔', cameraStyle: '中近景', moodStyle: '平静', promptHabits: '中文简练' },
  });
}
