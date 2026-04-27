import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    edl: [
      { clipId: 'c1', start: 0, end: 4 },
      { clipId: 'c2', start: 4, end: 7 },
      { clipId: 'c3', start: 7, end: 12 },
    ],
    duration: 12,
    message: '[mock] AI 自动剪辑结果（示例 EDL）',
  });
}
