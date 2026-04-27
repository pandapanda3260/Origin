import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    script: '[mock] 已扩充剧本：在原有结构上增加了若干细节描写与对白。',
    deltaTokens: 320,
  });
}
